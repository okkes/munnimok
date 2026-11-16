using System.Globalization;
using System.Text.Json;
using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Playwright;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// bol has no refresh grant: a login is expensive and never retried; a bot wall must not read as a bad password;
// a captcha with nobody at the agent fails at once instead of holding it
public sealed class BolAdapterTests
{
    private const string Email = "shopper@example.com";
    private const string Password = "hunter2";
    private const string Code = "418362";

    private static readonly DateTimeOffset Now = new(2026, 7, 28, 3, 0, 0, TimeSpan.Zero);

    private static readonly BolOptions Options = new();

    private static readonly BolOptions Pages = Options with { OrdersShape = BolOrdersShape.Html };

    // written out, not read off the adapter's own lists: a fixture built from them cannot disagree with them
    // (that is how a live ASN fetch was lost)
    private const string Username = "input[name='j_username']";
    private const string PasswordBox = "input[name='j_password']";
    private const string Submit = "button[type='submit']";
    private const string CodeBox = "input[autocomplete='one-time-code']";
    private const string CodeSubmit = "[data-test='verify-code-submit']";
    private const string Recaptcha = "iframe[src*='recaptcha']";
    // the cookie wall as bol serves it on 2026-10-06: a Radix dialog with both answers
    private const string ConsentRefuse = "[role='dialog'][data-state='open'] button:has-text('Weigeren')";
    private const string ConsentAccept = "[role='dialog'][data-state='open'] button:has-text('Alles accepteren')";
    // the language chooser bol raises behind the cookie wall since 2026-10-07
    private const string LanguageContinue = "[role='dialog'][data-state='open'] button:has-text('Doorgaan')";

    private const string PageHash = "sha256:0123456789abcdef0123456789abcdef";
    private const string PageUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    private const string PageBody =
        """{"operationName":"OrdersOverviewClient","variables":{"after":"5","locale":"nl-NL"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"sha256:0123456789abcdef0123456789abcdef"}}}""";

    private static readonly string[] SessionExpiredOnly = ["session_expired"];

    private static readonly string[] ReceiptIncludes = ["items", "raw", "invoice"];

    private static readonly string[] AccountPageThenLoginForm =
    [
        "https://www.bol.com/nl/nl/account/bestellingen/overzicht/",
        "https://login.bol.com/wsp/login",
    ];

    private static BolAdapter Adapter(BolOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    [Fact]
    public void The_manifest_validates_and_the_registry_accepts_it()
    {
        var registry = new ProviderRegistry([BolAdapters.Create()]);

        var manifest = registry.RequireManifest(BolAdapter.ProviderId);
        ManifestValidator.Validate(manifest);

        Assert.Equal("bol", manifest.Id);
        Assert.Equal("bol.com", manifest.Name);
        Assert.Equal(ProviderKind.Store, manifest.Kind);
        Assert.Equal("NL", manifest.Country);
    }

    [Fact]
    public void Bol_signs_in_through_a_browser_once_on_a_dutch_residential_line()
    {
        var manifest = Adapter().Describe();

        // T3, not T2: bol issues no refresh token, the jar dies in a day and the browser must come back (Jumbo too)
        Assert.Equal(ProviderRuntime.BrowserInteractive, manifest.Runtime);
        Assert.True(manifest.Agent.Required);
        Assert.Equal(AgentClass.Pooled, manifest.Agent.Class);
        Assert.NotNull(manifest.Agent.Egress);
        Assert.Equal("NL", manifest.Agent.Egress.Country);
        Assert.Equal("residential", manifest.Agent.Egress.Kind);
        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);
    }

    [Fact]
    public void Bol_does_not_claim_unattended_operation_it_cannot_deliver()
    {
        var manifest = Adapter().Describe();

        // only a session cookie, nothing to refresh: claiming unattended would promise scheduled syncs that fail
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.False(manifest.Auth.Reauth.Cheap);

        // RotatesOnUse defaults to TRUE: assert it, or consumers persist a bundle bol never re-issues
        Assert.False(
            manifest.Auth.Session.RotatesOnUse,
            "no fetch returns RefreshedMaterial, so nothing is ever re-issued");
        Assert.Equal(SessionExpiredOnly, manifest.Auth.Reauth.TriggerCodes);

        // a day is a guess; wrong-short costs a sign-in, wrong-long costs trust in the connection
        Assert.Equal(86_400, manifest.Auth.Session.TtlSeconds);
    }

    [Fact]
    public void The_credential_is_an_email_address_and_the_password_is_marked_secret()
    {
        var manifest = Adapter().Describe();
        var step = Assert.Single(manifest.Auth.Steps);

        Assert.Equal(AuthFlow.Password, manifest.Auth.Flow);
        Assert.Equal(2, step.Fields.Count);

        // j_username is type=email (confirmed): another keypad spends an attempt on a page that may score the browser
        var username = Assert.Single(step.Fields, f => f.Key == "username");
        Assert.Equal(FieldType.Text, username.Type);
        Assert.False(username.Secret);
        Assert.NotNull(username.Pattern);
        Assert.Matches(username.Pattern, Email);
        Assert.DoesNotMatch(username.Pattern, "+31612345678");

        var password = Assert.Single(step.Fields, f => f.Key == "password");
        Assert.Equal(FieldType.Password, password.Type);
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");
    }

    [Fact]
    public void Every_challenge_bol_might_raise_is_declared_rather_than_discovered()
    {
        var manifest = Adapter().Describe();

        // MfaCode assumed on a new device; Image can be relayed; AppApproval is the reCAPTCHA, which cannot be relayed
        Assert.Equal(
            new[] { ChallengeType.MfaCode, ChallengeType.Image, ChallengeType.AppApproval },
            manifest.Auth.Challenges);
    }

    [Fact]
    public void The_receipts_resource_matches_the_shape_every_other_store_offers()
    {
        var receipts = Adapter().Describe().Resource(BolAdapter.ReceiptsResource);

        Assert.NotNull(receipts);
        Assert.Equal(ResourceShape.Receipt, receipts.Returns);
        Assert.True(receipts.Param("since")!.Required);
        Assert.Equal(ParamType.Date, receipts.Param("until")!.Type);
        // raw is the payload a record was derived from, invoice is a file bol issued: separate includes
        Assert.Equal(ReceiptIncludes, receipts.Param("include")!.Values);

        // a marketplace order surfaces when the seller ships it, days after its date: fetching strictly since the last sync loses it
        Assert.Equal(7, Adapter().Describe().Limits.SettlementLagDays);
    }

    [Fact]
    public void Every_string_a_human_reads_is_a_key_and_never_prose()
    {
        var manifest = Adapter().Describe();

        Assert.StartsWith("connect.", manifest.NotesKey, StringComparison.Ordinal);
        foreach (var step in manifest.Auth.Steps)
        {
            Assert.StartsWith("connect.", step.LabelKey, StringComparison.Ordinal);
        }

        foreach (var field in manifest.Auth.AllFields())
        {
            Assert.StartsWith("connect.", field.LabelKey, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task The_spring_form_field_names_are_the_ones_that_get_filled()
    {
        var page = SignedInPage();
        using var ctx = LoginContext(page);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        // j_username/j_password are Spring Security's names; wrong ones burn a never-retried attempt
        Assert.Equal(Email, page.Filled[Username]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
        Assert.Contains("j_username", Username, StringComparison.Ordinal);
        Assert.Contains("j_password", PasswordBox, StringComparison.Ordinal);

        // the cookie jar is the whole credential; the expiry is stated from this login
        Assert.NotNull(result.Material.StorageState);
        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.RefreshToken);
        Assert.Equal(Now.AddSeconds(86_400), result.ExpiresAt);
        Assert.Equal("bol.com", result.Account!.DisplayName);
    }

    [Fact]
    public async Task The_latch_closes_before_the_credentials_leave_the_machine()
    {
        var page = SignedInPage();
        using var ctx = LoginContext(page);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        // after this a lost lease fails the job instead of requeuing: a retried login is a second real attempt
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Equal(Submit, page.Clicked[^1]);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_login_missing_a_credential_is_refused_before_the_page_is_touched(string missing)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Email,
            ["password"] = Password,
        };
        inputs.Remove(missing);

        var page = SignedInPage();
        using var ctx = new FakeJobContext { Inputs = inputs, Browser = new BolBrowserStub(page) };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Visited);
        Assert.Empty(page.Filled);
    }

    [Fact]
    public async Task A_missing_password_box_is_a_shape_change_and_spends_no_attempt()
    {
        // username, button and a code box are present: a filler settling for any input would find one
        var page = StubLoginPage.Showing(Username, Submit, CodeBox);
        using var ctx = LoginContext(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("password field", error.Detail, StringComparison.Ordinal);
        Assert.Contains("j_password", error.Detail, StringComparison.Ordinal);

        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Clicked);
    }

    [Fact]
    public async Task The_cookie_wall_is_refused_before_the_form_is_touched_and_accepted_when_it_cannot_be()
    {
        var page = StubLoginPage.Showing(ConsentRefuse, ConsentAccept, Username, PasswordBox, Submit);
        using var ctx = LoginContext(page);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(ConsentRefuse, page.Clicked[0]);
        var calls = page.Calls.ToList();
        Assert.True(calls.IndexOf("click") < calls.IndexOf("fill"), "the wall goes before the form is filled");
        Assert.DoesNotContain(ConsentAccept, page.Clicked);
        Assert.Contains(ctx.Notes, n => n.Contains("cookie wall was dismissed", StringComparison.Ordinal));

        var acceptOnly = StubLoginPage.Showing(ConsentAccept, Username, PasswordBox, Submit);
        using var ctx2 = LoginContext(acceptOnly);
        await Adapter().LoginAsync(ctx2, acceptOnly, Arrives(), CancellationToken.None);
        Assert.Equal(ConsentAccept, acceptOnly.Clicked[0]);
    }

    [Fact]
    public async Task The_language_chooser_behind_the_cookie_wall_is_carried_through_before_the_form_is_touched()
    {
        // prod 2026-10-07: a second full-screen dialog (language) timed out the login's click, as the wall had
        var page = StubLoginPage.Showing(ConsentRefuse, LanguageContinue, Username, PasswordBox, Submit);
        using var ctx = LoginContext(page);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(ConsentRefuse, page.Clicked[0]);
        Assert.Equal(LanguageContinue, page.Clicked[1]);
        var calls = page.Calls.ToList();
        Assert.True(calls.LastIndexOf("click", calls.IndexOf("fill")) >= 0, "both walls go before the form is filled");
        Assert.Contains(ctx.Notes, n => n.Contains("the language chooser was dismissed", StringComparison.Ordinal));

        var chooserOnly = StubLoginPage.Showing(LanguageContinue, Username, PasswordBox, Submit);
        using var ctx2 = LoginContext(chooserOnly);
        await Adapter().LoginAsync(ctx2, chooserOnly, Arrives(), CancellationToken.None);
        Assert.Equal(LanguageContinue, chooserOnly.Clicked[0]);
        Assert.Equal(Submit, chooserOnly.Clicked[^1]);
    }

    [Fact]
    public async Task A_cookie_wall_button_that_cannot_be_pressed_never_takes_the_login_down()
    {
        // 2026-10-06 (prod, four logins): the click found a button under the dialog and timed out on its paragraph
        var page = SignedInPage();
        page.Reveal(ConsentRefuse);
        page.ClickThrows = new TimeoutException("Timeout 500ms exceeded: <p>…</p> from <div role=\"dialog\"> intercepts pointer events");
        using var ctx = LoginContext(page);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(Submit, page.Clicked[^1]);
        Assert.Contains(ctx.Notes, n => n.Contains("could not be pressed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_page_step_the_page_will_not_take_fails_as_provider_unavailable_never_as_internal()
    {
        // 2026-10-06/07 (prod, GlitchTip #24-#28, #33-#34): a click Playwright gave up on was reported as
        // internal - an error event per sign-in, over a page that was merely slow or covered
        var page = SignedInPage();
        page.ClickThrows = new TimeoutException("Timeout 15000ms exceeded.\nCall log:\n  - attempting click action\n    - waiting for element to be visible, enabled and stable");
        using var ctx = LoginContext(page);

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderUnavailable, refused.Code);
        Assert.Contains("TimeoutException: Timeout 15000ms exceeded.", refused.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("Call log", refused.Detail, StringComparison.Ordinal);
        Assert.Empty(page.Clicked);
    }

    [Fact]
    public async Task The_login_enters_through_the_account_page_and_falls_back_to_the_form_itself()
    {
        var page = SignedInPage();
        using var ctx = LoginContext(page);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        // bol's own 302 chain is the shopper's flow and the address that returns the browser to the account page
        Assert.Equal("https://www.bol.com/nl/nl/account/bestellingen/overzicht/", Assert.Single(page.Visited));
    }

    [Fact]
    public async Task A_redirect_chain_that_leads_nowhere_still_reaches_the_login_form()
    {
        // the form address is a confirmed fact: a broken 302 chain costs one navigation, not the connection
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit);
        using var ctx = LoginContext(page);

        await Adapter(Options with { UsernameSelectors = [Username] })
            .LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal("https://www.bol.com/nl/nl/account/bestellingen/overzicht/", page.Visited[0]);

        Assert.Single(page.Visited);

        var blank = StubLoginPage.Showing(PasswordBox, Submit);
        using var second = LoginContext(blank);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(second, blank, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Equal(AccountPageThenLoginForm, blank.Visited);

        Assert.Contains("either the account page's redirect or the login form", error.Detail,
            StringComparison.Ordinal);
        Assert.False(second.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_login_that_leaves_no_cookies_for_the_orders_host_is_a_shape_change()
    {
        // JSESSIONID is set on login.bol.com and a browser would not send it to www.bol.com: a login leaving only that is unusable
        var page = SignedInPage();
        using var ctx = LoginContext(page, storageState: LoginHostOnlyState);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("www.bol.com", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_one_time_code_is_relayed_to_the_human_and_never_solved()
    {
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit, CodeBox, CodeSubmit);
        using var ctx = LoginContext(page, answer: _ => Code);

        await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, challenge.Type);

        // the credential is an e-mail address, so delivery is "email"; "sms" sends the user to a phone that never rings
        Assert.Equal("email", challenge.Delivery);
        Assert.Equal("connect.challenge.verification_code", challenge.PromptKey);

        // no length claimed: a wrong one makes the consumer reject a valid code
        Assert.Null(challenge.Length);
        Assert.Equal(Now.AddSeconds(300), challenge.ExpiresAt);

        Assert.Equal(Code, page.Filled[CodeBox]);
        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);
    }

    [Fact]
    public async Task A_device_bol_already_trusts_is_never_asked_for_anything()
    {
        var page = SignedInPage();
        using var ctx = LoginContext(page);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task An_unattended_recaptcha_is_refused_at_once_and_nobody_is_asked()
    {
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit, Recaptcha);
        using var ctx = LoginContext(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        // BlockedByProvider, not invalid_credentials: nobody is at this browser and a widget mints its token in its own JavaScript
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("unattended", error.Detail, StringComparison.Ordinal);
        Assert.Empty(ctx.Asked);

        // the password is off the page: the runner may capture an artifact after a failed job
        Assert.False(page.HoldsSecret);
    }

    [Fact]
    public async Task An_attended_recaptcha_asks_the_human_and_waits_for_the_session_to_appear()
    {
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit, Recaptcha);

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(),
            Browser = new BolBrowserStub(page),
            Attended = true,
            // nobody answers: whoever passes the widget in the browser has no reason to return to the consumer's UI
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var result = await Adapter().LoginAsync(ctx, page, Arrives(afterWaits: 1), cts.Token);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.AppApproval, challenge.Type);
        Assert.True(challenge.IsPassive);
        Assert.Null(challenge.Image);
        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task Only_a_page_that_states_a_credential_error_may_report_one()
    {
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit, "[data-test='login-error']");
        using var ctx = LoginContext(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
        Assert.False(page.HoldsSecret);
    }

    [Fact]
    public async Task A_notice_that_names_no_cause_is_a_block_and_not_a_bad_password()
    {
        // Lidl's login answers an automated browser with this notice; reading it as a wrong password was a bug
        var options = Options with { BlockedNoticeSelectors = ["[data-test='generic-error']"] };
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit, "[data-test='generic-error']");

        using var ctx = LoginContext(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(options).LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.False(page.HoldsSecret);
    }

    [Fact]
    public async Task A_login_that_says_nothing_at_all_is_a_shape_change_and_not_a_bad_password()
    {
        // silence is not a wrong password: a credential error is never retried, so the mistake would be permanent
        var page = StubLoginPage.Showing(Username, PasswordBox, Submit);
        using var ctx = LoginContext(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { LoginSettleSeconds = 0 })
                .LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("neither completed nor stated", error.Detail, StringComparison.Ordinal);
    }

    // prod 2026-10-07: the jar is sealed after the probe, not before, or its visits' cookies never reach a fetch;
    // only header NAMES go to the notes, never a value
    [Fact]
    public async Task The_jar_sealed_is_the_one_read_after_the_probe_and_the_page_s_request_rides_beside_the_hash()
    {
        var before = FixtureCatalog.Read("bol/storage-state.json");
        var after = before.Replace("fixture-xsrf-token", "probe-xsrf-token", StringComparison.Ordinal);
        var page = StubLoginPage.Showing();
        using var ctx = LoginContext(page, storageState: after);
        var signedIn = new LoginResult { Material = new SessionMaterial { StorageState = before } };
        var request = new BolPageRequest(PageBody, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["user-agent"] = PageUserAgent,
            ["accept"] = "*/*",
        });

        var sealed_ = await Adapter().SealAsync(
            ctx, page, signedIn, Task.FromResult(PageHash), _ => Task.FromResult<BolPageRequest?>(request), CancellationToken.None);

        Assert.Contains("probe-xsrf-token", sealed_.Material.StorageState, StringComparison.Ordinal);
        Assert.Equal(PageHash, BolPersistedQuery.Learned(sealed_.Material));

        var learned = BolPersistedQuery.LearnedRequest(sealed_.Material);
        Assert.NotNull(learned);
        Assert.Equal(PageBody, learned.Body);
        Assert.Equal(PageUserAgent, learned.Headers["user-agent"]);

        var note = Assert.Single(ctx.Notes, n => n.Contains("sealed into the session", StringComparison.Ordinal));
        Assert.Contains("sha256:0123456789ab)", note, StringComparison.Ordinal);
        Assert.Contains("[accept, user-agent]", note, StringComparison.Ordinal);
        Assert.DoesNotContain(PageUserAgent, note, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_jar_that_lost_its_orders_cookies_during_the_probe_never_replaces_the_one_the_login_checked()
    {
        // a lease that answers an empty state once its browser is gone, or a jar bol emptied on the way: the checked jar stands
        var page = StubLoginPage.Showing();
        using var ctx = LoginContext(page, storageState: LoginHostOnlyState);
        var signedIn = new LoginResult { Material = new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") } };
        var quick = Options with { HashProbeMs = 20, ProbeMs = 1 };

        var sealed_ = await Adapter(quick).SealAsync(
            ctx, page, signedIn, new TaskCompletionSource<string>().Task, _ => Task.FromResult<BolPageRequest?>(null), CancellationToken.None);

        Assert.Contains("fixture-xsrf-token", sealed_.Material.StorageState, StringComparison.Ordinal);
        Assert.Null(BolPersistedQuery.Learned(sealed_.Material));
        Assert.Null(BolPersistedQuery.LearnedRequest(sealed_.Material));
        Assert.Contains(ctx.Notes, n => n.Contains("the jar sealed at sign-in stands", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_hash_whose_request_could_not_be_read_is_still_sealed_and_says_so()
    {
        var page = StubLoginPage.Showing();
        using var ctx = LoginContext(page);
        var signedIn = new LoginResult { Material = new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") } };

        var sealed_ = await Adapter().SealAsync(
            ctx, page, signedIn, Task.FromResult(PageHash), _ => Task.FromResult<BolPageRequest?>(null), CancellationToken.None);

        Assert.Equal(PageHash, BolPersistedQuery.Learned(sealed_.Material));
        Assert.Null(BolPersistedQuery.LearnedRequest(sealed_.Material));
        Assert.Contains(ctx.Notes, n => n.Contains("could not be read", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_session_watcher_waits_for_a_cookie_rather_than_a_redirect()
    {
        // AH and Lidl end by navigating to a scheme Chromium cannot open; bol just stops being the login page,
        // so the cookie jar is the signal (same interface keeps CaptchaGate reusable)
        var page = SignedInPage();

        using var signedIn = new FakeJobContext { Browser = new BolBrowserStub(page) };
        var watcher = new BolSessionWatcher(signedIn, page, Options, new FixedTimeProvider(Now));

        Assert.NotNull(await watcher.WaitAsync(TimeSpan.FromMilliseconds(1), CancellationToken.None));

        // still on login.bol.com means nothing happened yet, and knowing costs no round trip
        using var stillOut = new FakeJobContext { Browser = new BolBrowserStub(page) };

        var stuck = new BolSessionWatcher(
            stillOut, new BolPageAt("https://login.bol.com/wsp/login"), Options, new FixedTimeProvider(Now));

        Assert.Null(await stuck.WaitAsync(TimeSpan.FromMilliseconds(1), CancellationToken.None));
    }

    [Fact]
    public void Only_cookies_a_browser_would_send_to_the_orders_host_are_sent()
    {
        var header = BolCookies.Header(FixtureCatalog.Read("bol/storage-state.json"), "www.bol.com");

        Assert.NotNull(header);

        Assert.Contains("XSC=", header, StringComparison.Ordinal);
        Assert.Contains("shopping_session_id=", header, StringComparison.Ordinal);

        // JSESSIONID is host-only on login.bol.com: a browser would not send it, so a fetch must not over-send it
        Assert.DoesNotContain("JSESSIONID", header, StringComparison.Ordinal);

        Assert.DoesNotContain("expired_marker", header, StringComparison.Ordinal);
        Assert.DoesNotContain("affiliate", header, StringComparison.Ordinal);
    }

    // name matched case-insensitively although RFC 6265 says case-sensitive: bol shipping Xsrf-Token must cost nothing
    [Fact]
    public void A_single_cookie_can_be_read_by_name_whatever_its_casing()
    {
        var jar = FixtureCatalog.Read("bol/storage-state.json");

        Assert.Equal("fixture-xsrf-token", BolCookies.Value(jar, "www.bol.com", "XSRF-TOKEN"));
        Assert.Equal("fixture-xsrf-token", BolCookies.Value(jar, "www.bol.com", "xsrf-token"));

        Assert.Null(BolCookies.Value(jar, "www.bol.com", "no-such-cookie"));
        Assert.Null(BolCookies.Value(jar, "www.bol.com", "JSESSIONID"));
    }

    // the window filter was never exercised; the fixture has one order on 29 July and one on 26 July
    [Theory]
    [InlineData("2026-07-28", null, 1)]
    [InlineData(null, "2026-07-28", 1)]
    [InlineData("2026-07-25", "2026-07-30", 2)]
    [InlineData("2026-08-01", null, 0)]
    public async Task Only_the_orders_inside_the_window_come_back(string? since, string? until, int expected)
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(
            ctx,
            Requests.Receipts(
                since: since is null ? null : DateOnly.Parse(since, CultureInfo.InvariantCulture),
                until: until is null ? null : DateOnly.Parse(until, CultureInfo.InvariantCulture)),
            CancellationToken.None);

        Assert.Equal(expected, result.Receipts.Count);
    }

    // a window excluding everything is an answer: neither an error nor incomplete
    [Fact]
    public async Task A_window_with_nothing_in_it_is_complete_and_empty()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: new DateOnly(2026, 8, 1)), CancellationToken.None);

        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task A_fetch_sends_the_cookie_jar_and_says_which_shape_answered()
    {
        var handler = new StubHttpHandler((_, _) => Html(FixtureCatalog.Read("bol/orders-page.html")));
        using var ctx = FetchContext(handler);

        var result = await Adapter(Pages).FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.Equal("html", result.Via);
        Assert.Equal(3, result.Receipts.Count);

        var request = handler.Requests[0];
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Contains("/nl/nl/rnwy/account/bestellingen", request.Path, StringComparison.Ordinal);
        Assert.Contains("XSC=", request.Header("Cookie"), StringComparison.Ordinal);
        Assert.Contains("nl-NL", request.Header("Accept-Language"), StringComparison.Ordinal);

        Assert.Null(result.RefreshedMaterial);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task A_page_with_errors_beside_its_orders_is_read_and_the_errors_are_noted()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse(FixtureCatalog.Read("bol/orders-graphql.json"))!.AsObject();
        node["errors"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["message"] = "Error(s) redacted." });
        var partial = node.ToJsonString();
        var handler = new StubHttpHandler((_, _) => Stub.Json(partial));
        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Contains(ctx.Notes, n => n.Contains("partial page", StringComparison.Ordinal) && n.Contains("errors=1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_hash_the_sign_in_learned_is_the_one_the_fetch_sends()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Json("""{"data":{"me":{"orders":[]}}}"""));
        using var ctx = new FakeJobContext(handler)
        {
            Material = BolPersistedQuery.WithHash(
                new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") },
                "0123abcd-learned"),
        };

        await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        using var sent = JsonDocument.Parse(handler.Requests[0].Body!);
        Assert.Equal(
            "0123abcd-learned",
            sent.RootElement.GetProperty("extensions").GetProperty("persistedQuery").GetProperty("sha256Hash").GetString());
        Assert.Contains(ctx.Notes, n => n.Contains("learned", StringComparison.Ordinal));
    }

    // prod 2026-10-05: a session that learned no hash is one sign-in away from working, so the refusal asks for the sign-in
    [Fact]
    public async Task A_refused_configured_hash_asks_for_a_new_sign_in()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Json("""{"errors":[{"message":"Error(s) redacted."}]}"""));
        using var ctx = FetchContext(handler);

        var ex = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, ex.Code);
        Assert.Contains("learned no hash", ex.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_refused_learned_hash_is_a_change_bol_made_since_the_sign_in()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Json("""{"errors":[{"message":"Error(s) redacted."}]}"""));
        using var ctx = new FakeJobContext(handler)
        {
            Material = BolPersistedQuery.WithHash(
                new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") },
                "0123abcd-learned"),
        };

        var ex = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        // the page said this hash today and bol refuses it: a real change, an operator's job
        Assert.Equal(ErrorCode.ProviderChanged, ex.Code);
    }

    // prod 2026-10-07: bol refused the request rebuilt around its own page's hash, so a learned request is replayed
    // with only the cursor rewritten; jar, referer and CSRF echo stay the fetch's own
    [Fact]
    public async Task The_page_s_own_request_is_replayed_with_only_the_cursor_rewritten_and_its_headers_added()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = new FakeJobContext(handler) { Material = ReplayMaterial() };

        await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        var request = handler.Requests[0];
        using var sent = JsonDocument.Parse(request.Body!);
        var root = sent.RootElement;

        Assert.Equal("0", root.GetProperty("variables").GetProperty("after").GetString());
        Assert.Equal("nl-NL", root.GetProperty("variables").GetProperty("locale").GetString());
        Assert.Equal(PageHash, root.GetProperty("extensions").GetProperty("persistedQuery").GetProperty("sha256Hash").GetString());

        Assert.Equal(PageUserAgent, request.Header("User-Agent"));
        Assert.Equal("7.3.1", request.Header("bol-app-version"));
        Assert.Equal("https://www.bol.com", request.Header("Origin"));
        Assert.Equal("same-origin", request.Header("sec-fetch-site"));
        Assert.Equal("application/json", request.Header("Content-Type"));
        Assert.Equal("OrdersOverviewClient", request.Header("bol-app-operation-name"));

        Assert.Contains("XSC=fixture-xsc-value", request.Header("Cookie"), StringComparison.Ordinal);
        Assert.DoesNotContain("stale", request.Header("Cookie"), StringComparison.Ordinal);
        Assert.Equal("fixture-xsrf-token", request.Header("x-xsrf-token"));
        Assert.Equal("https://www.bol.com/nl/nl/account/bestellingen/overzicht/", request.Header("Referer"));

        using var second = JsonDocument.Parse(handler.Requests[1].Body!);
        Assert.Equal("5", second.RootElement.GetProperty("variables").GetProperty("after").GetString());

        Assert.Contains(ctx.Notes, n => n.Contains("learned", StringComparison.Ordinal) && n.Contains("replaying", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_refusal_s_detail_names_the_code_the_path_and_whether_the_operation_ran()
    {
        const string refused = """{"errors":[{"message":"Error(s) redacted.","path":["me"],"extensions":{"code":"INTERNAL_ERROR"}}]}""";
        var handler = new StubHttpHandler((_, _) => Stub.Json(refused));

        using var learned = new FakeJobContext(handler) { Material = ReplayMaterial() };
        var change = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(learned, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, change.Code);
        Assert.Contains("code=INTERNAL_ERROR", change.Detail, StringComparison.Ordinal);
        Assert.Contains("path=me", change.Detail, StringComparison.Ordinal);
        Assert.Contains("data=absent", change.Detail, StringComparison.Ordinal);
        Assert.Contains("hash=sha256:0123456789ab ", change.Detail, StringComparison.Ordinal);
        Assert.Contains("body=replay", change.Detail, StringComparison.Ordinal);

        using var configured = FetchContext(handler);
        var expired = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(configured, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, expired.Code);
        Assert.Contains("code=INTERNAL_ERROR", expired.Detail, StringComparison.Ordinal);
        Assert.Contains("body=rebuilt", expired.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_anonymous_answer_beside_errors_asks_for_a_login_even_under_a_learned_hash()
    {
        const string anonymous =
            """{"errors":[{"message":"Unauthenticated","extensions":{"code":"UNAUTHENTICATED"}}],"data":{"me":{"__typename":"AnonymousCustomer"}}}""";
        var handler = new StubHttpHandler((_, _) => Stub.Json(anonymous));
        using var ctx = new FakeJobContext(handler) { Material = ReplayMaterial() };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("AnonymousCustomer", error.Detail, StringComparison.Ordinal);
        Assert.Contains("code=UNAUTHENTICATED", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_default_shape_posts_bol_s_own_persisted_operation()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.Equal("graphql", result.Via);

        var request = handler.Requests[0];
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://www.bol.com/api/graphql", request.Uri.ToString());
        Assert.Contains("application/json", request.Header("Content-Type"), StringComparison.Ordinal);

        using var sent = JsonDocument.Parse(request.Body!);
        Assert.Equal("OrdersOverviewClient", sent.RootElement.GetProperty("operationName").GetString());
        Assert.Equal(
            Options.OrdersPersistedQueryHash,
            sent.RootElement.GetProperty("extensions").GetProperty("persistedQuery")
                .GetProperty("sha256Hash").GetString());

        using var second = JsonDocument.Parse(handler.Requests[1].Body!);
        Assert.Equal("0", sent.RootElement.GetProperty("variables").GetProperty("after").GetString());
        Assert.Equal("5", second.RootElement.GetProperty("variables").GetProperty("after").GetString());
    }

    // bol's edge wants the operation in a header (body only: 400 InvalidRequest) and x-xsrf-token (absent: 403 XSRF failed)
    [Fact]
    public async Task The_api_call_names_its_operation_in_a_header_and_echoes_the_xsrf_token()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        var request = handler.Requests[0];

        Assert.Equal("OrdersOverviewClient", request.Header("bol-app-operation-name"));

        // the value comes off the stored cookie: a hard-coded token would pass while the real thing failed
        Assert.Equal("fixture-xsrf-token", request.Header("x-xsrf-token"));
        Assert.Contains("XSRF-TOKEN=fixture-xsrf-token", request.Header("Cookie"), StringComparison.Ordinal);
    }

    // a page GET sends no token: sending it would be traffic bol's own front end never makes
    [Fact]
    public async Task A_page_fetch_carries_neither_header_because_it_asks_no_operation()
    {
        var handler = new StubHttpHandler((_, _) => Html(FixtureCatalog.Read("bol/orders-page.html")));
        using var ctx = FetchContext(handler);

        await Adapter(Pages).FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.Equal(HttpMethod.Get, handler.Requests[0].Method);
        Assert.Null(handler.Requests[0].Header("x-xsrf-token"));
        Assert.Null(handler.Requests[0].Header("bol-app-operation-name"));
    }

    // without the token bol answers 403, read as a block (a dead end); a login sets the cookie, so session_expired fixes it
    [Fact]
    public async Task A_session_missing_the_xsrf_cookie_asks_for_a_login_instead_of_being_refused()
    {
        var jar = FixtureCatalog.Read("bol/storage-state.json")
            .Replace("XSRF-TOKEN", "SOMETHING-ELSE", StringComparison.Ordinal);

        var handler = new StubHttpHandler((_, _) => Stub.Fixture("bol/orders-graphql.json"));

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { StorageState = jar },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("XSRF-TOKEN", error.Detail, StringComparison.Ordinal);

        // a request that cannot succeed is not worth spending against an account bol may be scoring
        Assert.Empty(handler.Requests);
    }

    // a declared include that always arrives empty is worse than none: the consumer builds a screen for it
    [Fact]
    public async Task Raw_is_the_order_exactly_as_bol_sent_it_and_only_when_asked()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var asked = await Adapter().FetchAsync(
            ctx, Requests.Receipts(raw: true), CancellationToken.None);

        // keyed by the receipt's external id so a consumer can pair them
        var document = Assert.Contains("A000TEST001", (IDictionary<string, string>)asked.Raw!);

        using var parsed = JsonDocument.Parse(document);
        Assert.Equal("A000TEST001", parsed.RootElement.GetProperty("reference").GetString());

        // verbatim, not our reading: raw must still say what bol said when our parser stops agreeing
        Assert.True(parsed.RootElement.TryGetProperty("items", out _));
    }

    [Fact]
    public async Task A_caller_that_did_not_ask_for_raw_is_not_handed_somebody_s_purchase()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(raw: false), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Empty(result.Raw ?? new Dictionary<string, string>(StringComparer.Ordinal));
    }

    // a stale token is a 403 like bol's blocks; the body tells them apart, and mixing them up tells the user to wait for nothing
    [Fact]
    public async Task A_stale_csrf_token_asks_for_a_login_rather_than_reading_as_a_block()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Json("XSRF failed", HttpStatusCode.Forbidden));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    // a 403 that says anything else is a block: otherwise every block reads as an expired session
    [Fact]
    public async Task A_403_that_is_not_about_the_token_is_still_a_refusal()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Json("Access Denied", HttpStatusCode.Forbidden));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    // bol states no total, so the flag must survive the adapter or a matcher thinks bol confirmed a number it never said
    [Fact]
    public async Task A_receipt_bol_never_totalled_leaves_the_adapter_saying_so()
    {
        var handler = new StubHttpHandler((_, i) => i == 0
            ? Stub.Fixture("bol/orders-graphql.json")
            : Stub.Json("""{"data":{"me":{"orders":[]}}}"""));

        using var ctx = FetchContext(handler);

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.All(result.Receipts, r => Assert.True(r.TotalIsDerived));
        Assert.All(result.Receipts, r => Assert.False(r.Reconciled));

        var order = result.Receipts.Single(r => r.ExternalId == "A000TEST002");
        Assert.Equal(4248 + 1199, order.Total.Value);
    }

    [Fact]
    public async Task The_json_shape_is_a_configuration_edit_and_not_a_release()
    {
        var options = Options with { OrdersShape = BolOrdersShape.Json };
        var handler = new StubHttpHandler((_, _) => Stub.Fixture("bol/orders.json"));

        using var ctx = FetchContext(handler);

        var result = await Adapter(options).FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.Equal("json", result.Via);
        Assert.Equal(3, result.Receipts.Count);
        Assert.Contains("/rnwy/api/account/orders", handler.Requests[0].Path, StringComparison.Ordinal);
        Assert.Contains("application/json", handler.Requests[0].Header("Accept"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_fetch_with_no_stored_cookies_asks_for_a_new_login()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Status(HttpStatusCode.OK));

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { StorageState = LoginHostOnlyState },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        // no credential exists during a fetch: session_expired asks the platform for a login job
        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task An_unknown_resource_is_refused_without_a_request()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Status(HttpStatusCode.OK));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                ctx, new ResourceRequest { ResourceId = "transactions" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData((HttpStatusCode)429)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task Bot_protection_statuses_are_a_block_and_never_a_credential_error(HttpStatusCode status)
    {
        var handler = new StubHttpHandler((_, _) => Stub.Status(status));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        // bot protection is not a wrong password: the user would reset a good one and the block stay undiagnosed
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task A_rejected_session_is_session_expired_and_a_dead_upstream_is_unavailable()
    {
        var unauthorized = new StubHttpHandler((_, _) => Stub.Status(HttpStatusCode.Unauthorized));
        using (var ctx = FetchContext(unauthorized))
        {
            var error = await Assert.ThrowsAsync<ConnectorException>(
                () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

            Assert.Equal(ErrorCode.SessionExpired, error.Code);
        }

        var broken = new StubHttpHandler((_, _) => Stub.Status(HttpStatusCode.InternalServerError));
        using (var ctx = FetchContext(broken))
        {
            var error = await Assert.ThrowsAsync<ConnectorException>(
                () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

            Assert.Equal(ErrorCode.ProviderUnavailable, error.Code);
            Assert.True(error.Retriable);
        }
    }

    [Fact]
    public async Task A_two_hundred_that_is_really_a_wall_is_still_a_block()
    {
        var handler = new StubHttpHandler((_, _) => Html(FixtureCatalog.Read("bol/bot-wall.html")));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        // bol runs no such vendor (confirmed from response headers): defence against a change that must not read as a bad password
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("cf-browser-verification", error.Detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_two_hundred_that_is_really_the_login_form_asks_for_a_new_login()
    {
        var handler = new StubHttpHandler((_, _) => Html(FixtureCatalog.Read("bol/login-interstitial.html")));
        using var ctx = FetchContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        // a dead cookie is session_expired (a new login job), not a parser failure that pages an operator
        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("j_username", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_page_that_repeats_itself_stops_the_walk_instead_of_looping()
    {
        // bol's pagination parameter is a guess: an ignored page would be fetched twenty times against a live account
        var handler = new StubHttpHandler((_, _) => Html(FixtureCatalog.Read("bol/orders-page.html")));
        using var ctx = FetchContext(handler);

        var result = await Adapter(Pages).FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
        Assert.Equal(2, handler.Requests.Count);
    }

    private static StubLoginPage SignedInPage() =>
        StubLoginPage.Showing(Username, PasswordBox, Submit);

    private static StubRedirectWaiter Arrives(int afterWaits = 0) =>
        new("https://www.bol.com/nl/nl/account/bestellingen/overzicht/", afterWaits);

    private static StubRedirectWaiter Never() => new(redirect: null, afterWaits: 0);

    private static Dictionary<string, string> Credentials() =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Email,
            ["password"] = Password,
        };

    private static FakeJobContext LoginContext(
        StubLoginPage page, Func<Challenge, string>? answer = null, string? storageState = null) =>
        new()
        {
            Inputs = Credentials(),
            Browser = new BolBrowserStub(page, storageState),
            Answer = answer ?? (_ => Code),
        };

    private static FakeJobContext FetchContext(HttpMessageHandler handler) =>
        new(handler)
        {
            Material = new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") },
        };

    // the browser's own jar, CSRF echo and referer are in the bundle but a replay must leave them to the fetch
    private static SessionMaterial ReplayMaterial() =>
        BolPersistedQuery.WithRequest(
            BolPersistedQuery.WithHash(
                new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") }, PageHash),
            new BolPageRequest(PageBody, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["user-agent"] = PageUserAgent,
                ["accept"] = "*/*",
                ["content-type"] = "application/json",
                ["bol-app-operation-name"] = "OrdersOverviewClient",
                ["bol-app-version"] = "7.3.1",
                ["origin"] = "https://www.bol.com",
                ["sec-fetch-site"] = "same-origin",
                ["cookie"] = "XSC=stale",
                ["x-xsrf-token"] = "stale-token",
                ["referer"] = "https://www.bol.com/somewhere/else",
            }));

    private static HttpResponseMessage Html(string body) =>
        new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "text/html"),
        };

    private const string LoginHostOnlyState =
        """{"cookies":[{"name":"JSESSIONID","value":"x","domain":"login.bol.com","path":"/","expires":-1}],"origins":[]}""";
}

// own lease: the shared StubBrowserLease refuses StorageStateAsync, but bol's login yields only a cookie jar
internal sealed class BolBrowserStub : IBrowserLease
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    private readonly StubLoginPage _page;
    private readonly string _storageState;

    public BolBrowserStub(StubLoginPage page, string? storageState = null)
    {
        _page = page;
        _storageState = storageState ?? FixtureCatalog.Read("bol/storage-state.json");
    }

    public bool Started => true;

    public Task<string> StorageStateAsync(CancellationToken ct) => Task.FromResult(_storageState);

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        _page.Record("screenshot");
        return Task.FromResult(_page.HoldsSecret ? Array.Empty<byte>() : Png);
    }

    public Task<IPage> PageAsync(CancellationToken ct) =>
        throw new InvalidOperationException("this test drives the page through the adapter's seam");

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

internal sealed class BolPageAt : ILoginPage
{
    public BolPageAt(string url) => Url = url;

    public string Url { get; }

    public Task GotoAsync(string url, CancellationToken ct) => Task.CompletedTask;

    public Task ClearSecretsAsync(CancellationToken ct) => Task.CompletedTask;

    public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
        Task.FromResult<PageMatch?>(null);

    public Task<bool> FillAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
        Task.FromResult(false);

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
        Task.FromResult(false);

    public Task<bool> AnswerAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
        Task.FromResult(false);
}
