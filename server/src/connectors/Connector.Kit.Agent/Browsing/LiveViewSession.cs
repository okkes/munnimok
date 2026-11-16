#pragma warning disable S107 // the session is composed from its collaborators; the count is the number of them
using System.Security.Cryptography;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

internal sealed record LiveViewOptions
{
    // a CEILING of 12.5 fps: the next frame leaves when the last has and is the newest drawn, so a slow uplink gives
    // fewer pictures, not a queue answered against a box that has moved
    public TimeSpan BurstInterval { get; init; } = TimeSpan.FromMilliseconds(80);

    // roughly the gap between words: shorter and the stream drops to idle mid-password and typing shows late
    public TimeSpan BurstWindow { get; init; } = TimeSpan.FromMilliseconds(1200);

    // bites only on a self-animating page (spinner, carousel): sent twice a second instead of the sixty it draws
    public TimeSpan IdleInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    // a static form sends nothing, indistinguishable from a dead stream, and the control plane forgets a login
    // after two minutes unwritten; one fresh picture every 5 s answers both
    public TimeSpan MaxSilence { get; init; } = TimeSpan.FromSeconds(5);

    // motion hides what the lower quality costs, and these frames come many to the second
    public int MovingQuality { get; init; } = 45;

    // 80 because of QR codes (DigiD's app flow), swept over 135 combinations: failures 1.5% at 60, none at 70 and 80
    // a QR breaks on the JPEG block grid landing badly against module edges, not on a pixel shortage
    // QrDisplay relays a lossless PNG and does not depend on this
    public int SettledQuality { get; init; } = 80;

    // delay after the last pointer move before the sharp tier (and one fresh sharp frame) returns
    public TimeSpan SettleDelay { get; init; } = TimeSpan.FromMilliseconds(300);

    // not one: a home line drops a request; not unbounded: a control plane without these routes answers every frame alike
    public int MaxConsecutiveFailures { get; init; } = 5;

    public TimeSpan MeterInterval { get; init; } = TimeSpan.FromSeconds(1);

    // empty means the host the page is on when the stream opens, the strictest rule without a manifest
    public IReadOnlyList<string> Origins { get; init; } = [];

    /// <summary>Backstop between input polls when the control plane is unwell.</summary>
    public TimeSpan InputRetryDelay { get; init; } = TimeSpan.FromSeconds(1);

    // the route is a long poll, but a control plane answering 204 at once would turn this loop into a spin, a core at 100%
    public TimeSpan EmptyPollFloor { get; init; } = TimeSpan.FromMilliseconds(250);

    // any http(s) origin: the explore run's (#441 L3), where the operator drives their own browser
    // every other view keeps the origin latch
    public bool AnyOrigin { get; init; }

    /// <summary>Replay the navigation vocabulary (open an address, back, reload). Explore runs only.</summary>
    public bool Navigation { get; init; }
}

// whole page, unmasked, by custody decision: the human types into the provider's own page; frames are never stored
// two loops: the input long poll would stall pictures; Stop is terminal and a failed loop stops all, as a dead leg lies
// origin latch pins to the host at open (no manifest allowlist yet: no IdP crossing); only a frame's 32-byte hash is kept
internal sealed class LiveViewSession : IAsyncDisposable
{
    private readonly IPage _page;
    private readonly ControlPlaneClient _control;
    private readonly ILiveSurface _surface;
    private readonly string _jobId;
    private readonly LiveFrameSequence _sequence;
    private readonly LiveViewOptions _options;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly LiveViewMeter _meter;
    private readonly HashSet<string> _origins;

    // bounded at one so a burst cannot bank wake-ups that fire after the page went still
    private readonly SemaphoreSlim _nudge = new(0, 1);

    private CancellationTokenSource? _cts;
    private Task? _capture;
    private Task? _input;
    private int _stopped;

    // width and height packed in one long so they never come from two frames;
    // zero until the first post, so input before any picture is refused
    private long _frameSize;

    private long _burstUntilTicks;

    /// <summary>Until when the pointer counts as moving, which is what the softer encoding follows.</summary>
    private long _movingUntilTicks;

    // the JOB's counter: a second live view in one job must continue the count (see LiveFrameSequence)
    public LiveViewSession(
        IPage page,
        ControlPlaneClient control,
        string jobId,
        LiveFrameSequence sequence,
        LiveViewOptions options,
        ILogger logger,
        TimeProvider time,
        ILiveSurface? surface = null)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(control);
        ArgumentNullException.ThrowIfNull(sequence);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentException.ThrowIfNullOrWhiteSpace(jobId);

        _page = page;
        _control = control;
        _jobId = jobId;
        _sequence = sequence;
        _options = options;
        _logger = logger;
        _time = time;
        _surface = surface ?? new PlaywrightLiveSurface(page.Mouse, page.Keyboard, page);
        _meter = new LiveViewMeter(time, options.MeterInterval);

        _origins = BuildOrigins(options.Origins, page, logger);
    }

    public bool Stopped => Volatile.Read(ref _stopped) == 1;

    // written by the picture loop, read once the loops have finished
    public long FramesPosted { get; private set; }

    public void Start(CancellationToken ct)
    {
        if (_cts is not null) throw new InvalidOperationException("this live view has already been started");

        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // the resume sequence is logged: the connector discards a non-advancing frame with a 200,
        // so a second view starting at 0 stalled silently
        _logger.LogInformation(
            "job {JobId}: live view open on {Origins} at up to {Fps:0.#} fps, frames continue from {Sequence}",
            _jobId, Describe(_origins), Fps(), _sequence.Last);

        // wired before the first picture, so a page that leaves while the browser launches is caught
        _page.FrameNavigated += OnFrameNavigated;

        _capture = Task.Run(() => CaptureLoopAsync(_cts.Token), CancellationToken.None);
        _input = Task.Run(() => InputLoopAsync(_cts.Token), CancellationToken.None);
    }

    public void Stop(string reason)
    {
        if (Interlocked.Exchange(ref _stopped, 1) == 1) return;

        _logger.LogInformation("job {JobId}: live view stopped - {Reason}", _jobId, reason);

        try
        {
            _cts?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Disposal got there first, which is one of the ways a stream ends.
        }
    }

    public async ValueTask DisposeAsync()
    {
        Stop("the challenge is over");

        _page.FrameNavigated -= OnFrameNavigated;

        // teardown never throws over a job's outcome: a stream that ended badly must not fail a completed login
        foreach (var loop in new[] { _capture, _input })
        {
            if (loop is null) continue;

            try
            {
                await loop.ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "job {JobId}: a live view loop ended badly", _jobId);
            }
        }

        if (FramesPosted > 0)
        {
            if (_meter.Close() is { HasSamples: true } trailing) _logger.Report(_jobId, trailing);

            _logger.LogInformation("job {JobId}: live view sent {Total}", _jobId, _meter.Total());
        }

        _cts?.Dispose();
        _nudge.Dispose();
    }

    private sealed class Shutter
    {
        public byte[] LastHash { get; set; } = [];

        public DateTimeOffset LastPostedAt { get; set; }

        /// <summary>When a fresh picture of an unchanged page was last asked for, so the heartbeat asks once.</summary>
        public DateTimeOffset RefreshedAt { get; set; }

        public int Failures { get; set; }
    }

    private enum Posting
    {
        Idle,

        Accepted,

        Blipped,

        Ended,
    }

    private async Task CaptureLoopAsync(CancellationToken ct)
    {
        var now = _time.GetUtcNow();
        var shutter = new Shutter { LastPostedAt = now, RefreshedAt = now };

        // disposed with this loop: the browser stops encoding when the stream stops, not when the job does
        await using var camera = new LiveScreencast(
            _page,
            _options,
            IsAllowed,
            _ => Stop("the page navigated off the origin the stream opened on"),
            Wake,
            _logger,
            _time);

        try
        {
            if (!IsAllowed(_page.Url))
            {
                Stop("the page is not on an origin this stream may photograph");
                return;
            }

            await camera.StartAsync(TierAt(_time.GetUtcNow()), ct).ConfigureAwait(false);

            while (!ct.IsCancellationRequested && !Stopped)
            {
                if (camera.Closed)
                {
                    // warning, not debug: the viewer faces a picture that stopped updating and this line says why
                    _logger.LogWarning("job {JobId}: the page closed under its live view", _jobId);
                    Stop("the page closed");
                    return;
                }

                var tier = TierAt(_time.GetUtcNow());
                if (tier != camera.Tier) await camera.SetTierAsync(tier).ConfigureAwait(false);

                if (await TakeAndPostAsync(camera, shutter, ct).ConfigureAwait(false) == Posting.Ended) return;

                CountSkipped(camera);
                ReportIfDue();
                await WaitAsync(camera, shutter, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // OUR token: not an error; the filter keeps HttpClient.Timeout (a TaskCanceledException
            // from a POST nobody stopped) out of this arm
        }
        catch (Exception ex)
        {
            // anything else ends the stream loudly: pictures dying while input lives sends keystrokes to a frozen picture
            _logger.LogError(ex, "job {JobId}: the live view's camera failed", _jobId);
            Stop("the camera failed");
        }
    }

    private async Task<Posting> TakeAndPostAsync(LiveScreencast camera, Shutter shutter, CancellationToken ct)
    {
        var now = _time.GetUtcNow();

        if (!camera.TryTake(out var frame))
        {
            // heartbeat so silence never reads as a dead stream: asked for once a silence, posted when it arrives
            if (now - shutter.LastPostedAt >= _options.MaxSilence && now - shutter.RefreshedAt >= _options.MaxSilence)
            {
                shutter.RefreshedAt = now;
                await camera.RefreshAsync().ConfigureAwait(false);
            }

            return Posting.Idle;
        }

        // checked per frame, not only by events (a notification can be missed); read once so the origin reported is the one checked
        var url = _page.Url;
        if (!IsAllowed(url))
        {
            Stop("the page navigated off the origin the stream opened on");
            return Posting.Ended;
        }

        var age = now - frame.CapturedAt;
        if (IsQuiet(frame.Jpeg, shutter, out var hash))
        {
            _meter.Suppressed(age);
            return Posting.Idle;
        }

        return await PostAsync(frame, url, hash, age, shutter, ct).ConfigureAwait(false);
    }

    private void CountSkipped(LiveScreencast camera)
    {
        var (superseded, withheld) = camera.TakeCounts();
        _meter.Superseded(superseded);
        _meter.Missed(withheld);
    }

    private LiveTier TierAt(DateTimeOffset now) =>
        now.UtcTicks < Volatile.Read(ref _movingUntilTicks) ? LiveTier.Moving : LiveTier.Settled;

    // hashes the ENCODED bytes (identical for the same page at the same quality): 32 bytes, not a login page's picture
    private bool IsQuiet(byte[] jpeg, Shutter shutter, out byte[] hash)
    {
        hash = SHA256.HashData(jpeg);
        var unchanged = shutter.LastHash.Length > 0 && hash.AsSpan().SequenceEqual(shutter.LastHash);

        return unchanged && _time.GetUtcNow() - shutter.LastPostedAt < _options.MaxSilence;
    }

    private async Task<Posting> PostAsync(
        CastFrame capture, string url, byte[] hash, TimeSpan age, Shutter shutter, CancellationToken ct)
    {
        // the JOB's counter, taken after suppression so a static form burns no numbers, kept even if the POST fails:
        // a retried frame is a different picture and a reused number is refused
        var sequence = _sequence.Next();
        var frame = new LiveFrame
        {
            Sequence = sequence,
            Width = capture.Width,
            Height = capture.Height,
            Bytes = capture.Jpeg,
            // whose page this is, from the checked URL: the human sees no address bar, so a provider name proves nothing
            Origin = LiveOrigin.Normalize(url),
        };

        var postAt = _time.GetTimestamp();
        bool accepted;
        try
        {
            accepted = await _control.PostLiveFrameAsync(_jobId, frame, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (IsTransportBlip(ex, ct))
        {
            _meter.Failed(age);

            if (++shutter.Failures >= _options.MaxConsecutiveFailures)
            {
                _logger.LogWarning(
                    ex, "job {JobId}: {Count} live frames in a row did not land", _jobId, shutter.Failures);
                Stop("frames stopped reaching the control plane");
                return Posting.Ended;
            }

            _logger.LogDebug(ex, "job {JobId}: live frame {Sequence} did not land", _jobId, sequence);
            return Posting.Blipped;
        }

        var post = _time.GetElapsedTime(postAt);

        if (!accepted)
        {
            Stop("the control plane no longer has a live channel for this job");
            return Posting.Ended;
        }

        shutter.Failures = 0;
        shutter.LastHash = hash;
        shutter.LastPostedAt = _time.GetUtcNow();

        // published only after the bytes are accepted, so input before any picture is refused, not mapped to an unseen frame
        Volatile.Write(ref _frameSize, ((long)capture.Width << 32) | (uint)capture.Height);
        FramesPosted++;

        _meter.Posted(age, post, frame.Bytes.Length);
        return Posting.Accepted;
    }

    private sealed class Inbox
    {
        public long Cursor { get; set; }

        public int Failures { get; set; }
    }

    private async Task InputLoopAsync(CancellationToken ct)
    {
        var inbox = new Inbox();

        try
        {
            while (!ct.IsCancellationRequested && !Stopped)
            {
                var polledAt = _time.GetTimestamp();

                var (batch, ended) = await PollAsync(inbox, ct).ConfigureAwait(false);
                if (ended) return;

                // 204: the window closed untouched, normal for a login form; never faster than the floor, or it becomes a spin
                if (batch is null || batch.Events.Count == 0)
                {
                    await HoldToTheFloorAsync(polledAt, ct).ConfigureAwait(false);
                    continue;
                }

                if (!Accepts(batch, inbox)) continue;

                var size = Volatile.Read(ref _frameSize);
                var frame = ((int)(size >> 32), (int)(size & 0xFFFFFFFF));

                var dispatched = await LiveInputReplay
                    .ReplayAsync(batch.Events, frame, _surface, _logger, ct, _options.Navigation).ConfigureAwait(false);

                if (dispatched > 0) Nudge(batch.Events.Any(e => e.Kind is LiveInputKind.Move or LiveInputKind.Scroll));
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // our token, as above; a poll the HTTP client gave up on is a blip, retried above
        }
        catch (Exception ex)
        {
            // stopping is the honest end: taps would stop landing unseen, and the passive challenge below degrades to the plain wait
            _logger.LogError(ex, "job {JobId}: the live view's input channel failed", _jobId);
            Stop("the input channel failed");
        }
    }

    private async Task<(LiveInputBatch? Batch, bool Ended)> PollAsync(Inbox inbox, CancellationToken ct)
    {
        try
        {
            var batch = await _control.PollLiveInputAsync(_jobId, inbox.Cursor, ct).ConfigureAwait(false);
            inbox.Failures = 0;
            return (batch, false);
        }
        catch (Exception ex) when (IsTransportBlip(ex, ct))
        {
            if (++inbox.Failures >= _options.MaxConsecutiveFailures)
            {
                _logger.LogWarning(
                    ex, "job {JobId}: {Count} live input polls in a row failed", _jobId, inbox.Failures);
                Stop("the input channel stopped answering");
                return (null, true);
            }

            _logger.LogDebug(ex, "job {JobId}: a live input poll blipped", _jobId);
            await Task.Delay(_options.InputRetryDelay, _time, ct).ConfigureAwait(false);
            return (null, false);
        }
    }

    private async Task HoldToTheFloorAsync(long polledAt, CancellationToken ct)
    {
        var spent = _time.GetElapsedTime(polledAt);
        if (spent < _options.EmptyPollFloor)
        {
            await Task.Delay(_options.EmptyPollFloor - spent, _time, ct).ConfigureAwait(false);
        }
    }

    // the cursor moves on EVERY batch, delivered or not: a refused batch left in place is handed over again forever
    private bool Accepts(LiveInputBatch batch, Inbox inbox)
    {
        var newest = batch.Events.Max(e => e.Sequence);
        var stale = newest <= inbox.Cursor;
        inbox.Cursor = Math.Max(inbox.Cursor, newest);

        if (stale)
        {
            // loud: otherwise the human taps, nothing happens, and no line says why
            _logger.LogWarning(
                "job {JobId}: dropping {Count} live input event(s) with nothing newer than {Cursor}; " +
                "a re-delivered Enter is a second credential submission",
                _jobId, batch.Events.Count, inbox.Cursor);
            return false;
        }

        if (!batch.IsWellFormed())
        {
            _logger.LogWarning(
                "job {JobId}: refusing a live input batch of {Count} event(s); it is not well formed",
                _jobId, batch.Events.Count);
            return false;
        }

        return true;
    }

    // HttpClient.Timeout surfaces as a TaskCanceledException, an OperationCanceledException: a stalled POST or poll
    // looked like "challenge over" and ended the leg silently; only our token means stop, the rest is a counted, retried blip
    private static bool IsTransportBlip(Exception ex, CancellationToken ct) =>
        ex is ControlPlaneException || (ex is OperationCanceledException && !ct.IsCancellationRequested);

    private void Nudge(bool moved)
    {
        var now = _time.GetUtcNow();
        Volatile.Write(ref _burstUntilTicks, (now + _options.BurstWindow).UtcTicks);
        if (moved) Volatile.Write(ref _movingUntilTicks, (now + _options.SettleDelay).UtcTicks);

        Wake();
    }

    private void Wake()
    {
        try
        {
            _nudge.Release();
        }
        catch (SemaphoreFullException)
        {
            // The loop is already owed a wake-up. Banking a second one would
            // fire it after the page went still.
        }
        catch (ObjectDisposedException)
        {
            // The session is gone, and so is anyone to wake.
        }
    }

    // waits on the semaphore, not a timer, so the burst begins on the keystroke;
    // wall clock, deliberately: this is the cadence being measured
    private async Task WaitAsync(LiveScreencast camera, Shutter shutter, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !Stopped && !camera.Closed)
        {
            var now = _time.GetUtcNow();
            var paceUntil = shutter.LastPostedAt + GapAt(now);
            var settleAt = SettleAt(now);

            if (TierAt(now) != camera.Tier) return;

            if (now < paceUntil)
            {
                await _nudge.WaitAsync(Shortest(paceUntil - now, settleAt - now), ct).ConfigureAwait(false);
                continue;
            }

            var heartbeatAt = HeartbeatAt(shutter);
            if (camera.HasFrame || now >= heartbeatAt) return;

            await _nudge.WaitAsync(Shortest(heartbeatAt - now, settleAt - now), ct).ConfigureAwait(false);
            return;
        }
    }

    private TimeSpan GapAt(DateTimeOffset now) =>
        now.UtcTicks < Volatile.Read(ref _burstUntilTicks) ? _options.BurstInterval : _options.IdleInterval;

    private DateTimeOffset SettleAt(DateTimeOffset now)
    {
        var movingUntil = new DateTimeOffset(Volatile.Read(ref _movingUntilTicks), TimeSpan.Zero);
        return movingUntil > now ? movingUntil : DateTimeOffset.MaxValue;
    }

    private DateTimeOffset HeartbeatAt(Shutter shutter) =>
        (shutter.LastPostedAt > shutter.RefreshedAt ? shutter.LastPostedAt : shutter.RefreshedAt) + _options.MaxSilence;

    /// <summary>The nearer of two deadlines, never negative, and never past the heartbeat - a wait has to come back to look.</summary>
    private TimeSpan Shortest(TimeSpan a, TimeSpan b)
    {
        var shortest = a < b ? a : b;
        if (shortest <= TimeSpan.Zero) return TimeSpan.Zero;
        return shortest < _options.MaxSilence ? shortest : _options.MaxSilence;
    }

    private void ReportIfDue()
    {
        if (_meter.TryClose() is { HasSamples: true } window) _logger.Report(_jobId, window);
    }

    private void OnFrameNavigated(object? sender, IFrame frame)
    {
        // main frame only: a login page's third-party frames (captcha widgets) navigate constantly and would latch within a second
        if (frame != _page.MainFrame) return;

        if (!IsAllowed(frame.Url)) Stop("the page navigated off the origin the stream opened on");
    }

    // exact host, never a suffix: a suffix rule accepts login.ah.nl.example.com,
    // and subdomains keep streaming after login moved to account pages
    private bool IsAllowed(string? url)
    {
        // the operator's own browser (#441 L3): every page is theirs to see, even blank or error,
        // so a failed start address still leaves a picture to type the next over
        if (_options.AnyOrigin) return true;

        if (_origins.Count == 0) return false;

        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return false;

        return _origins.Contains(parsed.Host);
    }

    // a wildcard is refused as an empty set, which stops the stream before its first frame:
    // following a login past its success is a remote view of an authenticated account
    private static HashSet<string> BuildOrigins(IReadOnlyList<string> declared, IPage page, ILogger logger)
    {
        var origins = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var origin in declared)
        {
            if (string.IsNullOrWhiteSpace(origin)) continue;

            if (origin.Contains('*', StringComparison.Ordinal))
            {
                logger.LogWarning(
                    "live view: refusing the wildcard origin '{Origin}'; a stream that follows a login " +
                    "wherever it goes is a remote view of an authenticated account",
                    origin);
                return [];
            }

            origins.Add(origin);
        }

        if (origins.Count > 0) return origins;

        if (Uri.TryCreate(page.Url, UriKind.Absolute, out var current) && !string.IsNullOrEmpty(current.Host))
        {
            origins.Add(current.Host);
            return origins;
        }

        logger.LogWarning(
            "live view: no origin was declared and the page is not on one, so nothing will be streamed");
        return [];
    }

    private double Fps() => 1000d / Math.Max(1, _options.BurstInterval.TotalMilliseconds);

    private static string Describe(HashSet<string> origins) =>
        origins.Count == 0 ? "(nothing)" : string.Join(", ", origins);
}
