using System.Text.RegularExpressions;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// the selector cannot be proven in a browser; this holds the markup to the shape that makes it correct.
// The failure is silent: relaying DigiD's logo instead of the code sends a picture that cannot be scanned
public sealed partial class DuoQrMarkupTests
{
    private static readonly string Markup = Fixture.Read("duo/qr-screen.html");

    [GeneratedRegex("<img[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Image { get; }

    [GeneratedRegex(@"src=""(?<src>[^""]*)""", RegexOptions.IgnoreCase)]
    private static partial Regex Source { get; }

    [GeneratedRegex(@"data-code=""(?<code>[^""]*)""", RegexOptions.IgnoreCase)]
    private static partial Regex Code { get; }

    private static List<string> Sources() =>
        [.. Image.Matches(Markup)
            .Select(m => Source.Match(m.Value))
            .Where(m => m.Success)
            .Select(m => m.Groups["src"].Value)];

    // DigiD overlays its own logo on the code and the logo is the FIRST image: the selector anchors on the source, not position
    [Fact]
    public void The_first_image_in_the_block_is_not_the_qr()
    {
        var sources = Sources();

        Assert.NotEmpty(sources);
        Assert.DoesNotContain("data:image", sources[0], StringComparison.OrdinalIgnoreCase);
        Assert.Contains("digid_eo_rgb", sources[0], StringComparison.Ordinal);
    }

    [Fact]
    public void There_is_more_than_one_image_to_get_wrong()
    {
        // three: the logo, a remote copy for scripting-off, the code; one image would mean a capture of a different page
        Assert.Equal(3, Sources().Count);
    }

    [Fact]
    public void Exactly_one_image_carries_the_code_inline()
    {
        var inline = Sources()
            .Where(s => s.StartsWith("data:image", StringComparison.OrdinalIgnoreCase))
            .ToList();

        Assert.Single(inline);
    }

    // the magic number is asserted, not the url's media type: the url is DigiD's claim about the bytes
    [Fact]
    public void The_inline_image_decodes_to_a_png()
    {
        var inline = Sources().Single(s => s.StartsWith("data:image", StringComparison.OrdinalIgnoreCase));
        var bytes = Convert.FromBase64String(inline[(inline.IndexOf(',', StringComparison.Ordinal) + 1)..]);

        Assert.Equal([0x89, 0x50, 0x4E, 0x47], bytes.Take(4));
    }

    // the block also states the QR payload in plain attributes, so a consumer on the phone can offer a tap
    [Fact]
    public void The_block_also_states_the_payload_the_qr_encodes()
    {
        var code = Code.Match(Markup);

        Assert.True(code.Success);
        Assert.StartsWith("digid-app-auth://", code.Groups["code"].Value, StringComparison.Ordinal);
    }

    // the fixture stays redacted: the capture carried a live one-time login handle
    [Fact]
    public void The_recorded_session_handle_is_a_placeholder()
    {
        Assert.Contains("00000000-0000-4000-8000-000000000000", Markup, StringComparison.Ordinal);
    }

    [Fact]
    public void The_adapters_selectors_ask_for_an_inline_image()
    {
        Assert.All(
            new DuoOptions().QrImageSelectors,
            selector => Assert.Contains("data:image", selector, StringComparison.Ordinal));
    }
}
