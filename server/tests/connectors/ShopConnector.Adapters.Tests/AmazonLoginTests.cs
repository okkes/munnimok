using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// each branch decides how a human is treated and is unreachable without live Chromium; a real login can be spent about once
public sealed class AmazonLoginTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private static readonly AmazonOptions Options = new();

    private const string Email = "input#ap_email";
    private const string Password = "input#ap_password";
    private const string Continue = "input#continue";
    private const string Submit = "input#signInSubmit";
    private const string Otp = "input#auth-mfa-otpcode";
    private const string OtpSubmit = "input#auth-signin-button";

    private static AmazonAdapter Adapter(AmazonOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    /// a fixed clock makes every deadline-bounded wait unbounded: a mutation hangs the suite instead of failing
    /// use this where something must be FOUND
    private static AmazonAdapter Ticking(AmazonOptions? options = null) =>
        new(options ?? Options, new TickingClock(Now, TimeSpan.FromSeconds(5)));

    /// restored: the browser was opened with the bundle's cookie jar (a refresh); only then does SessionProbe ask
    private static FakeJobContext Context(
        AmazonStubPage page, bool attended = false, bool restored = false) => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "j.devries@example.nl",
            ["password"] = "correct horse battery staple",
        },
        Browser = new AmazonStubBrowser(page),
        Attended = attended,
        KeepsSession = restored,
    };

    /// production's waiter never signals (amazon.nl has no callback): success is the form gone and the URL on the order list
    private static StubRedirectWaiter Never() => new(null, int.MaxValue);

    [Fact]
    public async Task The_sign_in_starts_at_the_order_list_and_never_at_a_hand_built_openid_url()
    {
        // the reference's hardcoded openid.assoc_handle=usflex is a US value; the order list lets amazon.nl build its own chain
        var page = AmazonStubPage.Showing(Email, Password, Submit).SignedInAfter(Submit);
        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var first = Assert.Single(page.Visited);
        Assert.StartsWith("https://www.amazon.nl/your-orders/orders", first, StringComparison.Ordinal);
        Assert.DoesNotContain("assoc_handle", first, StringComparison.Ordinal);
        Assert.DoesNotContain("openid", first, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_password_screen_is_reached_by_advancing_the_wizard()
    {
        // address and password are on two screens: probed, so a single-screen form works too
        var page = AmazonStubPage
            .Showing(Email, Continue)
            .RevealingAfter(Continue, Password, Submit)
            .SignedInAfter(Submit);

        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Equal("j.devries@example.nl", page.Filled[Email]);
        Assert.Equal("correct horse battery staple", page.Filled[Password]);

        string[] wizard = [Continue, Submit];
        Assert.Equal(wizard, page.Clicked);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_single_screen_form_is_filled_without_advancing_anything()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit).SignedInAfter(Submit);
        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        // on a one-screen form clicking continue would submit the wrong thing
        string[] once = [Submit];
        Assert.Equal(once, page.Clicked);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task Advancing_the_wizard_latches_the_credential_before_the_click_not_after()
    {
        // the latch precedes the click: a lease lost here must fail the job, not requeue a login that may have reached Amazon
        var page = AmazonStubPage.Showing(Email);
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("continue button", error.Detail, StringComparison.Ordinal);
        Assert.True(ctx.CredentialWasSubmitted, "the identifier had already gone upstream");
    }

    [Fact]
    public async Task A_missing_email_field_is_a_shape_change_and_costs_no_login_attempt()
    {
        var page = AmazonStubPage.Showing(Submit);
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("e-mail field", error.Detail, StringComparison.Ordinal);
        Assert.Contains("ap_email", error.Detail, StringComparison.Ordinal);

        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Filled);
    }

    [Fact]
    public async Task A_session_that_is_already_signed_in_costs_no_credential_at_all()
    {
        // a password typed at a page that never asked is a login attempt spent for nothing
        var page = AmazonStubPage.Showing();
        page.Url = "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

        using var ctx = Context(page, restored: true);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.False(ctx.CredentialWasSubmitted, "this job is still safe to requeue");
    }

    /// a first connect has no profile dir and no cookie jar: SessionProbe answers "cannot tell" without its two ProbeMs probes
    [Fact]
    public async Task A_first_connect_is_never_asked_whether_it_is_already_signed_in()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit).SignedInAfter(Submit);
        page.Url = "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        // no look at the page before the e-mail goes in: a probe would be ProbeMs of pure latency on a browser handed nothing
        Assert.Equal("fill", page.Calls[0]);

        // it signed in the ordinary way: the fallthrough "cannot tell" is defined to produce
        Assert.Equal("j.devries@example.nl", page.Filled[Email]);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task The_one_time_code_is_relayed_to_the_human_and_never_solved()
    {
        var page = AmazonStubPage
            .Showing(Email, Password, Submit, ":text('tekstbericht')")
            .RevealingAfter(Submit, Otp, OtpSubmit)
            .SignedInAfter(OtpSubmit);

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Answer = challenge => challenge.Type == ChallengeType.MfaCode
                ? "314159"
                : throw new InvalidOperationException($"unexpected challenge {challenge.Type}"),
        };

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, asked.Type);
        Assert.Equal(6, asked.Length);
        Assert.Equal("sms", asked.Delivery);
        Assert.StartsWith("connect.", asked.PromptKey, StringComparison.Ordinal);

        Assert.Equal("314159", page.Filled[Otp]);
        Assert.Contains(OtpSubmit, page.Clicked);
    }

    [Fact]
    public async Task A_code_whose_delivery_the_page_does_not_state_is_left_generic()
    {
        // "the code we texted you" sends an authenticator-app user to a phone that never buzzes, and the challenge expires
        var page = AmazonStubPage
            .Showing(Email, Password, Submit)
            .RevealingAfter(Submit, Otp, OtpSubmit)
            .SignedInAfter(OtpSubmit);

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Answer = _ => "271828",
        };

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Null(Assert.Single(ctx.Asked).Delivery);
    }

    [Fact]
    public async Task Only_a_stated_credential_error_ever_reports_a_wrong_password()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit, "#auth-password-invalid-password-alert");
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task A_locked_account_is_a_refusal_and_not_a_wrong_password()
    {
        // a locked account renders both alerts: reporting a credential error is permanent, since nothing retries it
        var page = AmazonStubPage.Showing(
            Email, Password, Submit, "#auth-account-locked-alert", "#auth-password-invalid-password-alert");

        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task Silence_after_the_submit_is_a_shape_change_and_never_a_guess_at_the_password()
    {
        // the settle budget is zero because the suite's clock does not move: a frozen clock never reaches the deadline
        var page = AmazonStubPage.Showing(Email, Password, Submit);
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { LoginSettleSeconds = 0 })
                .LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.Contains("neither reached the order list", error.Detail, StringComparison.Ordinal);

        // the page must be photographable on exit: the redactor refuses while a secret field holds content
        Assert.False(page.HoldsSecret);
        Assert.Contains("clear-secrets", page.Calls);
    }

    /// a pooled agent streams the wall: the live view puts the page in front of the person who asked, and their clicks go back
    [Fact]
    public async Task An_unattended_agent_streams_the_widget_instead_of_refusing_it()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit, "#aa-challenge-page-captcha-container");

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Attended = false,
            Answer = _ =>
            {
                page.SignIn();
                return string.Empty;
            },
        };

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.LiveView, asked.Type);

        // nothing to type back: the widget hands its token to Amazon, so the page moving is the only observation
        Assert.True(asked.IsPassive);

        // the redactor refuses to photograph a page holding a secret: clearing it is what makes the view possible
        Assert.False(page.HoldsSecret);
        Assert.Contains("clear-secrets", page.Calls);
    }

    /// the passkey nudge (/ax/claim/webauthn/nudge) follows an accepted password; served to the pooled browser, not desktop
    [Fact]
    public async Task The_passkey_nudge_is_declined_and_the_sign_in_finishes()
    {
        var page = AmazonStubPage.Showing(
            Email, Password, Submit, "input[aria-labelledby*='nudge-not-now']");

        page.Url = "https://www.amazon.nl/ax/claim/webauthn/nudge?openid.mode=checkid_setup";

        page.SignedInAfter("input[aria-labelledby*='nudge-not-now']");

        using var ctx = Context(page, attended: false);

        // bounded: with a fixed clock a settle loop that never resolves never reaches its deadline
        await Ticking().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Contains(page.Clicked, c => c.Contains("nudge-not-now", StringComparison.Ordinal));

        Assert.Empty(ctx.Asked);
    }

    /// declining must return true, which restarts the settle budget; a version returning false passed every other test
    [Fact]
    public async Task Declining_says_it_acted_so_the_budget_restarts()
    {
        var nudge = AmazonStubPage.Showing("input[aria-labelledby*='nudge-not-now']");
        nudge.Url = "https://www.amazon.nl/ax/claim/webauthn/nudge?openid.mode=checkid_setup";

        Assert.True(await Adapter().DeclinePasskeyAsync(nudge, CancellationToken.None));
        Assert.Contains(nudge.Clicked, c => c.Contains("nudge-not-now", StringComparison.Ordinal));

        // a refusal button only means "decline the passkey" on the page that offered one
        var elsewhere = AmazonStubPage.Showing("input[aria-labelledby*='nudge-not-now']");
        elsewhere.Url = "https://www.amazon.nl/ap/signin?openid.mode=checkid_setup";

        Assert.False(await Adapter().DeclinePasskeyAsync(elsewhere, CancellationToken.None));
        Assert.Empty(elsewhere.Clicked);
    }

    /// the nudge also offers setting up or using a passkey, which would register a credential on the account:
    /// only refusals are clickable
    [Fact]
    public void The_passkey_options_that_enrol_a_credential_are_not_clickable()
    {
        var options = new AmazonOptions();

        Assert.All(options.PasskeyDeclineSelectors, selector =>
        {
            Assert.DoesNotContain("setup", selector, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("existing", selector, StringComparison.OrdinalIgnoreCase);
        });

        Assert.All(options.PasskeyDeclineSelectors, selector =>
            Assert.True(
                selector.Contains("not-now", StringComparison.Ordinal)
                || selector.Contains("skip", StringComparison.Ordinal),
                $"'{selector}' is neither a 'not now' nor a 'skip'"));
    }

    /// a nudge nobody can dismiss falls through to the wall check, which streams the page for a human to answer
    [Fact]
    public async Task A_nudge_with_no_refusal_on_it_is_handed_to_the_human()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit);
        page.Url = "https://www.amazon.nl/ap/cvf/request?arb=1";

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Answer = _ =>
            {
                page.SignIn();
                return string.Empty;
            },
        };

        await Ticking().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    /// markup is checked as well as the URL: without this the CVF selectors could be deleted and the URL would cover for them
    [Fact]
    public async Task The_verification_widget_is_a_wall_wherever_it_is_mounted()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit, "#cvf-aamation-challenge-iframe");

        // not a /ap/cvf URL, so the URL check cannot answer
        page.Url = "https://www.amazon.nl/ap/signin?openid.mode=checkid_setup";

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Answer = _ =>
            {
                page.SignIn();
                return string.Empty;
            },
        };

        await Ticking().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    /// /ap/cvf/request draws its challenge in an iframe: a poll before it appears sees no selector, so the URL marks the wall
    [Fact]
    public async Task The_verification_flow_is_a_wall_even_before_its_iframe_draws()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit);
        page.Url = "https://www.amazon.nl/ap/cvf/request?arb=1234";

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Answer = _ =>
            {
                page.SignIn();
                return string.Empty;
            },
        };

        // bounded so the test fails instead of hanging; zero seconds still runs one pass, the deadline is checked at the loop's end
        await Ticking().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    [Fact]
    public async Task An_attended_browser_is_asked_to_pass_the_widget_itself()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit, "#aa-challenge-page-captcha-container");

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new AmazonStubBrowser(page),
            Attended = true,
            // the page changing is the only observation: a widget hands its token to the provider
            Answer = _ =>
            {
                page.SignIn();
                return string.Empty;
            },
        };

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.LiveView, asked.Type);
        Assert.True(asked.IsPassive);
    }

    [Fact]
    public async Task An_image_captcha_is_relayed_only_after_the_password_has_left_the_page()
    {
        // the redactor refuses a page holding a secret, so a picture coming back proves the credentials were cleared first
        var page = AmazonStubPage
            .Showing(Email, Password, Submit, "#auth-captcha-image", "input#auth-captcha-guess")
            .SignedInAfterAnswer();

        var browser = new AmazonStubBrowser(page);
        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = browser,
            Answer = challenge => challenge.Type == ChallengeType.Image
                ? "MKPHTX"
                : throw new InvalidOperationException($"unexpected challenge {challenge.Type}"),
        };

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.Image, asked.Type);
        Assert.NotNull(asked.Image);
        Assert.NotEmpty(asked.Image);

        Assert.Equal(1, browser.Captures);
        Assert.False(page.HoldsSecret);

        // credentials are not resubmitted: a second submission of a password that may have counted is how an account gets locked
        Assert.Equal("MKPHTX", page.Answered);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_missing_credential_is_refused_before_a_browser_is_ever_leased(string missing)
    {
        var inputs = Credentials();
        inputs.Remove(missing);

        var page = AmazonStubPage.Showing(Email, Password, Submit);
        using var ctx = new FakeJobContext { Inputs = inputs, Browser = new AmazonStubBrowser(page) };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Visited);
    }

    private static Dictionary<string, string> Credentials() => new(StringComparer.Ordinal)
    {
        ["username"] = "j.devries@example.nl",
        ["password"] = "correct horse battery staple",
    };
}

/// moves on every read, so bounded loops end even when the page is not recognised (FixedTimeProvider would hang them)
internal sealed class TickingClock(DateTimeOffset start, TimeSpan step) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow()
    {
        _now += step;
        return _now;
    }
}
