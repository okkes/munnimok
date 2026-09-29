using Connector.Kit.Challenges;
using BankConnector.Adapters;
using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// ASN on the account holder's own machine: what it skips, and what it refuses
/// to assume.
///
/// <para>
/// The tier's whole payoff is that a profile which is still signed in asks the
/// human for nothing. Its whole risk is the same sentence read the other way:
/// an adapter that BELIEVES it is signed in drives a sign-in page as though it
/// were a bank, and reports the bank as broken.
/// </para>
///
/// <para>
/// So every test here is about one question - is this profile actually inside
/// ASN - and about the two different right answers.
/// </para>
/// </summary>
public sealed class AsnPersistentAdapterTests
{
    private static readonly AsnOptions Options = new();

    private const string SignedIn = "https://www.asnbank.nl/online/web/onlinebankieren/";

    private static AsnPersistentAdapter Adapter() => new(Options);

    private static FakeJobContext Context() => new() { Browser = new StubBrowserLease() };

    /// <summary>A profile that opens ASN and is still inside it.</summary>
    private static StubAsnPortal Inside()
    {
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = SignedIn;

        return portal;
    }

    /// <summary>
    /// A profile ASN has signed out from underneath, on a browser it has never
    /// registered.
    /// </summary>
    /// <remarks>
    /// The sign-in address SITS BENEATH the signed-in one, so this url still
    /// contains the signed-in marker. A check that looked only for that would
    /// call this profile connected - which is the entire trap.
    /// <para>
    /// UNREGISTERED, STATED. The stub's every selector is present unless said
    /// otherwise, and the five-digit box is how ASN's sign-in page says a
    /// browser is registered - so a fixture that did not rule it out would be
    /// a registered browser by accident, and a registered browser with no
    /// code is a different case with a different answer.
    /// </para>
    /// </remarks>
    private static StubAsnPortal Outside()
    {
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = Options.LoginUrl;
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        return portal;
    }

    // ---- what the tier is for ----------------------------------------------

    /// <summary>
    /// A PROFILE THAT IS STILL SIGNED IN ASKS FOR NOTHING.
    /// </summary>
    /// <remarks>
    /// No QR, no live view, no phone. This is the entire reason for keeping a
    /// profile, and it is one check - so it is worth a test that would notice
    /// if connecting quietly started costing a scan again.
    /// </remarks>
    [Fact]
    public async Task Connecting_a_profile_that_is_still_signed_in_asks_the_human_nothing()
    {
        using var ctx = Context();

        var result = await Adapter().LoginAsync(ctx, Inside(), CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.Contains(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));

        // AND NO SECRET COMES BACK. The session lives in a profile directory on
        // the user's machine; the agent stamps the pointer on. A cookie jar
        // here would put a live ASN session in the connector's database, which
        // is the exact thing this tier exists to avoid.
        Assert.Null(result.Material.StorageState);
        Assert.Null(result.Material.AccessToken);
        Assert.Null(result.Material.RefreshToken);
    }

    /// <summary>
    /// AND THE QUESTION IS NOT EVEN ASKED OF A BROWSER THAT WAS HANDED
    /// NOTHING.
    /// </summary>
    /// <remarks>
    /// The same portal as the test above - a browser that opens ASN and is
    /// inside it - run on a context whose browser starts from nothing at all.
    /// The kit's gate, <c>IJobContext.KeepsSession</c>, is what says so, and
    /// with it shut the bank is never asked: the sign-in the page is offering
    /// runs instead.
    /// <para>
    /// This tier cannot really produce that run - <c>browser_persistent</c>
    /// plus a BYO agent means <c>JobRunner.ResolveProfile</c> always hands it a
    /// profile directory - and it is asserted here anyway, because the gate is
    /// shared with every other provider and this suite is where an ASN
    /// regression would be seen. What must never happen is the opposite of
    /// what is asserted below: the bank being told "still signed in?" about a
    /// browser that has never held a cookie, and the settle window being spent
    /// on the answer.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_browser_with_nothing_kept_is_never_asked_whether_it_is_signed_in()
    {
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(), KeepsSession = false };

        var portal = Inside();

        // Unregistered, so what follows is the pooled QR sign-in - reached at
        // all only because the signed-in check never ran.
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // THE OVERVIEW WAS NEVER OPENED. That navigation is the first move of
        // the check and nothing else in this adapter makes it, so its absence
        // is the whole assertion.
        Assert.DoesNotContain(
            portal.Calls, c => c == $"goto:https://www.asnbank.nl{Options.SignedInPathMarker}");

        // Nor was the settle window spent waiting for a bounce.
        Assert.DoesNotContain(portal.Calls, c => c == $"wait:{Options.SignInPathMarker}");
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
    }

    // ---- and what it refuses to assume -------------------------------------

    /// <summary>
    /// A PROFILE THAT IS NOT SIGNED IN FAILS HONESTLY, RATHER THAN BLAMING ASN.
    /// </summary>
    /// <remarks>
    /// Whether ASN's session really survives in a persistent profile is the one
    /// claim this whole tier rests on, and nobody has measured it. So a fetch
    /// asks instead of believing.
    /// <para>
    /// The alternative is worse than a failed fetch. ASN serves its export form
    /// to a signed-out browser as a sign-in page, so an adapter that pressed on
    /// would hunt an account picker that was never rendered and report
    /// <c>provider_changed</c> - "the download form has no account picker" -
    /// about a bank that was simply waiting to be logged into. That reads as a
    /// broken connector and sends somebody to fix the wrong thing.
    /// </para>
    /// </remarks>
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

        // SESSION EXPIRED, which is the code the manifest names as its reauth
        // trigger - so the platform offers to reconnect rather than reporting
        // that ASN changed its site.
        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
        Assert.NotEqual(ErrorCode.ProviderChanged, refused.Code);

        Assert.Contains(AsnPersistentManifest.ProviderId, refused.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// And it never mistakes the sign-in page for the signed-in one.
    /// </summary>
    /// <remarks>
    /// ASN's sign-in address sits BENEATH its signed-in one -
    /// <c>/online/web/onlinebankieren/inloggen/</c> under
    /// <c>/online/web/onlinebankieren/</c> - so "the url contains the signed-in
    /// marker" is true on both. A check built on that alone calls every
    /// signed-out profile connected, and this is the fixture that says so.
    /// </remarks>
    [Fact]
    public void The_signed_out_fixture_would_pass_a_check_that_only_looked_for_the_signed_in_path()
    {
        Assert.Contains(Options.SignedInPathMarker, Options.LoginUrl, StringComparison.Ordinal);
    }

    /// <summary>
    /// A profile that has been signed out is CONNECTABLE again, and that is a
    /// different answer from a fetch failing.
    /// </summary>
    [Fact]
    public async Task Connecting_a_signed_out_profile_falls_back_to_the_ordinary_sign_in()
    {
        using var ctx = Context();
        var portal = Outside();

        // The pooled sign-in it delegates to needs the bank to answer; here it
        // does not, so this ends in a provider error rather than a connection.
        // What the test is about is WHICH path was taken: the cookie wall is
        // the sign-in's own first move, and reaching it proves the adapter did
        // not just hand back a pointer to a profile that is signed out.
        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Contains(portal.Calls, c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));
    }

    // ---- the trusted browser -----------------------------------------------

    private static FakeJobContext WithCode(string code = "12345") => new()
    {
        Browser = new StubBrowserLease(),
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [AsnPersistentAdapter.BrowserCodeKey] = code,
        },
    };

    /// <summary>A registered browser: the five-digit box is on the page.</summary>
    private static StubAsnPortal Trusted()
    {
        var portal = StubAsnPortal.Blank(Options.BrowserCodeSubmitLabel);
        portal.RedirectsTo = Options.LoginUrl;
        portal.ArrivesAt = SignedIn;

        return portal;
    }

    /// <summary>
    /// A TRUSTED BROWSER SIGNS IN WITH FIVE DIGITS AND NO PHONE.
    /// </summary>
    /// <remarks>
    /// The point of keeping a profile. Every other route into this bank needs
    /// somebody holding their phone: ASN's app code rotates every few seconds,
    /// so it cannot be relayed to anyone who is not there at that moment. Five
    /// digits can, which is the difference between a sync somebody has to
    /// attend and one they do not.
    /// </remarks>
    [Fact]
    public async Task A_registered_browser_signs_in_with_the_code_and_asks_for_nothing_else()
    {
        using var ctx = WithCode();
        var portal = Trusted();

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        // No QR, no live view, nothing relayed to anybody.
        Assert.Empty(ctx.Asked);
        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        // The code went into the box ASN shows a trusted browser...
        Assert.Equal("12345", portal.Filled[$"{Options.BrowserCodeSelectors[0]}#0"]);

        // ...and it is NOT in what comes back. The profile is the thing you
        // have and the code is the thing you know; sealing them together would
        // put both factors in one box.
        Assert.Null(result.Material.StorageState);
        Assert.Null(result.Material.AccessToken);
    }

    /// <summary>
    /// A CODE WITH NO REGISTRATION OPENS THE REGISTRATION PAGE.
    /// </summary>
    /// <remarks>
    /// The five digits are chosen BY the customer, on ASN's own "Kies een
    /// browsercode" screen - so somebody who has decided on a code and has no
    /// trusted browser is somebody in the middle of setting one up. Falling
    /// back to the QR would sign them in once, correctly, and leave them
    /// exactly as far from an unattended sync as they started.
    /// <para>
    /// Whether the browser is registered is asked of the PAGE - the five-digit
    /// box is the tell - rather than remembered from the day it was. So a
    /// registration ASN has withdrawn takes this same route rather than typing
    /// digits at a page with no box for them and blaming the code.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_code_with_no_registration_opens_asns_own_registration_page()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = SignedIn;

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        // It went to ASN's registration page, and it streamed it: registration
        // is twenty screens with two one-time codes in the middle, and driving
        // that from selectors would be a bank's identity flow automated on one
        // run's evidence with an account lockout for a failure mode.
        Assert.Contains(
            portal.Calls,
            c => c.Contains(Options.BrowserRegistrationPath, StringComparison.Ordinal));

        var streamed = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.LiveView, streamed.Type);
        Assert.Equal(AsnPersistentManifest.RegisterKey, streamed.PromptKey);

        // And it never fell through to the QR sign-in, whose own first move is
        // the cookie wall.
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.Null(result.Material.StorageState);
    }

    /// <summary>
    /// AND A REGISTRATION THAT RUNS OUT ITS WINDOW FAILS THERE, saying so, and
    /// never falls into the QR sign-in.
    /// </summary>
    /// <remarks>
    /// It takes two one-time codes and a debit card, so somebody walking away
    /// halfway through is an ordinary outcome rather than a fault. The profile
    /// is untouched and the page comes back where it was.
    /// <para>
    /// THE CLIFF THIS IS ABOUT. The window lapsing used to hand back null,
    /// which the caller read as "not a registered browser" and answered with
    /// the pooled sign-in - which opens the login address ON THE SAME PAGE,
    /// over a registration that might have been one screen from done, and
    /// then waits five more minutes for a scan nobody is going to make. The
    /// job's eventual failure blamed its working budget. So the claim here
    /// is twofold: the code names what happened, and after the registration
    /// page nothing navigated anywhere.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_registration_that_runs_out_its_window_fails_there_and_never_falls_into_the_qr_sign_in()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = null;

        var lapsed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // MFA TIMEOUT: nobody finished the challenge in its window. The
        // platform's own code for that, and it says "try again" - which is
        // exactly right for an errand that can be started over.
        Assert.Equal(ErrorCode.MfaTimeout, lapsed.Code);
        Assert.Contains($"{Options.RegistrationSeconds}s window", lapsed.Message, StringComparison.Ordinal);

        Assert.Contains(ctx.Notes, n => n.Contains("Nothing was lost", StringComparison.Ordinal));

        // The registration page was the LAST place the browser was sent. No
        // login address on top of it, and no cookie wall - the pooled
        // sign-in's own first move - after it.
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

    /// <summary>
    /// BUT A REGISTRATION THAT LANDS ON THE LAST MINUTE IS FINISHED, however
    /// slowly the page then loads.
    /// </summary>
    /// <remarks>
    /// The wait keeps waiting for the page to load after the address is
    /// already right, and it fails on the same clock. Failing THAT as "not
    /// finished within its window" would send somebody back through twenty
    /// screens, a code by e-mail, a code by text and a debit card, for a
    /// registration ASN had already granted - the most expensive wrong answer
    /// this adapter can give.
    /// </remarks>
    [Fact]
    public async Task A_registration_that_lands_before_its_page_finishes_loading_is_finished()
    {
        using var ctx = WithCode();

        var portal = Outside();
        portal.ArrivesAt = SignedIn;
        portal.ArrivesAfter = TimeSpan.FromSeconds(600);
        portal.LoadsAfter = TimeSpan.FromSeconds(900);

        // The human gets there inside the twelve minutes; the overview is
        // still drawing when they run out.
        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.RegistrationSeconds));
        Assert.True(TimeSpan.FromSeconds(Options.RegistrationSeconds) < portal.LoadsAfter);

        var result = await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.Null(result.Material.StorageState);
    }

    /// <summary>
    /// AND A CODE ASN REFUSES IS A CREDENTIAL PROBLEM, NOT A BROKEN BANK.
    /// </summary>
    /// <remarks>
    /// Confirmed by leaving, exactly as the QR path is: a wrong code leaves the
    /// browser on the sign-in page. Reporting that as <c>provider_changed</c>
    /// would send somebody to fix an adapter over a typo, and reporting it as
    /// success would be worse.
    /// </remarks>
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

        // And it says what it saw rather than what it concluded: the browser
        // is still on the sign-in page, which a refused code and a landing
        // that has not happened yet both look like from the address bar.
        Assert.Contains("still on ASN's sign-in page", refused.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A SLOW LANDING IS WAITED FOR, on a budget of its own.
    /// </summary>
    /// <remarks>
    /// The wait after the digits borrowed the selector timeout - ten seconds,
    /// the budget for a control APPEARING on a page that is already open -
    /// for a bank checking a credential and serving an overview on a headed
    /// emulated Chromium. A landing that took eleven seconds was reported as
    /// "ASN did not accept that browsercode", which marks the profile
    /// unhealthy and sends somebody to re-check five digits that were right.
    /// <para>
    /// The fixture states how long the bank takes; the two halves state that
    /// the option is what gets spent on it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_landing_slower_than_a_selector_but_inside_the_landing_window_still_signs_in()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.ArrivesAfter = TimeSpan.FromSeconds(20);

        // Twice what a selector gets, and inside the landing budget.
        Assert.True(TimeSpan.FromMilliseconds(Options.SelectorTimeoutMs) < portal.ArrivesAfter);
        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds));

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        // AND THE OPTION IS THE BUDGET. Shorten it below the bank's own time
        // and the same landing is refused - so a deployment that tunes the
        // number tunes the behaviour, rather than a constant somewhere else.
        using var hurried = WithCode();
        var slow = Trusted();
        slow.ArrivesAfter = TimeSpan.FromSeconds(20);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnPersistentAdapter(Options with { BrowserCodeLandingSeconds = 10 })
                .LoginAsync(hurried, slow, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
        Assert.Contains("10s after the browsercode was submitted", refused.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A BROWSER SENT SOMEWHERE THIRD IS A CHANGED PAGE, not a refused code.
    /// </summary>
    /// <remarks>
    /// A refused code leaves the browser on the sign-in page; a signed-in one
    /// lands on the overview. A page that is neither - a maintenance notice,
    /// a withdrawn registration, something this adapter has not seen - was
    /// reported as the code being wrong, which marks the profile unhealthy
    /// and says nothing about where the browser actually went. The address
    /// is the one fact the first failure can carry out, so it does.
    /// </remarks>
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

    /// <summary>
    /// THE MENU IS FOUND BY ITS NAME WHEN THE SELECTOR MISSES, because the
    /// name is the half of it anybody actually saw.
    /// </summary>
    /// <remarks>
    /// The mapping run reported this control as
    /// <c>button[data-testid='button'] "Profiel menu openen"</c>. The probe
    /// builds that selector from <c>data-testid</c> and reads that name from
    /// <c>aria-label</c> OR <c>title</c> - so the words are observed and
    /// <see cref="AsnOptions.UserMenuSelectors"/>, which spells them as an
    /// aria-label, is a guess. A <c>title</c> makes it match nothing.
    /// <para>
    /// That was survivable while the only caller was the sign-out ladder,
    /// which has positional rungs beneath it. As the witness for "is this
    /// profile signed in" it is not: a miss on a signed-in page reads as
    /// signed out, and a signed-out profile holding a browsercode is sent to
    /// ASN's twenty-screen registration - on top of a live session, for a
    /// browser that is already trusted. This fixture is that page.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_user_menu_the_css_selector_cannot_see_is_still_found_by_its_name()
    {
        using var ctx = WithCode();

        var portal = Inside();
        portal.AbsentSelectors.Add(Options.UserMenuSelectors[0]);
        portal.Labels.Add(Options.UserMenuLabel);

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in", StringComparison.Ordinal));

        // AND NEITHER WAY OF ASKING IS STILL NOT SIGNED IN. A page with no
        // menu under either name keeps the answer that costs a reconnect -
        // this fixture then goes on down the browsercode route and fails
        // there, which is itself the proof that it was not read as connected.
        using var neither = WithCode();
        var bare = Inside();
        bare.AbsentSelectors.Add(Options.UserMenuSelectors[0]);

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(neither, bare, CancellationToken.None));

        Assert.DoesNotContain(neither.Notes, n => n.Contains("still signed in", StringComparison.Ordinal));
    }

    /// <summary>
    /// A LANDING THE WAIT GAVE UP ON IS STILL A LANDING, if the address says
    /// so.
    /// </summary>
    /// <remarks>
    /// The real wait matches the address when the navigation commits and then
    /// keeps waiting, on the same clock, for the page to finish loading - so a
    /// bank overview that commits inside the budget and loads after it fails
    /// the wait with the browser already on the overview. Read as "neither
    /// page", that threw <c>provider_changed</c> saying the overview was
    /// "neither ASN's sign-in page nor its overview": a sentence its own
    /// subject contradicts, against a browser that was signed in, and
    /// <c>provider_changed</c> degrades this provider in the catalogue for
    /// everybody.
    /// <para>
    /// The address has the last word, exactly as it does on the signed-in
    /// check one method over.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_landing_whose_page_loads_after_the_budget_is_signed_in_rather_than_a_changed_bank()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.ArrivesAfter = TimeSpan.FromSeconds(5);
        portal.LoadsAfter = TimeSpan.FromSeconds(60);

        // The browser gets there well inside the budget; the page finishes
        // loading well outside it. Which is the case the wait cannot tell
        // apart from never having moved, and the address can.
        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds));
        Assert.True(TimeSpan.FromSeconds(Options.BrowserCodeLandingSeconds) < portal.LoadsAfter);

        await Adapter().LoginAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("no phone", StringComparison.Ordinal));

        // AND A BROWSER THAT REALLY WENT NOWHERE IS STILL REFUSED. The
        // second opinion is the address, not a blanket pardon for a wait
        // that ran out.
        using var stuck = WithCode();
        var stranded = Trusted();
        stranded.ArrivesAt = null;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(stuck, stranded, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
    }

    /// <summary>
    /// A REGISTERED BROWSER WITH NO CODE IS MISSING AN INPUT, not a changed
    /// bank.
    /// </summary>
    /// <remarks>
    /// The field is optional to the validator because a browser has to be
    /// registered before it has a code. But a registered browser's sign-in
    /// page has no method buttons on it - "Je logt in als", one box, Inloggen
    /// - so there is no QR to fall back to. The fallback ran anyway: it hunted
    /// "ASN Bank app" on a page that has never had it, reported
    /// <c>provider_changed</c>, and the catalogue degraded this provider for
    /// everybody on the strength of one person leaving a field blank.
    /// <para>
    /// The page decides what is missing. Invalid request, naming the key,
    /// the same way the validator would have if the manifest could have known.
    /// </para>
    /// </remarks>
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

        // And it never went looking for the QR route: no method button was
        // pressed, and the login address was not opened over the page.
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.AppMethodLabel, StringComparison.Ordinal));

        Assert.DoesNotContain(portal.Calls, c => c == "goto:" + Options.LoginUrl);

        // Nothing was typed, because there was nothing to type.
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("fill:", StringComparison.Ordinal));
    }

    /// <summary>
    /// THE GREETING IS A SECOND WITNESS that a browser is registered.
    /// </summary>
    /// <remarks>
    /// The five-digit box is the tell, and on its own it is also a single
    /// point of failure: the day ASN restyles that input, a registered browser
    /// reads as unregistered and goes down the QR route - which on a
    /// registered page ends in <c>provider_changed</c> for everyone. "Je logt
    /// in als" is what that page greets a registered browser with, and it is
    /// asked when the box is not found.
    /// </remarks>
    [Fact]
    public async Task A_page_that_greets_a_registered_browser_is_registered_even_when_its_box_has_moved()
    {
        // No box, but the greeting.
        var portal = Trusted();
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);
        portal.Headings.Add(Options.SignedInAsHeadingPrefix + " someone");

        using var ctx = Context();

        var missing = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // Registered, so the missing input - and not the QR route, whose first
        // move is the cookie wall.
        Assert.Equal(ErrorCode.InvalidRequest, missing.Code);
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        // And WITH a code, a registered page whose box cannot be typed into
        // is a page that changed - not a browser that wants registering.
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

    /// <summary>
    /// AND WITHOUT A CODE, ON AN UNREGISTERED BROWSER, IT IS THE ORDINARY
    /// SIGN-IN, unchanged.
    /// </summary>
    /// <remarks>
    /// The field is optional because a browser has to be registered before it
    /// has a code, and registering one is a long human errand this connector
    /// sends somebody to rather than drives. The qualification is the point:
    /// only the page with method buttons on it gets the method-button route.
    /// </remarks>
    [Fact]
    public async Task Without_a_code_the_connect_is_the_sign_in_it_always_was()
    {
        using var ctx = Context();
        var portal = Outside();

        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // Never touched the box, because nothing was given to type into it.
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("fill:", StringComparison.Ordinal));

        // And it reached the pooled sign-in, whose first checked move is the
        // method button.
        Assert.Contains(
            portal.Calls,
            c => c.StartsWith("click:" + Options.AppMethodLabel, StringComparison.Ordinal));
    }

    // ---- the retry latch ---------------------------------------------------

    /// <summary>
    /// A BROWSERCODE THAT HAS BEEN SUBMITTED IS LATCHED, so nothing ever types
    /// it at ASN a second time.
    /// </summary>
    /// <remarks>
    /// The platform decides whether a job whose lease lapsed may go back to the
    /// queue by exactly one question: has anything been submitted upstream. An
    /// adapter that never answers it leaves the answer at no - so an agent that
    /// stopped during the thirty-second landing wait sent this login back, and
    /// the next run typed the SAME five digits at the bank with nobody
    /// watching.
    /// <para>
    /// THE REFUSAL IS THE CASE THIS IS REALLY ABOUT, which is why it is the
    /// second half. A code ASN has already refused is the one thing the
    /// adapter's own failure says "must never be retried on its own" - and a
    /// bank that counts refused attempts counts the second one too. The error
    /// path carries that rule for a run that finishes; only the latch carries
    /// it for a run that is cut off.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_submitted_browsercode_is_latched_so_a_lapsed_lease_never_types_it_again()
    {
        using var ctx = WithCode();

        await Adapter().LoginAsync(ctx, Trusted(), CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);

        // A code the bank refused is latched just the same. This is the run
        // that must not come back: the digits have been at ASN once, and a
        // requeue would spend a second attempt on an account whose failures a
        // bank counts.
        using var refused = WithCode("00000");
        var wrong = Trusted();
        wrong.ArrivesAt = Options.LoginUrl;

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(refused, wrong, CancellationToken.None));

        Assert.True(refused.CredentialWasSubmitted);
    }

    /// <summary>
    /// AND IT IS LATCHED BEFORE THE BUTTON IS PRESSED, not after.
    /// </summary>
    /// <remarks>
    /// What must not exist is a window in which the code has reached ASN and
    /// the control plane has not heard about it - an agent killed inside the
    /// click itself would leave one. So the flag is raised while the digits are
    /// still on this machine, the way bol's and BKR's are, and this page is how
    /// that is stated: the box is there, the digits go in, and the Inloggen
    /// button is not there to press.
    /// <para>
    /// Latching a hair early costs nothing even here. A page that has lost its
    /// submit button is <c>provider_changed</c>, which is on the never-retry
    /// list, so the job was not going back to the queue either way.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_code_is_latched_before_the_click_rather_than_after_it()
    {
        using var ctx = WithCode();

        var portal = Trusted();
        portal.Labels.Remove(Options.BrowserCodeSubmitLabel);

        var changed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        // The page this fixture is: box typed into, button missing.
        Assert.Equal(ErrorCode.ProviderChanged, changed.Code);
        Assert.Contains($"'{Options.BrowserCodeSubmitLabel}' button is not", changed.Message, StringComparison.Ordinal);
        Assert.Equal("12345", portal.Filled[$"{Options.BrowserCodeSelectors[0]}#0"]);

        Assert.True(ctx.CredentialWasSubmitted);
    }

    /// <summary>
    /// A PAGE WITH NO BOX TO TYPE INTO LATCHES NOTHING, because nothing was
    /// typed.
    /// </summary>
    /// <remarks>
    /// The latch is not free: it converts a lapsed lease from a retry into a
    /// permanent failure, and the human is asked to connect again. So it is
    /// owed only where a credential really went somewhere. A registered
    /// browser's page whose box has moved has had five digits offered to it and
    /// has taken none of them - the right answer there is the retry the job
    /// still has.
    /// </remarks>
    [Fact]
    public async Task A_page_with_no_box_to_type_the_code_into_latches_nothing()
    {
        using var ctx = WithCode();

        // Registered by its greeting - so this is the browsercode route - but
        // with no input on it.
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

    /// <summary>
    /// AND A REGISTRATION LATCHES NOTHING EITHER, however long it runs.
    /// </summary>
    /// <remarks>
    /// Everything ASN receives during a registration is typed by the account
    /// holder into their own browser: the adapter opens a page and gets out of
    /// the way. Nothing has been submitted on anybody's behalf, so a lease that
    /// lapses mid-errand is a job that may go back - which is exactly what the
    /// adapter promises whoever walked away from it, "connect again and the
    /// page comes back where it was". Latching here would spend the retry that
    /// note has already offered.
    /// <para>
    /// Both endings, because they are the two ways out and the flag must be
    /// clear on each: the registration that finishes, and the one whose window
    /// runs out.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_registration_latches_nothing_because_the_adapter_submits_nothing()
    {
        using var ctx = WithCode();

        var finished = Outside();
        finished.ArrivesAt = SignedIn;

        await Adapter().LoginAsync(ctx, finished, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("registered with ASN now", StringComparison.Ordinal));
        Assert.False(ctx.CredentialWasSubmitted);

        // And the window lapsing is an MFA timeout, which the platform calls
        // retriable - a claim the latch would quietly contradict.
        using var lapsing = WithCode();

        var abandoned = Outside();
        abandoned.ArrivesAt = null;

        var lapsed = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(lapsing, abandoned, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaTimeout, lapsed.Code);
        Assert.False(lapsing.CredentialWasSubmitted);
    }

    // ---- reading the overview ----------------------------------------------

    /// <summary>
    /// A BOUNCE THAT HAPPENS AFTER THE NAVIGATION RETURNS IS STILL A BOUNCE.
    /// </summary>
    /// <remarks>
    /// The signed-in test read the address the instant the goto came back.
    /// Right for a bank that answers a signed-out visitor with its sign-in
    /// page server-side; wrong for one whose overview loads, looks at its
    /// session and moves itself on a moment later - and wrong in the
    /// expensive direction. A brand-new profile read as "still signed in",
    /// the connect finished having asked nobody anything, and the first fetch
    /// drove the export against a sign-in page and blamed the bank.
    /// <para>
    /// This is the page the account holder will meet first on a live run,
    /// which is why both halves are here: the connect must not hand back a
    /// pointer, and the fetch must say the session is gone.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_profile_the_bank_bounces_client_side_is_not_read_as_signed_in()
    {
        // The goto lands on the overview's address; the page then sends
        // itself to the sign-in page, which has no user menu on it.
        var portal = StubAsnPortal.Blank();
        portal.ThenMovesTo = Options.LoginUrl;
        portal.AbsentSelectors.Add(Options.UserMenuSelectors[0]);
        portal.AbsentSelectors.Add(Options.BrowserCodeSelectors[0]);

        using var ctx = Context();

        // Unregistered and no code, so the honest outcome is the ordinary
        // sign-in - which on this fixture ends in a provider error, and that
        // is fine: the claim is which route was taken.
        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
        Assert.Contains(
            portal.Calls,
            c => c.StartsWith("click:" + Options.CookieRefuseSelectors[0], StringComparison.Ordinal));

        // And a fetch on the same profile says the session ended, rather than
        // reading a sign-in page as an export form.
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

    /// <summary>
    /// THE PAGE A LIVE RUN ACTUALLY MET: the overview's address, the menu on
    /// screen, and a bounce to the sign-in page afterwards.
    /// </summary>
    /// <remarks>
    /// Observed on 2026-09-19 on a real account, and it corrects the fixture
    /// above rather than repeating it. That one gives the bouncing page no
    /// user menu, which is what made "the menu is a signed-in-only control"
    /// look safe; the live page had one. The connect reported "this profile
    /// was still signed in to ASN, so nothing was asked of you" about a
    /// profile directory seconds old, and the fetch twenty-five seconds later
    /// photographed <c>/inloggen/</c> offering the three method buttons an
    /// unregistered browser gets.
    /// <para>
    /// So both witnesses agreed and both were wrong, and the check no longer
    /// rests on either saying yes: it rests on the page being given its whole
    /// window to say NO, which only a signed-out one ever does.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_page_a_signed_out_browser_really_gets_is_not_read_as_signed_in()
    {
        // Every selector present, the menu included - this page looks signed
        // in by both of the old tests' measures.
        var portal = StubAsnPortal.Blank();
        portal.RedirectsTo = SignedIn;
        portal.ArrivesAt = Options.LoginUrl;
        portal.ArrivesAfter = TimeSpan.FromSeconds(3);

        Assert.True(portal.ArrivesAfter < TimeSpan.FromSeconds(Options.SignedInSettleSeconds));

        using var ctx = Context();

        // No code was given on the observed run either, so the honest route
        // is the ordinary sign-in; this fixture ends it in a provider error,
        // and the claim is which route was taken.
        await Assert.ThrowsAnyAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, portal, CancellationToken.None));

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));

        // AND A BOUNCE THAT NEVER COMES IS STILL SIGNED IN. The window is a
        // chance to say no, not a toll every connect pays for nothing.
        using var inside = Context();

        await Adapter().LoginAsync(inside, Inside(), CancellationToken.None);

        Assert.Contains(inside.Notes, n => n.Contains("nothing was asked of you", StringComparison.Ordinal));
    }

    /// <summary>
    /// A PAGE THAT SHOWS NEITHER ITS MENU NOR THE SIGN-IN ADDRESS IN TIME IS
    /// NOT SIGNED IN - and the settle window is the option.
    /// </summary>
    /// <remarks>
    /// The address alone was the whole test, and the address is right the
    /// instant a signed-in overview loads - so the wait is only ever paid on
    /// a page that is not what it looks like. Which way the doubt resolves is
    /// the decision: "not signed in" costs a reconnect, "signed in" costs a
    /// broken export and a degraded provider. The fixture states how long the
    /// menu takes; the two halves state that the option is what gets spent.
    /// </remarks>
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

        // Given the time, the same page is signed in and the fetch goes on to
        // the export form - which is as far as this fixture can take it.
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

    // ---- the wait ----------------------------------------------------------

    /// <summary>
    /// THE TWELVE-MINUTE WAIT ENDS WHEN ITS TOKEN DOES.
    /// </summary>
    /// <remarks>
    /// Playwright's waits take a timeout and nothing else, so the wait for the
    /// address to change ran until it changed or the budget ran out, and a
    /// cancellation in between changed nothing - the handler for it sat below
    /// a call that could never throw it. A lost lease, a spent budget or an
    /// agent shutting down therefore could not end a registration, and the
    /// browser stayed open on somebody's bank until ASN moved it or twelve
    /// minutes passed.
    /// <para>
    /// The race is a static seam that takes any task, which is what lets it
    /// be tested here without a browser: a wait that never finishes, a token
    /// that does, and a bound on how long the answer takes.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_path_wait_ends_promptly_when_its_token_is_cancelled()
    {
        var never = new TaskCompletionSource<bool>();

        using var cts = new CancellationTokenSource();
        cts.CancelAfter(TimeSpan.FromMilliseconds(50));

        var raced = AsnPortal.UntilCancelledAsync(never.Task, cts.Token);

        // Promptly: the answer arrives in the cancellation's own time, not the
        // budget's. Ten seconds is generous for a loaded machine and hopeless
        // for a wait that was actually waiting on the page.
        var first = await Task.WhenAny(raced, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(raced, first);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => raced);

        // And the two honest endings are untouched: a wait that lands is
        // true, a wait that runs out its budget is false.
        Assert.True(await AsnPortal.UntilCancelledAsync(Task.CompletedTask, CancellationToken.None));
        Assert.False(
            await AsnPortal.UntilCancelledAsync(
                Task.FromException(new TimeoutException("Timeout 720000ms exceeded")),
                CancellationToken.None));
    }

    // ---- the manifest ------------------------------------------------------

    /// <summary>
    /// THE MANIFEST DECLARES THE CHALLENGE ITS OWN LOGIN RAISES.
    /// </summary>
    /// <remarks>
    /// It declared <c>qr_display</c> and <c>code_display</c> until the adapter
    /// was written against it. Reasonable for a sketch and wrong about the
    /// bank: ASN's code rotates every few seconds, so a still photograph
    /// relayed once has expired by the time somebody has their phone out. The
    /// pooled manifest learned that from a live session; this one had no way to
    /// hear about it.
    /// </remarks>
    [Fact]
    public void The_manifest_declares_the_live_view_its_sign_in_actually_relays()
    {
        var manifest = AsnPersistentManifest.Build();

        Assert.Equal([Connector.Kit.Challenges.ChallengeType.LiveView], manifest.Auth.Challenges);

        // And the same one the pooled sign-in raises, because it IS that
        // sign-in.
        Assert.Equal(AsnManifest.Build().Auth.Challenges, manifest.Auth.Challenges);
    }

    /// <summary>
    /// SIGNING OUT WOULD DESTROY THE ASSET, so this tier declares none.
    /// </summary>
    /// <remarks>
    /// The pooled adapter signs out on purpose - a bank that sees a string of
    /// sessions never signed out of draws conclusions. Here the never-signed-
    /// out session IS the product, and a user who wants it gone revokes the
    /// agent or deletes the profile.
    /// </remarks>
    [Fact]
    public void The_always_on_tier_does_not_offer_a_sign_out()
    {
        Assert.Equal(LogoutSupport.None, AsnPersistentManifest.Build().Logout);
        Assert.Equal(LogoutSupport.Session, AsnManifest.Build().Logout);
    }
}
