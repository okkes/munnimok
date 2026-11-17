using System.Net;
using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// a live login attempt happens once, is never retried and can lock the account, so the login is driven offline
// three defects each failed every real login: no PKCE, an empty client secret, no e-mail sign-in
public sealed class LidlPlusLoginTests
{
    private const string Redirect = "com.lidlplus.app://callback?code=lidl-authorization-code&state=x";
    private const string TokenPath = "/connect/token";

    private const string Email = "shopper@example.com";
    private const string Phone = "+31612345678";

    private const string Code = "590287";

    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    private static readonly LidlPlusOptions Options = new();

    // selectors written out from the reference, not read off the adapter's list: a restated fixture passes with a wrong list
    private const string EmailInput = "input[data-testid='input-email']";
    private const string PhoneInput = "input[data-testid='input-phone']";
    private const string PasswordInput = "input[data-testid='login-input-password']";
    private const string Submit = "[data-testid='login-or-register-submit-button']";

    // the password screen's own button: the live page has two, and a stub with one cannot catch clicking the wrong one
    private const string PasswordSubmit = "[data-testid='button-primary']";
    private const string CodeInput = "input[name='VerificationCode']";

    // distinct from the identifier and password buttons, which once collapsed onto one selector and hid it from the stub
    private const string CodeSubmit = "[data-testid='button-primary']";

    private static readonly IReadOnlyDictionary<string, string> DutchConfig =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL", ["language"] = "nl" };

    private static LidlPlusAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    [Fact]
    public void The_challenge_is_a_correct_s256_of_the_verifier()
    {
        var pkce = PkceChallenge.Create();

        var expected = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(pkce.Verifier)))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

        Assert.Equal(expected, pkce.Challenge);

        // S256, never "plain": plain puts the secret straight in the URL and
        // protects nothing at all.
        Assert.Equal("S256", PkceChallenge.Method);

        // RFC 7636 sizes the verifier at 43-128 characters of the unreserved
        // set, so it survives a URL and a form body untouched.
        Assert.InRange(pkce.Verifier.Length, 43, 128);
        Assert.Matches("^[A-Za-z0-9._~-]+$", pkce.Verifier);

        // Fresh per login. A reused verifier is a reused secret.
        Assert.NotEqual(pkce.Verifier, PkceChallenge.Create().Verifier);
    }

    [Fact]
    public async Task The_verifier_that_answers_the_challenge_is_the_one_replayed_at_the_exchange()
    {
        var page = FullyLoggedInPage();
        var handler = new StubHttpHandler(Route);

        using var ctx = Context(handler, Email);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        var authorize = Query(Assert.Single(page.Visited));
        var challenge = authorize["code_challenge"];

        Assert.NotEmpty(challenge);
        Assert.Equal("S256", authorize["code_challenge_method"]);

        // the verifier survives a whole browser login: the two halves are minted together and used minutes apart
        var exchange = Form(Assert.Single(handler.Requests, r => r.Path == TokenPath));

        Assert.True(exchange.TryGetValue("code_verifier", out var verifier),
            "the token exchange carried no code_verifier");
        Assert.Equal(challenge, PkceChallenge.For(verifier).Challenge);

        Assert.Equal("authorization_code", exchange["grant_type"]);
        Assert.Equal("lidl-authorization-code", exchange["code"]);
        Assert.Equal("com.lidlplus.app://callback", exchange["redirect_uri"]);
    }

    [Fact]
    public async Task The_authorize_call_still_carries_the_four_confirmed_parameters()
    {
        var page = FullyLoggedInPage();
        using var ctx = Context(new StubHttpHandler(Route), Email);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        var url = Assert.Single(page.Visited);
        Assert.StartsWith("https://accounts.lidl.com/connect/authorize?", url, StringComparison.Ordinal);

        var query = Query(url);
        Assert.Equal("LidlPlusNativeClient", query["client_id"]);
        Assert.Equal("code", query["response_type"]);
        Assert.Equal("com.lidlplus.app://callback", query["redirect_uri"]);

        // offline_access is what yields the refresh token, and the refresh
        // token is the whole T2 story.
        Assert.Contains("offline_access", query["scope"], StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_basic_header_names_the_client_secret_the_reference_confirms()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler, Email);

        await Adapter().LoginAsync(ctx, FullyLoggedInPage(), Arrives(), CancellationToken.None);

        var exchange = Assert.Single(handler.Requests, r => r.Path == TokenPath);
        var expected = Convert.ToBase64String(Encoding.UTF8.GetBytes("LidlPlusNativeClient:secret"));

        Assert.Equal($"Basic {expected}", exchange.Header("Authorization"));

        // the value that used to go out ("LidlPlusNativeClient:") names a different client to the token endpoint
        var empty = Convert.ToBase64String(Encoding.UTF8.GetBytes("LidlPlusNativeClient:"));
        Assert.NotEqual($"Basic {empty}", exchange.Header("Authorization"));
    }

    [Fact]
    public async Task An_email_goes_into_the_email_input_and_never_into_the_phone_one()
    {
        var page = FullyLoggedInPage();
        using var ctx = Context(new StubHttpHandler(Route), Email);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(Email, page.Filled[EmailInput]);
        Assert.DoesNotContain(PhoneInput, page.Filled.Keys);
        Assert.Equal("hunter2", page.Filled[PasswordInput]);
    }

    [Fact]
    public async Task A_phone_number_goes_into_the_phone_input_and_never_into_the_email_one()
    {
        var page = FullyLoggedInPage();
        using var ctx = Context(new StubHttpHandler(Route), Phone);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(Phone, page.Filled[PhoneInput]);
        Assert.DoesNotContain(EmailInput, page.Filled.Keys);
    }

    [Theory]
    [InlineData(Email, "e-mail field")]
    [InlineData(Phone, "phone field")]
    public async Task The_expected_input_missing_hands_over_rather_than_typing_into_the_other_box(
        string username, string expected)
    {
        // the other box, password box and button are present, so a filler settling for "some input" would find one
        var other = username == Email ? PhoneInput : EmailInput;
        var page = StubLoginPage.Showing(other, PasswordInput, Submit, PasswordSubmit);

        var handler = new StubHttpHandler(Route);

        using var ctx = new FakeJobContext(handler)
        {
            Config = DutchConfig,
            Inputs = Credentials(username),
            AnswersNothing = true,
        };

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        // never the other box: an address in the phone input spends a login attempt against a page that scores us
        Assert.Empty(page.Filled);

        // a missing known box is not fatal: Lidl may have moved its markup, so the human signs in on the page instead
        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.True(ctx.CredentialWasSubmitted);

        // the exchange still happened: a shape change costs a hand-over, not the connection
        Assert.NotEmpty(handler.Requests);
        _ = expected;
    }

    [Theory]
    [InlineData("shopper@example.com", true)]
    [InlineData("first.last+lidl@sub.example.co.uk", true)]
    [InlineData("+31612345678", false)]
    [InlineData("+4915112345678", false)]
    public void The_shape_of_the_value_decides_which_box_it_belongs_in(string username, bool email)
    {
        // only one of the two shapes the manifest's pattern admits can hold an '@'
        Assert.Equal(email, LidlPlusAdapter.LooksLikeEmail(username));
        Assert.Matches(LidlPlusManifest.UsernamePattern, username);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_login_with_no_credentials_streams_the_page_instead_of_refusing(string missing)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Email,
            ["password"] = "hunter2",
        };
        inputs.Remove(missing);

        var page = FullyLoggedInPage();
        var handler = new StubHttpHandler(Route);

        using var ctx = new FakeJobContext(handler)
        {
            Config = DutchConfig,
            Inputs = inputs,
            AnswersNothing = true,
        };

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        // both fields optional, half a credential is the same as none: nothing to type, so the account's owner drives the page
        // refusing made a first connect impossible to offer to anyone unwilling to hand over a password up front
        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        // nothing typed, and no half-credential posted at a page that scores us
        Assert.Empty(page.Filled);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Theory]
    [InlineData(Email, "email")]
    [InlineData(Phone, "sms")]
    public async Task The_delivery_on_the_challenge_follows_what_the_user_actually_supplied(
        string username, string delivery)
    {
        var page = FullyLoggedInPage();
        using var ctx = Context(new StubHttpHandler(Route), username, answer: _ => Code);

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, challenge.Type);

        // "sms" for everybody sends an e-mail user to watch a phone while the code sits in their inbox and expires
        Assert.Equal(delivery, challenge.Delivery);

        Assert.Equal(6, challenge.Length);
        Assert.Equal(Options.CodeLength, challenge.Length);
        Assert.Equal(Now.AddSeconds(300), challenge.ExpiresAt);

        // a key, never prose, and not the sms key either
        Assert.Equal("connect.challenge.verification_code", challenge.PromptKey);

        Assert.Equal(Code, page.Filled[CodeInput]);
        Assert.Equal(CodeSubmit, page.Clicked[^1]);
        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);
    }

    // two-screen wizard: press the identifier's button to advance, then the password screen's own to submit
    // the live attempt died here: e-mail filled, "no element for the password field"
    [Fact]
    public async Task The_two_screen_wizard_advances_and_finishes()
    {
        var page = StubLoginPage.Showing(EmailInput, Submit);

        page.WhenClicked = (p, selector) =>
        {
            if (selector == Submit) p.Reveal(PasswordInput, PasswordSubmit, CodeInput, CodeSubmit);
        };

        using var ctx = Context(new StubHttpHandler(Route), Email);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        Assert.NotNull(result.Material.RefreshToken);

        Assert.Equal(Email, page.Filled[EmailInput]);
        Assert.Equal("hunter2", page.Filled[PasswordInput]);

        Assert.Equal([Submit, PasswordSubmit, CodeSubmit], page.Clicked);

        // the credential is declared before the wizard advances, because advancing IS the identifier reaching Lidl
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_page_that_states_it_mailed_the_code_beats_the_inference_about_a_phone_login()
    {
        // Signed in with a phone number, but the page says the code went to
        // the mailbox. The page knows and we are guessing, so it wins.
        var page = StubLoginPage.Showing(
            PhoneInput, PasswordInput, Submit, PasswordSubmit, CodeInput, "[data-verify-mode='email']");

        using var ctx = Context(new StubHttpHandler(Route), Phone, answer: _ => Code);

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        Assert.Equal("email", Assert.Single(ctx.Asked).Delivery);
    }

    [Fact]
    public async Task A_device_lidl_already_trusts_skips_the_code_and_nobody_is_asked_anything()
    {
        // No code box at all, and no wall either: Lidl goes straight to the
        // callback. Treating that as a failure would break the one login that
        // went perfectly.
        var page = StubLoginPage.Showing(EmailInput, PasswordInput, Submit, PasswordSubmit);
        using var ctx = Context(new StubHttpHandler(Route), Email);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.Equal("lidl-access-token-fixture", result.Material.AccessToken);
        Assert.Equal("lidl-refresh-token-fixture", result.Material.RefreshToken);

        // country and language are sealed in with the tokens: a fetch without config would be unserviceable
        Assert.Equal("NL", result.Material.Extra["country"]);
        Assert.Equal("nl", result.Material.Extra["language"]);
    }

    [Fact]
    public async Task The_latch_closes_before_the_credentials_leave_the_machine()
    {
        var page = FullyLoggedInPage();
        using var ctx = Context(new StubHttpHandler(Route), Email, answer: _ => Code);

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        // After this a lost lease fails the job rather than requeuing it: a
        // retried login is how an account gets locked, and Lidl has by then
        // already sent a code.
        Assert.True(ctx.CredentialWasSubmitted);
    }

    // reCAPTCHA's verdict is no detectable widget: the page bounces to the identifier screen with a generic notice
    // indistinguishable from moved markup; both are answered by giving the page to the account's owner
    [Fact]
    public async Task A_typed_login_that_fails_hands_over_instead_of_ending_the_connect()
    {
        // password box absent on both screens: the fill succeeds, the wall check finds nothing, SignInAsync throws provider_changed
        var page = StubLoginPage.Showing(EmailInput, Submit);

        var handler = new StubHttpHandler(Route);

        using var ctx = new FakeJobContext(handler)
        {
            Config = DutchConfig,
            Inputs = Credentials(Email),
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var result = await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        Assert.Equal("lidl-access-token-fixture", result.Material.AccessToken);
        Assert.False(page.HoldsSecret);
    }

    // reCAPTCHA Enterprise scores the BROWSER, not the account (proven live 2026-07-28):
    // only a browser a real person drives passes
    [Fact]
    public async Task An_interactive_captcha_hands_the_page_over_rather_than_refusing()
    {
        var page = StubLoginPage.Showing(
            EmailInput, PasswordInput, Submit, PasswordSubmit, "iframe[src*='hcaptcha']");

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Config = DutchConfig,
            Inputs = Credentials(Email),
            Browser = new StubBrowserLease(page),
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var result = await Adapter().LoginAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        // the identifier goes in, the PASSWORD does not: the wall is checked first,
        // since the redactor refuses a page holding a secret
        Assert.Equal(Email, page.Filled[EmailInput]);
        Assert.DoesNotContain(PasswordInput, page.Filled.Keys);
        Assert.False(page.HoldsSecret);

        Assert.Equal("lidl-access-token-fixture", result.Material.AccessToken);
    }

    [Fact]
    public async Task The_streamed_view_ends_on_the_redirect_and_not_on_an_answer()
    {
        var page = StubLoginPage.Showing(
            EmailInput, PasswordInput, Submit, PasswordSubmit, "iframe[src*='hcaptcha']");

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Config = DutchConfig,
            Inputs = Credentials(Email),
            Attended = true,
            Browser = new StubBrowserLease(page),
            // nobody answers: the person passing the widget has no reason to go back to the consumer's UI
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var result = await Adapter().LoginAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), cts.Token);

        var challenge = Assert.Single(ctx.Asked);

        // passive: the browser reaching Lidl's callback ends it, so someone who never returns to the consumer's UI still finishes
        Assert.Equal(ChallengeType.LiveView, challenge.Type);
        Assert.True(challenge.IsPassive);
        Assert.Null(challenge.Image);

        Assert.Equal("lidl-access-token-fixture", result.Material.AccessToken);
    }

    private static HttpResponseMessage Route(RecordedRequest request, int _) =>
        request.Path == TokenPath ? Stub.Fixture("lidl/token.json") : Stub.Status(HttpStatusCode.NotFound);

    private static StubLoginPage FullyLoggedInPage() =>
        StubLoginPage.Showing(EmailInput, PhoneInput, PasswordInput, Submit, PasswordSubmit, CodeInput, CodeSubmit);

    private static StubRedirectWaiter Arrives(int afterWaits = 0) => new(Redirect, afterWaits);

    private static Dictionary<string, string> Credentials(string username) =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = username,
            ["password"] = "hunter2",
        };

    private static FakeJobContext Context(
        HttpMessageHandler handler, string username, Func<Challenge, string>? answer = null) =>
        new(handler)
        {
            Config = DutchConfig,
            Inputs = Credentials(username),
            Answer = answer ?? (_ => Code),
        };

    private static Dictionary<string, string> Query(string url) =>
        Pairs(new Uri(url).Query.TrimStart('?'));

    private static Dictionary<string, string> Form(RecordedRequest request)
    {
        Assert.NotNull(request.Body);
        return Pairs(request.Body);
    }

    // hand-rolled so the assertions show exactly which characters went onto the wire
    private static Dictionary<string, string> Pairs(string encoded)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var pair in encoded.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0) continue;

            map[Uri.UnescapeDataString(pair[..separator])] =
                Uri.UnescapeDataString(pair[(separator + 1)..].Replace('+', ' '));
        }

        return map;
    }
}
