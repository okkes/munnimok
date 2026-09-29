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

/// <summary>
/// Coolblue, offline: no browser, no network, no credentials.
///
/// Two halves, and they are tested for opposite reasons.
///
/// The LOGIN is a standards-compliant OIDC authorization-code flow, and it is
/// tested the way a login that may only ever be attempted once has to be: the
/// PKCE pair surviving a whole page login, the state check on the callback, the
/// credential latch, and every path that must never become
/// invalid_credentials.
///
/// The FETCH is the opposite problem. It reads server-rendered markup with no
/// stable hook anywhere on it, which means the interesting failures are not
/// exceptions - they are plausible wrong answers. So what is tested here is
/// mostly what the adapter REFUSES to do: price an order from a page that is
/// not that order's, walk on when a pagination parameter stops working, call a
/// perfectly good account page a bot wall, or return seventy-five receipts
/// while implying they are the whole history.
/// </summary>
public sealed class CoolblueAdapterTests
{
    private const string Username = "shopper@example.com";
    private const string Password = "hunter2";
    private const string Code = "coolblue-authorization-code";

    private const string TokenPath = "/oauth/token";
    private const string UserInfoPath = "/oauth/userinfo";

    private static readonly DateTimeOffset Now = new(2026, 7, 28, 3, 0, 0, TimeSpan.Zero);

    private static readonly CoolblueOptions Options = new();

    /// <summary>
    /// The three controls Coolblue's login form is confirmed to carry, WRITTEN
    /// OUT rather than read off the adapter's own list.
    /// </summary>
    /// <remarks>
    /// These were <c>Options.UsernameSelectors[0]</c> and its siblings, which
    /// makes the fixture a restatement of the question: the page becomes
    /// "whatever this adapter looks for first", so a list that is entirely
    /// wrong still passes and replacing one moves the page underneath the test.
    /// That is the fixture shape that cost a live ASN fetch.
    /// <para>
    /// The password selector carries its <c>:not([tabindex='-1'])</c> and the
    /// submit its <c>:not([form])</c> on purpose. Both are load-bearing - the
    /// second is what stopped a login that had typed the password in correctly
    /// from then asking Coolblue to reset it - and a fixture written from the
    /// option would hide the day one of them was dropped.
    /// </para>
    /// </remarks>
    private const string UsernameInput = "input[name='username']";
    private const string PasswordInput = "input[name='password']:not([tabindex='-1'])";
    private const string Submit = "button[type='submit']:not([form])";

    private static CoolblueAdapter Adapter(CoolblueOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    // ---- the manifest ------------------------------------------------------

    [Fact]
    public void The_manifest_validates_and_does_not_promise_unattended_sync()
    {
        var manifest = Adapter().Describe();

        // Throws with every failing rule listed. A manifest that cannot boot
        // the host must not pass the suite either.
        ManifestValidator.Validate(manifest);

        Assert.Equal("coolblue", manifest.Id);
        Assert.Equal(ProviderKind.Store, manifest.Kind);
        Assert.Equal("NL", manifest.Country);

        // T2: a browser drives one login and the refresh token serves the rest.
        // The validator requires an agent for any browser runtime.
        Assert.Equal(ProviderRuntime.BrowserOnce, manifest.Runtime);
        Assert.True(manifest.Agent.Required);
        Assert.Equal(AgentClass.Pooled, manifest.Agent.Class);

        // 'any', not 'residential', and that is a finding rather than an
        // oversight: no bot management was found anywhere on coolblue.nl, so
        // demanding a residential line would buy a real cost against a wall
        // nobody has seen.
        Assert.NotNull(manifest.Agent.Egress);
        Assert.Equal("NL", manifest.Agent.Egress.Country);
        Assert.Equal("any", manifest.Agent.Egress.Kind);

        // FALSE, and this is the correction the live capture forced.
        //
        // offline_access and a refresh_token grant are both CONFIRMED and both
        // irrelevant to the fetch: they renew an ACCESS TOKEN, and Coolblue's
        // account pages are server-rendered HTML behind the session cookie -
        // the captured request for the order list carried no Authorization
        // header at all. Nothing can renew that cookie without a browser, so a
        // manifest claiming unattended sync would promise a daily job that
        // works until it silently stops.
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.False(manifest.Auth.Reauth.Cheap);

        // Still true and still UNCONFIRMED, and left that way because the error
        // runs the safe way round - see the manifest.
        Assert.True(manifest.Auth.Session.RotatesOnUse);

        // UNCONFIRMED lifetime, stated conservatively. Under-promising makes a
        // consumer offer a reconnect slightly early; over-promising makes it
        // promise months of silent syncing and then fail every day.
        Assert.Equal(2_592_000, manifest.Auth.Session.TtlSeconds);

        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);
        Assert.Equal(WebSupport.Ephemeral, manifest.WebSupport);
    }

    [Fact]
    public void The_manifest_says_in_its_notes_key_what_a_first_sync_costs()
    {
        var manifest = Adapter().Describe();

        // A key, never prose - the consuming app owns the copy in every
        // language it ships. The key still has to NAME the caveat, because a
        // consumer that renders it is what tells a user, before they connect,
        // what they are in for. The caveat is the COST: Coolblue's order list
        // states no money, so every receipt needs that order's own page, which
        // makes a first connect minutes rather than seconds.
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

        // One screen, both boxes - CONFIRMED. Not TwoStep: Coolblue is not
        // Lidl, and a consumer rendering a wizard for a single form would ask
        // the user to submit twice.
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

        // Declared against the evidence rather than for it: no captcha was
        // found on this form. A consumer with no UI for a challenge its
        // provider suddenly raises strands the user at the worst moment.
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

        // BOTH, and 'items' is here after being wrongly withdrawn on the
        // strength of a single order whose page charged 463 and itemised 399.
        // A second captured order lists 694 against a total of 694. So the gap
        // is a per-order fact, and it becomes a derived Unattributed line
        // rather than a reason to offer nothing at all.
        Assert.NotNull(include.Values);
        Assert.Equal(new[] { "items", ResourceRequest.InvoiceInclude }, include.Values);
    }

    /// <summary>
    /// What a fetch costs this provider, declared where a consumer can see it.
    ///
    /// Coolblue is the only provider here where a RECORD COSTS A PAGE LOAD: its
    /// order list states no money at all, so every total needs the order's own
    /// 600KB page. Both numbers below are that fact written down, and a change
    /// to either is a change to what a first connect feels like.
    /// </summary>
    [Fact]
    public void The_manifest_prices_a_fetch_that_costs_a_page_load_per_receipt()
    {
        var manifest = Adapter().Describe();

        // Seventy-five, where every other provider here says two hundred. At
        // 200 a single job would pull about a hundred and twenty megabytes.
        Assert.Equal(75, manifest.Resource("receipts")!.MaxRecordsPerFetch);

        // And a gap between requests, which most providers here do not ask for
        // at all. Half of Amazon's three seconds: Amazon has actually
        // rate-limited this project and Coolblue runs no bot management, but
        // this is the heaviest fetch in the fleet.
        Assert.Equal(1_500, manifest.Limits.MinRequestGapMs);
    }

    /// <summary>
    /// The history window must not hide orders the shop is still showing.
    ///
    /// This is not a preference. <c>ParamBinder.Widen</c> CLAMPS a caller's
    /// `since` to this number rather than refusing it, so a cap set too short
    /// silently rewrites the question and answers a different one. It was set
    /// from the oldest order visible in a capture - twice - and the account
    /// owner found a January 2020 order on Coolblue's own site that the
    /// connector insisted was out of range.
    /// <para>
    /// Asserted against a DATE rather than a day count, because the day count
    /// is the implementation and "orders from January 2020 are reachable" is
    /// the promise.
    /// </para>
    /// </summary>
    [Fact]
    public void The_history_window_reaches_the_oldest_orders_the_account_still_shows()
    {
        var manifest = Adapter().Describe();
        var days = manifest.Resource("receipts")!.MaxHistoryDays;

        Assert.NotNull(days);

        var earliest = DateOnly.FromDateTime(Now.UtcDateTime).AddDays(-days.Value);

        // The oldest order seen on this account, on Coolblue's own page.
        Assert.True(
            earliest <= new DateOnly(2020, 1, 11),
            $"the window reaches back only to {earliest}, which hides a known order of 11 January 2020");

        // The resource and the provider limit agree; the binder falls back from
        // one to the other, and a disagreement would mean two different answers
        // depending on which one a caller happened to read.
        Assert.Equal(days.Value, manifest.Limits.MaxHistoryDays);
    }

    // ---- the login: let Coolblue run its own flow --------------------------

    /// <summary>
    /// The login starts at the PROTECTED PAGE, not at an authorize URL of our
    /// own making - and that is the correction two live runs forced.
    ///
    /// Driving the OIDC flow ourselves meant minting a state and a PKCE
    /// verifier that Coolblue's own callback page knew nothing about. The human
    /// signed in, the identity server was satisfied, and www.coolblue.nl stayed
    /// ANONYMOUS - so the login sealed a jar of anonymous cookies and the first
    /// fetch was handed the sign-in form.
    /// <para>
    /// A signed-out GET of this page answers 307 to
    /// <c>/inloggen?returnUrl=...</c>, and Coolblue drives its own flow from
    /// there with its own state and its own verifier. Same reason bol's login
    /// starts at bol's account page.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_login_starts_at_the_protected_page_and_lets_coolblue_run_its_own_flow()
    {
        var page = LoginForm();
        using var ctx = SigningIn(new StubHttpHandler(Route));

        await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        var url = Assert.Single(page.Visited);
        Assert.Equal("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht", url);

        // Nothing of ours in it. A state, a nonce or a code_challenge here
        // means this adapter has started somebody else's login again.
        Assert.DoesNotContain("code_challenge", url, StringComparison.Ordinal);
        Assert.DoesNotContain("state=", url, StringComparison.Ordinal);
        Assert.DoesNotContain("/connect/authorize", url, StringComparison.Ordinal);
    }

    /// <summary>
    /// Which URLs count as signed in, and the ones that look like it and are
    /// not.
    ///
    /// Coolblue sends an unauthenticated visitor to
    /// <c>/inloggen?returnUrl=...</c> carrying the page they asked for - so the
    /// URL the browser sits on while LEAST signed in mentions the account area
    /// in its own query string. Live, that return URL is percent-encoded, which
    /// happens to hide it from a naive check.
    /// <para>
    /// Which means the two exclusion clauses are GUARDS rather than fixes:
    /// against today's URLs, matching the account path alone would give the
    /// same answers. They are tested here with the shapes that would make them
    /// matter - an unencoded return URL, and an authorize call naming the
    /// account area in its own redirect_uri - because an untested guard is one
    /// a refactor removes for free, and what it guards against is a login
    /// reporting success while sitting on the sign-in page.
    /// </para>
    /// </summary>
    [Theory]
    // The destination, and the account home it may land on instead.
    [InlineData("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht", true)]
    [InlineData("https://www.coolblue.nl/mijn-coolblue-account", true)]
    // The redirect, exactly as the live 307 spells it - encoded.
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

    // ---- a browser Coolblue is still letting in -----------------------------
    //
    // The protected page IS the test. Coolblue answers it for a browser it
    // knows and 307s one it does not to /inloggen - so an agent that keeps a
    // profile opens this and is simply on the order overview, and a sign-in
    // driven at that page would hunt an e-mail box that is not there and
    // report the shop as changed.

    /// <summary>
    /// The adapter with timers that do not wait, so the bounce window runs at
    /// its SHIPPED length rather than at one a test shortened to stay quick.
    /// </summary>
    private static CoolblueAdapter Patient() => new(Options, new InstantTimeProvider(Now));

    /// <summary>
    /// THE PAYOFF, as a test: a browser Coolblue still knows types nothing.
    /// </summary>
    /// <remarks>
    /// The page here carries every box the form has, and the credentials are
    /// stored - so a check placed after the inputs were read would still type
    /// and would still be caught below. What must happen is that none of it is
    /// reached.
    /// </remarks>
    [Fact]
    public async Task A_browser_still_signed_in_to_coolblue_types_nothing()
    {
        var page = LoginForm();
        page.Url = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

        using var ctx = SigningIn(new StubHttpHandler(Route), restored: true);

        // THE WAITER THAT ANSWERS, not the one that never does - and the
        // difference matters on a test whose whole claim is that this waiter is
        // never reached. A sign-in driven here would settle and then fail the
        // assertions below; a sign-in driven against Never() would sit in the
        // settle loop instead, and a hanging suite says far less than a red one.
        var result = await Patient().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);

        // AND NOTHING LATCHED, because nothing reached Coolblue. A connect
        // that typed no credential is still safe for the control plane to
        // requeue.
        Assert.False(ctx.CredentialWasSubmitted);

        // The same session a finished sign-in seals, because it is the same
        // method that builds it: on this shop the cookie jar IS the credential.
        Assert.Equal(SignedInJar, result.Material.StorageState);
        Assert.Equal("Coolblue", result.Account!.DisplayName);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in to Coolblue", StringComparison.Ordinal));
    }

    /// <summary>
    /// And the other side: a browser Coolblue redirects to <c>/inloggen</c>
    /// signs in the ordinary way.
    /// </summary>
    /// <remarks>
    /// The address is the ONLY witness this shop offers. Its cookies are not
    /// one - a signed-OUT request to any Coolblue page is answered with
    /// <c>Set-Cookie: Coolblue-Session=...</c>, confirmed live against a plain
    /// curl - which is why the redirect has to be believed the moment it is
    /// seen.
    /// </remarks>
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

    /// <summary>
    /// AND THE QUESTION IS NOT EVEN ASKED OF A BROWSER THAT WAS HANDED
    /// NOTHING.
    /// </summary>
    /// <remarks>
    /// The same page as the payoff test, standing on the account area, on a
    /// first connect: no kept profile and no cookie jar out of the bundle,
    /// because there is no bundle yet. Nothing could be holding a session, so
    /// <c>SessionProbe</c> answers "cannot tell" without looking and the
    /// sign-in runs.
    /// <para>
    /// The adapter is the SHIPPED one rather than <see cref="Patient"/>
    /// deliberately: with real timers this test would spend the whole
    /// <c>SignedOutBounceSeconds</c> window if the gate ever stopped working,
    /// so its speed is part of the assertion.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// The login makes NO HTTP request of its own.
    ///
    /// It used to POST the authorization code to Coolblue's token endpoint.
    /// Coolblue answered 403 - an edge refusal, not an OAuth error - and the
    /// job failed at the last step with the browser already signed in.
    /// <para>
    /// Removed rather than retried, because the exchange had stopped buying
    /// anything: it yields an ACCESS TOKEN, and this adapter sends no
    /// Authorization header anywhere because there is no API to send one to.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_login_never_redeems_the_authorization_code()
    {
        var handler = new StubHttpHandler(Route);
        var page = LoginForm();
        using var ctx = SigningIn(handler);

        var result = await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        // One navigation, to the authorize URL. Not one packet of our own.
        Assert.Single(page.Visited);
        Assert.Empty(handler.Requests);

        // And nothing that would need redeeming was kept.
        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.RefreshToken);
        Assert.Null(result.Material.AccessTokenExpiresAt);
    }

    /// <summary>
    /// What the login DOES produce: the browser's cookie jar, which on this
    /// provider is the entire credential.
    /// </summary>
    [Fact]
    public async Task The_login_seals_the_browsers_cookie_jar()
    {
        var page = LoginForm();
        using var ctx = SigningIn(new StubHttpHandler(Route));

        var result = await Adapter().LoginAsync(ctx, page, SignedIn(), CancellationToken.None);

        Assert.Equal(SignedInJar, result.Material.StorageState);

        // The brand, not the person. The OIDC userinfo endpoint would give us
        // their name and wants a bearer token this login no longer obtains.
        Assert.NotNull(result.Account);
        Assert.Equal("Coolblue", result.Account.DisplayName);
        Assert.Null(result.Account.ExternalId);

        // Unset on purpose: what expires is a cookie whose lifetime nobody
        // states, and the manifest carries the conservative guess.
        Assert.Null(result.ExpiresAt);

        Assert.Contains(JobStep.Authenticating, ctx.Steps);
        Assert.Contains(JobStep.Finalizing, ctx.Steps);
    }

    /// <summary>
    /// A login that ends with no cookie has produced nothing, and must say so
    /// rather than seal an empty bundle.
    ///
    /// The alternative is worse than a failed login: a connection that looks
    /// live, syncs nothing, and reports session_expired on a session that never
    /// existed - sending the user to sign in again for a reason that will
    /// repeat.
    /// </summary>
    [Fact]
    public async Task A_login_that_leaves_no_cookie_fails_rather_than_sealing_an_empty_session()
    {
        var page = LoginForm();

        // Signed in as far as the callback is concerned, and holding only
        // another site's cookies.
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

    /// <summary>
    /// The jar is never read until the browser has PROVED it is signed in, and
    /// this is the invariant whose absence cost a whole live run.
    ///
    /// Coolblue answers a signed-OUT request with <c>Coolblue-Session</c>,
    /// <c>cbvid</c> and <c>_csrfSecret</c> - confirmed against a plain curl with
    /// no credentials at all. So a login that asks "are there cookies yet?"
    /// gets yes immediately, from an anonymous session, and seals a bundle
    /// whose first fetch is handed the sign-in form. That is exactly what
    /// happened.
    /// <para>
    /// A login that never arrives must therefore read the jar ZERO times: there
    /// is nothing a cookie could tell it that would be true.
    /// </para>
    /// </summary>
    [Fact]
    public async Task The_cookie_jar_is_never_read_by_a_login_that_did_not_arrive()
    {
        var page = LoginForm();

        // A jar full of the cookies an anonymous visitor already has.
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

        // Nothing was exchanged either way.
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
        // No redirect, no stated error, no wall: the login simply did not
        // resolve. Guessing "wrong password" from silence is the mistake this
        // branch exists to refuse.
        //
        // The settle budget is zeroed because the suite's clock does not move:
        // the loop ends on a deadline, which is exactly right against a real
        // TimeProvider and never reached against a frozen one. Zero seconds
        // takes the same branch on the first pass.
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
        // None has ever been observed on this form. The probe is here so that
        // if one appears the adapter names it in one poll instead of waiting
        // out a whole job budget and then reporting the wrong thing.
        var page = StubLoginPage.Showing(
            UsernameInput, PasswordInput, Submit, "iframe[src*='hcaptcha']");

        using var ctx = new FakeJobContext(new StubHttpHandler(Route))
        {
            Inputs = Credentials(),
            Browser = new StubBrowserLease(page),
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        // Blocked, not internal and not invalid_credentials: nothing is wrong
        // with the password. There is simply nobody at this browser.
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("unattended", error.Detail, StringComparison.Ordinal);

        // Not one question, because there is nobody to answer it.
        Assert.Empty(ctx.Asked);

        // The password is off the page even though nothing photographed it:
        // the runner may capture an artifact on the way out of a failed job.
        Assert.False(page.HoldsSecret);
    }

    // ---- the fetch: an index, then a page per order ------------------------

    [Fact]
    public async Task A_fetch_with_no_stored_browser_session_is_a_dead_session_and_costs_coolblue_nothing()
    {
        // The cookie IS the credential now - the account pages are
        // server-rendered HTML and the captured request carried no
        // Authorization header at all. A fetch holds no password to fix that
        // with, so it asks the platform for a new login job.
        var handler = new StubHttpHandler((_, _) => Stub.Page(Overview));
        using var ctx = new FakeJobContext(handler) { Material = new SessionMaterial { AccessToken = "irrelevant" } };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Empty(handler.Requests);
    }

    /// <summary>
    /// A money unit is DECLARED, and an undeclared one refuses before a single
    /// packet leaves rather than after seventy page loads.
    /// </summary>
    [Fact]
    public async Task An_undeclared_money_unit_refuses_before_the_walk_starts()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Page(Overview));
        using var ctx = Fetching(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(Options with { TotalUnit = null }).FetchAsync(ctx, Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("MajorString", error.Detail!, StringComparison.Ordinal);

        // The point of checking first: an unusable configuration must cost the
        // provider nothing, not seventy requests it was always going to waste.
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

    /// <summary>
    /// The whole shape of a Coolblue fetch, in one test: an index page, then
    /// one page per order because the index states no money.
    /// </summary>
    [Fact]
    public async Task The_list_is_an_index_and_every_total_costs_that_orders_own_page()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal("orders-html", result.Via);
        Assert.True(result.Complete);
        Assert.Equal(3, result.Receipts.Count);

        // In order: the list, the empty page two that ended the walk, then one
        // details page per order. Asserted as a SEQUENCE rather than a set,
        // because "the whole list before any order" is the behaviour - a reader
        // that interleaved them would be opening pages it might be about to
        // discard.
        Assert.Equal(
            [
                "/mijn-coolblue-account/orderoverzicht",
                "/mijn-coolblue-account/orderoverzicht?page=2",
                "/mijn-coolblue-account/orderoverzicht/80000001",
                "/mijn-coolblue-account/orderoverzicht/80000002",
                "/mijn-coolblue-account/orderoverzicht/80000003",
            ],
            handler.Requests.Select(r => r.Path + r.Query));

        // Every request carried the session, and none carried a bearer token.
        Assert.All(handler.Requests, r =>
        {
            Assert.Equal("Coolblue-Session=session-fixture", r.Header("Cookie"));
            Assert.Null(r.Header("Authorization"));
        });

        // Nothing rotates: this fetch spends a cookie and there is nothing to
        // exchange one for.
        Assert.Null(result.RefreshedMaterial);
    }

    [Fact]
    public async Task A_receipt_carries_the_total_from_its_own_page_and_the_product_from_the_list()
    {
        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        // Newest first.
        var fridge = result.Receipts[0];
        Assert.Equal("80000001", fridge.ExternalId);
        Assert.Equal("coolblue", fridge.Merchant.Id);
        Assert.Equal("Coolblue", fridge.Merchant.Name);

        // The one useful string the list offers, carried through - "Coolblue"
        // ten times tells a user nothing.
        Assert.Equal("Testmerk Koelkast RB100", fridge.Merchant.StoreName);

        // Midnight in Amsterdam, from "15 december 2025" and nothing else: the
        // page states no machine-readable date anywhere.
        Assert.Equal(
            new DateTimeOffset(2025, 12, 15, 0, 0, 0, TimeSpan.FromHours(1)), fridge.PurchasedAt);

        // 463 euros, from the details page, declared MajorString. This is the
        // exact string that used to come back as MINUS 46300.
        Assert.Equal(46_300L, fridge.Total.Value);
        Assert.Equal("EUR", fridge.Total.Currency);

        // No items, and therefore no reconciliation claim: the details page
        // itemises 399 of a 463 total and does not say what the rest is.
        Assert.Empty(fridge.Items);
        Assert.False(fridge.TotalIsDerived);

        // Every payment field stated and null. Coolblue names no method at all,
        // and an explicit null tells a consumer its matching will be weaker
        // where an omitted one just looks like an oversight.
        Assert.NotNull(fridge.Payment);
        Assert.Null(fridge.Payment.Method);
        Assert.Null(fridge.Payment.CardLast4);
        Assert.Null(fridge.Payment.IbanTail);

        Assert.NotEmpty(fridge.ContentHash);
    }

    /// <summary>
    /// The window is what makes this provider affordable.
    ///
    /// A daily sync must not pay for the history it already has: every order
    /// outside the window costs a 600KB page load that is thrown away.
    /// </summary>
    [Fact]
    public async Task A_narrow_window_never_opens_the_pages_of_orders_it_does_not_want()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(
            ctx, Receipts(since: Requests.Day(2025, 10, 1)), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        Assert.Equal("80000001", receipt.ExternalId);

        // The two older orders were seen on the list and never opened.
        Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("80000002", StringComparison.Ordinal));
        Assert.DoesNotContain(handler.Requests, r => r.Path.EndsWith("80000003", StringComparison.Ordinal));
    }

    /// <summary>
    /// A page entirely below the window ends the walk, because the list is
    /// newest-first and every later page is older still.
    /// </summary>
    [Fact]
    public async Task A_page_wholly_older_than_the_window_stops_the_walk_rather_than_paging_on()
    {
        var handler = Coolblue();
        using var ctx = Fetching(handler);

        await Adapter().FetchAsync(ctx, Receipts(since: Requests.Day(2026, 1, 1)), CancellationToken.None);

        // Page one was read and page two never asked for: this is what keeps a
        // daily sync from walking two years of history to find yesterday.
        Assert.DoesNotContain(handler.Requests, r => r.Query.Contains("page=2", StringComparison.Ordinal));
    }

    /// <summary>
    /// A pagination parameter the provider stops honouring must not become a
    /// loop that fetches page one twenty times against a live account.
    /// </summary>
    [Fact]
    public async Task A_page_that_repeats_the_last_one_ends_the_walk()
    {
        // Every overview request answers page one, forever.
        var handler = new StubHttpHandler((request, _) =>
            request.Path.Contains("orderoverzicht/", StringComparison.Ordinal)
                ? Stub.Page(DetailsFor(Order(request.Path)))
                : Stub.Page(Overview));

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);

        // Two overview reads - the first, and the repeat that proved it - and
        // not twenty.
        Assert.Equal(2, handler.Requests.Count(r => !r.Path.Contains("orderoverzicht/", StringComparison.Ordinal)));
    }

    /// <summary>
    /// A details page that answers for a DIFFERENT order is refused, and this
    /// is not a hypothetical guard.
    ///
    /// Coolblue's own <c>/bestellingen</c> silently redirects to the account
    /// home rather than 404ing, so this provider is known to answer a
    /// wrong-but-plausible page. A total read off one would put one order's
    /// money on another's receipt, and every downstream check would agree with
    /// it.
    /// </summary>
    [Fact]
    public async Task A_page_that_states_another_order_number_is_never_priced_from()
    {
        // Order two's page answers with order one's document.
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(Overview),
            "/mijn-coolblue-account/orderoverzicht/80000002" => Stub.Page(Details),
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            _ => Stub.Page(Empty),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        // Two receipts, not three, and the pass says it is partial.
        Assert.Equal(["80000001", "80000003"], result.Receipts.Select(r => r.ExternalId));
        Assert.False(result.Complete);

        // And it says which order and why, rather than going quiet.
        Assert.Contains(ctx.Notes, n =>
            n.Contains("80000002", StringComparison.Ordinal)
            && n.Contains("Ordernummer", StringComparison.Ordinal));
    }

    /// <summary>
    /// One order's page failing must not throw away the sixty that worked - but
    /// a failure that will repeat for every one of them must not be swallowed
    /// sixty times either.
    /// </summary>
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
            // A wall answers every remaining order the same way. Carrying on
            // would spend sixty more requests to fail sixty more times, and
            // then report a short history as a complete one.
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

    /// <summary>
    /// The record cap, and what a caller is told when it bites.
    ///
    /// SEVENTY-FIVE here where every other provider says two hundred, because
    /// on Coolblue a record costs a 600KB page load - the order list states no
    /// money, so each total needs the order's own page. Two hundred would be a
    /// hundred and twenty megabytes in a single job.
    ///
    /// Driven through a generated overview rather than a hand-written one,
    /// because the behaviour under test only exists above seventy-five orders
    /// and a fixture that large would be unreadable.
    /// </summary>
    [Fact]
    public async Task A_pass_past_the_record_cap_returns_the_newest_and_admits_it_is_partial()
    {
        var cap = Adapter().Describe().Resource("receipts")!.MaxRecordsPerFetch;
        Assert.Equal(75, cap);

        const int orders = 90;
        var handler = new StubHttpHandler((request, _) => request.Path switch
        {
            var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
            "/mijn-coolblue-account/orderoverzicht" => Stub.Page(
                request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : ManyOrders(orders)),
            _ => Stub.Status(HttpStatusCode.NotFound),
        });

        using var ctx = Fetching(handler);

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(cap, result.Receipts.Count);

        // Newest first, so the caller holds the most recent and comes back for
        // the rest - and is TOLD to, rather than being handed seventy-five
        // receipts that look like the whole history.
        Assert.False(result.Complete);
        Assert.Equal("81000001", result.Receipts[0].ExternalId);
        Assert.Equal("81000075", result.Receipts[^1].ExternalId);

        // And the fifteen it dropped cost nothing: their pages were never
        // opened, which on this provider is nine megabytes not spent.
        Assert.Equal(cap, handler.Requests.Count(r => r.Path.Contains("orderoverzicht/", StringComparison.Ordinal)));
    }

    /// <summary>
    /// An overview with as many orders as asked for, newest first, in the same
    /// markup shape as the fixture - label, React separator, colon, then the
    /// date in its own element.
    /// </summary>
    private static string ManyOrders(int count)
    {
        var cards = new System.Text.StringBuilder("<html lang=\"nl\"><body><main>");

        for (var i = 0; i < count; i++)
        {
            // Descending dates: the first card is the newest, one day apart.
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

    // ---- line items --------------------------------------------------------

    /// <summary>
    /// Items arrive when asked for, and the gap between what Coolblue charged
    /// and what it itemised is NAMED rather than hidden.
    ///
    /// The captured order lists one product at 399 against a stated total of
    /// 463 and never says what the other 64 was. This adapter briefly answered
    /// that by offering no line items at all - which threw away every order
    /// that itemises perfectly to avoid being wrong about the ones that do not,
    /// and was corrected when the account owner asked where their items had
    /// gone.
    /// </summary>
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

        // One, because nothing is written in front of the name and that is what
        // this page's own convention means - it writes "3x" when it sells three.
        Assert.Equal(1m, product.Quantity);

        // The unit price stays null. The page states none, and dividing the
        // total by the count would invent a figure that looks authoritative and
        // is wrong the moment a line carries a discount.
        Assert.Null(product.UnitPrice);

        // The remainder, derived and labelled as such. A copy KEY, because the
        // connector may not invent prose in anybody's language.
        var remainder = receipt.Items[1];
        Assert.Equal(ReceiptLineKind.Unattributed, remainder.Kind);
        Assert.Equal(6_400L, remainder.Total.Value);
        Assert.Equal("receipt.line.unattributed", remainder.Name);

        // And the point of all of it: the breakdown adds up to what was paid,
        // so the reconciliation flag means something again.
        Assert.True(receipt.Reconciled);
        Assert.Equal(46_300L, receipt.Total.Value);

        // The total is untouched - Coolblue's own figure, which is what a bank
        // transaction is matched against.
        Assert.False(receipt.TotalIsDerived);
    }

    /// <summary>
    /// An order whose lines DO add up gets no derived line at all.
    ///
    /// The captured account has both kinds - one order lists 694 against a
    /// total of 694 - and inventing a zero-valued "unattributed" line on the
    /// well-behaved ones would make the exception look like the rule.
    /// </summary>
    [Fact]
    public async Task An_order_that_adds_up_gets_no_derived_line()
    {
        // The same page with the product priced at the total.
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

    /// <summary>
    /// A multi-quantity line reaches the receipt with its amount UNCHANGED.
    ///
    /// The fixture order has one of everything, so nothing else here would
    /// notice a count being multiplied into a total on the way out - and that
    /// is exactly the plausible-looking edit somebody makes later, having seen
    /// "3x" next to a price and assumed it was each.
    ///
    /// CONFIRMED from the invoice for that order: Aantal 3, Prijs per stuk
    /// EUR 134,99, Prijs incl. BTW EUR 404,97, and the order page prints
    /// 404,97. Three disks cost 404,97, not 1214,91.
    /// </summary>
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

        // And the unit price is still not invented, even though the arithmetic
        // would work on this particular line.
        Assert.Null(product.UnitPrice);
    }

    [Fact]
    public async Task A_caller_that_did_not_ask_for_items_gets_none()
    {
        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        // No items and therefore no derived line either - a receipt with
        // nothing itemised must not claim an unattributed remainder equal to
        // its whole total.
        Assert.All(result.Receipts, r => Assert.Empty(r.Items));
    }

    // ---- invoices ----------------------------------------------------------

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

        // Order three has two invoices, order two has none - both are normal.
        var document = Assert.Single(byId["80000001"].Documents);
        Assert.Equal(ReceiptDocumentKinds.Invoice, document.Kind);
        Assert.Equal("application/pdf", document.MediaType);
        Assert.Equal("coolblue-80000001-invoice-1300000001.pdf", document.Filename);
        Assert.Null(document.Name);
        Assert.Equal(Pdf.Length, document.SizeBytes);
        Assert.Equal(Convert.ToBase64String(Pdf), document.ContentBase64);

        Assert.Empty(byId["80000002"].Documents);
        Assert.Equal(2, byId["80000003"].Documents.Count);

        // One request per invoice and no discovery at all: the href is on the
        // card, unlike Amazon's opaque guid or bol's per-order details page.
        Assert.Equal(3, withHandler.Requests.Count(r => r.Path.Contains("mijn-factuur", StringComparison.Ordinal)));
    }

    /// <summary>
    /// A 200 that is not really a PDF is not attached.
    ///
    /// The magic number is the FILE's own claim as against the server's, and it
    /// is the half that catches an error page wearing a PDF content type -
    /// which is exactly what a session dying mid-fetch produces.
    /// </summary>
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

        // The receipts are unaffected either way: a document is an extra, and
        // failing a fetch that read every order correctly because one PDF would
        // not come down trades the whole answer for a footnote.
        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));
        Assert.True(result.Complete);
        Assert.NotEmpty(ctx.Notes);
    }

    // ---- transport: walls and dead sessions --------------------------------

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

        // 429 is in this set on purpose and the shared default does not put it
        // there: Coolblue sits behind CloudFront, an AWS WAF rate rule answers
        // 429 with no Retry-After to honour, and treating a wall as "try again
        // shortly" is how a client earns a permanent one.
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

        // A wall is checked before a dead session: mistaking one for the other
        // starts a fresh login straight into the wall, spending a credential
        // against something that was never going to answer.
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

    /// <summary>
    /// Every Coolblue page is served by CloudFront and says so, and every
    /// signed-in page links to the login host in its own navigation. The guard
    /// must not call those a block or a dead session.
    /// </summary>
    [Fact]
    public async Task An_ordinary_account_page_is_not_mistaken_for_a_wall_or_a_login()
    {
        Assert.Contains("Uitloggen", Overview, StringComparison.Ordinal);

        using var ctx = Fetching(Coolblue());

        var result = await Adapter().FetchAsync(ctx, Receipts(), CancellationToken.None);

        Assert.Equal(3, result.Receipts.Count);
    }

    // ---- helpers -----------------------------------------------------------

    private static string Overview => FixtureCatalog.Read("coolblue/orders-overview.html");

    private static string Details => FixtureCatalog.Read("coolblue/order-details.html");

    /// <summary>An account page with no orders on it - what page two answers.</summary>
    private const string Empty =
        "<html lang=\"nl\"><body><main><p>Je hebt nog geen bestellingen</p></main>" +
        "<nav><a href=\"/uitloggen\">Uitloggen</a></nav></body></html>";

    /// <summary>
    /// A real, valid PDF. bol's fixture rather than a second copy of the same
    /// few hundred bytes: what matters here is that the magic number is genuine
    /// and the file is not text, and one small PDF proves that for anybody.
    /// </summary>
    private static byte[] Pdf => Stub.FixtureBytes("bol/invoice.pdf");

    /// <summary>The receipts request, with Coolblue's own include vocabulary.</summary>
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

    /// <summary>The order id at the end of a details path.</summary>
    private static string Order(string path) => path[(path.LastIndexOf('/') + 1)..];

    /// <summary>
    /// The details fixture, speaking for whichever order asked for it.
    ///
    /// The fixture states order 80000001, and the adapter refuses a page whose
    /// order number is not the one it asked for - so a stub that served the
    /// fixture unchanged to every order would exercise the refusal on two
    /// orders out of three and nothing else.
    /// </summary>
    private static string DetailsFor(string orderId) =>
        Details.Replace("80000001", orderId, StringComparison.Ordinal);

    /// <summary>
    /// Coolblue, answering the way the capture showed: an index page, a page
    /// per order, a PDF per invoice link, and nothing on page two.
    /// </summary>
    private static StubHttpHandler Coolblue() => new((request, _) => request.Path switch
    {
        var p when p.Contains("mijn-factuur", StringComparison.Ordinal) => Stub.Bytes(Pdf),
        var p when p.Contains("orderoverzicht/", StringComparison.Ordinal) => Stub.Page(DetailsFor(Order(p))),
        "/mijn-coolblue-account/orderoverzicht" =>
            Stub.Page(request.Query.Contains("page=", StringComparison.Ordinal) ? Empty : Overview),
        _ => Stub.Status(HttpStatusCode.NotFound),
    });

    /// <summary>
    /// The provider, answering from its recorded token and userinfo payloads.
    /// A login reaches nothing else.
    /// </summary>
    private static HttpResponseMessage Route(RecordedRequest request, int _) => request.Path switch
    {
        TokenPath => Stub.Fixture("coolblue/token.json"),
        UserInfoPath => Stub.Fixture("coolblue/userinfo.json"),
        _ => Stub.Status(HttpStatusCode.NotFound),
    };

    private static HttpResponseMessage Html(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "text/html") };

    /// <summary>Every box the confirmed form carries, all on one screen.</summary>
    private static StubLoginPage LoginForm() =>
        StubLoginPage.Showing(UsernameInput, PasswordInput, Submit);

    /// <summary>
    /// Coolblue's own flow finishing the way it does: the browser ends up back
    /// on the page the login started from, which needs a session to reach.
    /// </summary>
    private static ArrivalWaiter SignedIn() =>
        new("https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht");

    /// <summary>A login that never resolves - the browser never arrives.</summary>
    private static ArrivalWaiter Never() => new(url: null);

    private static IReadOnlyDictionary<string, string> Credentials() =>
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Username,
            ["password"] = Password,
        };

    /// <summary>
    /// The cookie jar a completed Coolblue login leaves behind - the whole
    /// product of signing in, now that no token is redeemed.
    /// </summary>
    private const string SignedInJar =
        """{"cookies":[{"name":"Coolblue-Session","value":"session-fixture","domain":".coolblue.nl","expires":-1}]}""";

    private static FakeJobContext Context(HttpMessageHandler handler) =>
        new(handler) { Inputs = Credentials() };

    /// <summary>
    /// A login in progress, with a browser whose jar already holds the session.
    ///
    /// Separate from <see cref="Context"/> because most tests here must not
    /// touch a browser at all - a lease that refuses is how they prove it.
    /// </summary>
    /// <param name="restored">
    /// Whether this job's browser was opened with something an earlier run
    /// left - a kept profile, or the bundle's cookie jar. Only then is "are we
    /// already signed in?" a question with two possible answers, and only then
    /// does <c>SessionProbe</c> ask it.
    /// </param>
    private static FakeJobContext SigningIn(HttpMessageHandler handler, bool restored = false) =>
        new(handler)
        {
            Inputs = Credentials(),
            Browser = new StubBrowserLease(LoginForm()) { StorageState = SignedInJar },
            KeepsSession = restored,
        };

    /// <summary>A job holding the session a completed login would have sealed.</summary>
    /// <summary>
    /// A job holding the session a completed login would have sealed - tokens
    /// AND the browser state, because the fetch spends the second of those.
    ///
    /// The cookie list is deliberately awkward. The session cookie a login
    /// issues has a NEGATIVE expiry and must not be filtered out as "already
    /// expired"; a genuinely stale one and another domain's must not travel at
    /// all. All three are here so a fetch that got any of that wrong is caught
    /// by the Cookie header the requests carry.
    /// </summary>
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

    private static IReadOnlyDictionary<string, string> Query(string url) =>
        Pairs(new Uri(url).Query.TrimStart('?'));

    private static IReadOnlyDictionary<string, string> Form(RecordedRequest request)
    {
        Assert.NotNull(request.Body);
        return Pairs(request.Body);
    }

    /// <summary>
    /// A form body or a query string, unescaped. Hand-rolled rather than pulled
    /// from a web stack: the assertions here are about exactly which characters
    /// went onto the wire, so the reader wants to see the decoding rather than
    /// trust a helper's opinion of it.
    /// </summary>
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

    /// <summary>
    /// Where the browser ended up, which on this provider is the whole signal.
    ///
    /// Deliberately dumber than the watcher it stands in for. The real
    /// <see cref="CoolblueSessionWatcher"/> decides whether a URL counts as
    /// signed in, and that judgement is tested directly and exhaustively by
    /// <see cref="Only_the_account_area_counts_as_signed_in"/> - including the
    /// redirect that carries the account path inside its own query string.
    /// Duplicating the rule here would let both copies drift and agree.
    /// </summary>
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

    /// <summary>
    /// A lease that has a storage state and nothing else. The shared stub
    /// refuses this call, correctly - it exists for tests that must not start a
    /// browser - but sealing the browser session away IS the behaviour under
    /// test here.
    /// </summary>
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
    /// <summary>The calls a job's stub handler actually recorded.</summary>
    public static IReadOnlyList<RecordedRequest> Requests(this FakeJobContext ctx) =>
        ctx.Handler is StubHttpHandler stub ? stub.Requests : [];
}
