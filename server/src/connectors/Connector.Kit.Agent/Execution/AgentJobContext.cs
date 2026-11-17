using System.Net;
using System.Threading.Channels;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Tracing;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Exploring;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Tracing;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Execution;

// one-way by design: nothing an adapter can call reaches the database, the consuming app or the retry policy
public sealed class AgentJobContext : IJobContext, IAsyncDisposable
{
    private readonly LeasedJob _job;
    private readonly ControlPlaneClient _control;
    private readonly BrowserLease _browser;
    private readonly HttpClient _http;
    private readonly ILogger _logger;
    private readonly ScreenshotRedactor _redactor;

    // read once from the manifest so what the stream may see cannot drift from what the job started with
    private readonly IReadOnlyList<string> _loginOrigins;
    private readonly TimeProvider _time;
    private readonly TimeSpan _answerPollInterval;
    private readonly JobBudget? _budget;

    private readonly Channel<ProgressTick> _steps =
        Channel.CreateUnbounded<ProgressTick>(new UnboundedChannelOptions { SingleReader = true });

    private readonly List<JobStep> _reported = [];
    private readonly Task _pump;

    // per job, not per session: a job can raise several live views and the connector refuses frames not numbered higher
    // a per-session counter made the second view's frames vanish at the connector (answered 200)
    private readonly LiveFrameSequence _frames = new();

    // recording state (#441 L3); null unless the job asked for one
    private readonly TraceBook? _book;
    private readonly PageRecorder? _recorder;
    private readonly bool _explore;

    private int _credentialSubmitted;
    private JobStep _lastStep = JobStep.AgentAssigned;

    /// <summary>The last count the adapter reported; -1 until it reported one.</summary>
    private int _found = -1;
    private int _disposed;

    public AgentJobContext(
        JobContextOptions options,
        ControlPlaneClient control,
        PolitenessGate gate,
        ILoggerFactory loggers,
        TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(control);
        ArgumentNullException.ThrowIfNull(gate);
        ArgumentNullException.ThrowIfNull(loggers);

        _job = options.Job;
        _control = control;
        _time = time ?? TimeProvider.System;
        _answerPollInterval = options.AnswerPollInterval;
        _budget = options.Budget;
        _logger = loggers.CreateLogger($"Connector.Kit.Agent.Job.{options.Job.Provider}");

        // read from the browser options this job is handed, not re-derived from configuration, so it cannot drift from the window
        Attended = !options.Browser.Headless;

        // same rule: a profile directory or a storage state means the browser may open already signed in
        // deriving it from "is this BYO" would be wrong on fleet refresh jobs (no profile, full cookie jar)
        KeepsSession = options.Browser.ProfileDirectory is not null
                       || !string.IsNullOrEmpty(options.Browser.StorageState);

        WorkDirectory = Path.Combine(Path.GetFullPath(options.WorkRootDirectory), options.Job.JobId);
        Directory.CreateDirectory(WorkDirectory);

        SecretValues =
        [
            .. options.Manifest.Auth.AllFields()
                .Where(f => f.Secret)
                .Select(f => options.Job.Inputs.TryGetValue(f.Key, out var v) ? v : null)
                .Where(v => !string.IsNullOrEmpty(v))
                .Select(v => v!),
        ];

        _redactor = new ScreenshotRedactor(options.Manifest, _logger);
        _loginOrigins = options.Manifest.Auth.LoginOrigins;
        _explore = string.Equals(options.Manifest.Id, ExploreProvider.Id, StringComparison.Ordinal);

        if (options.Job.Record)
        {
            _book = new TraceBook(options.Job.JobId, options.Job.Provider, SecretValues, _time);
            _recorder = new PageRecorder(_book, (page, ct) => _redactor.DomDigestAsync(page, ct), _logger);
        }

        var recorder = _recorder;
        _browser = new BrowserLease(
            options.Browser with
            {
                DownloadsPath = WorkDirectory,
                OnPage = recorder is null
                    ? options.Browser.OnPage
                    : page =>
                    {
                        recorder.Attach(page);
                        return Task.CompletedTask;
                    },
            },
            _redactor,
            _logger);

        _http = BuildHttpClient(gate, options, _book);

        // the same gate as the HTTP client: a second would be an independent rate limit, doubling the provider's rate
        Pacer = new GatedPacer(gate, options.Job.Provider, PolitenessGap(options.Job));


        _pump = Task.Run(PumpProgressAsync);
    }

    public string SessionId => _job.SessionId;

    public string JobId => _job.JobId;

    public IReadOnlyDictionary<string, string> Inputs => _job.Inputs;

    public IReadOnlyDictionary<string, string> Config => _job.Config;

    public SessionMaterial? Material => _job.Material;

    public HttpClient Http => _http;

    public IBrowserLease Browser => _browser;

    public IProviderPacer Pacer { get; }

    public string WorkDirectory { get; }

    // true only on a HEADED agent, where the owner can reach the browser window; headless is the default
    public bool Attended { get; }

    // gate for SessionProbe: false means the browser starts from nothing, so the question has one answer and its wait is latency
    public bool KeepsSession { get; }

    // the runner reads it to decide whether a failure may be described as safe for the control plane to retry
    public bool HasSubmittedCredential => Volatile.Read(ref _credentialSubmitted) == 1;

    internal IReadOnlyCollection<string> SecretValues { get; }

    internal bool Records => _book is not null;

    // called before the browser goes: the cookie jar lives in it; null when the run was never recorded
    internal async Task<JobTrace?> TraceAsync(CancellationToken ct)
    {
        if (_book is null) return null;

        // answers still being read land first: a book built mid-read holds the requests and none of the responses
        if (_recorder is not null) await _recorder.FlushAsync(ct).ConfigureAwait(false);

        var cookies = _recorder is not null && _browser.Started
            ? await _recorder.CookiesAsync(ct).ConfigureAwait(false)
            : [];

        _book.Note("the run ended");
        return _book.Build(cookies);
    }

    // Information, not Debug: these notes explain outcomes that look like success ("no documents"); kept as well as logged
    // because the agent's log is not where the job's owner looks; scrubbed on the way in so no later path forgets
    // the cap is silent: a "notes dropped" note is itself a note
    public void Note(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;

        var scrubbed = SecretScrubber.Detail(message, SecretValues)!;

        _logger.LogInformation("job {JobId}: {Note}", JobId, scrubbed);

        lock (_notes)
        {
            if (_notes.Count < MaximumNotes) _notes.Add(scrubbed);
        }
    }

    internal IReadOnlyList<string> Notes
    {
        get
        {
            lock (_notes) return [.. _notes];
        }
    }

    private const int MaximumNotes = 40;

    private readonly List<string> _notes = [];

    public void Progress(JobStep step)
    {
        _lastStep = step;
        _steps.Writer.TryWrite(new ProgressTick(step, Counted()));
    }

    public void Found(int records)
    {
        var count = Math.Max(0, records);
        Volatile.Write(ref _found, count);
        _steps.Writer.TryWrite(new ProgressTick(_lastStep, count));
    }

    private int? Counted()
    {
        var found = Volatile.Read(ref _found);
        return found < 0 ? null : found;
    }

    private readonly record struct ProgressTick(JobStep Step, int? Found);

    // pushed upstream at once: a login that submits a password then dies must not look like one that never got that far
    // (the difference between a failed login and a locked account on the retry)
    public void CredentialSubmitted()
    {
        if (Interlocked.Exchange(ref _credentialSubmitted, 1) == 1) return;

        _logger.LogInformation("job {JobId}: a credential has been submitted upstream", JobId);
        _steps.Writer.TryWrite(new ProgressTick(_lastStep, Counted()));
    }

    public async Task<ChallengeAnswer> AskAsync(Challenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);

        var now = _time.GetUtcNow();
        if (challenge.IsExpired(now))
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired,
                $"challenge of type {challenge.Type} expired at {challenge.ExpiresAt:O}, before it was raised");
        }

        var image = await ImageForAsync(challenge, ct).ConfigureAwait(false);
        var raised = await _control.RaiseChallengeAsync(JobId, new RaiseChallengeRequest
        {
            Type = challenge.Type,
            AnswerKind = challenge.AnswerKind,
            PromptKey = challenge.PromptKey,
            ExpiresAt = challenge.ExpiresAt,
            Code = challenge.Code,
            Delivery = challenge.Delivery,
            Length = challenge.Length,
            Options = challenge.Options,
            Url = challenge.Url,
            ReturnPattern = challenge.ReturnPattern,
            ImageBase64 = image is null ? null : Convert.ToBase64String(image),
        }, ct).ConfigureAwait(false);

        Progress(JobStep.AwaitingHuman);

        // geometry is logged: a tap answer is meaningless without its box; wrong-place taps mean one of three rectangles
        // disagrees (photographed, drawn, mapped back), only the first is knowable here; fractions and pixel counts are not secrets
        _logger.LogInformation(
            "job {JobId}: raised challenge {ChallengeId} type={Type} answer_kind={AnswerKind} " +
            "crop={Crop} image={ImageBytes}B expires={ExpiresAt:O}",
            JobId,
            raised.ChallengeId,
            challenge.Type,
            challenge.AnswerKind,
            challenge.Crop is { } box
                ? $"{box.Width}x{box.Height}@{box.X},{box.Y}"
                : "none",
            image?.Length ?? 0,
            challenge.ExpiresAt);

        // the challenge's own expiry bounds the wait, not the job timeout: a stale challenge holds a live browser hostage
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(challenge.ExpiresAt - now);

        // the job's budget stops for the wait: it catches a stuck adapter, not one waiting for the owner
        // with both clocks running the human loses
        using var parked = _budget?.Park();

        // the PLATFORM opens and closes a live view, never the adapter (same provenance rule as ImageForAsync)
        // bound to the challenge's deadline so an expiry stops the shutter by the same clock
        await using var live = challenge.Type is ChallengeType.LiveView
            ? await OpenLiveViewAsync(deadline.Token).ConfigureAwait(false)
            : null;

        try
        {
            while (true)
            {
                try
                {
                    var answer = await _control
                        .PollAnswerAsync(JobId, deadline.Token, raised.ChallengeId).ConfigureAwait(false);

                    if (answer is not null)
                    {
                        // belt and braces over the query parameter: an older control plane answers with the newest
                        // a wrong answer would type an SMS code into a captcha
                        if (!string.Equals(answer.ChallengeId, raised.ChallengeId, StringComparison.Ordinal))
                        {
                            _logger.LogWarning(
                                "job {JobId}: ignoring an answer for challenge {Other}; this asked {Mine}",
                                JobId, answer.ChallengeId, raised.ChallengeId);
                            continue;
                        }

                        LogAnswer(challenge, answer);
                        return answer;
                    }
                }
                catch (ControlPlaneException ex) when (ex.IsTransient)
                {
                    // a human answering takes minutes and a home line drops in that time; dropping the challenge would waste their code
                    _logger.LogDebug(ex, "job {JobId}: answer poll blipped", JobId);
                }

                await Task.Delay(_answerPollInterval, _time, deadline.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ConnectorException(ErrorCode.MfaTimeout,
                $"nobody answered challenge {raised.ChallengeId} before {challenge.ExpiresAt:O}");
        }
    }

    // before the terminal result or failure, so the control plane has the credential latch before it decides what may be retried
    public async Task FlushProgressAsync()
    {
        _steps.Writer.TryComplete();
        try
        {
            await _pump.ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "the progress pump ended badly");
        }
    }

    public async Task<FailureArtifacts?> CaptureArtifactsAsync(CancellationToken ct)
    {
        if (!_browser.Started) return null;

        try
        {
            var screenshot = await _browser.ScreenshotAsync(null, ct).ConfigureAwait(false);
            var digest = await _browser.DomDigestAsync(ct).ConfigureAwait(false);

            if (screenshot.Length == 0 && digest is null) return null;

            return new FailureArtifacts
            {
                ScreenshotBase64 = screenshot.Length > 0 ? Convert.ToBase64String(screenshot) : null,
                DomDigest = digest,
            };
        }
        catch (Exception ex)
        {
            // diagnostics never get to mask the real failure
            _logger.LogDebug(ex, "job {JobId}: failure artifacts could not be captured", JobId);
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;

        await FlushProgressAsync().ConfigureAwait(false);
        if (_recorder is not null) await _recorder.DisposeAsync().ConfigureAwait(false);
        await _browser.DisposeAsync().ConfigureAwait(false);
        _http.Dispose();

        DeleteWorkDirectory();
    }

    // a pooled handler would share cookies between two users' sessions with one provider; reuse is worth far less
    private static HttpClient BuildHttpClient(PolitenessGate gate, JobContextOptions options, TraceBook? book)
    {
        var transport = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.All,
            CookieContainer = new CookieContainer(),
            UseCookies = true,
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 10,
            ConnectTimeout = TimeSpan.FromSeconds(20),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
        };

        var limiter = new PolitenessLimiter(gate, options.Job.Provider, PolitenessGap(options.Job))
        {
            InnerHandler = transport,
        };

        // outermost: sees the call as the adapter made it and the answer as it will read it
        HttpMessageHandler top = book is null ? limiter : new TraceHttpHandler(() => book) { InnerHandler = limiter };

        return new HttpClient(top, disposeHandler: true) { Timeout = options.HttpTimeout };
    }

    // derived once so the HTTP limiter and the adapter-facing pacer cannot drift into two rate limits on one provider
    private static TimeSpan PolitenessGap(LeasedJob job) =>
        TimeSpan.FromMilliseconds(Math.Max(0, job.Limits.PolitenessMs));

    // a tap answer is coordinates on a picture the redactor cleared, so it is logged in full (wrong-square taps need it)
    // every other answer is secret-tainted by default (MFA code, one-time password): length only
    private void LogAnswer(Challenge challenge, ChallengeAnswer answer)
    {
        if (challenge.AnswerKind != ChallengeAnswerKind.Taps)
        {
            _logger.LogInformation(
                "job {JobId}: answered {Type} challenge with {Length} character(s)",
                JobId, challenge.Type, answer.Value?.Length ?? 0);
            return;
        }

        if (!TapAnswer.TryParse(answer.Value, out var taps))
        {
            // a warning: nothing will be clicked and the adapter will report an unanswered challenge; the consumer ignores answer_kind
            _logger.LogWarning(
                "job {JobId}: a taps challenge came back as something else ({Length} character(s)); " +
                "nothing will be clicked. The consumer is ignoring answer_kind.",
                JobId, answer.Value?.Length ?? 0);
            return;
        }

        // the adapter maps again against a FRESHLY measured box; the difference from these pixels is the re-layout to survive
        var mapped = challenge.Crop is { } box
            ? string.Join(" ", taps.Taps.Select(t =>
            {
                var (x, y) = t.ToPagePixels(box);
                return $"({t.X:0.####},{t.Y:0.####})->{x:0}x{y:0}";
            }))
            : string.Join(" ", taps.Taps.Select(t => $"({t.X:0.####},{t.Y:0.####})"));

        _logger.LogInformation(
            "job {JobId}: answered with {Count} tap(s), submit={Submit}, against crop {Crop}: {Mapped}",
            JobId,
            taps.Taps.Count,
            taps.Submit,
            challenge.Crop is { } c ? $"{c.Width}x{c.Height}@{c.X},{c.Y}" : "none",
            mapped.Length == 0 ? "(none)" : mapped);
    }

    // every failure yields a live view that does not open, never a failed job: the challenge underneath is passive
    // (like AppApproval) and the adapter's own success watch still ends the wait
    private async Task<LiveViewSession?> OpenLiveViewAsync(CancellationToken ct)
    {
        if (!_browser.Started)
        {
            // deliberately not launching one: it would open on about:blank, outside any origin the stream may photograph
            _logger.LogWarning(
                "job {JobId}: a live view was raised with no browser running, so there is nothing to photograph",
                JobId);
            return null;
        }

        try
        {
            var page = await _browser.PageAsync(ct).ConfigureAwait(false);
            // the manifest half of the origin latch (Auth.LoginOrigins): without it a streamed login stopped at the identity provider
            // (DUO sends the human to login.digid.nl); a provider that declares nothing keeps the stricter behaviour
            var session = new LiveViewSession(
                page, _control, JobId, _frames,
                // an explore run (#441 L3) is the operator's own browser: any origin and navigation, decided from the provider
                // never from relayed input
                new LiveViewOptions { Origins = _loginOrigins, AnyOrigin = _explore, Navigation = _explore },
                _logger,
                _time);

            session.Start(ct);
            return session;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "job {JobId}: the live view could not be opened", JobId);
            return null;
        }
    }

    // adapter-supplied bytes are re-verified against the live page: the adapter holds a real IPage
    private async Task<byte[]?> ImageForAsync(Challenge challenge, CancellationToken ct)
    {
        // a live view carries no still, whoever offered one: the raise image is stored on the challenge row for the job's length,
        // and "a live view frame is never stored" is what makes the custody claim true
        if (challenge.Type is ChallengeType.LiveView) return null;

        if (challenge.Image is { Length: > 0 } supplied)
        {
            if (!_browser.Started) return supplied;

            var page = await _browser.PageAsync(ct).ConfigureAwait(false);
            if (await _redactor.IsSafeToCaptureAsync(page, ct).ConfigureAwait(false)) return supplied;

            _logger.LogWarning(
                "job {JobId}: dropping the adapter's challenge image; the page is not verifiably safe to capture",
                JobId);
            return null;
        }

        var wantsImage = challenge.Crop is not null
                         || challenge.Type is ChallengeType.Image or ChallengeType.QrDisplay;

        if (!wantsImage || !_browser.Started) return null;

        var captured = await _browser.ScreenshotAsync(challenge.Crop, ct).ConfigureAwait(false);
        return captured.Length > 0 ? captured : null;
    }

    private async Task PumpProgressAsync()
    {
        await foreach (var tick in _steps.Reader.ReadAllAsync(CancellationToken.None).ConfigureAwait(false))
        {
            var report = new ProgressReport
            {
                Step = tick.Step,
                StepsDone = [.. _reported],
                CredentialSubmitted = Volatile.Read(ref _credentialSubmitted) == 1,
                Found = tick.Found,
            };

            if (!_reported.Contains(tick.Step)) _reported.Add(tick.Step);

            await PostProgressAsync(report).ConfigureAwait(false);
        }
    }

    private async Task PostProgressAsync(ProgressReport report)
    {
        // retried: the only carrier of the credential latch; a dropped post decides between refusing a retry and re-running a login
        const int Attempts = 3;

        for (var attempt = 1; attempt <= Attempts; attempt++)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await _control.ProgressAsync(JobId, report, timeout.Token).ConfigureAwait(false);
                return;
            }
            catch (Exception ex) when (ex is ControlPlaneException or OperationCanceledException)
            {
                if (attempt == Attempts || (ex as ControlPlaneException)?.IsTransient == false)
                {
                    _logger.LogWarning(ex, "job {JobId}: progress step {Step} did not land", JobId, report.Step);
                    return;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt), _time).ConfigureAwait(false);
            }
        }
    }

    // deleted on every path, failure included: a downloaded bank statement left on an agent's disk is the residue to avoid
    private void DeleteWorkDirectory()
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (Directory.Exists(WorkDirectory)) Directory.Delete(WorkDirectory, recursive: true);
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Chromium can still hold a handle for a moment after teardown.
                if (attempt == 2)
                {
                    _logger.LogError(ex, "job {JobId}: work directory {Directory} could not be deleted", JobId, WorkDirectory);
                    return;
                }

                Thread.Sleep(200);
            }
        }
    }
}

public sealed record JobContextOptions
{
    public required LeasedJob Job { get; init; }

    public required ProviderManifest Manifest { get; init; }

    public required string WorkRootDirectory { get; init; }

    public BrowserLeaseOptions Browser { get; init; } = new();

    public TimeSpan AnswerPollInterval { get; init; } = TimeSpan.FromSeconds(2);

    public TimeSpan HttpTimeout { get; init; } = TimeSpan.FromSeconds(60);

    // suspended while the context is parked in AskAsync; null only outside the job runner
    internal JobBudget? Budget { get; init; }
}
