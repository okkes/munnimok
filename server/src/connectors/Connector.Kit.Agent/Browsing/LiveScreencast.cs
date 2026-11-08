using System.Text.Json;
using Connector.Kit.Normalization;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

/// <summary>Which of its two encodings the screencast runs at.</summary>
internal enum LiveTier
{
    /// <summary>The pointer is moving: softer frames, because motion hides what a lower quality costs.</summary>
    Moving,

    /// <summary>Nothing is moving: sharp frames - small print and a QR stay readable.</summary>
    Settled,
}

/// <summary>
/// One picture the browser composited, and the size it covers. The size is
/// the viewport in CSS pixels, read off the frame's own metadata, because
/// every fraction the human sends back is multiplied by it.
/// </summary>
internal readonly record struct CastFrame(byte[] Jpeg, int Width, int Height, DateTimeOffset CapturedAt);

/// <summary>
/// Chromium's own screencast as the live view's camera (#429): the browser
/// pushes a JPEG only when its compositor drew something new, instead of the
/// agent taking a full screenshot on a timer.
///
/// <b>Every frame is acknowledged the moment it arrives.</b> Chromium keeps at
/// most three unacknowledged and drops whatever it composites past that for
/// good - measured: a change drawn while three were in flight never arrived,
/// even after all three were acknowledged. So nothing waits on the uplink
/// here; the newest picture replaces an older one still waiting, and the
/// session posts whichever is newest when it is ready for one.
///
/// <b>A tier switch is a restart.</b> Stopping the screencast and starting it
/// at the other quality delivers a fresh frame of the page as it is - 15 ms
/// median, 20 runs of 20, measured - which is what makes "one sharp frame when
/// the pointer settles" cheap, and what the heartbeat uses for a picture of a
/// page that has not changed. Re-issuing the start alone is NOT enough: right
/// after a frame it brought no fresh one in 7 runs of 20, and on a still page
/// that is a view stuck at the wrong quality.
///
/// <b>Nothing of a page off the allowed origins leaves.</b> The live view's
/// guarantees are not a mask - see <see cref="LiveViewSession"/> for why a
/// streamed login is photographed whole - but the origin latch, and the
/// latch is held here, at the source, as well as above: from the moment the
/// main frame starts loading a document until its commit has been checked,
/// every frame is dropped. A new document cannot paint before it commits, and
/// its loading starts before its request is even sent, so no frame of a page
/// the stream may not show can be in hand while the check is pending.
///
/// <b>The caret is steadied, not hidden.</b> A blinking caret is a new
/// compositor frame twice a second for as long as a field has focus; an
/// inspector stylesheet - invisible to the page's own scripts, which is
/// where a login page that hunts for automation looks - sets
/// <c>caret-animation: manual</c>, so the human sees where they type and a
/// focused field sends nothing until it changes. Where it cannot be applied
/// (a cross-origin frame, an older browser) the caret blinks, which costs
/// bandwidth and nothing else.
///
/// Not thread-safe by design beyond the slot: one capture loop drives it,
/// and the browser's events fill the slot under a lock.
/// </summary>
internal sealed class LiveScreencast : IAsyncDisposable
{
    private const string SteadyCaret = "*{caret-animation:manual !important}";

    private readonly IPage _page;
    private readonly LiveViewOptions _options;
    private readonly Func<string?, bool> _isAllowed;
    private readonly Action<string> _onLeft;
    private readonly Action _onArrived;
    private readonly ILogger _logger;
    private readonly TimeProvider _time;
    private readonly Lock _gate = new();

    private ICDPSession? _cdp;
    private string? _mainFrameId;
    private PendingFrame? _newest;
    private bool _held;
    private bool _left;
    private int _stopped;
    private int _superseded;
    private int _withheld;

    /// <param name="isAllowed">Whether a URL is one the stream may photograph.</param>
    /// <param name="onLeft">The main frame committed a document the stream may not photograph.</param>
    /// <param name="onArrived">A picture is waiting; wakes whoever takes them.</param>
    public LiveScreencast(
        IPage page,
        LiveViewOptions options,
        Func<string?, bool> isAllowed,
        Action<string> onLeft,
        Action onArrived,
        ILogger logger,
        TimeProvider time)
    {
        _page = page;
        _options = options;
        _isAllowed = isAllowed;
        _onLeft = onLeft;
        _onArrived = onArrived;
        _logger = logger;
        _time = time;
    }

    /// <summary>The tier the browser is encoding at now.</summary>
    public LiveTier Tier { get; private set; }

    /// <summary>True once the browser's side went away - the page closed, the session detached.</summary>
    public bool Closed { get; private set; }

    /// <summary>Whether a picture is waiting to be taken.</summary>
    public bool HasFrame
    {
        get
        {
            lock (_gate) return _newest is not null;
        }
    }

    public async Task StartAsync(LiveTier tier, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var cdp = await _page.Context.NewCDPSessionAsync(_page).ConfigureAwait(false);
        _cdp = cdp;

        // Subscribed before anything is enabled, so not one event is missed.
        cdp.Event("Page.screencastFrame").OnEvent += OnFrame;
        cdp.Event("Page.frameStartedLoading").OnEvent += OnStartedLoading;
        cdp.Event("Page.frameNavigated").OnEvent += OnNavigated;
        cdp.Event("Page.frameStoppedLoading").OnEvent += OnStoppedLoading;
        cdp.Close += OnClosed;

        await cdp.SendAsync("Page.enable").ConfigureAwait(false);
        var tree = await cdp.SendAsync("Page.getFrameTree").ConfigureAwait(false);
        var root = tree is { } found ? found.Child("frameTree") : default;
        lock (_gate) _mainFrameId = root.Child("frame").Text("id");

        // Before the first picture, so it already shows a steady caret rather
        // than drawing a second frame the moment the rule lands. A page that
        // refuses the sheet only keeps its blink.
        await SteadyTheCaretAsync(root).ConfigureAwait(false);

        Tier = tier;
        await StartScreencastAsync(tier).ConfigureAwait(false);
    }

    /// <summary>The newest picture not yet taken, if any. Decoded here rather than on arrival, so a superseded one costs nothing.</summary>
    public bool TryTake(out CastFrame frame)
    {
        PendingFrame? pending;
        lock (_gate)
        {
            pending = _newest;
            _newest = null;
        }

        frame = default;
        if (pending is not { } taken) return false;

        try
        {
            frame = new CastFrame(Convert.FromBase64String(taken.Base64), taken.Width, taken.Height, taken.CapturedAt);
            return frame.Jpeg.Length > 0;
        }
        catch (FormatException ex)
        {
            _logger.LogDebug(ex, "a screencast frame did not decode");
            return false;
        }
    }

    /// <summary>
    /// Frames the browser drew that will never leave: replaced by a newer one
    /// before they were taken, and dropped while a navigation was being
    /// checked. Read and reset, for the meter.
    /// </summary>
    public (int Superseded, int Withheld) TakeCounts() =>
        (Interlocked.Exchange(ref _superseded, 0), Interlocked.Exchange(ref _withheld, 0));

    /// <summary>Switches the encoding; the browser answers with a fresh frame at the new quality.</summary>
    public async Task SetTierAsync(LiveTier tier)
    {
        if (tier == Tier) return;

        Tier = tier;
        await RestartAsync().ConfigureAwait(false);
    }

    /// <summary>Asks for a fresh picture of the page as it is, changed or not - the heartbeat's.</summary>
    public Task RefreshAsync() => RestartAsync();

    private async Task RestartAsync()
    {
        if (_cdp is not { } cdp || Volatile.Read(ref _stopped) == 1) return;

        await cdp.SendAsync("Page.stopScreencast").ConfigureAwait(false);
        await StartScreencastAsync(Tier).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) == 1) return;
        if (_cdp is not { } cdp) return;

        // Teardown is best effort and never throws over the job's outcome: a
        // closed page has already taken the screencast with it.
        try
        {
            await cdp.SendAsync("Page.stopScreencast").ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            _logger.LogDebug(ex, "the screencast was already gone at stop");
        }

        try
        {
            await cdp.DetachAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            _logger.LogDebug(ex, "the screencast session was already detached");
        }
    }

    private Task StartScreencastAsync(LiveTier tier)
    {
        if (_cdp is not { } cdp) return Task.CompletedTask;

        var args = new Dictionary<string, object>
        {
            ["format"] = "jpeg",
            ["quality"] = tier == LiveTier.Moving ? _options.MovingQuality : _options.SettledQuality,
            // Every composited frame, never every nth: a change that lands on a
            // skipped one would not arrive until the page changed again.
            ["everyNthFrame"] = 1,
        };

        // Encoded at CSS size, as the old shutter's Scale = Css was: a retina
        // agent would otherwise encode, ship and decode three times the pixels
        // for a picture drawn at the same size.
        if (_page.ViewportSize is { Width: > 0, Height: > 0 } viewport)
        {
            args["maxWidth"] = viewport.Width;
            args["maxHeight"] = viewport.Height;
        }

        return cdp.SendAsync("Page.startScreencast", args);
    }

    private async Task SteadyTheCaretAsync(JsonElement root)
    {
        try
        {
            await _cdp!.SendAsync("DOM.enable").ConfigureAwait(false);
            await _cdp.SendAsync("CSS.enable").ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            _logger.LogDebug(ex, "no inspector stylesheet on this page; the caret keeps blinking");
            return;
        }

        foreach (var frameId in FrameIds(root)) await SteadyCaretInAsync(frameId).ConfigureAwait(false);
    }

    /// <summary>The frame and every same-process frame under it; a cross-origin frame is another target and is not in this tree.</summary>
    private static IEnumerable<string> FrameIds(JsonElement node)
    {
        if (node.Child("frame").Text("id") is { } id) yield return id;

        foreach (var child in node.Items("childFrames"))
        {
            foreach (var nested in FrameIds(child)) yield return nested;
        }
    }

    private async Task SteadyCaretInAsync(string frameId)
    {
        if (_cdp is not { } cdp || Volatile.Read(ref _stopped) == 1) return;

        try
        {
            var sheet = await cdp.SendAsync("CSS.createStyleSheet", new() { ["frameId"] = frameId }).ConfigureAwait(false);
            if (sheet is not { } created || created.Text("styleSheetId") is not { } id) return;

            await cdp.SendAsync("CSS.setStyleSheetText", new() { ["styleSheetId"] = id, ["text"] = SteadyCaret })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            // A frame that went away between its commit and this call, or one
            // that is not this target's to style.
            _logger.LogDebug(ex, "the caret could not be steadied in frame {FrameId}", frameId);
        }
    }

    private void OnFrame(object? sender, JsonElement? args)
    {
        if (args is not { } e) return;

        // First, whatever happens next: an unacknowledged frame is one of the
        // three the browser will stop at.
        if (e.Int32("sessionId") is { } screencastId) _ = AcknowledgeAsync(screencastId);

        var metadata = e.Child("metadata");
        var width = Pixels(metadata.Decimal("deviceWidth"));
        var height = Pixels(metadata.Decimal("deviceHeight"));
        var data = e.Text("data");

        if (data is null || width <= 0 || height <= 0) return;

        var pending = new PendingFrame(data, width, height, CapturedAt(metadata.Decimal("timestamp")));
        bool first;

        lock (_gate)
        {
            if (_held || _left || Volatile.Read(ref _stopped) == 1)
            {
                Interlocked.Increment(ref _withheld);
                return;
            }

            first = _newest is null;
            if (!first) Interlocked.Increment(ref _superseded);
            _newest = pending;
        }

        // Once per waiting picture: a page that animates must not wake the
        // loop sixty times a second while it waits out its gap.
        if (first) _onArrived();
    }

    private async Task AcknowledgeAsync(int screencastId)
    {
        try
        {
            await _cdp!.SendAsync("Page.screencastFrameAck", new() { ["sessionId"] = screencastId }).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            // The session is closing; there is nobody left to keep streaming for.
            _logger.LogDebug(ex, "a screencast frame could not be acknowledged");
        }
    }

    private void OnStartedLoading(object? sender, JsonElement? args)
    {
        if (args is not { } e) return;

        lock (_gate)
        {
            if (string.Equals(e.Text("frameId"), _mainFrameId, StringComparison.Ordinal)) _held = true;
        }
    }

    private void OnNavigated(object? sender, JsonElement? args)
    {
        if (args is not { } e) return;

        var frame = e.Child("frame");
        var frameId = frame.Text("id");
        if (frameId is null) return;

        // A child frame's new document needs its own sheet; it changes nothing
        // about what the stream may show, which the main frame alone decides.
        if (frame.Text("parentId") is not null)
        {
            _ = SteadyCaretInAsync(frameId);
            return;
        }

        var url = frame.Text("url");
        var allowed = _isAllowed(url);

        lock (_gate)
        {
            _mainFrameId = frameId;
            if (allowed)
            {
                _held = false;
            }
            else
            {
                _held = true;
                _left = true;
                _newest = null;
            }
        }

        if (!allowed)
        {
            _onLeft(url ?? "(no address)");
            return;
        }

        _ = SteadyCaretInAsync(frameId);
    }

    private void OnStoppedLoading(object? sender, JsonElement? args)
    {
        if (args is not { } e) return;

        // A load that never committed - a download, a 204, a navigation
        // replaced by another - leaves the document where it was, and that one
        // was already checked.
        lock (_gate)
        {
            if (!_left && string.Equals(e.Text("frameId"), _mainFrameId, StringComparison.Ordinal)) _held = false;
        }
    }

    private void OnClosed(object? sender, ICDPSession session)
    {
        Closed = true;
        _onArrived();
    }

    private static int Pixels(decimal? css) =>
        css is { } value && value > 0 && value < 100_000 ? (int)Math.Round(value, MidpointRounding.AwayFromZero) : 0;

    /// <summary>
    /// When the compositor drew the frame: the metadata's wall-clock seconds,
    /// or the moment it arrived when the browser did not say. Only ever used to
    /// measure how old a picture is by the time it leaves.
    /// </summary>
    private DateTimeOffset CapturedAt(decimal? seconds)
    {
        var now = _time.GetUtcNow();
        if (seconds is not { } stated || stated <= 0) return now;

        try
        {
            var at = DateTimeOffset.FromUnixTimeMilliseconds((long)(stated * 1000));
            return at > now || now - at > TimeSpan.FromMinutes(1) ? now : at;
        }
        catch (ArgumentOutOfRangeException)
        {
            return now;
        }
    }

    /// <summary>A frame as it arrived: still base64, because most of them are superseded before anybody looks.</summary>
    private sealed record PendingFrame(string Base64, int Width, int Height, DateTimeOffset CapturedAt);
}
