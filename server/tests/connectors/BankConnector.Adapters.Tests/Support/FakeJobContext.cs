using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Tests.Support;

/// <summary>
/// The adapter's whole world, offline.
///
/// Both refusals are deliberate. <see cref="Browser"/> throws on any use, so
/// a mock that declares a browser tier for ROUTING purposes and then quietly
/// started Chromium would fail here rather than in a CI image. And the
/// default <see cref="Http"/> handler throws and counts, so "opened no
/// socket" is asserted rather than assumed.
/// </summary>
internal sealed class FakeJobContext : IJobContext, IDisposable
{
    private static readonly IReadOnlyDictionary<string, string> None =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly List<JobStep> _steps = [];
    private readonly List<Challenge> _asked = [];
    private readonly List<string> _notes = [];
    private readonly Lazy<string> _workDirectory;

    public FakeJobContext(HttpMessageHandler? handler = null)
    {
        Handler = handler ?? new ThrowingHttpHandler();
        Http = new HttpClient(Handler, disposeHandler: false);

        _workDirectory = new Lazy<string>(() =>
        {
            var path = Path.Combine(Path.GetTempPath(), "bank-adapter-tests", Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(path);
            return path;
        });
    }

    public HttpMessageHandler Handler { get; }

    public string SessionId { get; init; } = "ses_0123456789abcdef0123456789abcdef";

    public string JobId { get; init; } = "job_0123456789abcdef0123456789abcdef";

    public IReadOnlyDictionary<string, string> Inputs { get; init; } = None;

    public IReadOnlyDictionary<string, string> Config { get; init; } = None;

    public SessionMaterial? Material { get; init; }

    public HttpClient Http { get; }

    public IBrowserLease Browser { get; init; } = new NoBrowserLease();

    /// <summary>
    /// Whether this job's browser opens onto something an earlier run left.
    ///
    /// TRUE BY DEFAULT HERE, AND ONLY HERE. Every browser test in this suite
    /// drives ASN, whose persistent tier is a kept profile by definition -
    /// <c>browser_persistent</c> plus a BYO agent, so <c>ResolveProfile</c>
    /// always hands it a directory and the real context always answers true.
    /// A fixture defaulting to false would model a run this provider cannot
    /// have, and would make every signed-in test say so explicitly for no
    /// reason. The test that cares about the gate turns it OFF.
    /// </summary>
    public bool KeepsSession { get; init; } = true;

    /// <summary>
    /// How the human answers. Refusing by default, so an adapter that raises
    /// an unexpected challenge fails loudly rather than receiving an empty
    /// string and carrying on.
    /// </summary>
    public Func<Challenge, string> Answer { get; init; } =
        challenge => throw new InvalidOperationException($"unexpected challenge of type {challenge.Type}");

    public IReadOnlyList<JobStep> Steps => _steps;

    public IReadOnlyList<Challenge> Asked => _asked;

    /// <summary>
    /// What the adapter told the operator.
    ///
    /// Kept because several of this connector's decisions are only visible
    /// here: a skipped reservation, a savings list ING refused, a sign-out that
    /// could not be found. All three are cases where the fetch succeeds and the
    /// note is the ONLY difference between "nothing was there" and "we could
    /// not read it", which is precisely the confusion the note exists to end.
    /// </summary>
    public IReadOnlyList<string> Notes => _notes;

    /// <summary>
    /// The latch that decides whether a lost lease requeues a job or fails
    /// it permanently. Three retries locks a real bank account, so this is
    /// asserted directly rather than trusted.
    /// </summary>
    public bool CredentialWasSubmitted { get; private set; }

    public string WorkDirectory => _workDirectory.Value;

    public void Progress(JobStep step) => _steps.Add(step);

    public void Note(string message) => _notes.Add(message);

    public List<ProviderQuota> Quotas { get; } = [];

    public void ReportQuota(ProviderQuota quota) => Quotas.Add(quota);

    /// <summary>
    /// Nobody ever comes back to the browser tab.
    /// </summary>
    /// <remarks>
    /// The realistic case for a passive challenge, and the one worth pinning:
    /// the human approves on their PHONE, the provider's own page advances, and
    /// the card in the consumer is never touched. An adapter that only works
    /// when somebody also presses a button has not solved anything.
    /// </remarks>
    public bool AnswersNever { get; init; }

    /// <summary>
    /// How many raised challenges were abandoned by their asker.
    /// </summary>
    /// <remarks>
    /// Asserted rather than assumed, because the platform releases the job's
    /// budget park on exactly this unwind: an adapter that drops the task
    /// without cancelling stops the run's working clock for the rest of the
    /// login, and nothing else in the suite would notice.
    /// <para>
    /// Interlocked, and paired with <see cref="AbandonedAsync"/>: the count is
    /// incremented on whichever thread resumes the cancelled wait, which is not
    /// the one asserting on it.
    /// </para>
    /// </remarks>
    public int ChallengesAbandoned => Volatile.Read(ref _challengesAbandoned);

    /// <summary>
    /// Waits until an abandonment has actually been RECORDED.
    /// </summary>
    /// <remarks>
    /// <c>CancellationTokenSource.CancelAsync</c> completes when the
    /// cancellation callbacks have run - not when the continuation waiting on
    /// the token has been rescheduled and resumed. So a test that cancels and
    /// immediately reads the counter is racing the thread pool, and loses it
    /// only on a loaded machine: this test passed alone and failed in a full
    /// run, which is the worst way for a race to introduce itself.
    /// </remarks>
    public async Task<bool> AbandonedAsync(int count = 1, int timeoutMs = 10_000)
    {
        for (var i = 0; i < count; i++)
        {
            if (!await _abandoned.WaitAsync(timeoutMs).ConfigureAwait(false)) return false;
        }

        return true;
    }

    private readonly SemaphoreSlim _abandoned = new(0);
    private int _challengesAbandoned;

    public async Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);
        ct.ThrowIfCancellationRequested();

        _asked.Add(challenge);

        if (AnswersNever)
        {
            try
            {
                await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                Interlocked.Increment(ref _challengesAbandoned);
                _abandoned.Release();
                throw;
            }
        }

        return new ChallengeAnswer
        {
            ChallengeId = $"chl_{_asked.Count:D2}",
            Value = Answer(challenge),
        };
    }

    public void CredentialSubmitted() => CredentialWasSubmitted = true;

    public void Dispose()
    {
        Http.Dispose();
        Handler.Dispose();
        _abandoned.Dispose();

        if (_workDirectory.IsValueCreated && Directory.Exists(_workDirectory.Value))
        {
            Directory.Delete(_workDirectory.Value, recursive: true);
        }
    }
}

internal sealed class NoBrowserLease : IBrowserLease
{
    public bool Started => false;

    public Task<IPage> PageAsync(CancellationToken ct) => throw Refused();

    public Task<string> StorageStateAsync(CancellationToken ct) => throw Refused();

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) => throw Refused();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() => new("this test must not start a browser");
}

/// <summary>
/// Counts as well as throws: an adapter that swallowed the exception would
/// still be caught by the count, and "made zero network calls" is the claim.
/// </summary>
internal sealed class ThrowingHttpHandler : HttpMessageHandler
{
    public int Calls { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        Calls++;

        throw new InvalidOperationException(
            $"this adapter must not make network calls, but it requested {request.Method} {request.RequestUri}");
    }
}

/// <summary>
/// A clock pinned to the ledger's anchor, so a window is a fixed range
/// rather than a function of the day the suite happens to run.
/// </summary>
internal sealed class FixedTimeProvider : TimeProvider
{
    private readonly DateTimeOffset _now;

    public FixedTimeProvider(DateTimeOffset now) => _now = now;

    public override DateTimeOffset GetUtcNow() => _now;
}
