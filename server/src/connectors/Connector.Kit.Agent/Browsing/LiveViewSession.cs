#pragma warning disable S107 // the session is composed from its collaborators; the count is the number of them
using System.Security.Cryptography;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

/// <summary>
/// How often frames leave, at what quality, and when the stream stops.
///
/// The cadence numbers are the argument, so they are here with their reasons
/// rather than scattered through the loop. The browser's screencast decides
/// WHEN there is a new picture (only when it drew something); these decide
/// how many of them are worth sending.
/// </summary>
internal sealed record LiveViewOptions
{
    /// <summary>
    /// The shortest gap between two posted frames while the human is touching
    /// the page.
    ///
    /// 80 ms is a CEILING of 12.5 frames a second and will often be missed
    /// downward, which is the point: the next frame leaves when the last one
    /// has, and it is always the newest one the browser drew, so a slow uplink
    /// degrades to fewer pictures instead of a queue of pictures that arrive
    /// late and are then answered against a box that has moved.
    /// </summary>
    public TimeSpan BurstInterval { get; init; } = TimeSpan.FromMilliseconds(80);

    /// <summary>
    /// How long a burst lasts after the last event was replayed.
    ///
    /// 1.2 s, which is roughly the gap a person leaves between words. Shorter
    /// and the stream drops to the idle tier in the middle of a password, so
    /// the human watches their own typing arrive half a second late and types
    /// it again.
    /// </summary>
    public TimeSpan BurstWindow { get; init; } = TimeSpan.FromMilliseconds(1200);

    /// <summary>
    /// The shortest gap between two posted frames when nobody has touched
    /// anything.
    ///
    /// 500 ms. A login form draws nothing until somebody touches it, so this
    /// only bites on a page that animates on its own - a spinner, a carousel
    /// behind the cookie banner - which is then sent twice a second rather
    /// than at the sixty its compositor draws.
    /// </summary>
    public TimeSpan IdleInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// The longest a stream stays silent when nothing on the page has changed.
    ///
    /// The screencast sends nothing for a static form, which is correct and is
    /// also indistinguishable, from the viewer's side, from a stream that has
    /// died - and the control plane forgets a login nothing was written to for
    /// two minutes. One fresh picture every 5 s answers both.
    /// </summary>
    public TimeSpan MaxSilence { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// JPEG quality while the pointer moves: a drag, a scroll, a hover. Motion
    /// hides what the lower quality costs, and these are the frames that come
    /// many to the second.
    /// </summary>
    public int MovingQuality { get; init; } = 45;

    /// <summary>
    /// JPEG quality for everything else, and for the one frame that follows
    /// the pointer coming to rest: what the human reads and types against.
    /// </summary>
    /// <remarks>
    /// 80, because of a QR, measured rather than guessed. A login that works by
    /// showing a QR for the account owner to scan - DigiD's app flow, and
    /// therefore anything reached through it - was swept across 135
    /// combinations of payload length, error-correction level, rendered size
    /// and offset against JPEG's 8x8 block grid:
    /// <code>
    /// quality  trials  failed  failure rate
    ///      60     135       2          1.5%
    ///      70     135       0          0.0%
    ///      80     135       0          0.0%
    /// </code>
    /// The failures are not where intuition puts them - one was a LARGER QR
    /// that decoded fine at quality 40 - because what breaks a QR is the block
    /// grid landing badly against its module edges, not a shortage of pixels.
    /// A QR on a streamed page is still, so it is drawn at this quality. (A
    /// <see cref="Challenges.ChallengeType.QrDisplay"/> relays a lossless PNG
    /// still through <see cref="ScreenshotRedactor.CaptureAsync"/> and never
    /// depended on this number.) Measured on a phone-sized form: 7.6 KB at 45,
    /// 9.9 KB at 80; on a photographic page 15.7 KB against 27 KB.
    /// </remarks>
    public int SettledQuality { get; init; } = 80;

    /// <summary>
    /// How long after the last pointer move the sharp tier returns - and with
    /// it one fresh, sharp frame of the page as it came to rest.
    /// </summary>
    public TimeSpan SettleDelay { get; init; } = TimeSpan.FromMilliseconds(300);

    /// <summary>
    /// Consecutive transport failures before the stream gives up on a leg.
    ///
    /// Not one: a home line drops a request and the human is still typing. Not
    /// unbounded either - a control plane that has never heard of these routes
    /// answers every frame the same way, and hammering it twelve times a second
    /// for the length of a login is the failure mode this bounds.
    /// </summary>
    public int MaxConsecutiveFailures { get; init; } = 5;

    /// <summary>How often the cost of a frame is written down. See <see cref="LiveViewMeter"/>.</summary>
    public TimeSpan MeterInterval { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>
    /// The exact hosts this stream may photograph. Empty means "wherever the
    /// page already is when the stream opens", which is the strictest rule
    /// available without a manifest to read - see
    /// <see cref="LiveViewSession"/>'s remarks.
    /// </summary>
    public IReadOnlyList<string> Origins { get; init; } = [];

    /// <summary>Backstop between input polls when the control plane is unwell.</summary>
    public TimeSpan InputRetryDelay { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>
    /// The shortest an empty input poll may take before the next one starts.
    ///
    /// The route is specified as a long poll, so this should never fire. It is
    /// here because the failure if it is wrong is not a slow stream but a
    /// core at 100%: a control plane that answers 204 immediately turns this
    /// loop into a spin, and the first symptom is the frame timings this whole
    /// exercise exists to measure being wrong for a reason nobody can see.
    /// </summary>
    public TimeSpan EmptyPollFloor { get; init; } = TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// Stream whatever http(s) origin the page is on (#441 L3): the explore
    /// run's, where the operator drives their own browser and there is no
    /// login to stop at. Every other view keeps the origin latch.
    /// </summary>
    public bool AnyOrigin { get; init; }

    /// <summary>Replay the navigation vocabulary (open an address, back, reload). Explore runs only.</summary>
    public bool Navigation { get; init; }
}

/// <summary>
/// One live view, for the length of one challenge: the browser's own
/// screencast (<see cref="LiveScreencast"/>) pushes a picture whenever it drew
/// something new, the newest one is posted, and what the human sends back is
/// replayed.
///
/// <b>What is photographed is the whole visible page, unmasked</b>, and that
/// is a custody decision rather than a gap. The still relay refuses a page
/// whose password box holds content and conceals every secret-bearing field,
/// because there the value would be OURS. Here the human is typing into the
/// provider's own page, deliberately, watching this stream to do it: a
/// provider served this way declares no credential fields, frames are never
/// stored, and they go to one attached viewer. A refusal would stream a black
/// rectangle at exactly the moment the feature exists for. What does hold is
/// the origin latch below - checked at the source, per frame, and on every
/// navigation.
///
/// <b>Two loops, not one.</b> The input leg is a long poll bounded by the
/// control plane's own window - tens of seconds - so running it inline would
/// stall the pictures for essentially the whole session. They share a stop and
/// one nudge: replaying an event puts the stream into its burst tier, because
/// the only moment a login form changes is just after somebody touched it, and
/// a pointer that moves puts it into the softer encoding until it settles.
///
/// <b>Stopping is terminal.</b> <see cref="Stop"/> latches through an
/// <see cref="Interlocked.Exchange(ref int, int)"/> and is checked after every
/// await, so no path resumes a stream that has been stopped. Six things stop
/// it today: the caller's token, the page navigating off the allowed origin,
/// the page closing, the control plane saying the channel is gone, a run of
/// transport failures, and either loop failing in a way nobody predicted.
/// Stopping also stops the browser's screencast. The last is deliberate
/// and it is new: a leg that dies quietly leaves a live view that lies - a
/// frozen picture that still accepts keystrokes, or a moving one that answers
/// none - so an unexpected end is logged at error and takes the whole stream
/// with it, back to the passive wait the challenge underneath always was.
///
/// <b>The origin latch, and what it is not.</b> The design wants an exact-host
/// allowlist the adapter declares in its manifest, refused if it contains a
/// wildcard, because a stream that keeps running after a successful login is a
/// live remote view of an authenticated account. The manifest half of that does
/// not exist yet. What this does instead is strictly narrower and needs nothing
/// from anybody: with no allowlist it pins to the host the page is on when the
/// stream opens, and stops the moment the main frame goes anywhere else. That
/// is observed rather than claimed, which is the stronger kind of check; what
/// it cannot do is allow a login that legitimately crosses to an identity
/// provider, and that is exactly what the manifest list is for.
///
/// <b>Nothing here is stored.</b> One frame waits at a time, replaced by the
/// next, and what outlives a posted one is a 32-byte hash used to notice that
/// the next one is identical. Not the previous frame's pixels: holding a
/// picture of somebody's login page in agent memory to compare against is the
/// same mistake as writing it to a row, one order of magnitude smaller.
/// </summary>
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

    /// <summary>
    /// Wakes the picture loop the instant an event lands or the browser drew a
    /// frame. Bounded at one so a burst of either cannot bank wake-ups that
    /// fire long after the page went still.
    /// </summary>
    private readonly SemaphoreSlim _nudge = new(0, 1);

    private CancellationTokenSource? _cts;
    private Task? _capture;
    private Task? _input;
    private int _stopped;

    /// <summary>
    /// The size of the last frame that actually left this machine, packed into
    /// one long so width and height can never be read from two different
    /// frames. Zero until the first frame is posted, which is what makes
    /// "input before any picture" a refusal rather than a guess.
    /// </summary>
    private long _frameSize;

    private long _burstUntilTicks;

    /// <summary>Until when the pointer counts as moving, which is what the softer encoding follows.</summary>
    private long _movingUntilTicks;

    /// <param name="sequence">
    /// The JOB's frame counter, not this session's. Passed in rather than
    /// started here, because a second live view inside one job must continue the
    /// count - see <see cref="LiveFrameSequence"/> for what happens when it does
    /// not.
    /// </param>
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

    /// <summary>True once anything has stopped this stream. Never goes back.</summary>
    public bool Stopped => Volatile.Read(ref _stopped) == 1;

    /// <summary>
    /// Frames that reached the control plane. Written by the picture loop and
    /// read once the loops have finished, which is what decides whether a
    /// closing measurement is worth writing down at all.
    /// </summary>
    public long FramesPosted { get; private set; }

    /// <summary>
    /// Starts both loops. Returns immediately; the stream lives until
    /// <see cref="DisposeAsync"/>, the token, or a latch.
    /// </summary>
    public void Start(CancellationToken ct)
    {
        if (_cts is not null) throw new InvalidOperationException("this live view has already been started");

        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // The sequence it resumes from is in the line because it is the one
        // thing about a SECOND live view that used to be invisible from both
        // ends: the connector discards a frame that does not advance the count
        // and answers 200, so "this view starts at 0" was a silent stall.
        _logger.LogInformation(
            "job {JobId}: live view open on {Origins} at up to {Fps:0.#} fps, frames continue from {Sequence}",
            _jobId, Describe(_origins), Fps(), _sequence.Last);

        // The navigation latch is wired before the first picture, so a page
        // that leaves while the browser is still launching is caught too.
        _page.FrameNavigated += OnFrameNavigated;

        _capture = Task.Run(() => CaptureLoopAsync(_cts.Token), CancellationToken.None);
        _input = Task.Run(() => InputLoopAsync(_cts.Token), CancellationToken.None);
    }

    /// <summary>
    /// Stops the stream for good. Safe to call from anywhere and any number of
    /// times; only the first call is heard, and there is no way to restart.
    /// </summary>
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

        // Teardown never throws over a job's real outcome, exactly as the
        // browser lease's does not: a stream that ended badly must not turn a
        // completed login into a failure.
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

    /// <summary>What the picture loop carries from one frame to the next.</summary>
    private sealed class Shutter
    {
        public byte[] LastHash { get; set; } = [];

        public DateTimeOffset LastPostedAt { get; set; }

        /// <summary>When a fresh picture of an unchanged page was last asked for, so the heartbeat asks once.</summary>
        public DateTimeOffset RefreshedAt { get; set; }

        public int Failures { get; set; }
    }

    /// <summary>What became of one frame the loop tried to post.</summary>
    private enum Posting
    {
        /// <summary>Nothing new to send: no picture waiting, or the same one again.</summary>
        Idle,

        /// <summary>The control plane took it.</summary>
        Accepted,

        /// <summary>A transport blip; the loop waits and tries the next one.</summary>
        Blipped,

        /// <summary>The stream is over, and <see cref="Stop"/> has been told why.</summary>
        Ended,
    }

    private async Task CaptureLoopAsync(CancellationToken ct)
    {
        var now = _time.GetUtcNow();
        var shutter = new Shutter { LastPostedAt = now, RefreshedAt = now };

        // Disposed with this loop, however it ends: the browser stops encoding
        // the moment the stream stops, not when the job does.
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
                    // Warning, not debug: somebody is in front of a picture
                    // that has stopped updating, and this is the one line that
                    // says why.
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
            // OUR token. The stream ending is not an error, whichever end ended
            // it - and the filter is what makes that claim true. Without it this
            // arm also swallowed HttpClient.Timeout, which arrives as a
            // TaskCanceledException from a POST nobody asked to stop.
        }
        catch (Exception ex)
        {
            // Anything else ends the pictures, so it ends the stream too,
            // loudly. Pictures that die while the input leg lives are the worse
            // of the two failures: the human's keystrokes keep reaching a page
            // they can no longer see, against a frozen picture of it.
            _logger.LogError(ex, "job {JobId}: the live view's camera failed", _jobId);
            Stop("the camera failed");
        }
    }

    /// <summary>
    /// Posts the newest picture the browser drew, when there is one; asks for
    /// a fresh one when the page has been still for too long.
    /// </summary>
    private async Task<Posting> TakeAndPostAsync(LiveScreencast camera, Shutter shutter, CancellationToken ct)
    {
        var now = _time.GetUtcNow();

        if (!camera.TryTake(out var frame))
        {
            // Nothing drawn: a heartbeat, so silence never reads as a dead
            // stream - asked for once a silence, posted when it arrives.
            if (now - shutter.LastPostedAt >= _options.MaxSilence && now - shutter.RefreshedAt >= _options.MaxSilence)
            {
                shutter.RefreshedAt = now;
                await camera.RefreshAsync().ConfigureAwait(false);
            }

            return Posting.Idle;
        }

        // Checked per frame and not only trusted to the events: a
        // notification can be missed, and no frame may leave for a page that
        // is not where it is supposed to be. Read once and reused for the
        // frame, so the origin reported is the one that was checked.
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

    /// <summary>The frames the browser drew that never left, for the meter's line.</summary>
    private void CountSkipped(LiveScreencast camera)
    {
        var (superseded, withheld) = camera.TakeCounts();
        _meter.Superseded(superseded);
        _meter.Missed(withheld);
    }

    /// <summary>The encoding the pointer asks for: soft while it moves, sharp once it settled.</summary>
    private LiveTier TierAt(DateTimeOffset now) =>
        now.UtcTicks < Volatile.Read(ref _movingUntilTicks) ? LiveTier.Moving : LiveTier.Settled;

    /// <summary>
    /// Whether this picture is the last one again, recently enough to skip -
    /// a fresh frame asked for by a tier switch on a page that did not change.
    ///
    /// Hashing the ENCODED bytes, which are byte-identical for the same page
    /// at the same quality. The hash and not the frame: 32 bytes of nothing,
    /// rather than a picture of a login page kept alive to compare against.
    /// </summary>
    private bool IsQuiet(byte[] jpeg, Shutter shutter, out byte[] hash)
    {
        hash = SHA256.HashData(jpeg);
        var unchanged = shutter.LastHash.Length > 0 && hash.AsSpan().SequenceEqual(shutter.LastHash);

        return unchanged && _time.GetUtcNow() - shutter.LastPostedAt < _options.MaxSilence;
    }

    /// <summary>Numbers, posts and books one frame the loop decided to send.</summary>
    private async Task<Posting> PostAsync(
        CastFrame capture, string url, byte[] hash, TimeSpan age, Shutter shutter, CancellationToken ct)
    {
        // The JOB's counter and never this session's. Taken here, after
        // suppression has decided the bytes are worth sending, so a
        // static form does not burn numbers - and kept whether or not
        // the POST below lands, because a retried frame is a different
        // picture and re-using a number is the one thing the connector
        // refuses.
        var sequence = _sequence.Next();
        var frame = new LiveFrame
        {
            Sequence = sequence,
            Width = capture.Width,
            Height = capture.Height,
            Bytes = capture.Jpeg,
            // Whose page this is, from the URL checked above. The
            // human is looking at a photograph with no address bar and
            // no padlock, so without this the only claim about whose
            // password box they are filling in is a provider name the
            // consumer wrote, which is evidence of nothing.
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

        // Published only after the bytes are accepted, so an event that
        // arrives before any picture has one meaning - refuse - rather
        // than being mapped against a frame nobody received.
        Volatile.Write(ref _frameSize, ((long)capture.Width << 32) | (uint)capture.Height);
        FramesPosted++;

        _meter.Posted(age, post, frame.Bytes.Length);
        return Posting.Accepted;
    }

    /// <summary>What the input loop carries from one poll to the next.</summary>
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

                // 204: the window closed with nobody touching anything, which
                // is the normal state of a login form. Ask again - but never
                // faster than the floor, because a control plane that answers
                // immediately would otherwise turn this into a spin.
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

                // Something moved, so the next pictures are worth sending soon.
                if (dispatched > 0) Nudge(batch.Events.Any(e => e.Kind is LiveInputKind.Move or LiveInputKind.Scroll));
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Our token, as above. A poll that the HTTP client gave up on is
            // not this, and is retried by the handler further up.
        }
        catch (Exception ex)
        {
            // The human's taps stop landing and there is no way to tell them so
            // through a picture. Stopping is the honest end: the challenge
            // underneath is passive, so it degrades to the wait a consumer that
            // had never heard of a live view would have got.
            _logger.LogError(ex, "job {JobId}: the live view's input channel failed", _jobId);
            Stop("the input channel failed");
        }
    }

    /// <summary>
    /// One long poll for input. A transport blip is absorbed up to the
    /// configured run of them; past that the channel is declared dead and
    /// <c>ended</c> is true.
    /// </summary>
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

    /// <summary>Never faster than the floor: an empty answer that came back at once must not become a spin.</summary>
    private async Task HoldToTheFloorAsync(long polledAt, CancellationToken ct)
    {
        var spent = _time.GetElapsedTime(polledAt);
        if (spent < _options.EmptyPollFloor)
        {
            await Task.Delay(_options.EmptyPollFloor - spent, _time, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Moves the cursor past the batch and says whether it is worth replaying.
    ///
    /// The cursor moves on EVERY batch received, delivered or not. A batch
    /// that is refused but does not move the cursor is a batch the control
    /// plane hands over again, forever, at the speed of a long poll - and the
    /// events inside it were already counted against the human once.
    /// </summary>
    private bool Accepts(LiveInputBatch batch, Inbox inbox)
    {
        var newest = batch.Events.Max(e => e.Sequence);
        var stale = newest <= inbox.Cursor;
        inbox.Cursor = Math.Max(inbox.Cursor, newest);

        if (stale)
        {
            // Loud, because the alternative to noticing this is a live
            // view that looks broken from the outside: the human taps,
            // nothing happens, and no line anywhere says why.
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

    /// <summary>
    /// Whether an exception is the transport having a bad moment, rather than
    /// this stream being stopped.
    ///
    /// The distinction is the whole point. <c>HttpClient.Timeout</c> surfaces as
    /// a <see cref="TaskCanceledException"/>, which IS an
    /// <see cref="OperationCanceledException"/> - so one stalled POST and one
    /// stalled long poll are indistinguishable from "the challenge is over"
    /// unless somebody asks whose token fired. Nobody asked, so a single stall
    /// ended that leg for the rest of the login, silently, without the retry
    /// budget ever seeing a failure.
    ///
    /// Our token is the only thing that means stop. Everything else is a blip on
    /// a home line with a human still typing, and gets counted and retried like
    /// any other transport failure.
    /// </summary>
    private static bool IsTransportBlip(Exception ex, CancellationToken ct) =>
        ex is ControlPlaneException || (ex is OperationCanceledException && !ct.IsCancellationRequested);

    /// <summary>
    /// Puts the stream into its burst tier and wakes it now, so the frame
    /// after a keystroke leaves at once rather than up to half a second later;
    /// a pointer that moved also asks for the softer encoding until it settles.
    /// </summary>
    private void Nudge(bool moved)
    {
        var now = _time.GetUtcNow();
        Volatile.Write(ref _burstUntilTicks, (now + _options.BurstWindow).UtcTicks);
        if (moved) Volatile.Write(ref _movingUntilTicks, (now + _options.SettleDelay).UtcTicks);

        Wake();
    }

    /// <summary>Wakes the picture loop: a frame is waiting, or somebody touched the page.</summary>
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

    /// <summary>
    /// Sleeps until the next thing worth doing: the gap since the last posted
    /// frame closing (shorter while somebody is at the page), a picture
    /// arriving, the pointer settling, or the heartbeat coming due.
    ///
    /// The wait is on the semaphore rather than a timer so that the burst
    /// begins on the keystroke instead of at the end of whatever idle gap
    /// happened to be running. Wall clock and not a virtual one, deliberately:
    /// this is the cadence, and the whole point of the exercise is a real
    /// number.
    /// </summary>
    private async Task WaitAsync(LiveScreencast camera, Shutter shutter, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !Stopped && !camera.Closed)
        {
            var now = _time.GetUtcNow();
            var paceUntil = shutter.LastPostedAt + GapAt(now);
            var settleAt = SettleAt(now);

            // The tier follows the pointer at once, whatever else is pending.
            if (TierAt(now) != camera.Tier) return;

            if (now < paceUntil)
            {
                // A picture may already be waiting; it is the newest one when
                // the gap closes. A keystroke shortens the gap.
                await _nudge.WaitAsync(Shortest(paceUntil - now, settleAt - now), ct).ConfigureAwait(false);
                continue;
            }

            var heartbeatAt = HeartbeatAt(shutter);
            if (camera.HasFrame || now >= heartbeatAt) return;

            await _nudge.WaitAsync(Shortest(heartbeatAt - now, settleAt - now), ct).ConfigureAwait(false);
            return;
        }
    }

    /// <summary>The shortest gap between two posted frames: short while somebody is at the page.</summary>
    private TimeSpan GapAt(DateTimeOffset now) =>
        now.UtcTicks < Volatile.Read(ref _burstUntilTicks) ? _options.BurstInterval : _options.IdleInterval;

    /// <summary>When a moving pointer counts as settled, or never while it is not moving.</summary>
    private DateTimeOffset SettleAt(DateTimeOffset now)
    {
        var movingUntil = new DateTimeOffset(Volatile.Read(ref _movingUntilTicks), TimeSpan.Zero);
        return movingUntil > now ? movingUntil : DateTimeOffset.MaxValue;
    }

    /// <summary>When a still page is due its fresh picture: a silence after the last frame sent or asked for.</summary>
    private DateTimeOffset HeartbeatAt(Shutter shutter) =>
        (shutter.LastPostedAt > shutter.RefreshedAt ? shutter.LastPostedAt : shutter.RefreshedAt) + _options.MaxSilence;

    /// <summary>The nearer of two deadlines, never negative, and never past the heartbeat - a wait has to come back to look.</summary>
    private TimeSpan Shortest(TimeSpan a, TimeSpan b)
    {
        var shortest = a < b ? a : b;
        if (shortest <= TimeSpan.Zero) return TimeSpan.Zero;
        return shortest < _options.MaxSilence ? shortest : _options.MaxSilence;
    }

    /// <summary>A window is written when it closes with something in it; a still page writes nothing.</summary>
    private void ReportIfDue()
    {
        if (_meter.TryClose() is { HasSamples: true } window) _logger.Report(_jobId, window);
    }

    private void OnFrameNavigated(object? sender, IFrame frame)
    {
        // Only the main frame. A login page's third-party frames navigate
        // constantly - that is what a captcha widget does all day - and
        // latching on those would stop every stream within a second.
        if (frame != _page.MainFrame) return;

        if (!IsAllowed(frame.Url)) Stop("the page navigated off the origin the stream opened on");
    }

    /// <summary>
    /// Whether a URL is one this stream may photograph.
    ///
    /// Exact host, never a suffix match. A rule that accepted anything ending
    /// in the allowed host accepts <c>login.ah.nl.example.com</c>, and a rule
    /// that accepted subdomains keeps streaming after a successful login has
    /// moved the browser to the account pages.
    /// </summary>
    private bool IsAllowed(string? url)
    {
        // The operator's own browser (#441 L3): every page it lands on is
        // theirs to see, the blank one and the error page included - a start
        // address that did not resolve must still leave a picture to type
        // the next address over.
        if (_options.AnyOrigin) return true;

        if (_origins.Count == 0) return false;

        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return false;

        return _origins.Contains(parsed.Host);
    }

    /// <summary>
    /// The hosts this stream may run on: what was declared, or - when nothing
    /// was - the one the page is already on.
    ///
    /// A wildcard is refused rather than expanded, and the refusal is an empty
    /// set, which stops the stream before its first frame. An adapter that
    /// declared <c>*.ah.nl</c> would keep streaming after the login succeeded,
    /// and the whole point of the latch is that it does not.
    /// </summary>
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
