using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// jumbo.com/inloggen is a 404; the live chain is /account/inloggen, /api/auth/login, then Auth0 Universal Login on another
// host, so a "URL says inloggen" test could never say yes
public sealed class JumboLoginTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    private const string Signed = "https://www.jumbo.com/mijn-jumbo/bestellingen";

    private static readonly string[] FormControls = ["input#username", "input#password", "button[type='submit']"];

    private static JumboAdapter Adapter(JumboOptions? options = null) =>
        new(options ?? new JumboOptions(), new FakeJumboGraphQl(), new FixedTimeProvider(Now));

    // answersNothing: a live view is passive (no string to type back), so the human acts unobserved and never returns an answer
    private static FakeJobContext Context(
        StubLoginPage page, string? storageState = null, bool attended = false, bool answersNothing = false) =>
        new()
        {
            Inputs = JumboFixtures.Credentials,
            Browser = new JumboBrowserLease(page, storageState),
            Attended = attended,
            AnswersNothing = answersNothing,
        };

    private static StubLoginPage FormPage(params string[] extra) =>
        StubLoginPage.Showing([.. FormControls, .. extra]);

    // confirmed live 2026-07-28: the old address 404s and the page it ends on is not on jumbo.com,
    // so an "inloggen" marker never matched
    [Fact]
    public void The_login_starts_at_the_address_that_still_exists()
    {
        var options = new JumboOptions();

        Assert.Equal("https://www.jumbo.com/account/inloggen", options.LoginUrl);
        Assert.Contains("auth.jumbo.com", options.LoginUrlMarkers);
        Assert.Contains("/u/login", options.LoginUrlMarkers);
    }

    [Theory]
    [InlineData("https://www.jumbo.com/account/inloggen", false)]
    [InlineData("https://www.jumbo.com/api/auth/login?sourceUrl=/", false)]
    [InlineData("https://auth.jumbo.com/authorize?client_id=rWRgjhmeqWGeMLyJwf2Zf863o18XiDk0", false)]
    [InlineData("https://auth.jumbo.com/u/login?state=abc", false)]
    [InlineData("about:blank", false)]
    [InlineData("https://www.jumbo.com/", true)]
    [InlineData("https://www.jumbo.com/mijn-jumbo/bestellingen", true)]
    public void A_session_exists_only_back_on_the_shop_and_off_every_login_marker(string url, bool signedIn)
    {
        // Both halves matter: auth.jumbo.com ends in the shop's own domain but
        // is the login, and about:blank is on neither.
        Assert.Equal(signedIn, JumboReturnWatcher.IsSignedIn(url, new JumboOptions()));
    }

    [Fact]
    public async Task A_login_navigates_to_the_login_url_types_both_credentials_and_seals_the_cookies()
    {
        var page = FormPage();
        using var ctx = Context(page);

        var result = await Adapter().LoginAsync(
            ctx, page, new StubRedirectWaiter(Signed, afterWaits: 0), CancellationToken.None);

        Assert.Equal("https://www.jumbo.com/account/inloggen", Assert.Single(page.Visited));
        Assert.Equal("shopper@example.test", page.Filled["input#username"]);
        Assert.Equal("correct horse battery staple", page.Filled["input#password"]);
        Assert.Contains("button[type='submit']", page.Clicked);

        Assert.NotNull(result.Material.StorageState);
        Assert.False(string.IsNullOrWhiteSpace(result.Material.DeviceId));

        // Stated from this login rather than left to the manifest, so the
        // consumer's countdown starts now.
        Assert.Equal(Now.AddSeconds(86_400), result.ExpiresAt);
    }

    // the latch stops a lost lease requeuing a login that may already have counted against the account
    [Fact]
    public async Task The_credential_latch_is_set_before_anything_is_submitted()
    {
        var page = FormPage();
        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, afterWaits: 0), CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);
    }

    // a box that moved is handed to the human rather than failed, nothing typed so nothing counted.
    // a hanging page is handed over too, else it surfaced as "something went wrong on munni's side"
    [Fact]
    public async Task A_page_that_will_not_settle_is_handed_over_rather_than_blamed_on_munni()
    {
        var page = FormPage();
        page.FillThrows = new TimeoutException("Timeout 15000ms exceeded.");
        using var ctx = Context(page, answersNothing: true);

        var result = await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Contains(ctx.Notes, n => n.Contains("handed over", StringComparison.Ordinal));
        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task A_missing_username_box_hands_the_page_over_rather_than_failing()
    {
        var page = StubLoginPage.Showing("button[type='submit']");
        using var ctx = Context(page, answersNothing: true);

        var result = await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.NotNull(result.Material.StorageState);
    }

    // Auth0 may use two screens: the identifier is submitted to reach the second,
    // so the latch is already down when no password box shows
    [Fact]
    public async Task A_password_box_on_neither_screen_hands_over_with_the_latch_already_down()
    {
        var page = StubLoginPage.Showing("input#username", "button[type='submit']");
        using var ctx = Context(page, answersNothing: true);

        var result = await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        Assert.True(ctx.CredentialWasSubmitted);
        Assert.NotNull(result.Material.StorageState);
    }

    // both credentials are optional: none is a first connect, the page is streamed to the person who has one
    [Fact]
    public async Task A_login_with_no_credentials_streams_the_page_instead_of_refusing()
    {
        var page = FormPage();
        using var ctx = new FakeJobContext
        {
            AnswersNothing = true,
            Browser = new JumboBrowserLease(page),
        };

        var result = await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.Empty(page.Filled);
        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task A_stated_credential_error_is_the_only_path_to_invalid_credentials()
    {
        var page = FormPage(":text('Verkeerde e-mail of wachtwoord')");
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(null, 99), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
    }

    // silence is handed to the human, never called a wrong password: that sends the user to reset a fine one
    // and credential errors are never retried
    [Fact]
    public async Task Silence_hands_the_page_over_and_is_never_a_wrong_password()
    {
        var page = FormPage();
        using var ctx = Context(page, answersNothing: true);

        var result = await Adapter(new JumboOptions { LoginSettleSeconds = 0 })
            .LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 1), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task A_login_that_leaves_no_jumbo_cookies_is_a_shape_change()
    {
        var page = FormPage();
        using var ctx = Context(page, storageState: """{"cookies":[],"origins":[]}""");

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("no jumbo.com cookies", error.Detail, StringComparison.Ordinal);
    }

    // Auth0 activates hCaptcha, reCAPTCHA or Turnstile on risk score; none can be relayed
    // (the token is minted in the widget's own JS); a pooled agent has nobody to ask
    [Fact]
    public async Task An_interactive_widget_hands_the_page_to_the_human_who_can_pass_it()
    {
        var page = FormPage("iframe[src*='hcaptcha']");
        using var ctx = Context(page, answersNothing: true);

        var result = await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, 0), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.NotNull(result.Material.StorageState);

        // the password never went into the box: the redactor refuses to photograph a page holding one
        Assert.DoesNotContain("input#password", page.Filled.Keys);
        Assert.False(page.HoldsSecret);
    }

    [Fact]
    public async Task A_picture_captcha_is_relayed_only_after_the_password_leaves_the_dom()
    {
        var page = FormPage("img[alt*='captcha' i]", "input[name='captcha']");

        using var ctx = new FakeJobContext
        {
            Inputs = JumboFixtures.Credentials,
            Browser = new JumboBrowserLease(page),
            Answer = _ => "8421",
        };

        var result = await Adapter().LoginAsync(
            ctx, page, new StubRedirectWaiter(Signed, afterWaits: 1), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.Image, challenge.Type);
        Assert.NotNull(challenge.Image);
        Assert.Equal("8421", page.Answered);

        // the redactor produces no bytes while a secret is on the page, so a delivered picture proves the clearing came first
        var calls = page.Calls.ToList();
        var clear = calls.IndexOf("clear-secrets");
        var shot = calls.IndexOf("screenshot");
        Assert.True(clear >= 0 && clear < shot, "the password must leave the DOM before anything photographs it");

        Assert.NotNull(result.Material.StorageState);
    }

    // relayed, never guessed; the prompt does not claim how the code arrived
    [Fact]
    public async Task A_one_time_code_is_relayed_to_the_human()
    {
        var page = FormPage("input[name='code']");

        using var ctx = new FakeJobContext
        {
            Inputs = JumboFixtures.Credentials,
            Browser = new JumboBrowserLease(page),
            Answer = _ => "123456",
        };

        await Adapter().LoginAsync(ctx, page, new StubRedirectWaiter(Signed, afterWaits: 1), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, challenge.Type);
        Assert.Equal("connect.challenge.verification_code", challenge.PromptKey);

        // no delivery claim: Auth0 sends the code however the account is configured,
        // and pointing at a phone that never rings is unrecoverable
        Assert.Null(challenge.Delivery);

        Assert.Equal("123456", page.Answered);
    }
}
