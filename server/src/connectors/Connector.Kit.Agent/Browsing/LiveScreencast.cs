using System.Text.Json;
using Connector.Kit.Normalization;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

internal enum LiveTier
{
    /// <summary>The pointer is moving: softer frames, because motion hides what a lower quality costs.</summary>
    Moving,

    /// <summary>Nothing is moving: sharp frames - small print and a QR stay readable.</summary>
    Settled,
}

// the size is the viewport in CSS pixels from the frame's metadata: every fraction the human sends back is multiplied by it
internal readonly record struct CastFrame(byte[] Jpeg, int Width, int Height, DateTimeOffset CapturedAt);

// ack each frame at once: Chromium drops frames past 3 unacknowledged for good; the newest replaces a waiting one
// a tier switch is stop+start (fresh frame, ~15 ms median); re-issuing start alone brought none in 7 of 20 runs
// frames drop from a main-frame load start until its commit is checked: the origin latch is held at the source too
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

    public LiveTier Tier { get; private set; }

    public bool Closed { get; private set; }

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

        cdp.Event("Page.screencastFrame").OnEvent += OnFrame;
        cdp.Event("Page.frameStartedLoading").OnEvent += OnStartedLoading;
        cdp.Event("Page.frameNavigated").OnEvent += OnNavigated;
        cdp.Event("Page.frameStoppedLoading").OnEvent += OnStoppedLoading;
        cdp.Close += OnClosed;

        await cdp.SendAsync("Page.enable").ConfigureAwait(false);
        var tree = await cdp.SendAsync("Page.getFrameTree").ConfigureAwait(false);
        var root = tree is { } found ? found.Child("frameTree") : default;
        lock (_gate) _mainFrameId = root.Child("frame").Text("id");

        // before the first picture, so it already shows a steady caret; the inspector sheet is invisible to page scripts,
        // and a blinking caret is a new frame twice a second
        await SteadyTheCaretAsync(root).ConfigureAwait(false);

        Tier = tier;
        await StartScreencastAsync(tier).ConfigureAwait(false);
    }

    // decoded here, not on arrival, so a superseded frame costs nothing
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

    public (int Superseded, int Withheld) TakeCounts() =>
        (Interlocked.Exchange(ref _superseded, 0), Interlocked.Exchange(ref _withheld, 0));

    public async Task SetTierAsync(LiveTier tier)
    {
        if (tier == Tier) return;

        Tier = tier;
        await RestartAsync().ConfigureAwait(false);
    }

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

        // best effort: a closed page has already taken the screencast with it
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
            // every composited frame, never every nth: a change on a skipped one would not arrive until the page changed again
            ["everyNthFrame"] = 1,
        };

        // encoded at CSS size: a retina agent would otherwise encode, ship and decode three times the pixels
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

        // first: an unacknowledged frame counts toward the three the browser stops at
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

        // once per waiting picture: an animating page must not wake the loop sixty times a second
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

        // a child frame's new document needs its own sheet; only the main frame decides what the stream may show
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

        // a load that never committed (download, 204, replaced navigation) leaves the already-checked document in place
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

    // the compositor's draw time from the metadata, else arrival; used only to measure a frame's age as it leaves
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
