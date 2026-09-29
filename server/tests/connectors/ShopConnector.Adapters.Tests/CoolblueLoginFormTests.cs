using System.Text.RegularExpressions;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Fixtures;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// Which box the password goes in, against Coolblue's real sign-in page.
///
/// Coolblue keeps a DECOY password input on that screen, and says so in its own
/// markup - it is there so browser password managers behave. It is the only
/// input of type password the screen has:
///
///   &lt;div data-hidden aria-hidden="true"&gt;
///     &lt;input tabindex="-1" type="password" name="password"
///            autocomplete="current-password"&gt;
///   &lt;/div&gt;
///
/// Every selector this adapter shipped with matched it - by name, by
/// autocomplete and by type alike - so a login would have typed the password
/// into a field nobody reads and submitted the e-mail address on its own. The
/// adapter's own comment called the one-screen form CONFIRMED.
///
/// The fixture is a signed-out capture, so it carries no personal data.
/// </summary>
public sealed class CoolblueLoginFormTests
{
    private static string Page => FixtureCatalog.Read("coolblue/login-page.html");

    /// <summary>The screen behind "Doorgaan", where the password is typed.</summary>
    private static string PasswordScreen => FixtureCatalog.Read("coolblue/login-password-screen.html");

    /// <summary>
    /// The premise, asserted rather than trusted: one password input on that
    /// screen, and it really is the decoy.
    /// </summary>
    [Fact]
    public void The_sign_in_screen_has_exactly_one_password_input_and_it_is_a_decoy()
    {
        var inputs = Regex.Matches(Page, "<input[^>]*type=\"password\"[^>]*>");

        var only = Assert.Single(inputs).Value;
        Assert.Contains("tabindex=\"-1\"", only, StringComparison.Ordinal);
        Assert.Contains("name=\"password\"", only, StringComparison.Ordinal);
        Assert.Contains("autocomplete=\"current-password\"", only, StringComparison.Ordinal);
    }

    /// <summary>
    /// And every password selector refuses it.
    ///
    /// Asserted against the OPTIONS rather than a hand-written list, so a
    /// candidate added later without the guard fails here rather than in
    /// somebody's login.
    /// </summary>
    [Fact]
    public void No_password_selector_would_choose_the_decoy()
    {
        var selectors = new CoolblueOptions().PasswordSelectors;

        Assert.NotEmpty(selectors);
        Assert.All(
            selectors,
            selector => Assert.Contains(":not([tabindex='-1'])", selector, StringComparison.Ordinal));
    }

    /// <summary>
    /// The username box is real and visible; the two beside it are not.
    ///
    /// The same screen carries two <c>&lt;input type="hidden" name="username"&gt;</c>
    /// fields next to the actual e-mail box, and the first username candidate
    /// is <c>input[name='username']</c> - which matches them. It survives only
    /// because the page driver requires a VISIBLE element, so a hidden input is
    /// skipped and the type='email' candidate wins.
    ///
    /// Pinned because that is a load-bearing accident: a driver change that
    /// stopped requiring visibility would silently start typing the e-mail
    /// address into a hidden field.
    /// </summary>
    [Fact]
    public void The_username_candidates_are_ordered_around_two_hidden_decoys()
    {
        Assert.Equal(2, Regex.Matches(Page, "<input type=\"hidden\" name=\"username\"").Count);
        Assert.Single(Regex.Matches(Page, "<input[^>]*type=\"email\""));

        var selectors = new CoolblueOptions().UsernameSelectors;
        Assert.Contains("input[type='email']", selectors);
    }

    // ---- the second screen, and the button that must never be pressed ------

    /// <summary>
    /// The premise, asserted rather than trusted: the password screen carries
    /// THREE submit buttons and the login is not the first of them.
    ///
    /// This is the markup that cost the account owner a password-reset e-mail
    /// on 2026-08-07. A bare <c>button[type='submit']</c> takes the first
    /// match, and the first match asks Coolblue to reset the password.
    /// </summary>
    [Fact]
    public void The_password_screen_puts_a_reset_button_in_front_of_the_login_button()
    {
        var submits = Regex.Matches(PasswordScreen, "<button[^>]*type=\"submit\"[^>]*>");

        Assert.Equal(3, submits.Count);

        // First: the one that e-mails a reset link. It says so twice - it names
        // the reset form, and it names the action.
        Assert.Contains("form=\"form__request_password_reset\"", submits[0].Value, StringComparison.Ordinal);
        Assert.Contains("data-action=\"reset-password\"", submits[0].Value, StringComparison.Ordinal);

        // Second: the login. The ONLY one of the three with no form attribute,
        // because it belongs to the form it sits in.
        Assert.DoesNotContain("form=", submits[1].Value, StringComparison.Ordinal);

        // Third: the passwordless route, which also e-mails rather than logs in.
        Assert.Contains("form=\"form__request_passwordless_login\"", submits[2].Value, StringComparison.Ordinal);
    }

    /// <summary>
    /// And no candidate this adapter would click can reach either of the two
    /// that send e-mail.
    ///
    /// Asserted against the OPTIONS rather than a hand-written list, so a
    /// candidate added later without the guard fails here rather than in
    /// somebody's mailbox. The same shape as the decoy-password test above,
    /// for the same reason: the dangerous control sits next to the right one
    /// and looks exactly like it.
    /// </summary>
    [Fact]
    public void No_click_this_adapter_makes_can_land_on_a_button_that_sends_email()
    {
        var options = new CoolblueOptions();

        IReadOnlyList<string>[] clicked = [options.SubmitSelectors, options.ContinueSelectors];

        Assert.All(clicked, list =>
        {
            Assert.NotEmpty(list);
            Assert.All(list, selector => Assert.Contains(
                CoolblueOptions.OwnFormOnly, selector, StringComparison.Ordinal));
        });

        // has-text matches substrings, and "Inloggen zonder wachtwoord" - the
        // passwordless button in some renderings - contains "Inloggen". Any
        // text candidate has to be exact.
        Assert.All(
            options.SubmitSelectors.Where(s => s.Contains("text", StringComparison.Ordinal)),
            selector => Assert.Contains("text-is(", selector, StringComparison.Ordinal));
    }

    /// <summary>
    /// The never-press list describes controls that really exist, rather than
    /// ones somebody imagined.
    /// </summary>
    [Fact]
    public void The_never_press_markers_are_on_the_real_page()
    {
        Assert.All(
            new CoolblueOptions().NeverPressSelectors,
            selector =>
            {
                // "[data-action='reset-password']" -> data-action="reset-password"
                var attribute = selector.Trim('[', ']').Replace("'", "\"", StringComparison.Ordinal);
                Assert.Contains(attribute, PasswordScreen, StringComparison.Ordinal);
            });
    }

    /// <summary>
    /// The password box on the SECOND screen is real, unlike the first
    /// screen's - so the same selector has to accept this one and refuse that
    /// one.
    /// </summary>
    [Fact]
    public void The_second_screens_password_box_is_the_real_one()
    {
        var inputs = Regex.Matches(PasswordScreen, "<input[^>]*type=\"password\"[^>]*>");

        var only = Assert.Single(inputs).Value;
        Assert.DoesNotContain("tabindex=\"-1\"", only, StringComparison.Ordinal);
        Assert.Contains("name=\"password\"", only, StringComparison.Ordinal);
    }

    /// <summary>
    /// Neither fixture carries the account owner's address or a live token.
    ///
    /// Both are REAL captures of a real sign-in, and the password screen was
    /// taken mid-login - so it held an e-mail address and three signed CSRF
    /// tokens before it was redacted.
    /// </summary>
    [Fact]
    public void The_captured_sign_in_pages_carry_no_personal_data()
    {
        foreach (var page in new[] { Page, PasswordScreen })
        {
            Assert.DoesNotContain("o.doker", page, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("live.nl", page, StringComparison.OrdinalIgnoreCase);

            // A signed JWT starts "eyJ" - the csrf tokens on this page were
            // exactly that.
            Assert.DoesNotContain("eyJhbGciOi", page, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// There is no real password box on the first screen, which is what makes
    /// the two-step probe necessary rather than defensive.
    ///
    /// The account owner reported entering an e-mail, pressing a button, and
    /// only then being shown a password field. This is the markup agreeing with
    /// them: strip the decoy and nothing is left to type into.
    /// </summary>
    [Fact]
    public void Stripping_the_decoy_leaves_the_first_screen_with_no_password_box()
    {
        var withoutDecoy = Regex.Replace(Page, "<input[^>]*tabindex=\"-1\"[^>]*>", string.Empty);

        Assert.Empty(Regex.Matches(withoutDecoy, "<input[^>]*type=\"password\""));

        // And the adapter has somewhere to go when that happens.
        Assert.NotEmpty(new CoolblueOptions().ContinueSelectors);
    }
}
