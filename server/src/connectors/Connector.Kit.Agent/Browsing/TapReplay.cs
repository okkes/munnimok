using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// narrow on purpose: where a tap lands and what must not be clicked is arithmetic and refusals, provable without a browser
internal interface IPointerSurface
{
    Task ClickAsync(double x, double y, CancellationToken ct);

    Task PauseAsync(TimeSpan gap, CancellationToken ct);
}

// page.Mouse, not frame.ClickAsync: hCaptcha is in a cross-origin iframe no selector reaches; a mouse event arrives there
internal sealed class MousePointer(IMouse mouse, TimeProvider time) : IPointerSurface
{
    // a press has a duration: down and up in the same instant is a shape no device produces; a widget may see only one
    private const float PressMs = 40;

    public Task ClickAsync(double x, double y, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // taps are rounded to four decimals of the image, so the float cast cannot cross a tile boundary
        return mouse.ClickAsync((float)x, (float)y, new MouseClickOptions { Delay = PressMs });
    }

    public Task PauseAsync(TimeSpan gap, CancellationToken ct) => Task.Delay(gap, time, ct);
}

// the mapping lives on the wire type (Tap.ToPagePixels) so both ends agree on what a coordinate means
internal static class TapReplay
{
    // not evasion: same-millisecond clicks are not separate selections, and the page needs time to paint the accepted tile
    internal static readonly TimeSpan DefaultGap = TimeSpan.FromMilliseconds(180);

    // returns clicks dispatched; zero is a refusal, not an error; every refusal comes BEFORE the first click
    // so a live page is never half-clicked
    internal static async Task<int> ReplayAsync(
        IReadOnlyList<Tap> taps,
        RegionCapture capture,
        (int Width, int Height)? viewport,
        IPointerSurface pointer,
        TimeSpan gap,
        ILogger logger,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(taps);
        ArgumentNullException.ThrowIfNull(pointer);
        ArgumentNullException.ThrowIfNull(logger);

        // no image left this machine, so these taps answer nothing: the redactor's refusal arriving here
        if (!capture.Captured)
        {
            logger.LogWarning(
                "no taps replayed: no image was captured for this challenge, so there is nothing they answer");
            return 0;
        }

        if (taps.Count == 0) return 0;

        var region = capture.Region;

        // crop and mouse are measured against the viewport: a region that no longer fits means the page scrolled or re-laid out
        if (viewport is { } screen && !Fits(region, screen))
        {
            logger.LogWarning(
                "no taps replayed: the captured region {X},{Y} {W}x{H} does not fit the {VW}x{VH} viewport any more",
                region.X, region.Y, region.Width, region.Height, screen.Width, screen.Height);
            return 0;
        }

        // all taps are mapped before any click; out-of-box cannot happen today, the check guards a future change on either
        // side of the wire
        var points = new (double X, double Y)[taps.Count];
        for (var i = 0; i < taps.Count; i++)
        {
            var point = taps[i].ToPagePixels(region);
            if (!Inside(point, region))
            {
                logger.LogWarning(
                    "no taps replayed: tap {Index} maps to {X},{Y}, which is outside the region it was measured against",
                    i, point.X, point.Y);
                return 0;
            }

            points[i] = point;
        }

        for (var i = 0; i < points.Length; i++)
        {
            ct.ThrowIfCancellationRequested();

            // Between the taps, never before the first and never after the
            // last: the gap belongs to the interval, not to the click.
            if (i > 0) await pointer.PauseAsync(gap, ct).ConfigureAwait(false);

            await pointer.ClickAsync(points[i].X, points[i].Y, ct).ConfigureAwait(false);
        }

        // Counts and the box, never the coordinates: where on a captcha grid a
        // particular human tapped is theirs.
        logger.LogInformation(
            "replayed {Count} taps into the region at {X},{Y}", points.Length, region.X, region.Y);

        return points.Length;
    }

    private static bool Fits(CropRegion region, (int Width, int Height) screen) =>
        region.X >= 0
        && region.Y >= 0
        && region.X + region.Width <= screen.Width
        && region.Y + region.Height <= screen.Height;

    private static bool Inside((double X, double Y) point, CropRegion region) =>
        point.X >= region.X
        && point.Y >= region.Y
        && point.X <= region.X + region.Width
        && point.Y <= region.Y + region.Height;
}
