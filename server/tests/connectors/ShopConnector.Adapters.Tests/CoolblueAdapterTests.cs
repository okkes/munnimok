using System.Net;
using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// fetch tests mostly pin refusals: its failures are plausible wrong answers (another order's price, a partial history
// passed off as whole), not exceptions
public sealed class CoolblueAdapterTests
{
    private const string Username = "shopper@example.com";
    private const string Password = "hunter2";
    private const string Code = "coolblue-authorization-code";

    private const string TokenPath = "/oauth/token";
    private const string UserInfoPath = "/oauth/userinfo";

    private static readonly DateTimeOffset Now = new(2026, 7, 28, 3, 0, 0, TimeSpan.Zero);

    private static readonly CoolblueOptions Options = new();

    // written out, not read off the options: a fixture built from the option's own list passes even when it is wrong
    // :not([tabindex='-1']) and :not([form]) are load-bearing: the latter stops a reset-password click
    private const string UsernameInput = "input[name='username']";
    private const string PasswordInput = "input[name='password']:not([tabindex='-1'])";
    private const string Submit = "button[type='submit']:not([form])";

    private static CoolblueAdapter Adapter(CoolblueOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    [Fact]
    public void The_manifest_validates_and_does_not_promise_unattended_sync()
    {
        var manifest = Adapter().Describe();

        ManifestValidator.Validate(manifest);

        Assert.Equal("coolblue", manifest.Id);
        Assert.Equal(ProviderKind.Store, manifest.Kind);
        Assert.Equal("NL", manifest.Country);

        Assert.Equal(ProviderRuntime.BrowserOnce, manifest.Runtime);
        Assert.True(manifest.Agent.Required);
        Assert.Equal(AgentClass.Pooled, manifest.Agent.Class);

        // egress 'any': no bot management was found on coolblue.nl, so a residential line would cost for a wall nobody has seen
        Assert.NotNull(manifest.Agent.Egress);
        Assert.Equal("NL", manifest.Agent.Egress.Country);
        Assert.Equal("any", manifest.Agent.Egress.Kind);

        // not refreshable: the account pages are server-rendered HTML behind the session cookie (no Authorization header on the
        // captured request) and nothing renews that cookie without a browser
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.False(manifest.Auth.Reauth.Cheap);

        // RotatesOnUse stays true though unconfirmed: the error runs the safe way round (see the manifest)
        Assert.True(manifest.Auth.Session.RotatesOnUse);

        // lifetime unconfirmed and stated conservatively: under-promising offers a reconnect early, over-promising fails daily
        Assert.Equal(2_592_000, manifest.Auth.Session.TtlSeconds);

        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);
        Assert.Equal(WebSupport.Ephemeral, manifest.WebSupport);
    }

    [Fact]
    public void The_manifest_says_in_its_notes_key_what_a_first_sync_costs()
    {
        var manifest = Adapter().Describe();

        // the key names the cost: the order list states no money, so each receipt needs the order's own page;
        // a first connect takes minutes
        Assert.Equal("connect.coolblue.notes.page_per_order", manifest.NotesKey);
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
    public void The_manifest_asks_for_an_email_and_a_password_on_one_screen()
    {
        var manifest = Adapter().Describe();

        // one screen, both boxes (confirmed): not TwoStep, a wizard would make the user submit twice
        Assert.Equal(AuthFlow.Password, manifest.Auth.Flow);

        var step = Assert.Single(manifest.Auth.Steps);
        Assert.Equal(2, step.Fields.Count);

        var username = Assert.Single(step.Fields, f => f.Key == "username");
        Assert.Equal(FieldType.Text, username.Type);
        Assert.False(username.Secret);
        Assert.True(username.Required);

        var password = Assert.Single(step.Fields, f => f.Key == "password");
        Assert.Equal(FieldType.Password, password.Type);
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");

        // declared against the evidence (no captcha seen on this form): a consumer with no UI for a challenge strands the user
        Assert.Equal(
            new[] { ChallengeType.Image, ChallengeType.AppApproval },
            manifest.Auth.Challenges);
    }

    [Fact]
    public void The_receipts_resource_matches_the_shape_every_shop_provider_offers()
    {
        var receipts = Adapter().Describe().Resource("receipts");

        Assert.NotNull(receipts);
        Assert.Equal(ResourceShape.Receipt, receipts.Returns);

        var since = receipts.Param("since");
        Assert.NotNull(since);
        Assert.Equal(ParamType.Date, since.Type);
        Assert.True(since.Required);

        var until = receipts.Param("until");
        Assert.NotNull(until);
        Assert.Equal(ParamType.Date, until.Type);

        var include = receipts.Param("include");
        Assert.NotNull(include);
        Assert.Equal(ParamType.Enum, include.Type);
        Assert.True(include.Multi);

        // 'items' is offered: one order charged 463 and itemised 399 but another lists 694 of 694, so the gap is per order
        // and becomes a derived Unattributed line
        Assert.NotNull(include.Values);
        Assert.Equal(new[] { "items", ResourceRequest.InvoiceInclude }, include.Values);
    }

    // a record costs a page load: the order list states no money, so every total needs the order's own 600KB page
    [Fact]
    public void The_manifest_prices_a_fetch_that_costs_a_page_load_per_receipt()
    {
        var manifest = Adapter().Describe();

        // 400 where other stores allow 2000: each receipt is a page load of about 600KB
        Assert.Equal(400, manifest.Resource("receipts")!.MaxRecordsPerFetch);

        // 1.5 s gap, half of Amazon's 3 s: Amazon has rate-limited this project, Coolblue runs no bot management,
        // but this is the heaviest fetch
        Assert.Equal(1_500, manifest.Limits.MinRequestGapMs);
    }

    // ParamBinder.Widen CLAMPS a caller's since to this window, so a cap set too short silently answers a different question
    // (a January 2020 order on Coolblue's own site was once out of range)
    [Fact]
    public void The_history_window_reaches_the_oldest_orders_the_account_still_shows()
    {
        var manifest = Adapter().Describe();
        var days = manifest.Resource("receipts")!.MaxHistoryDays;

        Assert.NotNull(days);

        var earliest = DateOnly.FromDateTime(Now.UtcDateTime).AddDays(-days.Value);

        Assert.True(
            earliest <= new DateOnly(2020, 1, 11),
            $"the window reaches back only to {earliest}, which hides a known order of 11 January 2020");

        // the resource and provider limits must agree: the binder falls back from one to the other
        Assert.Equal(days.Value, manifest.Limits.MaxHistoryDays);
    }

    // starts at the protected page: our own authorize URL (own state/PKCE) left www.coolblue.nl anonymous;
    // Coolblue's 307 to /inloggen runs its own flow
    [Fact]
    public async Task The_login_starts_at_the_protected_page_and_lets_coolblue_run_its_own_flow()
    {
        var page = LoginForm();
        using var ctx = SigningIn(new StubHttpHandler(Route));

        await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        var url = Assert.Single(page.Visited);
        Assert.Equal("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht", url);

        Assert.DoesNotContain("code_challenge", url, StringComparison.Ordinal);
        Assert.DoesNotContain("state=", url, StringComparison.Ordinal);
        Assert.DoesNotContain("/connect/authorize", url, StringComparison.Ordinal);
    }

    // the two exclusion clauses are guards: today's percent-encoded return URL hides the account path anyway,
    // so they are tested with an unencoded return URL and a redirect_uri naming the account area
    [Theory]
    [InlineData("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht", true)]
    [InlineData("https://www.coolblue.nl/mijn-coolblue-account", true)]
    [InlineData("https://www.coolblue.nl/inloggen?returnUrl=https%3A%2F%2Fwww.coolblue.nl%2Fmijn-coolblue-account%2Forderoverzicht", false)]
    // And unencoded, which is what makes the /inloggen clause earn its place.
    [InlineData("https://www.coolblue.nl/inloggen?returnUrl=/mijn-coolblue-account/orderoverzicht", false)]
    // The form itself - and the form with the account area named in its own
    // redirect_uri, which is what makes the login-HOST clause earn its place.
    [InlineData("https://accounts.coolblue.nl/connect/authorize?client_id=Webshop", false)]
    [InlineData("https://accounts.coolblue.nl/connect/authorize?redirect_uri=https://www.coolblue.nl/mijn-coolblue-account", false)]
    [InlineData("https://www.coolblue.nl/", false)]
    [InlineData("", false)]
    public void Only_the_account_area_counts_as_signed_in(string url, bool signedIn)
    {
        Assert.Equal(signedIn, CoolblueSessionWatcher.SignedIn(url, Options));
    }

    // the protected page is the test: a browser Coolblue knows lands on the overview, one it does not is 307'd to /inloggen;
    // a sign-in driven at the overview would hunt an e-mail box that is not there

    // timers that do not wait: the bounce window runs at its shipped length
    private static CoolblueAdapter Patient() => new(Options, new InstantTimeProvider(Now));

    // the page has every box and credentials are stored: a check placed after the inputs are read would still type
    [Fact]
    public async Task A_browser_still_signed_in_to_coolblue_types_nothing()
    {
        var page = LoginForm();
        page.Url = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

        using var ctx = SigningIn(new StubHttpHandler(Route), restored: true);

        // the waiter that answers, not Never(): a sign-in driven here fails the asserts, against Never() it would hang the suite
        var result = await Patient().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);

        // nothing latched, nothing reached Coolblue: the control plane may requeue
        Assert.False(ctx.CredentialWasSubmitted);

        // the same session a finished sign-in seals: on this shop the cookie jar is the credential
        Assert.Equal(SignedInJar, result.Material.StorageState);
        Assert.Equal("Coolblue", result.Account!.DisplayName);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in to Coolblue", StringComparison.Ordinal));
    }

    // the address is the only witness: a signed-out request to any Coolblue page also gets Set-Cookie: Coolblue-Session
    // (confirmed with curl), so the redirect must be believed when seen
    [Fact]
    public async Task A_browser_coolblue_sends_to_the_sign_in_page_signs_in_the_ordinary_way()
    {
        var page = LoginForm();
        page.Url =
            "https://www.coolblue.nl/inloggen?returnUrl=https%3A%2F%2Fwww.coolblue.nl%2Fmijn-coolblue-account";

        using var ctx = SigningIn(new StubHttpHandler(Route), restored: true);

        await Patient().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Equal(Username, page.Filled[UsernameInput]);
        Assert.Equal(Password, page.Filled[PasswordInput]);
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still signed in to Coolblue", StringComparison.Ordinal));
    }

    // first connect: no kept profile or bundle jar, so SessionProbe says "cannot tell" without looking;
    // the shipped adapter (real timers) makes a broken gate show as slowness
    [Fact]
    public async Task A_first_connect_is_never_asked_whether_it_is_already_signed_in()
    {
        var page = LoginForm();
        page.Url = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

        using var ctx = SigningIn(new StubHttpHandler(Route));

        await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Equal(Username, page.Filled[UsernameInput]);
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still signed in to Coolblue", StringComparison.Ordinal));
    }

    // no HTTP request of its own: the token POST got a 403 edge refusal, and an access token buys nothing
    // (no Authorization header anywhere)
    [Fact]
    public async Task The_login_never_redeems_the_authorization_code()
    {
        var handler = new StubHttpHandler(Route);
        var page = LoginForm();
        using var ctx = SigningIn(handler);

        var result = await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Single(page.Visited);
        Assert.Empty(handler.Requests);

        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.RefreshToken);
        Assert.Null(result.Material.AccessTokenExpiresAt);
    }

    [Fact]
    public async Task The_login_seals_the_browsers_cookie_jar()
    {
        var page = LoginForm();
        using var ctx = SigningIn(new StubHttpHandler(Route));

        var result = await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Equal(SignedInJar, result.Material.StorageState);

        // the brand, not the person: userinfo would need a bearer token this login no longer obtains
        Assert.NotNull(result.Account);
        Assert.Equal("Coolblue", result.Account.DisplayName);
        Assert.Null(result.Account.ExternalId);

        // unset: the cookie's lifetime is unstated, the manifest carries the conservative guess
        Assert.Null(result.ExpiresAt);

        Assert.Contains(JobStep.Authenticating, ctx.Steps);
        Assert.Contains(JobStep.Finalizing, ctx.Steps);
    }

    // an empty bundle would look live, sync nothing and report session_expired on a session that never existed
    [Fact]
    public async Task A_login_that_leaves_no_cookie_fails_rather_than_sealing_an_empty_session()
    {
        var page = LoginForm();

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Inputs = Credentials(),
            Browser = new StubBrowserLease(page)
            {
                StorageState = """{"cookies":[{"name":"x","value":"y","domain":".example.test"}]}""",
            },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { SessionSettleSeconds = 0 })
                .LoginAsync(ctx, page, SignedIn(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("coolblue.nl", error.Detail!, StringComparison.Ordinal);
    }

    // a signed-out request already gets Coolblue-Session, cbvid and _csrfSecret (confirmed with curl): checking for cookies
    // seals an anonymous jar, so a login that never arrives reads the jar zero times
    [Fact]
    public async Task The_cookie_jar_is_never_read_by_a_login_that_did_not_arrive()
    {
        var page = LoginForm();

        var lease = new StubBrowserLease(page) { StorageState = SignedInJar };

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Inputs = Credentials(),
            Browser = lease,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { LoginSettleSeconds = 0 }).LoginAsync(ctx, page, Never(), cts.Token));

        Assert.Equal(0, lease.StorageReads);
    }

    [Fact]
    public async Task The_latch_closes_before_the_credentials_leave_the_machine()
    {
        var page = LoginForm();
        using var ctx = SigningIn(new StubHttpHandler(Route));

        await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        // After this a lost lease fails the job rather than requeuing it: a
        // retried login is how an account gets locked.
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_login_missing_a_credential_is_refused_before_the_page_is_touched(string missing)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Username,
            ["password"] = Password,
        };
        inputs.Remove(missing);

        var page = LoginForm();
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler) { Inputs = inputs };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(page.Visited);
        Assert.Empty(handler.Requests);
    }

    [Theory]
    [InlineData("username field")]
    [InlineData("password field")]
    [InlineData("login submit")]
    public async Task A_missing_element_on_the_login_form_is_a_shape_change_that_names_itself(string expected)
    {
        // Everything except the one under test, so a filler willing to settle
        // for "some input" would find one.
        var page = expected switch
        {
            "username field" => StubLoginPage.Showing(PasswordInput, Submit),
            "password field" => StubLoginPage.Showing(UsernameInput, Submit),
            _ => StubLoginPage.Showing(UsernameInput, PasswordInput),
        };

        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None));

        // Named with the candidate list, so the next breakage arrives already
        // diagnosed - and never invalid_credentials, which is permanent.
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains(expected, error.Detail, StringComparison.Ordinal);

        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_page_that_states_a_credential_error_is_the_only_route_to_invalid_credentials()
    {
        var page = StubLoginPage.Showing(
            UsernameInput, PasswordInput, Submit, ":text('e-mailadres of wachtwoord')");

        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);

        // It really did go upstream, which is what makes this reading honest
        // and what stops anything from retrying it.
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Silence_after_the_submit_is_a_shape_change_and_never_a_guess_at_the_password()
    {
        // the settle budget is zeroed: the suite's clock does not move, so the deadline loop never ends;
        // zero takes the same branch at once
        var options = Options with { LoginSettleSeconds = 0 };

        var page = LoginForm();
        using var ctx = Context(new StubHttpHandler(Route));
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(options).LoginAsync(ctx, page, Never(), cts.Token));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.Contains("neither reached", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_unattended_interactive_captcha_is_refused_at_once_and_nobody_is_asked()
    {
        // none has been seen on this form: the probe names one in a poll instead of waiting out the job budget
        var page = StubLoginPage.Showing(
            UsernameInput, PasswordInput, Submit, "iframe[src*='hcaptcha']");

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Inputs = Credentials(),
            Browser = new StubBrowserLease(page),
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        // blocked, not invalid_credentials: nothing is wrong with the password, nobody is at this browser
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("unattended", error.Detail, StringComparison.Ordinal);

        Assert.Empty(ctx.Asked);

        // the runner may capture an artifact on the way out of a failed job, so the password must be off the page
        Assert.False(page.HoldsSecret);
    }

    [Fact]
    public async Task A_fetch_with_no_stored_browser_session_is_a_dead_session_and_costs_coolblue_nothing()
    {
        // the cookie is the credential (server-rendered pages, no Authorization header);
        // a fetch holds no password, so it asks for a new login job
        var handler = new StubHttpHandler((_, _) => Stub.Page(Overview));
        using var ctx = new FakeJobContext(handler) { Material = new SessionMaterial { AccessToken = "irrelevant" } };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task An_undeclared_money_unit_refuses_before_the_walk_starts()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Page(Overview));
        using var ctx = Fetching(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { TotalUnit = null }).FetchAsync(ctx, Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("MajorString", error.Detail!, StringComparison.Ordinal);

        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task An_unknown_resource_is_unsupported()
    {
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                ctx, new ResourceRequest { ResourceId = "invoices" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
    }

    [Fact]
    public async Task The_list_is_an_index_and_every_total_costs_that_orders_own_page()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal("orders-html", result.Via);
        Assert.True(result.Complete);
        Assert.Equal(3, result.Receipts.Count);

        // a sequence, not a set: the whole list is read before any order page, so no page is opened that might be discarded
        Assert.Equal(
            [
                "/mijn-coolblue-account/orderoverzicht",
                "/mijn-coolblue-account/orderoverzicht?page=2",
                "/mijn-coolblue-account/orderoverzicht/80000001",
                "/mijn-coolblue-account/orderoverzicht/80000002",
                "/mijn-coolblue-account/orderoverzicht/80000003",
            ],
            handler.Requests.Select(r => r.Path + r.Query));

        Assert.All(handler.Requests, r =>
        {
            Assert.Equal("Coolblue-Session=session-fixture", r.Header("Cookie"));
            Assert.Null(r.Header("Authorization"));
        });

        Assert.Null(result.RefreshedMaterial);
    }

    [Fact]
    public async Task A_receipt_carries_the_total_from_its_own_page_and_the_product_from_the_list()
    {
        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        var fridge = result.Receipts[0];
        Assert.Equal("80000001", fridge.ExternalId);
        Assert.Equal("coolblue", fridge.Merchant.Id);
        Assert.Equal("Coolblue", fridge.Merchant.Name);

        // the one useful string the list offers: "Coolblue" ten times tells a user nothing
        Assert.Equal("Testmerk Koelkast RB100", fridge.Merchant.StoreName);

        // midnight Amsterdam from "15 december 2025": the page states no machine-readable date
        Assert.Equal(
            new DateTimeOffset(2025, 12, 15, 0, 0, 0, TimeSpan.FromHours(1)), fridge.PurchasedAt);

        Assert.Equal(46_300L, fridge.Total.Value);
        Assert.Equal("EUR", fridge.Total.Currency);

        // no items, so no reconciliation claim: the page itemises 399 of 463 and does not say what the rest is
        Assert.Empty(fridge.Items);
        Assert.False(fridge.TotalIsDerived);

        // payment fields explicit null: Coolblue names no method; null tells a consumer matching is weaker,
        // omission looks like an oversight
        Assert.NotNull(fridge.Payment);
        Assert.Null(fridge.Payment.Method);
        Assert.Null(fridge.Payment.CardLast4);
        Assert.Null(fridge.Payment.IbanTail);

        Assert.NotEmpty(fridge.ContentHash);
    }

    // a daily sync must not pay for history it has: each order outside the window is a thrown-away 600KB page load
    [Fact]
    public async Task A_narrow_window_never_opens_the_pages_of_orders_it_does_not_want()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(
            ctx, Receipts(since: Requests.Day(2025, 10, 1)), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        Assert.Equal("80000001", receipt.ExternalId);

        Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("80000002", StringComparison.Ordinal));
        Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("80000003", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_page_wholly_older_than_the_window_stops_the_walk_rather_than_paging_on()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        await Adapter().FetchAsync(ctx, Receipts(since: Requests.Day(2026, 1, 1)), CancellationToken.None);

        Assert.DoesNotContain(handler.Requests, r => r.Query.Contains("page=2", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_page_that_repeats_the_last_one_ends_the_walk()
    {
        var handler = new StubHttpHandler((request, _) =>
            request.Path.Contains("orderoverzicht/", StringComparison.Ordinal)
                ? Stub.Page(DetailsFor(Order(request.Path)))
                : Stub.Page(Overview));

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);

        Assert.Equal(2, handler.Requests.Count(r => !r.Path.Contains("orderoverzicht/", StringComparison.Ordinal)));
    }

    // Coolblue's /bestellingen redirects to the account home instead of 404: it answers wrong-but-plausible pages,
    // and a total read off one would put one order's money on another's receipt
    [Fact]
    public async Task A_page_that_states_another_order_number_is_never_priced_from()
    {
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(Overview),
            "/mijn-coolblue-account/orderoverzicht/80000002" => Stub.Page(Details),
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            _ => Stub.Page(Empty),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(["80000001", "80000003"], result.Receipts.Select(r => r.ExternalId));
        Assert.False(result.Complete);

        Assert.Contains(ctx.Notes, n =>
            n.Contains("80000002", StringComparison.Ordinal)
            && n.Contains("Ordernummer", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, false)]
    [InlineData(HttpStatusCode.InternalServerError, false)]
    [InlineData(HttpStatusCode.Forbidden, true)]
    public async Task A_failure_on_one_order_is_skipped_and_a_failure_on_all_of_them_is_thrown(
        HttpStatusCode status, bool fatal)
    {
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(Overview),
            "/mijn-coolblue-account/orderoverzicht/80000002" => Stub.Page(string.Empty, status),
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            _ => Stub.Page(Empty),
        });

        using var ctx = Fetching(handler);

        if (fatal)
        {
            // a wall answers every remaining order alike: carrying on wastes requests and reports a short history as complete
            var error = await Assert.ThrowsAsync<ConnectorException>(
                () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

            Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
            return;
        }

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(["80000001", "80000003"], result.Receipts.Select(r => r.ExternalId));
        Assert.False(result.Complete);
        Assert.Contains(ctx.Notes, n => n.Contains("80000002", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_window_that_ends_early_leaves_the_newer_orders_unopened()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(
            ctx, Receipts(until: Requests.Day(2025, 9, 30)), CancellationToken.None);

        Assert.Equal(["80000002", "80000003"], result.Receipts.Select(r => r.ExternalId));
        Assert.True(result.Complete);
        Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("80000001", StringComparison.Ordinal));
    }

    // driven through a generated overview: the cap only bites above its size and a fixture that large is unreadable
    [Fact]
    public async Task A_pass_past_the_record_cap_returns_the_newest_and_admits_it_is_partial()
    {
        // the seam's cap, not the manifest's 400: proving the cap with 400 invented orders would be unreadable
        const int cap = 75;

        const int orders = 90;
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(
                request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : ManyOrders(orders)),
            _ => Stub.Status(HttpStatusCode.NotFound),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter(new CoolblueOptions { RecordCap = cap }).FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(cap, result.Receipts.Count);

        // newest first: the caller holds the most recent and is told to come back, not handed a partial history that looks whole
        Assert.False(result.Complete);
        Assert.Equal("81000001", result.Receipts[0].ExternalId);
        Assert.Equal("81000075", result.Receipts[^1].ExternalId);

        Assert.Equal(cap, handler.Requests.Count(r => r.Path.Contains("orderoverzicht/", StringComparison.Ordinal)));
    }

    private static string ManyOrders(int count)
    {
        var cards = new System.Text.StringBuilder("<html lang=\"nl\"><body><main>");

        for (var i = 0; i < count; i++)
        {
            var placed = new DateOnly(2026, 1, 1).AddDays(-i);
            var id = $"8100{i + 1:0000}";

            cards.Append(System.Globalization.CultureInfo.InvariantCulture,
                $"""
                 <div class="css-4miz4d">
                 <p class="css-1x2y3z">Besteld op<!-- -->:</p><p class="css-i623zk">{placed.Day} {Month(placed.Month)} {placed.Year}</p>
                 <h2 class="css-807ot0">Testmerk Artikel {id}</h2>
                 <a href="/mijn-coolblue-account/orderoverzicht/{id}" class="css-ov5677"></a>
                 </div>
                 """);
        }

        return cards.Append("</main></body></html>").ToString();
    }

    private static string Month(int month) =>
        new[]
        {
            "januari", "februari", "maart", "april", "mei", "juni",
            "juli", "augustus", "september", "oktober", "november", "december",
        }[month - 1];

    // the gap between charged and itemised is named: offering no items at all threw away every order that itemises exactly
    [Fact]
    public async Task Items_arrive_when_asked_for_and_the_unitemised_remainder_is_named()
    {
        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(items: true), CancellationToken.None);

        var receipt = result.Receipts[0];
        Assert.Equal(2, receipt.Items.Count);

        var product = receipt.Items[0];
        Assert.Equal("Testmerk Koelkast RB100", product.Name);
        Assert.Equal(39_900L, product.Total.Value);
        Assert.Equal(ReceiptLineKind.Product, product.Kind);

        // quantity 1: this page writes "3x" when it sells three, so nothing before the name means one
        Assert.Equal(1m, product.Quantity);

        // unit price stays null: dividing the total by the count would invent a figure, wrong once a line is discounted
        Assert.Null(product.UnitPrice);

        // the remainder is derived and named by a copy KEY: the connector may not invent prose in anybody's language
        var remainder = receipt.Items[1];
        Assert.Equal(ReceiptLineKind.Unattributed, remainder.Kind);
        Assert.Equal(6_400L, remainder.Total.Value);
        Assert.Equal("receipt.line.unattributed", remainder.Name);

        Assert.True(receipt.Reconciled);
        Assert.Equal(46_300L, receipt.Total.Value);

        // the total stays Coolblue's own figure: what a bank transaction is matched against
        Assert.False(receipt.TotalIsDerived);
    }

    // an order whose lines add up gets no zero-valued unattributed line: it would make the exception look like the rule
    [Fact]
    public async Task An_order_that_adds_up_gets_no_derived_line()
    {
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(
                DetailsFor(Order(p)).Replace("399,-", "463,-", StringComparison.Ordinal)),
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(
                request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : Overview),
            _ => Stub.Status(HttpStatusCode.NotFound),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(items: true), CancellationToken.None);

        var receipt = result.Receipts[0];
        var item = Assert.Single(receipt.Items);

        Assert.Equal(ReceiptLineKind.Product, item.Kind);
        Assert.Equal(46_300L, item.Total.Value);
        Assert.True(receipt.Reconciled);
    }

    // the fixture order has one of everything, so only this notices a count multiplied into a total; confirmed from the invoice
    // (Aantal 3, Prijs incl. BTW 404,97, the page prints 404,97)
    [Fact]
    public async Task A_line_bought_three_times_keeps_the_amount_the_page_printed()
    {
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(
                DetailsFor(Order(p))
                    .Replace(
                        "<h3 class=\"css-i623zk\"> <a href",
                        "<h3 class=\"css-i623zk\">3x <a href",
                        StringComparison.Ordinal)
                    .Replace("399,-", "404,97", StringComparison.Ordinal)),
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(
                request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : Overview),
            _ => Stub.Status(HttpStatusCode.NotFound),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(items: true), CancellationToken.None);

        var product = result.Receipts[0].Items[0];

        Assert.Equal(3m, product.Quantity);
        Assert.Equal(40_497L, product.Total.Value);
        Assert.NotEqual(121_491L, product.Total.Value);

        // unit price not invented even where the arithmetic would work
        Assert.Null(product.UnitPrice);
    }

    [Fact]
    public async Task A_caller_that_did_not_ask_for_items_gets_none()
    {
        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        // no items means no derived line: it would claim an unattributed remainder equal to the whole total
        Assert.All(result.Receipts, r => Assert.Empty(r.Items));
    }

    [Fact]
    public async Task Invoices_come_free_off_the_list_markup_and_only_when_asked_for()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var without = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);
        Assert.All(without.Receipts, r => Assert.Empty(r.Documents));
        Assert.DoesNotContain(handler.Requests, r => r.Path.Contains("mijn-factuur", StringComparison.Ordinal));

        var withHandler = Coolblue();
        using var asked = Fetching(withHandler);

        var result = await Adapter().FetchAsync(asked, Receipts(invoice: true), CancellationToken.None);

        Assert.Equal("orders-html+invoice-pdf", result.Via);

        var byId = result.Receipts.ToDictionary(r => r.ExternalId, StringComparer.Ordinal);

        var document = Assert.Single(byId["80000001"].Documents);
        Assert.Equal(ReceiptDocumentKinds.Invoice, document.Kind);
        Assert.Equal("application/pdf", document.MediaType);
        Assert.Equal("coolblue-80000001-invoice-1300000001.pdf", document.Filename);
        Assert.Null(document.Name);
        Assert.Equal(Pdf.Length, document.SizeBytes);
        Assert.Equal(Convert.ToBase64String(Pdf), document.ContentBase64);

        Assert.Empty(byId["80000002"].Documents);
        Assert.Equal(2, byId["80000003"].Documents.Count);

        // the href is on the card: one request per invoice and no discovery, unlike Amazon's opaque guid or bol's details page
        Assert.Equal(3, withHandler.Requests.Count(r => r.Path.Contains("mijn-factuur", StringComparison.Ordinal)));
    }

    // the magic number is the file's own claim: it catches an error page wearing a PDF content type,
    // which a session dying mid-fetch produces
    [Theory]
    [InlineData("text/html", true)]
    [InlineData("application/pdf", false)]
    public async Task An_invoice_that_is_not_a_pdf_is_noted_and_left_off(string mediaType, bool realPdf)
    {
        var body = realPdf ? Pdf : System.Text.Encoding.UTF8.GetBytes("<html>not a pdf at all</html>");

        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            var p when p.Contains("mijn-factuur", StringComparison.Ordinal) => Stub.Bytes(body, mediaType),
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(Overview),
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            _ => Stub.Page(Empty),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(invoice: true), CancellationToken.None);

        // a document is an extra: failing a fetch that read every order correctly over one PDF trades the answer for a footnote
        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));
        Assert.True(result.Complete);
        Assert.NotEmpty(ctx.Notes);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData((HttpStatusCode)429)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task Bot_protection_statuses_are_blocked_and_never_invalid_credentials(HttpStatusCode status)
    {
        using var ctx = Fetching(new StubHttpHandler((_, _) => Stub.Page(string.Empty, status)));

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

        // 429 is a wall here, unlike the shared default: CloudFront's AWS WAF rate rule sends no Retry-After,
        // and treating a wall as "try again shortly" earns a permanent one
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task An_interstitial_answered_with_200_is_blocked_rather_than_parsed()
    {
        const string wall =
            "<html><head><title>ERROR: The request could not be satisfied</title></head>" +
            "<body>Request blocked. Generated by cloudfront (CloudFront)</body></html>";

        using var ctx = Fetching(new StubHttpHandler((_, _) => Stub.Page(wall)));

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

        // a wall is checked before a dead session: mistaking one for the other starts a login straight into the wall
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    [Fact]
    public async Task A_bounce_to_the_sign_in_form_is_a_dead_session()
    {
        const string login =
            "<html><body><form action=\"https://accounts.coolblue.nl/connect/authorize\">" +
            "<input name=\"csrf\" value=\"x\">" +
            "<input tabindex=\"-1\" type=\"password\" autocomplete=\"current-password\"></form></body></html>";

        using var ctx = Fetching(new StubHttpHandler((_, _) => Stub.Page(login)));

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    // every page is served by CloudFront and signed-in pages link the login host: neither may read as a block or a dead session
    [Fact]
    public async Task An_ordinary_account_page_is_not_mistaken_for_a_wall_or_a_login()
    {
        Assert.Contains("Uitloggen", Overview, StringComparison.Ordinal);

        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
    }

    private static string Overview => FixtureCatalog.Read("coolblue/orders-overview.html");

    private static string Details => FixtureCatalog.Read("coolblue/order-details.html");

    private const string Empty =
        "<html lang=\"nl\"><body><main><p>Je hebt nog geen bestellingen</p></main>" +
        "<nav><a href=\"/uitloggen\">Uitloggen</a></nav></body></html>";

    // bol's fixture: only a genuine magic number and a non-text file matter
    private static byte[] Pdf => Stub.FixtureBytes("bol/invoice.pdf");

    private static ResourceRequest Receipts(
        DateOnly? since = null, DateOnly? until = null, bool invoice = false, bool items = false)
    {
        List<string> include = [];
        if (items) include.Add("items");
        if (invoice) include.Add(ResourceRequest.InvoiceInclude);

        return new ResourceRequest
        {
            ResourceId = "receipts",
            Since = since,
            Until = until,
            Selections = include.Count == 0
                ? new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                : new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["include"] = include,
                },
        };
    }

    private static string Order(string path) => path[(path.LastIndexOf('/') + 1)..];

    // the fixture states order 80000001 and the adapter refuses another order's number,
    // so each order needs its own id substituted
    private static string DetailsFor(string orderId) =>
        Details.Replace("80000001", orderId, StringComparison.Ordinal);

    private static StubHttpHandler Coolblue() => new((request, _) => request.Path switch
    {
        var p when p.Contains("mijn-factuur", StringComparison.Ordinal) => Stub.Bytes(Pdf),
        var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
        "/mijn-coolblue-account/orderoverzicht" =>
            Stub.Page(request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : Overview),
        _ => Stub.Status(HttpStatusCode.NotFound),
    });

    private static HttpResponseMessage Route(RecordedRequest request, int _) => request.Path switch
    {
        TokenPath => Stub.Fixture("coolblue/token.json"),
        UserInfoPath => Stub.Fixture("coolblue/userinfo.json"),
        _ => Stub.Status(HttpStatusCode.NotFound),
    };

    private static HttpResponseMessage Html(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/html") };

    private static StubLoginPage LoginForm() =>
        StubLoginPage.Showing(UsernameInput, PasswordInput, Submit);

    private static ArrivalWaiter SignedIn() =>
        new("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht");

    private static ArrivalWaiter Never() => new(url: null);

    private static Dictionary<string, string> Credentials() =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Username,
            ["password"] = Password,
        };

    private const string SignedInJar =
        """{"cookies":[{"name":"Coolblue-Session","value":"session-fixture","domain":".coolblue.nl","expires":-1}]}""";

    private static FakeJobContext Context(HttpMessageHandler handler) =>
        new(handler) { Inputs = Credentials() };

    // separate from Context: most tests must not touch a browser (a lease that refuses proves it)
    // restored: the browser was opened with a kept profile or the bundle's jar;
    // only then does SessionProbe ask whether already signed in
    private static FakeJobContext SigningIn(HttpMessageHandler handler, bool restored = false) =>
        new(handler)
        {
            Inputs = Credentials(),
            Browser = new StubBrowserLease(LoginForm()) { StorageState = SignedInJar },
            KeepsSession = restored,
        };

    // the cookie list is awkward on purpose: the session cookie has a NEGATIVE expiry and must not be filtered as expired;
    // a genuinely stale one and another domain's must not travel
    private static FakeJobContext Fetching(HttpMessageHandler handler) =>
        new(handler)
        {
            Material = new SessionMaterial
            {
                AccessToken = "stored-access-token",
                RefreshToken = "stored-refresh-token",
                StorageState =
                    """
                    {"cookies":[
                      {"name":"Coolblue-Session","value":"session-fixture","domain":".coolblue.nl","expires":-1},
                      {"name":"stale","value":"x","domain":".coolblue.nl","expires":1},
                      {"name":"elsewhere","value":"x","domain":".example.test"}
                    ]}
                    """,
            },
        };

    private static Dictionary<string, string> Query(string url) =>
        Pairs(new Uri(url).Query.TrimStart('?'));

    private static Dictionary<string, string> Form(RecordedRequest request)
    {
        Assert.NotNull(request.Body);
        return Pairs(request.Body);
    }

    // hand-rolled: the assertions are about exactly which characters went onto the wire
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

    // deliberately dumber than CoolblueSessionWatcher, which is tested directly:
    // duplicating its rule would let both copies drift and agree
    private sealed class ArrivalWaiter : IRedirectWaiter
    {
        private readonly string? _url;

        public ArrivalWaiter(string? url) => _url = url;

        public int Waits { get; private set; }

        public Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
        {
            Waits++;
            return Task.FromResult(_url);
        }
    }

    // the shared stub refuses PageAsync; sealing the browser session away is the behaviour under test
    private sealed class StorageOnlyLease : IBrowserLease
    {
        private readonly string _state;

        public StorageOnlyLease(string state) => _state = state;

        public bool Started => true;

        public Task<string> StorageStateAsync(CancellationToken ct) => Task.FromResult(_state);

        public Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct) => throw Refused();

        public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) => throw Refused();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        private static InvalidOperationException Refused() => new("this test must not start a browser");
    }
}

internal static class CoolblueTestExtensions
{
    public static IReadOnlyList<RecordedRequest> Requests(this FakeJobContext ctx) =>
        ctx.Handler is StubHttpHandler stub ? stub.Requests : [];
}
