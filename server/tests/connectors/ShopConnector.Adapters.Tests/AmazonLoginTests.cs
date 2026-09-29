using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// Amazon's sign-in chain, offline.
///
/// Every branch here decides how a human is treated - whether a wall is
/// relayed or refused, whether silence is called a wrong password, whether a
/// credential that already went upstream can be sent again - and none of them
/// is reachable without a live Chromium and a real account. On this platform a
/// real Amazon login attempt is something that can be spent about once, so the
/// decisions live behind a seam and are asserted here instead.
/// </summary>
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

    /// <summary>
    /// The same adapter on a clock that MOVES.
    ///
    /// Every wait in this login is bounded by a deadline, so a fixed clock
    /// makes those loops unbounded: a mutation that stops a page being
    /// recognised does not turn its test red, it hangs the whole suite. That
    /// is not theoretical - it killed a bite-check run mid-way and left the
    /// mutated source sitting in the tree, which is the one thing a mutation
    /// run must never do.
    ///
    /// A test that asserts something is FOUND should use this, so that failing
    /// to find it ends.
    /// </summary>
    private static AmazonAdapter Ticking(AmazonOptions? options = null) =>
        new(options ?? Options, new TickingClock(Now, TimeSpan.FromSeconds(5)));

    /// <param name="restored">
    /// Whether this job's browser was opened with the bundle's cookie jar in
    /// it, which is what a refresh looks like. Only then is "are we already
    /// signed in?" a question with two possible answers, and only then does
    /// <c>SessionProbe</c> ask it.
    /// </param>
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

    /// <summary>
    /// The waiter production actually passes: amazon.nl has no callback the
    /// browser cannot follow, so nothing ever arrives here and the page itself
    /// is what says whether the sign-in worked. Every test below therefore
    /// drives success the way a live run does - the form goes away and the URL
    /// becomes the order list - rather than through a signal this provider
    /// does not have.
    /// </summary>
    private static StubRedirectWaiter Never() => new(null, int.MaxValue);

    // ---- the entry point ---------------------------------------------------

    [Fact]
    public async Task The_sign_in_starts_at_the_order_list_and_never_at_a_hand_built_openid_url()
    {
        // The reference hardcodes openid.assoc_handle=usflex - a US value its
        // own docstring admits is not adjusted for other domains - and has no
        // 'nl' entry in either its region-language or region-currency table.
        // Navigating to the order list instead lets amazon.nl build its own
        // sign-in chain with its own parameters.
        var page = AmazonStubPage.Showing(Email, Password, Submit).SignedInAfter(Submit);
        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        var first = Assert.Single(page.Visited);
        Assert.StartsWith("https://www.amazon.nl/your-orders/orders", first, StringComparison.Ordinal);
        Assert.DoesNotContain("assoc_handle", first, StringComparison.Ordinal);
        Assert.DoesNotContain("openid", first, StringComparison.Ordinal);
    }

    // ---- the two screens ---------------------------------------------------

    [Fact]
    public async Task The_password_screen_is_reached_by_advancing_the_wizard()
    {
        // Amazon asks for the address and the password on two screens. Probed
        // rather than assumed, so a single-screen form still works and neither
        // layout needs a release.
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

        // The continue button is never touched: on a one-screen form clicking
        // it would submit the wrong thing.
        string[] once = [Submit];
        Assert.Equal(once, page.Clicked);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task Advancing_the_wizard_latches_the_credential_before_the_click_not_after()
    {
        // The button is gone, so the click fails - and the e-mail address had
        // already been typed for it. The latch has to have happened BEFORE the
        // click, because a lease lost at exactly this point must fail the job
        // rather than requeue a login that may already have reached Amazon.
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

        // Nothing was typed anywhere, so nothing was spent.
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Filled);
    }

    [Fact]
    public async Task A_session_that_is_already_signed_in_costs_no_credential_at_all()
    {
        // The lease restored a session that still works. Typing a password at
        // a page that never asked for one is a login attempt spent for nothing.
        var page = AmazonStubPage.Showing();
        page.Url = "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

        using var ctx = Context(page, restored: true);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.False(ctx.CredentialWasSubmitted, "this job is still safe to requeue");
    }

    /// <summary>
    /// AND THE QUESTION IS NOT EVEN ASKED OF A BROWSER THAT WAS HANDED
    /// NOTHING.
    /// </summary>
    /// <remarks>
    /// The same page as the test above, standing on the order list, on a first
    /// connect: no profile directory - Amazon runs on the pooled fleet, which
    /// gets none - and no cookie jar out of the bundle, because there is no
    /// bundle yet. Nothing could be holding a session, so <c>SessionProbe</c>
    /// answers "cannot tell" without looking, and the ordinary sign-in runs.
    /// <para>
    /// What the gate buys on this provider is the two form probes below, each
    /// <c>ProbeMs</c> long, on every single first connect - the one run
    /// somebody is sitting and watching - to learn an answer that was never in
    /// doubt. What it must never cost is the refresh case, which is the test
    /// above: that browser IS handed the jar, and the gate opens for it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_first_connect_is_never_asked_whether_it_is_already_signed_in()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit).SignedInAfter(Submit);
        page.Url = "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

        using var ctx = Context(page);

        await Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None);

        // NOT ONE LOOK AT THE PAGE BEFORE THE E-MAIL GOES IN. The check's
        // first move on an order-list address is to probe for a credential
        // box, so a gate that let it run would put a "find" ahead of this
        // "fill" - and that probe is ProbeMs of pure latency on a browser
        // that was handed nothing.
        Assert.Equal("fill", page.Calls[0]);

        // It signed in the ordinary way, which is the fallthrough "cannot
        // tell" is defined to produce.
        Assert.Equal("j.devries@example.nl", page.Filled[Email]);
        Assert.True(ctx.CredentialWasSubmitted);
    }

    // ---- the one-time code -------------------------------------------------

    [Fact]
    public async Task The_one_time_code_is_relayed_to_the_human_and_never_solved()
    {
        // The code screen appears only after the password is submitted, and
        // the order list only after the code is.
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

        // Typed into Amazon's own box; nothing was computed from a stored
        // shared secret, because no such field exists on this provider.
        Assert.Equal("314159", page.Filled[Otp]);
        Assert.Contains(OtpSubmit, page.Clicked);
    }

    [Fact]
    public async Task A_code_whose_delivery_the_page_does_not_state_is_left_generic()
    {
        // A prompt that says "the code we texted you" to somebody whose code is
        // in an authenticator app sends them to stare at a phone that will
        // never buzz, and the challenge expires while they wait. Worse copy,
        // better outcome.
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

    // ---- verdicts ----------------------------------------------------------

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
        // Both alerts are on the page, which is what Amazon actually renders
        // when it locks an account after a sign-in attempt. Reporting a
        // credential error here sends somebody to change a password that is
        // fine and will not help - and nothing retries a credential error, so
        // the mistake is permanent for that session too.
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
        // No order list, no stated error, no wall: the sign-in simply did not
        // resolve. Guessing "wrong password" from silence is the mistake this
        // branch exists to refuse.
        //
        // The settle budget is zeroed because the suite's clock does not move:
        // the loop ends on a deadline, which is right against a real
        // TimeProvider and never reached against a frozen one.
        var page = AmazonStubPage.Showing(Email, Password, Submit);
        using var ctx = Context(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { LoginSettleSeconds = 0 })
                .LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.Contains("neither reached the order list", error.Detail, StringComparison.Ordinal);

        // And the page is photographable on the way out.
        //
        // The runner captures a failed job's page, and the redactor refuses -
        // correctly - while a field the manifest calls secret still holds
        // content. Every live failure on this path logged "no capture:
        // password still holds content" and threw away the only evidence of
        // what the browser was looking at, which is precisely the failure that
        // needs evidence: it is the one that says "something unrecognised".
        Assert.False(page.HoldsSecret);
        Assert.Contains("clear-secrets", page.Calls);
    }

    // ---- walls -------------------------------------------------------------

    /// <summary>
    /// A pooled agent streams the wall rather than refusing it.
    ///
    /// This test used to assert the opposite, and the opposite was right when
    /// it was written: a widget wants drags and tile clicks and mints its token
    /// in its own JavaScript, so nothing a screenshot and a text box can carry
    /// will pass one, and there is nobody at a datacenter browser to try.
    ///
    /// What changed is that there does not have to be. The live view puts the
    /// page in front of the person who asked for the connection, wherever they
    /// are, and their clicks go back into it - which is how Albert Heijn, Lidl
    /// and BKR are already signed in to. Amazon was the last provider still
    /// answering this wall with a refusal, and it is the provider that raises
    /// it most: a correct password from a pooled browser lands on "Bevestig je
    /// identiteit" every time.
    /// </summary>
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

        // Nothing to type back: the widget hands its token to Amazon, not to
        // us, so the page moving is the only observation there is.
        Assert.True(asked.IsPassive);

        // And the password left the DOM before the first frame. The redactor
        // refuses to photograph a page holding a secret, so this is what makes
        // the view possible at all rather than a stream of nothing.
        Assert.False(page.HoldsSecret);
        Assert.Contains("clear-secrets", page.Calls);
    }

    /// <summary>
    /// The passkey nudge is dismissed, and the sign-in carries on.
    ///
    /// This is what stopped every live login. The password is ACCEPTED and
    /// Amazon then interposes "Passkey setup" at /ax/claim/webauthn/nudge,
    /// which is not an error, not a captcha, not a code and not the order
    /// list - so the settle loop had no name for it and waited out its whole
    /// budget on a page one button away from done. It is served to the pooled
    /// browser and not to a plain desktop run, which is why three probes
    /// walked straight past it.
    /// </summary>
    [Fact]
    public async Task The_passkey_nudge_is_declined_and_the_sign_in_finishes()
    {
        var page = AmazonStubPage.Showing(
            Email, Password, Submit, "input[aria-labelledby*='nudge-not-now']");

        page.Url = "https://www.amazon.nl/ax/claim/webauthn/nudge?openid.mode=checkid_setup";

        // Saying no to the passkey is what lands the session.
        page.SignedInAfter("input[aria-labelledby*='nudge-not-now']");

        using var ctx = Context(page, attended: false);

        // Bounded so a mutation that stops the nudge being recognised FAILS
        // rather than spinning: the clock here is fixed, so a settle loop that
        // never resolves never reaches its deadline either.
        await Ticking().LoginAsync(ctx, page, Never(), CancellationToken.None);

        Assert.Contains(page.Clicked, c => c.Contains("nudge-not-now", StringComparison.Ordinal));

        // Nobody was asked anything. The password already worked; this page is
        // the platform's problem, not the user's.
        Assert.Empty(ctx.Asked);
    }

    /// <summary>
    /// Declining REPORTS that it acted, which is what restarts the budget.
    ///
    /// Amazon has to build the next page after the refusal, and a login that
    /// already spent three minutes getting here has little of its four left.
    /// Saying "I did something" is what buys that time - and a version that
    /// clicked the button and returned false passed every other test in this
    /// file, because the stub signs in on the click and nothing downstream
    /// noticed the budget was never reset.
    /// </summary>
    [Fact]
    public async Task Declining_says_it_acted_so_the_budget_restarts()
    {
        var nudge = AmazonStubPage.Showing("input[aria-labelledby*='nudge-not-now']");
        nudge.Url = "https://www.amazon.nl/ax/claim/webauthn/nudge?openid.mode=checkid_setup";

        Assert.True(await Adapter().DeclinePasskeyAsync(nudge, CancellationToken.None));
        Assert.Contains(nudge.Clicked, c => c.Contains("nudge-not-now", StringComparison.Ordinal));

        // The same control, on a page that is not the nudge: nothing is
        // clicked and nothing is claimed. A refusal button only means "decline
        // the passkey" on the page that offered one.
        var elsewhere = AmazonStubPage.Showing("input[aria-labelledby*='nudge-not-now']");
        elsewhere.Url = "https://www.amazon.nl/ap/signin?openid.mode=checkid_setup";

        Assert.False(await Adapter().DeclinePasskeyAsync(elsewhere, CancellationToken.None));
        Assert.Empty(elsewhere.Clicked);
    }

    /// <summary>
    /// And it declines. The nudge offers to SET UP a passkey and to sign in
    /// with an existing one, and either would register a new credential against
    /// the account - which is enormously more than "read my receipts" asked
    /// for. The candidate list is tried in order until one matches, so a wrong
    /// entry in it is a permanent change to somebody's account.
    /// </summary>
    [Fact]
    public void The_passkey_options_that_enrol_a_credential_are_not_clickable()
    {
        var options = new AmazonOptions();

        Assert.All(options.PasskeyDeclineSelectors, selector =>
        {
            Assert.DoesNotContain("setup", selector, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("existing", selector, StringComparison.OrdinalIgnoreCase);
        });

        // Positively: every entry names a refusal.
        Assert.All(options.PasskeyDeclineSelectors, selector =>
            Assert.True(
                selector.Contains("not-now", StringComparison.Ordinal)
                || selector.Contains("skip", StringComparison.Ordinal),
                $"'{selector}' is neither a 'not now' nor a 'skip'"));
    }

    /// <summary>
    /// A nudge nobody can dismiss falls through to the wall check, which
    /// streams the page. Somebody looking at a passkey prompt can answer it;
    /// failing the login because a button was renamed cannot be answered by
    /// anyone.
    /// </summary>
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

    /// <summary>
    /// And by its markup as well as by its URL.
    ///
    /// The two are separate on purpose and this is what keeps them separate:
    /// the URL check alone would miss a verification widget mounted anywhere
    /// else, and the selectors alone miss the page while its iframe is still
    /// drawing. Without this test the CVF selectors could be deleted and every
    /// other test would still pass, because the URL would quietly cover for
    /// them - which is exactly what bite-checking found.
    /// </summary>
    [Fact]
    public async Task The_verification_widget_is_a_wall_wherever_it_is_mounted()
    {
        var page = AmazonStubPage.Showing(Email, Password, Submit, "#cvf-aamation-challenge-iframe");

        // Deliberately NOT a /ap/cvf URL, so the URL check cannot answer this.
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

    /// <summary>
    /// The wall is recognised by its URL as well as by its markup.
    ///
    /// /ap/cvf/request draws its challenge inside an iframe, so a poll that
    /// arrives while the page is still building it sees no selector at all -
    /// and the settle loop would then spend its whole budget on a page that is
    /// unmistakably a wall by where the browser is standing. That is exactly
    /// what happened live: four minutes of polling, then "the provider changed
    /// its site", about a site that had changed nothing.
    /// </summary>
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

        // Bounded, and the bound is what makes this test able to FAIL rather
        // than hang. The clock here is fixed, so a settle loop that never
        // recognises the wall never reaches its deadline either - it spins
        // forever, and a mutation that blinds the detector takes the suite down
        // with it instead of turning red. Zero seconds still runs one full
        // pass, because the deadline is checked at the END of the loop.
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
            // The human passes the puzzle in the window in front of them and
            // Amazon carries on. There is nothing for them to type back at us:
            // a widget hands its token to the provider, not to the agent, so
            // the page changing is the only observation there is.
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
        // The one wall a relay can carry: a picture and a box. The redactor
        // refuses to photograph a page while a secret-declared field still
        // holds content, so a picture coming back at all is proof the
        // credentials were cleared first.
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

        // Only the captcha is answered. The credentials are deliberately not
        // resubmitted to make the form look complete: a second submission of a
        // password that may already have counted is how an account gets locked.
        Assert.Equal("MKPHTX", page.Answered);
    }

    // ---- inputs ------------------------------------------------------------

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

/// <summary>
/// A clock that moves every time it is read.
///
/// <c>FixedTimeProvider</c> stops a deadline from ever arriving, which turns
/// "this page was not recognised" from a failing test into a hanging one.
/// Reading advances it, so every bounded loop in the adapter terminates
/// whether or not it found what it was looking for.
/// </summary>
internal sealed class TickingClock(DateTimeOffset start, TimeSpan step) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow()
    {
        _now += step;
        return _now;
    }
}
