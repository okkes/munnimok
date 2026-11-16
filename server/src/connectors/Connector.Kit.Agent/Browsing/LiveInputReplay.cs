using Connector.Kit.Challenges;
using Connector.Kit.Exploring;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// narrow on purpose: no method takes a URL, selector, script or path, nothing holds a key down,
// and PressAsync takes the LiveKey enum, so a key name exists as text only inside the implementation
internal interface ILiveSurface
{
    Task MoveAsync(double x, double y, CancellationToken ct);

    Task DownAsync(CancellationToken ct);

    Task UpAsync(CancellationToken ct);

    Task ScrollAsync(double deltaY, CancellationToken ct);

    /// <summary>Types the text one character at a time, each with its key events — literal characters, never a key name.</summary>
    Task TypeTextAsync(string text, CancellationToken ct);

    Task PressAsync(LiveKey key, CancellationToken ct);

    /// <summary>Opens an address the kit already held to the explore rule. Explore runs only (#441 L3).</summary>
    Task NavigateAsync(Uri url, CancellationToken ct);

    Task BackAsync(CancellationToken ct);

    Task ReloadAsync(CancellationToken ct);
}

// the only place a LiveKey becomes a string: a switch returning constants, since Playwright's PressAsync accepts
// shortcuts like Control+o and a lookup keyed on relayed data is a file dialog away; null is a refusal, never a fallback
internal static class LiveKeys
{
    public static string? LiteralFor(LiveKey key) => key switch
    {
        LiveKey.Backspace => "Backspace",
        LiveKey.Delete => "Delete",
        LiveKey.Enter => "Enter",
        LiveKey.Tab => "Tab",
        LiveKey.Escape => "Escape",
        LiveKey.ArrowUp => "ArrowUp",
        LiveKey.ArrowDown => "ArrowDown",
        LiveKey.ArrowLeft => "ArrowLeft",
        LiveKey.ArrowRight => "ArrowRight",
        LiveKey.Home => "Home",
        LiveKey.End => "End",
        _ => null,
    };
}

// page.Mouse and Keyboard, not locators: a cross-origin login form is reachable by no selector,
// but browser-level events arrive where a real one would
internal sealed class PlaywrightLiveSurface(IMouse mouse, IKeyboard keyboard, IPage? page = null) : ILiveSurface
{
    /// <summary>A navigation is given this long; a page that takes longer is left loading and the view carries on.</summary>
    private const float NavigateMs = 20_000;

    public async Task NavigateAsync(Uri url, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(url);
        ct.ThrowIfCancellationRequested();
        if (page is null) throw new InvalidOperationException("this surface has no page to navigate");

        try
        {
            await page.GotoAsync(url.ToString(), new PageGotoOptions { WaitUntil = WaitUntilState.Commit, Timeout = NavigateMs })
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // Still loading; the shutter will show whatever arrives.
        }
    }

    public async Task BackAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (page is null) throw new InvalidOperationException("this surface has no page to navigate");
        await page.GoBackAsync(new PageGoBackOptions { WaitUntil = WaitUntilState.Commit, Timeout = NavigateMs }).ConfigureAwait(false);
    }

    public async Task ReloadAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (page is null) throw new InvalidOperationException("this surface has no page to navigate");
        await page.ReloadAsync(new PageReloadOptions { WaitUntil = WaitUntilState.Commit, Timeout = NavigateMs }).ConfigureAwait(false);
    }
    // how long the button stays down for a one-gesture press; Down/Up carry the human's own timing
    private const float PressMs = 40;

    /// <summary>The beat between two typed characters: long enough for a page to move its focus to the next box, short enough to feel typed.</summary>
    private const float TypeMs = 35;

    public Task MoveAsync(double x, double y, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // coordinates were rounded to four decimals of the frame on the way in, so the float cast moves nothing visible
        return mouse.MoveAsync((float)x, (float)y);
    }

    // primary button only: MouseDownOptions has no modifiers, so no Ctrl-click
    // a secondary button's context menu is browser chrome, in no frame
    public Task DownAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return mouse.DownAsync();
    }

    public Task UpAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return mouse.UpAsync();
    }

    // WheelAsync takes no position and scrolls wherever the pointer is, so the caller moves first
    public Task ScrollAsync(double deltaY, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return mouse.WheelAsync(0, (float)deltaY);
    }

    // TypeAsync, never PressAsync: it interprets nothing, so no relayed string can name a key
    // one character at a time with key events: a segmented input (a box per SMS digit) advances per character
    public Task TypeTextAsync(string text, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return keyboard.TypeAsync(text, new KeyboardTypeOptions { Delay = TypeMs });
    }

    public Task PressAsync(LiveKey key, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var literal = LiveKeys.LiteralFor(key)
            ?? throw new ArgumentOutOfRangeException(nameof(key), key, "not a key this agent presses");

        return keyboard.PressAsync(literal, new KeyboardPressOptions { Delay = PressMs });
    }
}

// maps through Tap.ToPagePixels, shared with the still relay so a coordinate means the same in both
// a streamed frame is the whole viewport, region (0, 0, width, height)
internal static class LiveInputReplay
{
    // a distance, so clamped rather than refused: a page clamps its own scroll,
    // and a huge double becomes float.Infinity and throws mid-batch
    private const double MaxScrollScreens = 20;

    // zero is a real answer: every refusal returns it, decided BEFORE the first event is dispatched
    // a batch is [Down, Move, Move, Up]: refusing one midway leaves the button held down, so the batch is the unit
    // frame is the CAPTURED size, never the viewport asked for again
    internal static async Task<int> ReplayAsync(
        IReadOnlyList<LiveInput> events,
        (int Width, int Height) frame,
        ILiveSurface surface,
        ILogger logger,
        CancellationToken ct,
        bool allowNavigation = false)
    {
        ArgumentNullException.ThrowIfNull(events);
        ArgumentNullException.ThrowIfNull(surface);
        ArgumentNullException.ThrowIfNull(logger);

        if (events.Count == 0) return 0;

        // no posted frame means nothing was seen, so these events answer no picture (the redactor's refusal)
        if (frame.Width <= 0 || frame.Height <= 0)
        {
            logger.LogWarning(
                "no live input replayed: no frame has been posted, so {Count} event(s) answer no picture",
                events.Count);
            return 0;
        }

        var region = new CropRegion(0, 0, frame.Width, frame.Height);

        // everything is resolved before dispatch: an unmapped key is refused here, costing a batch, not thrown mid-dispatch
        var points = new (double X, double Y)[events.Count];
        var scrolls = new double[events.Count];

        for (var i = 0; i < events.Count; i++)
        {
            if (!TryResolve(events, i, region, logger, allowNavigation, out points[i], out scrolls[i])) return 0;
        }

        var dispatched = 0;

        for (var i = 0; i < events.Count; i++)
        {
            ct.ThrowIfCancellationRequested();

            var input = events[i];
            try
            {
                // no gap between events, unlike the tap relay's 180 ms: these carry the human's own rhythm
                if (await DispatchAsync(input, points[i], scrolls[i], surface, ct).ConfigureAwait(false))
                {
                    dispatched++;
                    continue;
                }

                // an event with no arm: a `default:` marked unreachable once threw out of here and faulted the input task for the login
                // so it is local to the event, logged by kind, and the rest of the batch goes
                logger.LogWarning(
                    "live input: event {Index} of {Count} is a {Kind} this agent does not replay; " +
                    "it is skipped and the rest of the batch stands",
                    i, events.Count, input.Kind);
            }
            // every failure but cancellation: a login is a hundred gestures, and the channel must carry the next whatever went wrong
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // a text failure is logged without the exception: relayed characters must not reach a failure detail,
                // and the scrubber is built from job inputs, empty for a streamed login (the password never entered the platform)
                if (input.Kind is LiveInputKind.Text)
                {
                    logger.LogWarning(
                        "live input: a text event of {Length} character(s) was not delivered; " +
                        "the rest of the batch is dropped",
                        input.Text?.Length ?? 0);
                }
                else
                {
                    logger.LogWarning(
                        ex, "live input: a {Kind} event was not delivered; the rest of the batch is dropped", input.Kind);
                }

                break;
            }
        }

        // counts and kinds, never coordinates or text: where a human touched a login form hints which field they filled
        logger.LogDebug("replayed {Dispatched} of {Count} live input event(s)", dispatched, events.Count);

        return dispatched;
    }

    // press and release move first: Playwright's mouse has no coordinates and acts where the pointer already is
    // returns false, never throws, for an event it cannot read: an `unreachable` default once threw (the enum converter
    // takes "kind": 99) and faulted the input task; Text and Key are checked, not forgiven with !
    internal static async Task<bool> DispatchAsync(
        LiveInput input, (double X, double Y) point, double scroll, ILiveSurface surface, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(surface);

        switch (input.Kind)
        {
            case LiveInputKind.Move:
                await surface.MoveAsync(point.X, point.Y, ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Down:
                await surface.MoveAsync(point.X, point.Y, ct).ConfigureAwait(false);
                await surface.DownAsync(ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Up:
                await surface.MoveAsync(point.X, point.Y, ct).ConfigureAwait(false);
                await surface.UpAsync(ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Scroll:
                await surface.MoveAsync(point.X, point.Y, ct).ConfigureAwait(false);
                await surface.ScrollAsync(scroll, ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Text:
                if (input.Text is not { Length: > 0 } text) return false;

                await surface.TypeTextAsync(text, ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Navigate:
                // re-checked as the key is: the surface gets the Uri the kit's rule parsed, never the relayed string
                if (!ExploreProvider.IsNavigable(input.Url, out var target)) return false;

                await surface.NavigateAsync(target, ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Back:
                await surface.BackAsync(ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Reload:
                await surface.ReloadAsync(ct).ConfigureAwait(false);
                return true;

            case LiveInputKind.Key:
                // re-checked: PressAsync throws on an unknown key, which would fault the input channel
                if (input.Key is not { } key || LiveKeys.LiteralFor(key) is null) return false;

                await surface.PressAsync(key, ct).ConfigureAwait(false);
                return true;

            default:
                return false;
        }
    }

    // false refuses the whole batch; logged by kind and index, never by value
    private static bool TryResolve(
        IReadOnlyList<LiveInput> events,
        int i,
        CropRegion region,
        ILogger logger,
        bool allowNavigation,
        out (double X, double Y) point,
        out double scroll)
    {
        point = default;
        scroll = 0;
        var input = events[i];

        if (!input.IsWellFormed())
        {
            // kind and index, never the value: a malformed text event is still someone's typing
            logger.LogWarning(
                "no live input replayed: event {Index} of {Count} is a malformed {Kind}", i, events.Count, input.Kind);
            return false;
        }

        if (input.Kind is LiveInputKind.Key && LiveKeys.LiteralFor(input.Key!.Value) is null)
        {
            logger.LogWarning(
                "no live input replayed: event {Index} names a key this agent does not press", i);
            return false;
        }

        if (input.Kind is LiveInputKind.Text or LiveInputKind.Key) return true;

        if (input.Kind is LiveInputKind.Navigate or LiveInputKind.Back or LiveInputKind.Reload)
        {
            // The whole batch is refused rather than the one event skipped: a
            // navigation that did not happen changes what every tap after it
            // would have landed on.
            if (!allowNavigation)
            {
                logger.LogWarning(
                    "no live input replayed: event {Index} is a {Kind} and this view does not navigate", i, input.Kind);
                return false;
            }

            return true;
        }

        point = new Tap(input.X, input.Y).ToPagePixels(region);
        if (!Inside(point, region))
        {
            // unreachable while IsWellFormed bounds a fraction to [0,1]; kept as the tap relay's twin
            // against a future change on either side of the wire
            logger.LogWarning(
                "no live input replayed: event {Index} maps outside the {W}x{H} frame it was measured against",
                i, region.Width, region.Height);
            return false;
        }

        if (input.Kind is LiveInputKind.Scroll)
        {
            scroll = Math.Clamp(input.DeltaY, -MaxScrollScreens, MaxScrollScreens) * region.Height;
        }

        return true;
    }

    private static bool Inside((double X, double Y) point, CropRegion region) =>
        point.X >= region.X
        && point.Y >= region.Y
        && point.X <= region.X + region.Width
        && point.Y <= region.Y + region.Height;
}
