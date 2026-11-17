using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Tests.Support;

// Browser and the default Http handler throw on any use (Http also counts): a mock declaring a browser tier for routing
// must fail here, and "opened no socket" is asserted rather than assumed
internal sealed class FakeJobContext : IJobContext, IDisposable
{
    private static readonly IReadOnlyDictionary<string, string> None =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly List<JobStep> _steps = [];
    private readonly List<int> _counted = [];
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

    // true by default only here: every browser test drives ASN, whose persistent tier is a kept profile (browser_persistent
    // plus a BYO agent), so ResolveProfile always hands it a directory; the test of the gate turns it off
    public bool KeepsSession { get; init; } = true;

    // refuses by default, so an unexpected challenge fails loudly instead of getting an empty answer
    public Func<Challenge, string> Answer { get; init; } =
        challenge => throw new InvalidOperationException($"unexpected challenge of type {challenge.Type}");

    public IReadOnlyList<JobStep> Steps => _steps;

    public IReadOnlyList<Challenge> Asked => _asked;

    // several decisions show only here (skipped reservation, refused savings list, missing sign-out): the note is the only
    // difference between "nothing was there" and "we could not read it"
    public IReadOnlyList<string> Notes => _notes;

    // the latch deciding whether a lost lease requeues a job or fails it permanently; three retries locks a real bank account
    public bool CredentialWasSubmitted { get; private set; }

    public string WorkDirectory => _workDirectory.Value;

    public void Progress(JobStep step) => _steps.Add(step);

    public IReadOnlyList<int> Counted => _counted;

    public void Found(int records) => _counted.Add(records);

    public void Note(string message) => _notes.Add(message);

    public List<ProviderQuota> Quotas { get; } = [];

    public void ReportQuota(ProviderQuota quota) => Quotas.Add(quota);

    // nobody returns to the browser tab: a passive challenge is approved on the phone and the provider's page advances itself
    public bool AnswersNever { get; init; }

    // the platform releases the job's budget park on this unwind: an adapter that drops the task without cancelling stops
    // the run's clock; Interlocked because the resuming thread is not the asserting one
    public int ChallengesAbandoned => Volatile.Read(ref _challengesAbandoned);

    // CancelAsync completes when the callbacks ran, not when the waiting continuation resumed: reading the counter right after
    // races the thread pool and loses only on a loaded machine
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

// counts as well as throws: an adapter that swallowed the exception is still caught, and "zero network calls" is the claim
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

// pinned to the ledger's anchor so a window is a fixed range, not a function of the day the suite runs
internal sealed class FixedTimeProvider : TimeProvider
{
    private readonly DateTimeOffset _now;

    public FixedTimeProvider(DateTimeOffset now) => _now = now;

    public override DateTimeOffset GetUtcNow() => _now;
}
