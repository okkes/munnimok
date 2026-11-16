using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;

namespace Connector.Kit.Agent.Tests;

/// the picture is answerable only if the rectangle it was cut from is the one the taps are mapped back into
public class RegionCaptureTests
{
    private static readonly byte[] Png = [0x89, (byte)'P', (byte)'N', (byte)'G'];

    [Fact]
    public void A_capture_carries_the_box_its_image_came_from()
    {
        var capture = RegionCapture.Of(Png, new CropRegion(12, 34, 300, 180));

        Assert.True(capture.Captured);
        Assert.Equal(new CropRegion(12, 34, 300, 180), capture.Region);
        Assert.Equal(Png, capture.Png);
    }

    [Fact]
    public void A_capture_without_bytes_or_without_area_is_a_refusal()
    {
        // Captured is the single question every caller asks before mapping a tap
        Assert.False(RegionCapture.Of([], new CropRegion(0, 0, 10, 10)).Captured);
        Assert.False(RegionCapture.Of(Png, new CropRegion(0, 0, 0, 10)).Captured);
        Assert.False(RegionCapture.Of(Png, new CropRegion(0, 0, 10, 0)).Captured);
        Assert.False(RegionCapture.Of(Png, default).Captured);
    }

    [Fact]
    public void A_refusal_never_hands_out_a_null_array()
    {
        // callers post these bytes: a null would be an exception on the path meant to be uneventful
        Assert.Empty(RegionCapture.Refused.Png);
        Assert.Empty(default(RegionCapture).Png);
        Assert.Equal(RegionCapture.Refused, default);
    }

    [Fact]
    public void An_enclosing_box_never_cuts_the_element()
    {
        // rounds outward: a captcha's tiles run to the edge of its frame, and truncating loses the last row
        var region = Enclosing(10.4, 20.6, 100.3, 50.9);

        Assert.Equal(10, region.X);
        Assert.Equal(20, region.Y);
        Assert.True(region.X + region.Width >= 10.4 + 100.3);
        Assert.True(region.Y + region.Height >= 20.6 + 50.9);
    }

    [Fact]
    public void A_whole_pixel_box_is_left_exactly_alone()
    {
        Assert.Equal(new CropRegion(40, 80, 300, 200), RegionCapture.Enclosing(40, 80, 300, 200));
    }

    [Fact]
    public void Nothing_photographable_is_no_box_at_all()
    {
        // A zero-area element, one scrolled off the top-left where Playwright
        // cannot clip at all, and a measurement that came back as nonsense.
        Assert.Null(RegionCapture.Enclosing(10, 10, 0, 40));
        Assert.Null(RegionCapture.Enclosing(10, 10, 40, 0));
        Assert.Null(RegionCapture.Enclosing(-2, 10, 40, 40));
        Assert.Null(RegionCapture.Enclosing(10, -2, 40, 40));
        Assert.Null(RegionCapture.Enclosing(double.NaN, 10, 40, 40));
        Assert.Null(RegionCapture.Enclosing(10, double.PositiveInfinity, 40, 40));
        Assert.Null(RegionCapture.Enclosing(1e12, 10, 40, 40));
    }

    [Fact]
    public void A_tap_on_an_enclosing_box_lands_inside_the_element_it_encloses()
    {
        // the round trip the feature rests on: the box clipped is the box taps map into,
        // so a fraction of the picture is a point on the element
        const double X = 100.7, Y = 200.2, Width = 300.6, Height = 150.4;
        var region = Enclosing(X, Y, Width, Height);

        var (centreX, centreY) = new Tap(0.5, 0.5).ToPagePixels(region);

        Assert.InRange(centreX, X, X + Width);
        Assert.InRange(centreY, Y, Y + Height);
    }

    private static CropRegion Enclosing(double x, double y, double width, double height) =>
        RegionCapture.Enclosing(x, y, width, height)
        ?? throw new InvalidOperationException("expected a box for a measurable element");
}
