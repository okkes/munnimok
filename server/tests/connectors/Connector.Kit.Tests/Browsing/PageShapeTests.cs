using System.Text.Json;
using Connector.Kit.Browsing;
using Xunit;

namespace Connector.Kit.Tests.Browsing;

/// <summary>
/// What a page description may carry out of somebody's bank.
///
/// <para>
/// This runs during a discovery session, against a real account, and its output
/// goes into notes that end up in a commit message. So the rule is not "be
/// careful": it is that a shape can be pasted anywhere without anybody checking
/// it first, and these tests are what makes that a property rather than a
/// habit.
/// </para>
///
/// <para>
/// The probe itself runs in a browser and cannot be reached offline. What CAN
/// be tested is the half that decides what leaves - the reader - so it is fed
/// the shapes the probe produces, including a few it should not.
/// </para>
/// </summary>
public sealed class PageShapeTests
{
    private static JsonElement Shape(string json) => JsonDocument.Parse(json).RootElement;

    /// <summary>
    /// A SIGN-IN PAGE, DESCRIBED AS SELECTORS AND NOTHING ELSE.
    /// </summary>
    /// <remarks>
    /// The output somebody actually works from: they read this line and decide
    /// which selector goes in which option. So it is asserted whole rather than
    /// by fragments - a description that quietly stopped naming the inputs
    /// would still contain every substring a looser test looked for.
    /// </remarks>
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

    /// <summary>
    /// A QR IS REPORTED AS A SQUARE, NEVER AS AN IMAGE.
    /// </summary>
    /// <remarks>
    /// Its dimensions are what identifies it - a square canvas a couple of
    /// hundred pixels across - and its bytes ARE the code somebody is about to
    /// scan into their bank. Reporting where it sits is the whole job;
    /// reporting what is in it would be relaying a live second factor into a
    /// log.
    /// </remarks>
    [Fact]
    public void A_qr_code_is_located_by_its_dimensions_and_never_carried()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","codes":[
          {"selector":"canvas.qr","tag":"canvas","w":220,"h":220,"square":true},
          {"selector":"img.logo","tag":"img","w":180,"h":40,"square":false}]}
        """));

        Assert.Contains("images: canvas.qr 220x220 SQUARE", described, StringComparison.Ordinal);

        // The logo is reported too, unmarked. Anything filtered out of a
        // discovery run is something somebody has to go back for.
        Assert.Contains("img.logo 180x40", described, StringComparison.Ordinal);
    }

    /// <summary>
    /// A CHALLENGE NUMBER IS COUNTED, NEVER QUOTED.
    /// </summary>
    /// <remarks>
    /// The useful fact is that eight digits appear at a given selector - that
    /// is what says "this is where the number a device is keyed with lives".
    /// The digits themselves are a live second factor.
    /// </remarks>
    [Fact]
    public void A_number_on_screen_is_reported_as_a_length_and_not_as_digits()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","shown":[{"selector":"output#challenge","digits":8}]}
        """));

        Assert.Contains("digit-runs: output#challenge (8 digits)", described, StringComparison.Ordinal);
    }

    /// <summary>
    /// AND NOTHING THAT ARRIVES UNEXPECTEDLY IS PASSED THROUGH.
    /// </summary>
    /// <remarks>
    /// The probe is the thing meant to withhold values, and this is the second
    /// lock: a probe that was edited carelessly, or a page that answered with
    /// something else under the same keys, must not turn the reader into a
    /// conduit. Every field it reads is one it has a shape for, so a
    /// <c>value</c> nobody asked for has nowhere to go.
    /// </remarks>
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

        // It still described the page.
        Assert.Contains("password #pw", described, StringComparison.Ordinal);
    }

    /// <summary>
    /// A probe that answered with nothing usable says so, rather than producing
    /// an empty line somebody reads as "the page was blank".
    /// </summary>
    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("\"not a shape\"")]
    public void A_probe_that_answered_with_nothing_says_so(string json) =>
        Assert.Equal("the page described itself as nothing at all", PageShape.Describe(Shape(json)));

    /// <summary>
    /// Whatever the page is complaining about DOES come through, because it is
    /// the one piece of text somebody onboarding a provider cannot work
    /// without - a login that failed and a login that is waiting look identical
    /// otherwise.
    /// </summary>
    [Fact]
    public void What_the_page_is_complaining_about_comes_through()
    {
        var described = PageShape.Describe(Shape("""
        {"url":"https://x/","said":["De ingevoerde code is onjuist."]}
        """));

        Assert.Contains("says: De ingevoerde code is onjuist.", described, StringComparison.Ordinal);
    }

    /// <summary>
    /// THE BUTTON LIST NAMES ICON BUTTONS AND DROPS NOTHING.
    /// </summary>
    /// <remarks>
    /// Two live sign-outs were spent on a header this probe described as three
    /// buttons with no names: ASN's controls all report as
    /// <c>button[data-testid='button']</c> - a design system's component name
    /// where a handle should be - and the only thing telling them apart was the
    /// <c>aria-label</c> the probe was not reading. So the page read as having
    /// nothing on it, and the search that followed pressed them in the dark.
    /// <para>
    /// And the list used to DISCARD any button whose label ran past forty
    /// characters, silently - the same failure as the twelve-button cap that
    /// hid the account dialog's confirm, and reasoned from the same way: a
    /// control missing from the list reads as a control that is not on the
    /// page.
    /// </para>
    /// <para>
    /// PINNED IN THE SOURCE rather than run, and that is a real limitation. The
    /// probe is JavaScript evaluated in a browser and there is no browser here,
    /// so this asserts that the script still says what it should - the same
    /// thing <c>SelectorMissRuleTests</c> does for a trap that also could not
    /// be reached from a unit test.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_probe_names_icon_buttons_and_drops_none_of_them()
    {
        Assert.Contains("aria-label", PageShape.Script, StringComparison.Ordinal);

        Assert.DoesNotContain(
            ".filter(b => b.label.length < 40)",
            PageShape.Script,
            StringComparison.Ordinal);

        // The cap that remains says so when it bites, which is the difference
        // between a short list and a cut one.
        Assert.Contains("cut:", PageShape.Script, StringComparison.Ordinal);
    }
}
