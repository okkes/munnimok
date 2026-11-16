using System.Text.Json;
using Connector.Kit.Browsing;
using Xunit;

namespace Connector.Kit.Tests.Browsing;

// discovery output runs against a real account and ends up in commit messages: a shape must be pasteable unchecked,
// so the reader (the half that decides what leaves) is tested; the probe runs in a browser and is unreachable offline
public sealed class PageShapeTests
{
    private static JsonElement Shape(string json) => JsonDocument.Parse(json).RootElement;

    // asserted whole: a description that stopped naming the inputs would still contain every substring a looser test looks for
    [Fact]
    public void A_sign_in_page_reads_as_the_selectors_somebody_has_to_choose_between()
    {
        var described = PageShape.Describe(Shape("""
        {
          "url": "https://www.asnbank.nl/online/inloggen",
          "title": "Inloggen",
          "headings": ["Inloggen bij ASN Bank"],
          "said": [],
          "inputs": [{"kind":"text","selector":"#serienummer","autocomplete":"username","maxlength":"12"}],
          "buttons": [{"selector":"#inloggen","label":"Inloggen"}],
          "codes": [],
          "shown": [],
          "links": ["/online/downloaden"]
        }
        """));

        Assert.Equal(
            "at: https://www.asnbank.nl/online/inloggen | title: Inloggen | "
            + "headings: Inloggen bij ASN Bank | "
            + "inputs: text #serienummer autocomplete=username maxlength=12 | "
            + "buttons: #inloggen \"Inloggen\" | "
            + "links: /online/downloaden",
            described);
    }

    // a QR is reported by position and size only: its bytes are a live second factor
    [Fact]
    public void A_qr_code_is_located_by_its_dimensions_and_never_carried()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","codes":[
          {"selector":"canvas.qr","tag":"canvas","w":220,"h":220,"square":true},
          {"selector":"img.logo","tag":"img","w":180,"h":40,"square":false}]}
        """));

        Assert.Contains("images: canvas.qr 220x220 SQUARE", described, StringComparison.Ordinal);

        // the logo is reported too: anything filtered out of a discovery run has to be gone back for
        Assert.Contains("img.logo 180x40", described, StringComparison.Ordinal);
    }

    // eight digits at a selector is the useful fact; the digits themselves are a live second factor
    [Fact]
    public void A_number_on_screen_is_reported_as_a_length_and_not_as_digits()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","shown":[{"selector":"output#challenge","digits":8}]}
        """));

        Assert.Contains("digit-runs: output#challenge (8 digits)", described, StringComparison.Ordinal);
    }

    // second lock beside the probe: a careless probe or a page answering under the same keys must not turn
    // the reader into a conduit
    [Fact]
    public void A_probe_that_offered_values_would_still_carry_none()
    {
        var described = PageShape.Describe(Shape("""
        {
          "url": "https://x/",
          "inputs": [{"kind":"password","selector":"#pw","value":"hunter2","placeholder":"Wachtwoord"}],
          "shown": [{"selector":"output","digits":8,"text":"84213906"}],
          "codes": [{"selector":"canvas","w":220,"h":220,"png":"iVBORw0KGgo="}],
          "balance": "1.730,01"
        }
        """));

        Assert.DoesNotContain("hunter2", described, StringComparison.Ordinal);
        Assert.DoesNotContain("84213906", described, StringComparison.Ordinal);
        Assert.DoesNotContain("iVBORw0KGgo", described, StringComparison.Ordinal);
        Assert.DoesNotContain("1.730,01", described, StringComparison.Ordinal);
        Assert.DoesNotContain("Wachtwoord", described, StringComparison.Ordinal);

        Assert.Contains("password #pw", described, StringComparison.Ordinal);
    }

    // an unusable answer says so, not an empty line that reads as "the page was blank"
    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("\"not a shape\"")]
    public void A_probe_that_answered_with_nothing_says_so(string json) =>
        Assert.Equal("the page described itself as nothing at all", PageShape.Describe(Shape(json)));

    // the page's complaint comes through: a failed login and a waiting one look identical otherwise
    [Fact]
    public void What_the_page_is_complaining_about_comes_through()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","said":["De ingevoerde code is onjuist."]}
        """));

        Assert.Contains("says: De ingevoerde code is onjuist.", described, StringComparison.Ordinal);
    }

    // ASN's controls all report as button[data-testid='button'] and only aria-label tells them apart; dropping labels
    // past forty characters hid controls like the twelve-button cap did (a missing control reads as absent)
    // pinned in the script source: no browser here
    [Fact]
    public void The_probe_names_icon_buttons_and_drops_none_of_them()
    {
        Assert.Contains("aria-label", PageShape.Script, StringComparison.Ordinal);

        Assert.DoesNotContain(
            ".filter(b => b.label.length < 40)",
            PageShape.Script,
            StringComparison.Ordinal);

        // the remaining cap says "cut:" when it bites, so a short list differs from a cut one
        Assert.Contains("cut:", PageShape.Script, StringComparison.Ordinal);
    }
}
