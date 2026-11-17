using Connector.Kit.Challenges;
using BankConnector.Adapters;
using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Xunit;

namespace BankConnector.Adapters.Tests;

// the tier's payoff is a signed-in profile asking nothing; its risk is believing that and driving a sign-in page
// as if it were a bank
public sealed class AsnPersistentAdapterTests
{
    private static readonly AsnOptions Options = new();

    private const string SignedIn = "https://www.asnbank.nl/online/web/onlinebankieren/";

    private static AsnPersistentAdapter Adapter() => new(Options);

    private static FakeJobContext Context() => new() { Browser = new StubBrowserLease() };

    private static StubAsnPortal Inside()
    {
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = SignedIn;

        return portal;
    }

    // the sign-in address sits beneath the signed-in one, so this url still contains the signed-in marker: a check on
    // that alone calls it connected unregistered stated: the five-digit box marks a registered browser, and the stub
    // has every selector unless one is removed
    private static StubAsnPortal Outside()
    {
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = Options.LoginUrl;
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        return portal;
    }

    [Fact]
    public async Task Connecting_a_profile_that_is_still_signed_in_asks_the_human_nothing()
    {
        using var ctx = Context();

        var result = await Adapter().LoginAsync(ctx, Inside(), CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.Contains(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));

        // no secret comes back: the session lives in a profile directory on the user's machine; a cookie jar would put a
        // live ASN session in the database
        Assert.Null(result.Material.StorageState);
        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.RefreshToken);
    }

    // KeepsSession gates the check: a browser with nothing kept is never asked, so the sign-in runs; this tier cannot
    // produce that run (ResolveProfile always gives a profile) but the gate is shared, and this suite is where an ASN
    // regression shows
    [Fact]
    public async Task A_browser_with_nothing_kept_is_never_asked_whether_it_is_signed_in()
    {
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(), KeepsSession = false };

        var portal = Inside();

        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(
            portal.Calls, c => c == $"goto:https://www.asnbank.nl{Options.SignedInPathMarker}");

        Assert.DoesNotContain(portal.Calls, c => c == $"wait:{Options.SignInPathMarker}");
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
    }

    // whether ASN's session survives in a persistent profile is unmeasured, so a fetch asks; a signed-out browser is
    // served the sign-in page for the export form, which an adapter pressing on would report as provider_changed
    [Fact]
    public async Task A_fetch_on_a_signed_out_profile_says_the_session_ended()
    {
        using var ctx = Context();

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                ctx,
                Outside(),
                new ResourceRequest { ResourceId = BankResources.Accounts },
                CancellationToken.None));

        // SessionExpired is the manifest's reauth trigger: the platform offers reconnecting instead of reporting a changed
        // site
        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
        Assert.NotEqual(ErrorCode.ProviderChanged, refused.Code);

        Assert.Contains(AsnPersistentManifest.ProviderId, refused.Message, StringComparison.Ordinal);
    }

    // the sign-in address sits beneath the signed-in one, so the marker is in both urls
    [Fact]
    public void The_signed_out_fixture_would_pass_a_check_that_only_looked_for_the_signed_in_path()
    {
        Assert.Contains(Options.SignedInPathMarker, Options.LoginUrl, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Connecting_a_signed_out_profile_falls_back_to_the_ordinary_sign_in()
    {
        using var ctx = Context();
        var portal = Outside();

        // the pooled sign-in needs the bank, so this ends in a provider error; reaching the cookie wall proves which path
        // was taken
        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Contains(portal.Calls, c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));
    }

    private static FakeJobContext WithCode(string code = "12345") => new()
    {
        Browser = new StubBrowserLease(),
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [AsnPersistentAdapter.BrowserCodeKey] = code,
        },
    };

    private static StubAsnPortal Trusted()
    {
        var portal = StubAsnPortal.Blank(Options.BrowserCodeSubmitLabel);
        portal.RedirectsTo = Options.LoginUrl;
        portal.ArrivesAt = SignedIn;

        return portal;
    }

    // ASN's app code rotates every few seconds so it cannot be relayed unattended; five digits can: the point of
    // keeping a profile
    [Fact]
    public async Task A_registered_browser_signs_in_with_the_code_and_asks_for_nothing_else()
    {
        using var ctx = WithCode();
        var portal = Trusted();

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        Assert.Equal("12345", portal.Filled[$"{Options.BrowserCodeSelectors[0]}#0"]);

        // not in what comes back: the profile is what you have, the code what you know; sealing them together puts both
        // factors in one box
        Assert.Null(result.Material.StorageState);
        Assert.Null(result.Material.AccessToken);
    }

    // the five digits are chosen on ASN's "Kies een browsercode" screen: a code with no trusted browser means
    // registration in progress, QR would not help registered is asked of the page (the five-digit box), so a withdrawn
    // registration takes this route too
    [Fact]
    public async Task A_code_with_no_registration_opens_asns_own_registration_page()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = SignedIn;

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        // registration is streamed: twenty screens with two one-time codes, automating it from selectors risks an account
        // lockout
        Assert.Contains(
            portal.Calls,
            c => c.Contains(Options.BrowserRegistrationPath, StringComparison.Ordinal));

        var streamed = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.LiveView, streamed.Type);
        Assert.Equal(AsnPersistentManifest.RegisterKey, streamed.PromptKey);

        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.Null(result.Material.StorageState);
    }

    // a lapsed window used to return null, read as "not registered": the pooled sign-in then opened the login address
    // over a registration near done and waited five more minutes; now MfaTimeout and no navigation after the
    // registration page
    [Fact]
    public async Task A_registration_that_runs_out_its_window_fails_there_and_never_falls_into_the_qr_sign_in()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = null;

        var lapsed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // MfaTimeout is the platform's code for an unfinished challenge and says "try again", right for an errand that can
        // restart
        Assert.Equal(ErrorCode.MfaTimeout, lapsed.Code);
        Assert.Contains($"{Options.RegistrationSeconds}s window", lapsed.Message, StringComparison.Ordinal);

        Assert.Contains(ctx.Notes, n => n.Contains("Nothing was lost", StringComparison.Ordinal));

        // the registration page is the last place the browser is sent: no login address on top, no cookie wall after
        var opened = portal.Calls
            .Select((c, i) => (Call: c, Index: i))
            .Single(x => x.Call.StartsWith("goto:", StringComparison.Ordinal)
                         && x.Call.Contains(Options.BrowserRegistrationPath, StringComparison.Ordinal));

        Assert.DoesNotContain(
            portal.Calls.Skip(opened.Index + 1),
            c => c.StartsWith("goto:", StringComparison.Ordinal));

        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));
    }

    // the page-load wait runs on the same clock as the address match: failing that would send someone through the
    // whole registration again
    [Fact]
    public async Task A_registration_that_lands_before_its_page_finishes_loading_is_finished()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = SignedIn;
        portal.ArrivesAfter = TimeSpan.FromSeconds(600);
        portal.LoadsAfter = TimeSpan.FromSeconds(900);

        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.RegistrationSeconds));
        Assert.True(TimeSpan.FromSeconds(Options.RegistrationSeconds) < portal.LoadsAfter);

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.Null(result.Material.StorageState);
    }

    // confirmed by leaving: a wrong code leaves the browser on the sign-in page; provider_changed would send someone
    // to fix an adapter over a typo
    [Fact]
    public async Task A_refused_browsercode_says_so_rather_than_blaming_the_bank()
    {
        using var ctx = WithCode("00000");

        var portal = Trusted();
        portal.ArrivesAt = Options.LoginUrl;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
        Assert.Contains("not the account's own password", refused.Message, StringComparison.Ordinal);

        // says what it saw: still on the sign-in page, which a refused code and a landing not yet made both look like
        Assert.Contains("still on ASN's sign-in page", refused.Message, StringComparison.Ordinal);
    }

    // the wait after the digits borrowed the 10 s selector timeout: an 11 s landing was reported as a refused code and
    // marked the profile unhealthy
    [Fact]
    public async Task A_landing_slower_than_a_selector_but_inside_the_landing_window_still_signs_in()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.ArrivesAfter = TimeSpan.FromSeconds(20);

        Assert.True(TimeSpan.FromMilliseconds(Options.SelectorTimeoutMs) < portal.ArrivesAfter);
        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds));

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        // the option is the budget: shortened below the bank's time, the same landing is refused
        using var hurried = WithCode();
        var slow = Trusted();
        slow.ArrivesAfter = TimeSpan.FromSeconds(20);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnPersistentAdapter(Options with { BrowserCodeLandingSeconds = 10 })
                .LoginAsync(hurried, slow, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
        Assert.Contains("10s after the browsercode was submitted", refused.Message, StringComparison.Ordinal);
    }

    // a page that is neither sign-in nor overview (maintenance, withdrawn registration) was reported as a wrong code.
    // the address is what the first failure can carry out
    [Fact]
    public async Task A_browser_sent_somewhere_third_after_the_code_names_the_address_rather_than_the_code()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.ArrivesAt = "https://www.asnbank.nl/onderhoud/";

        var moved = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, moved.Code);
        Assert.Contains("https://www.asnbank.nl/onderhoud/", moved.Message, StringComparison.Ordinal);
    }

    // the mapping run saw the menu as button[data-testid='button'] "Profiel menu openen"; the probe reads the name
    // from aria-label OR title, so the aria-label selector is a guess as the signed-in witness a miss reads as signed
    // out and sends a trusted browser through the twenty-screen registration
    [Fact]
    public async Task A_user_menu_the_css_selector_cannot_see_is_still_found_by_its_name()
    {
        using var ctx = WithCode();

        var portal = Inside();
        portal.AbsentSelectors.Add(Options.UserMenuSelectors[0]);
        portal.Labels.Add(Options.UserMenuLabel);

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in", StringComparison.Ordinal));

        using var neither = WithCode();
        var bare = Inside();
        bare.AbsentSelectors.Add(Options.UserMenuSelectors[0]);

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(neither, bare, CancellationToken.None));

        Assert.DoesNotContain(neither.Notes, n => n.Contains("still signed in", StringComparison.Ordinal));
    }

    // the real wait matches the address on commit, then keeps waiting for load on the same clock: a late-loading
    // overview threw provider_changed, which degrades the provider for everybody; the address has the last word
    [Fact]
    public async Task A_landing_whose_page_loads_after_the_budget_is_signed_in_rather_than_a_changed_bank()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.ArrivesAfter = TimeSpan.FromSeconds(5);
        portal.LoadsAfter = TimeSpan.FromSeconds(60);

        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds));
        Assert.True(TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds) < portal.LoadsAfter);

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        using var stuck = WithCode();
        var stranded = Trusted();
        stranded.ArrivesAt = null;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(stuck, stranded, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
    }

    // a registered browser's sign-in page has no method buttons, so there is no QR to fall back to: the fallback
    // hunted "ASN Bank app" and degraded the provider the field is optional because a browser must be registered
    // before it has a code
    [Fact]
    public async Task A_registered_browser_given_no_code_says_the_code_is_missing_rather_than_that_the_bank_changed()
    {
        using var ctx = Context();
        var portal = Trusted();

        var missing = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, missing.Code);
        Assert.NotEqual(ErrorCode.ProviderChanged, missing.Code);
        Assert.Contains($"input '{AsnPersistentAdapter.BrowserCodeKey}' is required", missing.Message, StringComparison.Ordinal);

        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.AppMethodLabel, StringComparison.Ordinal));

        Assert.DoesNotContain(portal.Calls, c => c == "goto:" + Options.LoginUrl);

        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("fill:", StringComparison.Ordinal));
    }

    // the five-digit box is a single point of failure; "Je logt in als" greets a registered browser and is asked when
    // the box is not found
    [Fact]
    public async Task A_page_that_greets_a_registered_browser_is_registered_even_when_its_box_has_moved()
    {
        var portal = Trusted();
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);
        portal.Headings.Add(Options.SignedInAsHeadingPrefix + " someone");

        using var ctx = Context();

        var missing = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, missing.Code);
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        // with a code, a registered page whose box cannot be typed into has changed, not a browser that wants registering
        var again = Trusted();
        again.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);
        again.Headings.Add(Options.SignedInAsHeadingPrefix + " someone");

        using var withCode = WithCode();

        var changed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(withCode, again, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, changed.Code);
        Assert.DoesNotContain(
            again.Calls,
            c => c.Contains(Options.BrowserRegistrationPath, StringComparison.Ordinal));
    }

    // registering is a long human errand this connector sends somebody to rather than drives; only the page with
    // method buttons gets the method-button route
    [Fact]
    public async Task Without_a_code_the_connect_is_the_sign_in_it_always_was()
    {
        using var ctx = Context();
        var portal = Outside();

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("fill:", StringComparison.Ordinal));

        Assert.Contains(
            portal.Calls,
            c => c.StartsWith("click:" + Options.AppMethodLabel, StringComparison.Ordinal));
    }

    // the platform requeues a lapsed-lease job unless something was submitted upstream: a cut-off run typed the same
    // five digits again a refused code must never be retried (banks count attempts): the error path carries that for
    // finished runs, only the latch for cut-off ones
    [Fact]
    public async Task A_submitted_browsercode_is_latched_so_a_lapsed_lease_never_types_it_again()
    {
        using var ctx = WithCode();

        await Adapter().LoginAsync(ctx, Trusted(), CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);

        // a refused code is latched too: a requeue would spend a second attempt the bank counts
        using var refused = WithCode("00000");
        var wrong = Trusted();
        wrong.ArrivesAt = Options.LoginUrl;

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(refused, wrong, CancellationToken.None));

        Assert.True(refused.CredentialWasSubmitted);
    }

    // latched before the press: an agent killed inside the click would leave the code at ASN unknown to the control
    // plane early latching costs nothing here: a lost submit button is provider_changed, never retried anyway
    [Fact]
    public async Task The_code_is_latched_before_the_click_rather_than_after_it()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.Labels.Remove(Options.BrowserCodeSubmitLabel);

        var changed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, changed.Code);
        Assert.Contains($"'{Options.BrowserCodeSubmitLabel}' button is not", changed.Message, StringComparison.Ordinal);
        Assert.Equal("12345", portal.Filled[$"{Options.BrowserCodeSelectors[0]}#0"]);

        Assert.True(ctx.CredentialWasSubmitted);
    }

    // the latch turns a lapsed lease into a permanent failure, so it is owed only where a credential really went
    // somewhere
    [Fact]
    public async Task A_page_with_no_box_to_type_the_code_into_latches_nothing()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);
        portal.Headings.Add(Options.SignedInAsHeadingPrefix + " someone");

        var changed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, changed.Code);
        Assert.Contains("no five-digit box", changed.Message, StringComparison.Ordinal);

        Assert.False(ctx.CredentialWasSubmitted);
        Assert.Empty(portal.Filled);
    }

    // the adapter submits nothing in a registration (the holder types into their own browser): latching would spend
    // the retry the "connect again" note offers
    [Fact]
    public async Task A_registration_latches_nothing_because_the_adapter_submits_nothing()
    {
        using var ctx = WithCode();

        var finished = Outside();
        finished.ArrivesAt = SignedIn;

        await Adapter().LoginAsync(ctx, finished, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.False(ctx.CredentialWasSubmitted);

        // the window lapsing is an MfaTimeout, which the platform calls retriable: a latch would contradict that
        using var lapsing = WithCode();

        var abandoned = Outside();
        abandoned.ArrivesAt = null;

        var lapsed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(lapsing, abandoned, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaTimeout, lapsed.Code);
        Assert.False(lapsing.CredentialWasSubmitted);
    }

    // the signed-in test read the address the instant the goto returned: a client-side bounce read as "still signed
    // in" and the first fetch blamed the bank
    [Fact]
    public async Task A_profile_the_bank_bounces_client_side_is_not_read_as_signed_in()
    {
        var portal = StubAsnPortal.Blank();
        portal.ThenMovesTo = Options.LoginUrl;
        portal.AbsentSelectors.Add(Options.UserMenuSelectors[0]);
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        using var ctx = Context();

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
        Assert.Contains(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        var fetched = StubAsnPortal.Blank();
        fetched.ThenMovesTo = Options.LoginUrl;
        fetched.AbsentSelectors.Add(Options.UserMenuSelectors[0]);

        using var fetching = Context();

        var expired = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                fetching,
                fetched,
                new ResourceRequest { ResourceId = BankResources.Accounts },
                CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, expired.Code);
        Assert.DoesNotContain(fetched.Calls, c => c.Contains(Options.ExportPath, StringComparison.Ordinal));
    }

    // observed live 2026-09-19: the overview address with the menu on screen, then a bounce to /inloggen/; a
    // seconds-old profile read as still signed in both witnesses (address, menu) said yes wrongly: the check now rests
    // on the page being given its whole window to say NO
    [Fact]
    public async Task The_page_a_signed_out_browser_really_gets_is_not_read_as_signed_in()
    {
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = SignedIn;
        portal.ArrivesAt = Options.LoginUrl;
        portal.ArrivesAfter = TimeSpan.FromSeconds(3);

        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.SignedInSettleSeconds));

        using var ctx = Context();

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));

        // the window is a chance to say no, not a toll every connect pays
        using var inside = Context();

        await Adapter().LoginAsync(inside, Inside(), CancellationToken.None);

        Assert.Contains(inside.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
    }

    // the address alone is right the instant a signed-in overview loads, so the wait is paid only on a doubtful page.
    // "not signed in" costs a reconnect, "signed in" a broken export and a degraded provider
    [Fact]
    public async Task A_menu_that_does_not_appear_within_the_settle_window_means_not_signed_in()
    {
        var portal = Inside();
        portal.AppearsAfter[Options.UserMenuSelectors[0]] = TimeSpan.FromSeconds(20);

        Assert.True(TimeSpan.FromSeconds(Options.SignedInSettleSeconds) < TimeSpan.FromSeconds(20));

        using var ctx = Context();

        var expired = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                ctx,
                portal,
                new ResourceRequest { ResourceId = BankResources.Accounts },
                CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, expired.Code);

        var patient = Inside();
        patient.AppearsAfter[Options.UserMenuSelectors[0]] = TimeSpan.FromSeconds(20);

        using var waiting = Context();

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => new AsnPersistentAdapter(Options with { SignedInSettleSeconds = 25 }).FetchAsync(
                waiting,
                patient,
                new ResourceRequest { ResourceId = BankResources.Accounts },
                CancellationToken.None));

        Assert.Contains(patient.Calls, c => c.Contains(Options.ExportPath, StringComparison.Ordinal));
    }

    // Playwright's waits take only a timeout, so a cancellation could not end the address wait: a lost lease left the
    // browser open on the bank for twelve minutes the race is a static seam taking any task, testable without a
    // browser
    [Fact]
    public async Task The_path_wait_ends_promptly_when_its_token_is_cancelled()
    {
        var never = new TaskCompletionSource<bool>();

        using var cts = new CancellationTokenSource();
        cts.CancelAfter(TimeSpan.FromMilliseconds(50));

        var raced = AsnPortal.UntilCancelledAsync(never.Task, cts.Token);

        var first = await Task.WhenAny(raced, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(raced, first);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => raced);

        Assert.True(await AsnPortal.UntilCancelledAsync(Task.CompletedTask, CancellationToken.None));
        Assert.False(
            await AsnPortal.UntilCancelledAsync(
                Task.FromException(new TimeoutException("Timeout 720000ms exceeded")),
                CancellationToken.None));
    }

    // the manifest declared qr_display and code_display from a sketch; ASN's code rotates, so a still has expired by
    // the time the phone is out
    [Fact]
    public void The_manifest_declares_the_live_view_its_sign_in_actually_relays()
    {
        var manifest = AsnPersistentManifest.Build();

        Assert.Equal([Connector.Kit.Challenges.ChallengeType.LiveView], manifest.Auth.Challenges);

        Assert.Equal(AsnManifest.Build().Auth.Challenges, manifest.Auth.Challenges);
    }

    // the pooled adapter signs out on purpose (a bank seeing a string of unclosed sessions draws conclusions); here
    // the never-signed-out session IS the product
    [Fact]
    public void The_always_on_tier_does_not_offer_a_sign_out()
    {
        Assert.Equal(LogoutSupport.None, AsnPersistentManifest.Build().Logout);
        Assert.Equal(LogoutSupport.Session, AsnManifest.Build().Logout);
    }
}
