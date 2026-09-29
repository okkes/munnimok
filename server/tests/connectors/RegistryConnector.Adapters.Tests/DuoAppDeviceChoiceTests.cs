using System.Text.RegularExpressions;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// DigiD's app path, as it exists on the device the agent actually runs.
///
/// The agent's browser is Pixel 5 - <c>ConnectorAgentOptions.BrowserDevice</c>,
/// handed to every manifest that does not set <c>DesktopBrowser</c>, and DUO
/// does not set it. DigiD serves a phone a different app flow from a desktop,
/// and this file holds the two findings that came out of finally capturing it
/// on the right browser.
///
/// FIRST: the phone gets an extra screen, asking whether the DigiD app is on
/// this device or another one. Its two tiles are anchors with the same class,
/// distinguishable only by href, and taking the wrong one hangs the login
/// silently rather than failing.
///
/// SECOND: what follows is not a QR. A desktop draws a code for a phone to
/// scan; a phone is asked to type a code the app shows it. The adapter relays
/// a QR because that is what the desktop captures held, and this states in
/// tests that the agent's own device does something else.
/// </summary>
public sealed partial class DuoAppDeviceChoiceTests
{
    private static readonly string Choice = Fixture.Read("duo/app-device-choice.html");
    private static readonly string Koppelcode = Fixture.Read("duo/app-koppelcode-screen.html");
    private static readonly string Qr = Fixture.Read("duo/qr-screen.html");

    [GeneratedRegex(@"<a\s[^>]*class='[^']*login_tile[^']*'[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Tile { get; }

    [GeneratedRegex(@"href='(?<href>[^']*)'", RegexOptions.IgnoreCase)]
    private static partial Regex Href { get; }

    private static List<string> TileHrefs() =>
        [.. Tile.Matches(Choice)
            .Select(m => Href.Match(m.Value))
            .Where(m => m.Success)
            .Select(m => m.Groups["href"].Value)];

    [Fact]
    public void The_screen_offers_exactly_two_tiles()
    {
        // Two, not four. The method screen before it offers four ways to sign
        // in; this one asks a single either/or, and a fixture that grew a third
        // tile would mean DigiD changed the question.
        Assert.Equal(2, TileHrefs().Count);
    }

    /// <summary>
    /// The tile that must never be taken, and what makes it dangerous: it does
    /// not fail, it hands off to an app that cannot exist in a container.
    /// </summary>
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

    /// <summary>
    /// The two tiles share a class, so a selector on the class alone would pick
    /// whichever came first - which is the wrong one.
    /// </summary>
    [Fact]
    public void Both_tiles_carry_the_same_class_so_only_the_href_tells_them_apart()
    {
        var tiles = Tile.Matches(Choice).Select(m => m.Value).ToList();

        Assert.Equal(2, tiles.Count);
        Assert.All(tiles, tile => Assert.Contains("login_tile", tile, StringComparison.Ordinal));

        // Counted across the TILES, not the file. The fixture's own header
        // explains why the href is what the selector anchors on, so it says
        // `confirm=true` too - and a test that counted the file would be
        // measuring a comment.
        Assert.Single(tiles, tile => tile.Contains("confirm=true", StringComparison.Ordinal));
    }

    [Fact]
    public void The_adapters_first_selector_asks_for_the_href_that_tells_them_apart()
    {
        var first = new DuoOptions().AppOnOtherDeviceSelectors[0];

        Assert.Equal("a.login_tile[href*='confirm=true']", first);
    }

    /// <summary>
    /// The one that matters. Every selector, not just the first: a fallback
    /// that matched "dit apparaat" would fire on exactly the runs where the
    /// precise one failed, which is the worst possible time to take the wrong
    /// tile.
    /// </summary>
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

    // ---- and what the phone gets instead of a QR ---------------------------

    /// <summary>
    /// The finding this file exists to keep: the two paths are not the same
    /// screen in two languages, they are opposites. The desktop capture carries
    /// an inline image and a scannable payload; the phone's carries neither.
    /// </summary>
    [Fact]
    public void The_phones_app_screen_carries_no_qr_at_all()
    {
        Assert.DoesNotContain("data:image", Koppelcode, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data-code=", Koppelcode, StringComparison.OrdinalIgnoreCase);

        // The desktop one does, so this is a difference between the screens
        // rather than a fixture that happens to be trimmed short.
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

    /// <summary>
    /// Letters, and only consonants - so a code box validated as digits would
    /// reject every real koppelcode. DigiD states the alphabet itself.
    /// </summary>
    [Fact]
    public void The_code_is_consonants_and_holds_no_digits()
    {
        var pattern = Regex.Match(Koppelcode, @"data-pattern=""(?<p>[^""]*)""").Groups["p"].Value;

        Assert.Equal("^[BbCcDdFfGgHhJjKkLlMmNnPpQqRrSsTtVvWwXxZz]{4}", pattern);
        Assert.DoesNotContain("0-9", pattern, StringComparison.Ordinal);
        Assert.DoesNotContain(@"\d", pattern, StringComparison.Ordinal);

        // Vowels are absent on purpose: no four-letter word can come out of a
        // generated code. A test for the alphabet's LENGTH would pass on a
        // typo, so name one that must not be there.
        Assert.DoesNotContain("Aa", pattern, StringComparison.Ordinal);
    }

    /// <summary>
    /// And where the code goes next. The form's own action is the endpoint the
    /// desktop path starts at, which is the clearest evidence that these are
    /// two entrances to one flow rather than two flows.
    /// </summary>
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
