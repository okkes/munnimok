using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using Microsoft.Playwright;

namespace ShopConnector.Adapters.Tests.Support;

/// Browser and (by default) Http refuse on use: a T1 adapter starting Chromium or making a network call fails the test
internal sealed class FakeJobContext : IJobContext, IDisposable
{
    private static readonly IReadOnlyDictionary<string, string> None =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly List<JobStep> _steps = [];
    private readonly List<int> _counted = [];
    private readonly List<Challenge> _asked = [];
    private readonly List<CancellationToken> _askTokens = [];
    private readonly List<string> _notes = [];
    private readonly Lazy<string> _workDirectory;

    public FakeJobContext(HttpMessageHandler? handler = null)
    {
        Handler = handler ?? new ThrowingHttpHandler();
        Http = new HttpClient(Handler, disposeHandler: false);

        _workDirectory = new Lazy<string>(() =>
        {
            var path = Path.Combine(Path.GetTempPath(), "shop-adapter-tests", Guid.NewGuid().ToString("n"));
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

    public IProviderPacer Pacer { get; init; } = UnpacedProvider.Instance;

    public bool Attended { get; init; }

    /// false by default like the contract's: a test about a browser that could already be signed in has to say so
    public bool KeepsSession { get; init; }

    /// defaults to refusing: an unexpected challenge fails loudly instead of receiving an empty string
    public Func<Challenge, string> Answer { get; init; } =
        challenge => throw new InvalidOperationException($"unexpected challenge of type {challenge.Type}");

    /// challenge recorded, never answered: a passive challenge, the human acts in the browser window;
    /// the adapter must finish without them
    public bool AnswersNothing { get; init; }

    public IReadOnlyList<JobStep> Steps => _steps;

    public IReadOnlyList<Challenge> Asked => _asked;

    /// a cancelled token proves a passive ask was ended: an abandoned one leaves browser, shutter and agent
    /// occupied after login succeeded
    public IReadOnlyList<CancellationToken> AskTokens => _askTokens;

    /// decides whether a lost lease requeues or fails the job: a login that may already have counted is never retried
    public bool CredentialWasSubmitted { get; private set; }

    public string WorkDirectory => _workDirectory.Value;

    /// IJobContext.Note defaults to nothing; notes report partial results (unpriced orders, failed invoices,
    /// truncation), so the suite must see them
    public IReadOnlyList<string> Notes => _notes;

    public void Progress(JobStep step) => _steps.Add(step);

    public IReadOnlyList<int> Counted => _counted;

    public void Found(int records) => _counted.Add(records);

    public void Note(string message) => _notes.Add(message);

    public Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);
        ct.ThrowIfCancellationRequested();

        _asked.Add(challenge);
        _askTokens.Add(ct);

        if (AnswersNothing)
        {
            // Still cancellable: an adapter that regressed into awaiting an
            // answer nobody sends fails its test rather than hanging the
            // suite on it.
            var pending = new TaskCompletionSource<ChallengeAnswer>(TaskCreationOptions.RunContinuationsAsynchronously);
            ct.Register(() => pending.TrySetCanceled(ct));
            return pending.Task;
        }

        return Task.FromResult(new ChallengeAnswer
        {
            ChallengeId = $"chl_{_asked.Count:D2}",
            Value = Answer(challenge),
        });
    }

    public void CredentialSubmitted() => CredentialWasSubmitted = true;

    public void Dispose()
    {
        Http.Dispose();
        Handler.Dispose();

        if (_workDirectory.IsValueCreated && Directory.Exists(_workDirectory.Value))
        {
            Directory.Delete(_workDirectory.Value, recursive: true);
        }
    }
}

/// a T1 adapter never touches a browser and T2/T3 fixture tests drive the parse layer, so any call here is a mistake
internal sealed class NoBrowserLease : IBrowserLease
{
    public bool Started => false;

    public Task<IPage> PageAsync(CancellationToken ct) => throw Refused();

    public Task<string> StorageStateAsync(CancellationToken ct) => throw Refused();

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) => throw Refused();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() =>
        new("this test must not start a browser");
}

/// records the SHAPE of pacing, not durations: the gap is proved in PolitenessGate;
/// adapters must ask around every call and release before the next
internal sealed class RecordingPacer : IProviderPacer
{
    private readonly List<string> _trace = [];

    /// the ORDER is the assertion: a ticket held across the whole walk paces nothing yet satisfies any entry count
    public List<string> Trace => _trace;

    public int Entered => _trace.Count(entry => entry == "enter");

    public List<TimeSpan> Backoffs { get; } = [];

    public Task<IDisposable> EnterAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _trace.Add("enter");

        return Task.FromResult<IDisposable>(new Release(_trace));
    }

    public void Backoff(TimeSpan delay)
    {
        _trace.Add("backoff");
        Backoffs.Add(delay);
    }

    private sealed class Release : IDisposable
    {
        private readonly List<string> _trace;
        private int _disposed;

        public Release(List<string> trace) => _trace = trace;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
            _trace.Add("release");
        }
    }
}

/// only GetUtcNow is overridden: CreateTimer stays on the system timer,
/// so a test needing a delay to elapse drives it to zero
internal sealed class FixedTimeProvider : TimeProvider
{
    private readonly DateTimeOffset _now;

    public FixedTimeProvider(DateTimeOffset now) => _now = now;

    public override DateTimeOffset GetUtcNow() => _now;
}
