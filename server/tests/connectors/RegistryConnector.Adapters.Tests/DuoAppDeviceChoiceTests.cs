using System.Text.RegularExpressions;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// agent browser is Pixel 5 (BrowserDevice; DUO sets no DesktopBrowser) and DigiD serves phones another app flow: an extra
// device-choice screen whose tiles share a class (only href differs; the wrong one hangs silently),
// then a typed koppelcode instead of a QR
public sealed partial class DuoAppDeviceChoiceTests
{
    private static readonly string Choice = Fixture.Read("duo/app-device-choice.html");
    private static readonly string Koppelcode = Fixture.Read("duo/app-koppelcode-screen.html");
    private static readonly string Qr = Fixture.Read("duo/qr-screen.html");

    [GeneratedRegex(@"<a\s[^>]*class='[^']*login_tile[^']*'[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Tile { get; }

    [GeneratedRegex(@"href='(?<href>[^']*)'", RegexOptions.IgnoreCase)]
    private static partial Regex Href { get; }

    [GeneratedRegex(@"data-pattern=""(?<p>[^""]*)""")]
    private static partial Regex DataPattern { get; }

    private static List<string> TileHrefs() =>
        [.. Tile.Matches(Choice)
            .Select(m => Href.Match(m.Value))
            .Where(m => m.Success)
            .Select(m => m.Groups["href"].Value)];

    [Fact]
    public void The_screen_offers_exactly_two_tiles()
    {
        Assert.Equal(2, TileHrefs().Count);
    }

    // the this-device tile hands off to an app that cannot exist in a container: it hangs, it does not fail
    [Fact]
    public void The_tile_for_this_device_asks_the_operating_system_to_open_an_app()
    {
        var here = TileHrefs().Single(h => h.Contains("web_to_app", StringComparison.Ordinal));

        Assert.Equal("https://login.digid.nl/inloggen_app_web_to_app", here);
        Assert.Contains("open_app_on_device", Choice, StringComparison.Ordinal);
    }

    [Fact]
    public void The_tile_for_another_device_is_the_one_carrying_confirm()
    {
        var other = TileHrefs().Single(h => h.Contains("confirm=true", StringComparison.Ordinal));

        Assert.Equal("https://login.digid.nl/inloggen_app?confirm=true", other);
    }

    [Fact]
    public void Both_tiles_carry_the_same_class_so_only_the_href_tells_them_apart()
    {
        var tiles = Tile.Matches(Choice).Select(m => m.Value).ToList();

        Assert.Equal(2, tiles.Count);
        Assert.All(tiles, tile => Assert.Contains("login_tile", tile, StringComparison.Ordinal));

        Assert.Single(tiles, tile => tile.Contains("confirm=true", StringComparison.Ordinal));
    }

    [Fact]
    public void The_adapters_first_selector_asks_for_the_href_that_tells_them_apart()
    {
        var first = new DuoOptions().AppOnOtherDeviceSelectors[0];

        Assert.Equal("a.login_tile[href*='confirm=true']", first);
    }

    // every selector, not only the first: a fallback matching "dit apparaat" fires exactly when the precise one failed
    [Fact]
    public void No_selector_can_reach_the_tile_that_opens_the_app_here()
    {
        string[] forbidden = ["dit apparaat", "this device", "web_to_app", "open_app_on_device"];

        Assert.All(
            new DuoOptions().AppOnOtherDeviceSelectors,
            selector => Assert.DoesNotContain(
                forbidden,
                bad => selector.Contains(bad, StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void Every_selector_names_the_other_device_one_way_or_another()
    {
        Assert.All(
            new DuoOptions().AppOnOtherDeviceSelectors,
            selector => Assert.True(
                selector.Contains("confirm=true", StringComparison.Ordinal)
                || selector.Contains("ander mobiel apparaat", StringComparison.Ordinal)
                || selector.Contains("another mobile device", StringComparison.Ordinal),
                $"selector '{selector}' names neither the href nor the wording of the other-device tile"));
    }

    // the paths are opposites: the desktop capture carries an inline image and scannable payload, the phone's neither
    [Fact]
    public void The_phones_app_screen_carries_no_qr_at_all()
    {
        Assert.DoesNotContain("data:image", Koppelcode, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data-code=", Koppelcode, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("data:image", Qr, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("data-code=", Qr, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void It_asks_the_account_holder_to_type_a_four_letter_code()
    {
        Assert.Contains(@"data-minimum-length=""4""", Koppelcode, StringComparison.Ordinal);
        Assert.Contains(@"data-maximum-length=""4""", Koppelcode, StringComparison.Ordinal);
        Assert.Contains(@"id=""app_verification_code_verification_code""", Koppelcode, StringComparison.Ordinal);
    }

    // consonants only: a digit-validated code box would reject every real koppelcode
    [Fact]
    public void The_code_is_consonants_and_holds_no_digits()
    {
        var pattern = DataPattern.Match(Koppelcode).Groups["p"].Value;

        Assert.Equal("^[BbCcDdFfGgHhJjKkLlMmNnPpQqRrSsTtVvWwXxZz]{4}", pattern);
        Assert.DoesNotContain("0-9", pattern, StringComparison.Ordinal);
        Assert.DoesNotContain(@"\d", pattern, StringComparison.Ordinal);

        // vowels are absent on purpose; assert one that must not appear, a length check passes on a typo
        Assert.DoesNotContain("Aa", pattern, StringComparison.Ordinal);
    }

    // the form posts to the endpoint the desktop path starts at: two entrances to one flow
    [Fact]
    public void The_code_is_submitted_to_the_endpoint_the_desktop_path_begins_at()
    {
        Assert.Contains(
            @"action=""https://login.digid.nl/inloggen_app_qr""",
            Koppelcode,
            StringComparison.Ordinal);

        Assert.Contains("Stap <strong>1 van 3</strong>", Koppelcode, StringComparison.Ordinal);
    }
}
