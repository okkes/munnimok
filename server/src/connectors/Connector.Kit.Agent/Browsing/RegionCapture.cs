using Connector.Kit.Challenges;

namespace Connector.Kit.Agent.Browsing;

// the box travels with the picture: a tap fraction needs the rectangle it was cut from,
// and re-measuring after photographing drifts as a captcha re-lays itself
// Refused has no bytes and no box, unlike a masked PNG; callers ask Captured, not the look of the pixels
public readonly record struct RegionCapture
{
    private readonly byte[]? _png;

    private RegionCapture(byte[] png, CropRegion region)
    {
        _png = png;
        Region = region;
    }

    // also the default value: an unassigned capture and a refused one mean the same
    public static RegionCapture Refused => default;

    // validated so Captured carries a real invariant: bytes exist and the box has a positive area
    public static RegionCapture Of(byte[] png, CropRegion region)
    {
        ArgumentNullException.ThrowIfNull(png);

        if (png.Length == 0) return Refused;
        if (region.Width <= 0 || region.Height <= 0) return Refused;

        return new RegionCapture(png, region);
    }

    /// <summary>The redacted PNG. Empty for a refusal, never null.</summary>
    public byte[] Png => _png ?? [];

    // CSS pixels relative to the viewport, the units page.Mouse takes
    public CropRegion Region { get; }

    public bool Captured => _png is { Length: > 0 };

    // rounds OUTWARD (floor origin, ceil far edge): truncating loses up to a pixel of a captcha's last row.
    // the margin cancels as taps are normalised against the captured box
    // a negative origin is refused, not clamped: clamping would photograph a different rectangle than taps map into
    internal static CropRegion? Enclosing(double x, double y, double width, double height)
    {
        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(width) || !double.IsFinite(height))
        {
            return null;
        }

        if (width <= 0 || height <= 0) return null;
        if (x < 0 || y < 0) return null;

        // the bound keeps a nonsense measurement from becoming a negative CropRegion when the int cast wraps
        const double MaxPixel = 100_000;
        if (x + width > MaxPixel || y + height > MaxPixel) return null;

        var left = (int)Math.Floor(x);
        var top = (int)Math.Floor(y);
        var right = (int)Math.Ceiling(x + width);
        var bottom = (int)Math.Ceiling(y + height);

        return new CropRegion(left, top, right - left, bottom - top);
    }
}
