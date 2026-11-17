using System.Text.RegularExpressions;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Fixtures;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// the sign-in page keeps a DECOY password input (the only type=password, tabindex -1, for password managers); every selector
// once matched it, typing the password where nobody reads; fixtures are signed-out captures with no personal data
public sealed partial class CoolblueLoginFormTests
{
    private static string Page => FixtureCatalog.Read("coolblue/login-page.html");

    private static string PasswordScreen => FixtureCatalog.Read("coolblue/login-password-screen.html");

    [GeneratedRegex("<input[^>]*type=\"password\"[^>]*>")]
    private static partial Regex PasswordInput();

    [GeneratedRegex("<input[^>]*type=\"password\"")]
    private static partial Regex PasswordInputOpening();

    [GeneratedRegex("<input type=\"hidden\" name=\"username\"")]
    private static partial Regex HiddenUsernameInput();

    [GeneratedRegex("<input[^>]*type=\"email\"")]
    private static partial Regex EmailInput();

    [GeneratedRegex("<input[^>]*tabindex=\"-1\"[^>]*>")]
    private static partial Regex UnfocusableInput();

    [GeneratedRegex("<button[^>]*type=\"submit\"[^>]*>")]
    private static partial Regex SubmitButton();

    [Fact]
    public void The_sign_in_screen_has_exactly_one_password_input_and_it_is_a_decoy()
    {
        var inputs = PasswordInput().Matches(Page);

        var only = Assert.Single(inputs).Value;
        Assert.Contains("tabindex=\"-1\"", only, StringComparison.Ordinal);
        Assert.Contains("name=\"password\"", only, StringComparison.Ordinal);
        Assert.Contains("autocomplete=\"current-password\"", only, StringComparison.Ordinal);
    }

    // asserted against the options, not a hand-written list: a candidate added without the guard fails here, not in a login
    [Fact]
    public void No_password_selector_would_choose_the_decoy()
    {
        var selectors = new CoolblueOptions().PasswordSelectors;

        Assert.NotEmpty(selectors);
        Assert.All(
            selectors,
            selector => Assert.Contains(":not([tabindex='-1'])", selector, StringComparison.Ordinal));
    }

    // two hidden username inputs match input[name='username']; it works only because the driver requires a VISIBLE element
    // (a load-bearing accident)
    [Fact]
    public void The_username_candidates_are_ordered_around_two_hidden_decoys()
    {
        Assert.Equal(2, HiddenUsernameInput().Count(Page));
        Assert.Single(EmailInput().Matches(Page));

        var selectors = new CoolblueOptions().UsernameSelectors;
        Assert.Contains("input[type='email']", selectors);
    }

    // a bare button[type='submit'] takes the first match, which asks Coolblue to reset the password
    // (it cost the account owner a reset e-mail)
    [Fact]
    public void The_password_screen_puts_a_reset_button_in_front_of_the_login_button()
    {
        var submits = SubmitButton().Matches(PasswordScreen);

        Assert.Equal(3, submits.Count);

        Assert.Contains("form=\"form__request_password_reset\"", submits[0].Value, StringComparison.Ordinal);
        Assert.Contains("data-action=\"reset-password\"", submits[0].Value, StringComparison.Ordinal);

        Assert.DoesNotContain("form=", submits[1].Value, StringComparison.Ordinal);

        Assert.Contains("form=\"form__request_passwordless_login\"", submits[2].Value, StringComparison.Ordinal);
    }

    // asserted against the options so a candidate added without the guard fails here, not in somebody's mailbox
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

        // has-text matches substrings and "Inloggen zonder wachtwoord" contains "Inloggen": text candidates must be exact
        Assert.All(
            options.SubmitSelectors.Where(s => s.Contains("text", StringComparison.Ordinal)),
            selector => Assert.Contains("text-is(", selector, StringComparison.Ordinal));
    }

    [Fact]
    public void The_never_press_markers_are_on_the_real_page()
    {
        Assert.All(
            new CoolblueOptions().NeverPressSelectors,
            selector =>
            {
                var attribute = selector.Trim('[', ']').Replace("'", "\"", StringComparison.Ordinal);
                Assert.Contains(attribute, PasswordScreen, StringComparison.Ordinal);
            });
    }

    [Fact]
    public void The_second_screens_password_box_is_the_real_one()
    {
        var inputs = PasswordInput().Matches(PasswordScreen);

        var only = Assert.Single(inputs).Value;
        Assert.DoesNotContain("tabindex=\"-1\"", only, StringComparison.Ordinal);
        Assert.Contains("name=\"password\"", only, StringComparison.Ordinal);
    }

    // both fixtures are real captures; the password screen was taken mid-login,
    // with an e-mail address and three signed CSRF tokens before redaction
    [Fact]
    public void The_captured_sign_in_pages_carry_no_personal_data()
    {
        foreach (var page in new[] { Page, PasswordScreen })
        {
            Assert.DoesNotContain("o.doker", page, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("live.nl", page, StringComparison.OrdinalIgnoreCase);

            // a signed JWT starts "eyJ"; the CSRF tokens were JWTs
            Assert.DoesNotContain("eyJhbGciOi", page, StringComparison.Ordinal);
        }
    }

    // no real password box on the first screen is why the two-step probe is necessary
    [Fact]
    public void Stripping_the_decoy_leaves_the_first_screen_with_no_password_box()
    {
        var withoutDecoy = UnfocusableInput().Replace(Page, string.Empty);

        Assert.Empty(PasswordInputOpening().Matches(withoutDecoy));

        Assert.NotEmpty(new CoolblueOptions().ContinueSelectors);
    }
}
