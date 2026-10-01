using System.Text.RegularExpressions;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// The recorded QR block, and the assumptions the adapter's selector rests on.
///
/// The adapter reads an attribute off a live page, so nothing here can prove it
/// picks the right element in a browser. What this CAN do is hold the recorded
/// markup to the shape that makes the selector correct - and that is worth
/// holding, because the failure it prevents is silent: relaying DigiD's own
/// logo instead of the code sends somebody a picture that arrives, renders, and
/// cannot be scanned, and then the login simply waits.
///
/// If DigiD rearranges this block, whoever re-captures it gets told here rather
/// than by a user who could not sign in.
/// </summary>
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

    /// <summary>
    /// The whole reason the selector is anchored on the source rather than on
    /// position. DigiD overlays its own logo on the code, and that logo is the
    /// FIRST image in the block.
    /// </summary>
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
        // Three: the logo, a remote copy for people with scripting off, and
        // the code itself. A block with one image would make this whole test
        // class pointless - and would mean the capture was re-taken from a
        // page that is no longer the one the adapter was written against.
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

    /// <summary>
    /// And what it carries is a picture. The magic number is asserted rather
    /// than the media type in the url, because the url is DigiD's claim about
    /// the bytes and this is the bytes.
    /// </summary>
    [Fact]
    public void The_inline_image_decodes_to_a_png()
    {
        var inline = Sources().Single(s => s.StartsWith("data:image", StringComparison.OrdinalIgnoreCase));
        var bytes = Convert.FromBase64String(inline[(inline.IndexOf(',', StringComparison.Ordinal) + 1)..]);

        Assert.Equal([0x89, 0x50, 0x4E, 0x47], bytes.Take(4));
    }

    /// <summary>
    /// The second finding from the same block: it states the QR's payload in
    /// plain attributes. That is what lets a consumer running ON the phone
    /// offer a tap instead of asking somebody to photograph their own screen.
    /// </summary>
    [Fact]
    public void The_block_also_states_the_payload_the_qr_encodes()
    {
        var code = Code.Match(Markup);

        Assert.True(code.Success);
        Assert.StartsWith("digid-app-auth://", code.Groups["code"].Value, StringComparison.Ordinal);
    }

    /// <summary>
    /// The fixture is redacted, and stays redacted. The capture it came from
    /// carried a live one-time login handle for a real account.
    /// </summary>
    [Fact]
    public void The_recorded_session_handle_is_a_placeholder()
    {
        Assert.Contains("00000000-0000-4000-8000-000000000000", Markup, StringComparison.Ordinal);
    }

    /// <summary>
    /// The options are anchored on the same assumption this file holds the
    /// markup to, so a selector edited to match on position would leave the
    /// two disagreeing.
    /// </summary>
    [Fact]
    public void The_adapters_selectors_ask_for_an_inline_image()
    {
        Assert.All(
            new DuoOptions().QrImageSelectors,
            selector => Assert.Contains("data:image", selector, StringComparison.Ordinal));
    }
}
