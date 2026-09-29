using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// A login this platform deliberately cannot perform.
///
/// DUO's SAML request carries <c>ForceAuthn=true</c>, so DigiD re-authenticates
/// the human every single time; and the flow is <c>remote_browser</c>, which
/// the manifest validator only accepts from a provider declaring no fields at
/// all. So there is nothing to type, nothing stored, and nothing to assert
/// about a credential except that none of it happens.
///
/// What IS worth asserting is everything around that: where the login starts,
/// what counts as having finished, and the one thing this adapter does more
/// than stream - relaying DigiD's QR as the bytes DigiD drew rather than as a
/// photograph of them.
/// </summary>
public sealed class DuoLoginTests
{
    private static readonly DuoOptions Options = new();

    private static readonly DateTimeOffset Now = new(2026, 8, 10, 12, 0, 0, TimeSpan.Zero);

    private const string Portal = "https://mijn.duo.nl/particulier/portaal/dashboard";

    private const string QrImage = "#app_verification_code img[src^='data:image']";

    private const string QrBlock = "#app_verification_code";

    /// <summary>A 1x1 PNG. The real one is 2958 bytes at 196x196.</summary>
    private const string Png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    private const string Payload =
        "digid-app-auth://app_session_id=00000000-0000-4000-8000-000000000000&lb=&at=1700000000&host=digid.nl";

    private static DuoAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    private static StubLoginPage Page() => StubLoginPage.Showing();

    /// <summary>
    /// A streamed login, as it really behaves: the human signs in on the page
    /// in front of them and never comes back to answer anything, so what ends
    /// the challenge is the session appearing.
    /// </summary>
    private static FakeJobContext Streaming() => new() { AnswersNothing = true };

    /// <summary>A DUO that says there is a session, which is what ends a login.</summary>
    private static StubDuoPortal SignedIn() => StubDuoPortal.Answering();

    // ---- what actually ends a login -----------------------------------------

    /// <summary>
    /// THE BUG THAT SHIPPED, as a test.
    ///
    /// Opening <c>mijn.duo.nl</c> redirects to <c>/particulier/portaal/dashboard</c>
    /// and only THEN bounces into SAML, so the very first thing the watch loop
    /// sees is a portal address belonging to nobody. Reading that address
    /// reported the login as finished 80 milliseconds after the live view
    /// opened - before DigiD had been shown to anyone, let alone signed in to.
    ///
    /// The url gate cannot fix this, because at that instant the url really is
    /// a portal url. Only DUO can say, so DUO is asked.
    /// </summary>
    [Fact]
    public async Task Sitting_on_the_portal_url_is_not_a_finished_login()
    {
        var page = Page();
        var portal = StubDuoPortal.WithNoSession();

        // Answers immediately, so the loop gets exactly one pass: the url says
        // signed in from the very first poll, exactly as it did live.
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);

        // And it was asked rather than assumed.
        Assert.Contains(portal.Requested, u => u.EndsWith("sessietoken/rest/jwt", StringComparison.Ordinal));
    }

    /// <summary>
    /// The same first poll, the same url, and DUO naming a profile. That, and
    /// only that, is a finished login.
    /// </summary>
    [Fact]
    public async Task A_login_ends_when_duo_itself_names_a_session()
    {
        var page = Page();
        var portal = SignedIn();
        using var ctx = new FakeJobContext();

        var result = await Adapter()
            .LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Contains(portal.Requested, u => u.EndsWith("sessietoken/rest/jwt", StringComparison.Ordinal));
    }

    /// <summary>
    /// And DUO is not asked while the browser is still somewhere in the login
    /// chain - which is what keeps this to about two calls per sign-in rather
    /// than one per poll for fifteen minutes.
    /// </summary>
    [Fact]
    public async Task Duo_is_not_asked_about_a_session_while_the_url_is_still_digids()
    {
        var page = Page();
        var portal = SignedIn();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        // Three passes where the url is not a portal url, then the landing.
        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 3), portal, cts.Token);

        Assert.Single(portal.Requested);
    }

    [Theory]
    [InlineData(StubDuoPortal.SessionJson, true)]
    [InlineData(StubDuoPortal.SignInPage, false)]
    [InlineData("""{"nieuwToken":true,"timeout":900}""", false)]
    [InlineData("""{"profiel":""}""", false)]
    [InlineData("""{"profiel":null}""", false)]
    [InlineData("[]", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void A_session_is_one_duo_names_a_profile_for(string? body, bool confirmed)
    {
        Assert.Equal(confirmed, DuoSession.Confirmed(body, Options));
    }

    // ---- a profile that is already inside -----------------------------------
    //
    // The reason this provider is pinned to an agent on somebody's own
    // machine. DUO's session is fifteen minutes of inactivity carried by the
    // browser's own cookies, so a second connect inside that window opens the
    // portal and is simply there - and ForceAuthn does not stop it, because
    // ForceAuthn binds an authentication that is STARTED and opening a page
    // DUO already has a session for starts none.

    /// <summary>
    /// The promise, as a test: connect again inside the window and nobody is
    /// asked anything.
    /// </summary>
    /// <remarks>
    /// The context here is the TYPED one - a stored DigiD username and
    /// password - so a check placed after the credentials were read would
    /// still drive DUO's chooser and DigiD's form and would still be caught by
    /// the assertions below. What must happen is that none of it is reached at
    /// all.
    /// </remarks>
    [Fact]
    public async Task A_profile_still_inside_duo_connects_without_asking_anything()
    {
        var page = Page();
        var portal = StubDuoPortal.Inside();
        using var ctx = Typing(keptProfile: true);

        var result = await Adapter()
            .LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        // Nothing asked, nothing typed, nothing pressed.
        Assert.Empty(ctx.Asked);
        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);

        // And DigiD was never reached: one navigation, to DUO's own protected
        // page, and no second one.
        Assert.Equal(["https://mijn.duo.nl/"], page.Visited);

        // THE SAME RESULT A FINISHED SIGN-IN RETURNS, because it is the same
        // method that builds it. The cookie jar IS the session here, so a
        // connect that carried no jar out would say "Connected" and leave
        // every later fetch signed out.
        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("DUO", result.Account!.DisplayName);
        Assert.Equal(Now.AddSeconds(900), result.ExpiresAt);

        // Opened, then finished. Never "Authenticating", because nothing
        // authenticated, and never "AwaitingHuman", because no human was.
        Assert.Equal([JobStep.OpeningProvider, JobStep.Finalizing], ctx.Steps);

        Assert.Contains(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // DUO ITSELF SAID SO. The address cannot: opening the portal lands on
        // a /particulier/portaal/ address before the bounce, which is how this
        // adapter once reported a finished login 80ms after the live view
        // opened.
        Assert.Equal(
            "https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt",
            Assert.Single(portal.Requested));

        // And the page was given exactly the window the option states, which
        // is the only thing standing between "still inside" and the address a
        // signed-out browser sits on while it bounces.
        Assert.Equal(TimeSpan.FromSeconds(Options.SignedOutBounceSeconds), Assert.Single(portal.Waited));
    }

    /// <summary>
    /// AND NOTHING IS LATCHED, because nothing was submitted.
    /// </summary>
    /// <remarks>
    /// The latch is what stops a lost lease requeueing a job - see
    /// <c>EfLeasedJobQueue.RequeueExpiredLeasesAsync</c> - and it is placed
    /// where it is because a requeued DigiD login is a second authentication
    /// attempt against an account whose failures Logius counts. A connect that
    /// reached neither DigiD nor DUO's login chain made no such attempt, so
    /// latching for it would only cost an agent that restarts mid-connect a
    /// sign-in it never made.
    /// </remarks>
    [Fact]
    public async Task A_connect_that_asked_for_nothing_latches_no_attempt()
    {
        var page = Page();
        using var ctx = Typing(keptProfile: true);

        await Adapter()
            .LoginAsync(ctx, page, new StubSignedIn(Portal, 0), StubDuoPortal.Inside(), CancellationToken.None);

        Assert.False(ctx.CredentialWasSubmitted);
    }

    /// <summary>
    /// AND THE QUESTION IS NOT EVEN ASKED OF A BROWSER THAT WAS HANDED
    /// NOTHING.
    /// </summary>
    /// <remarks>
    /// The same fixture as the test above - a portal that never bounces and
    /// names a profile when asked - on a run with no kept profile and no
    /// restored cookie jar. There is nothing for a session to be riding on, so
    /// <c>SessionProbe</c> answers "cannot tell" without touching DUO at all
    /// and the ordinary sign-in runs.
    /// <para>
    /// What the gate buys is the whole <c>SignedOutBounceSeconds</c> window,
    /// paid on every first connect - the one run somebody is sitting and
    /// watching - to learn an answer that was never in doubt. The two
    /// assertions below are the two halves of that: DUO was not asked, and no
    /// window was spent waiting for a bounce that could not matter.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_browser_with_nothing_kept_is_never_asked_whether_it_is_inside()
    {
        var page = SmsPage();
        var portal = StubDuoPortal.Inside();
        using var ctx = Typing();

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        Assert.Empty(portal.Waited);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // And it signed in the ordinary way instead, which is the fallthrough
        // "cannot tell" is defined to produce.
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Equal(Username, page.Filled[UsernameBox]);
    }

    /// <summary>
    /// And the other side of it: a browser DUO bounces into the sign-in chain
    /// signs in the ordinary way, and THAT is latched.
    /// </summary>
    [Fact]
    public async Task A_profile_that_is_bounced_to_digid_signs_in_and_is_latched()
    {
        var page = SmsPage();
        var portal = SignedIn();
        portal.BouncesAfter = TimeSpan.FromSeconds(3);

        // Inside the window, so the bounce is what decides rather than the
        // window running out.
        Assert.True(portal.BouncesAfter < TimeSpan.FromSeconds(Options.SignedOutBounceSeconds));

        using var ctx = Typing(keptProfile: true);

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(ChallengeType.MfaCode, Assert.Single(ctx.Asked).Type);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // A browser that has already left for DigiD is signed out full stop,
        // so the session endpoint is not asked about it here - it would be
        // answered from inside the SAML chain, which reads in the log as a
        // session that just died. The one call below is the sign-in's own.
        Assert.Single(portal.Requested);
    }

    /// <summary>
    /// A BOUNCE SLOWER THAN THE WINDOW IS A JUDGMENT, and here is what it
    /// costs.
    /// </summary>
    /// <remarks>
    /// Ten seconds is not a measurement: no capture ever timed DUO's redirect,
    /// because before a kept profile existed nobody had a browser that could
    /// arrive signed in. What makes an under-long window survivable is that it
    /// does not decide anything on its own - a page that has not bounced in
    /// time is handed to DUO's own session endpoint, which cannot be fooled by
    /// an address - and this fixture is a signed-out profile slow enough to
    /// prove it.
    /// <para>
    /// What the window buys is the cheaper half: given long enough to see the
    /// bounce, the answer costs no services call at all. Both halves below
    /// take the same route and end the same way, and the number of times DUO
    /// was asked is what says which witness decided.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_bounce_slower_than_the_window_leaves_the_answer_to_duo_itself()
    {
        var portal = StubDuoPortal.WithNoSession();
        portal.BouncesAfter = TimeSpan.FromSeconds(20);

        Assert.True(TimeSpan.FromSeconds(Options.SignedOutBounceSeconds) < TimeSpan.FromSeconds(20));

        // Nothing stored, so the streamed sign-in is the route; the context
        // answers immediately, which is a consumer closing the live view, and
        // that gives the watch loop exactly one pass.
        using var ctx = Watching(keptProfile: true);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, Page(), new StubSignedIn(Portal, 0), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // Twice: the check's, and the streamed loop's. The check paid for its
        // answer because the page had not refused in time.
        Assert.Equal(2, portal.Requested.Count);

        // Said out loud, too - a connect that opens the portal, waits, and
        // then streams DigiD for no stated reason is the one shape of "sign in
        // again" that reads as a bug.
        Assert.Contains(ctx.Notes, n => n.Contains("named no profile", StringComparison.Ordinal));

        // GIVEN THE WINDOW, the page refuses on its own and DUO is not asked
        // before the sign-in starts at all.
        var patient = StubDuoPortal.WithNoSession();
        patient.BouncesAfter = TimeSpan.FromSeconds(20);

        using var waiting = Watching(keptProfile: true);

        await Assert.ThrowsAsync<ConnectorException>(
            () => new DuoAdapter(Options with { SignedOutBounceSeconds = 25 }, new FixedTimeProvider(Now))
                .LoginAsync(waiting, Page(), new StubSignedIn(Portal, 0), patient, CancellationToken.None));

        Assert.Single(patient.Requested);
        Assert.DoesNotContain(waiting.Notes, n => n.Contains("named no profile", StringComparison.Ordinal));
    }

    /// <summary>
    /// Nothing stored, so the streamed sign-in is the only route - and the
    /// live view is answered the instant it is raised, which is a consumer
    /// closing it rather than a human signing in.
    /// </summary>
    /// <remarks>
    /// That answer is what bounds the watch loop to a single pass, the way
    /// <c>Sitting_on_the_portal_url_is_not_a_finished_login</c> relies on -
    /// the loop's own deadline never arrives under a clock that does not move.
    /// </remarks>
    private static FakeJobContext Watching(bool keptProfile = false) => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal),
        KeepsSession = keptProfile,
    };

    // ---- tier two: both credentials stored ----------------------------------

    private const string Username = "duo-fixture";

    private const string Password = "hunter2";

    private const string UsernameBox = "#authentication_username";

    private const string PasswordBox = "#authentication_password";

    private const string Continue = "#submit-button";

    private const string SelfRadio = "#ITFIM_WAYF_IDP_0";

    private const string SmsMethod = "a:has-text('sms-controle')";

    private const string AppMethod = "a:has-text('DigiD app')";

    private static string CodeBox(int i) => $"#smscode_smscode_field_{i}";

    /// <summary>DUO's chooser as a person sees it: a card with a label on it.</summary>
    private const string SelfLabel = "label[for='ITFIM_WAYF_IDP_0']";

    /// <summary>
    /// DigiD's sms path AS A WIZARD, which is what it is.
    /// </summary>
    /// <remarks>
    /// This used to show every screen at once, and that is the fixture shape
    /// this stub was built to replace: its own summary says so, because a flat
    /// page already let an adapter that filled two screens' fields up front
    /// look perfectly correct offline. DUO's sms path is four screens - the
    /// chooser, the method, the credentials, the six boxes - and each one
    /// arrives only when the last has been answered.
    /// <para>
    /// A flat page cannot fail on ORDER, which is all a wizard is: an adapter
    /// that typed the code before submitting the password, or skipped the
    /// chooser entirely, passed either way.
    /// </para>
    /// <para>
    /// <b>And the radio is present-but-unclickable, exactly as DUO serves
    /// it.</b> The options file has said for a while that the label comes first
    /// "because the input is the one that cannot be clicked" - it is styled as
    /// a card with the real input parked off-screen - and no fixture here ever
    /// carried the label at all. Delete both label candidates and every test
    /// still passed, while the live login broke the way it already once did.
    /// </para>
    /// </remarks>
    private static StubLoginPage SmsPage()
    {
        var page = StubLoginPage.Showing(SelfLabel, Continue);

        // Found by Playwright, scrolled to, and never actionable.
        page.Unclickable(SelfRadio);

        var screen = 0;

        page.WhenClicked = (showing, clicked) =>
        {
            // EITHER method is a link that takes DigiD to its credentials
            // screen - the choice is which second factor follows, not whether
            // a password is typed - so both reveal the same two boxes.
            if (clicked == SmsMethod || clicked == AppMethod)
            {
                showing.Reveal(UsernameBox, PasswordBox);
                return;
            }

            if (clicked != Continue) return;

            switch (++screen)
            {
                case 1: showing.Reveal(SmsMethod, AppMethod); break;
                case 2:
                    showing.Reveal(
                        CodeBox(0), CodeBox(1), CodeBox(2), CodeBox(3), CodeBox(4), CodeBox(5));
                    break;
            }
        };

        return page;
    }

    /// <param name="keptProfile">
    /// Whether this job's browser opens onto a profile an earlier run left.
    /// Only then is "are we already inside?" a question with two possible
    /// answers, and only then does <c>SessionProbe</c> ask it.
    /// </param>
    private static FakeJobContext Typing(string code = "123456", bool keptProfile = false) => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = Username,
            ["password"] = Password,
        },
        Answer = _ => code,
        KeepsSession = keptProfile,
    };

    /// <summary>
    /// The whole point of tier two: the human is asked for six digits and
    /// nothing else, and no browser is streamed to them at all.
    /// </summary>
    [Fact]
    public async Task With_both_credentials_stored_the_only_question_is_the_texted_code()
    {
        var page = SmsPage();
        using var ctx = Typing();

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, asked.Type);
        Assert.Equal(6, asked.Length);
        Assert.Equal("sms", asked.Delivery);

        // Nothing streamed. That is the request this tier exists to answer.
        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.LiveView);

        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
    }

    /// <summary>
    /// DUO's own fork comes BEFORE DigiD and is chosen explicitly, because the
    /// other option - "als gemachtigde" - signs in on somebody else's behalf
    /// and would fetch a different person's debt.
    /// </summary>
    [Fact]
    public async Task The_typed_path_says_it_is_signing_in_for_itself()
    {
        var page = SmsPage();
        using var ctx = Typing();

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        // THE LABEL, not the input. DUO styles the chooser as a card and parks
        // the real radio off-screen, so the input is found and never actionable
        // - which is the failure this provider already had live.
        Assert.Contains(SelfLabel, page.Clicked);
        Assert.DoesNotContain(SelfRadio, page.Clicked);
    }

    [Fact]
    public async Task The_six_boxes_are_filled_one_digit_each_in_order()
    {
        var page = SmsPage();
        using var ctx = Typing("478213");

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        // The POST carries one field, but the browser has to type into six.
        Assert.Equal(["4", "7", "8", "2", "1", "3"], Enumerable.Range(0, 6).Select(i => page.Filled[CodeBox(i)]));
    }

    /// <summary>
    /// Checked before a single box is filled. Half a code typed into DigiD's
    /// form is an attempt DigiD counts, and DigiD locks accounts - so a short
    /// or non-numeric answer must never reach the page at all.
    /// </summary>
    [Theory]
    [InlineData("123")]
    [InlineData("12345678")]
    [InlineData("12345a")]
    [InlineData("")]
    public async Task A_code_that_is_not_six_digits_never_touches_digids_form(string code)
    {
        var page = SmsPage();
        using var ctx = Typing(code);

        // Falls back to the stream rather than failing the connect, which is
        // what every tier-two problem does. The watcher lands on the first
        // pass because this context answers challenges immediately, which is a
        // consumer closing the view rather than a human giving up.
        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        Assert.All(Enumerable.Range(0, 6), i => Assert.False(page.Filled.ContainsKey(CodeBox(i))));
        Assert.Contains(ctx.Asked, c => c.Type == ChallengeType.LiveView);
    }

    /// <summary>
    /// A typed sign-in that meets something it does not recognise hands the
    /// page over rather than ending the connect.
    ///
    /// This is what makes the weaker selectors safe to ship. DUO's own chooser
    /// and DigiD's method list were captured by their LABELS rather than their
    /// ids, so a reworded link finds nothing - and finding nothing has to cost
    /// a streamed login, not a failed one.
    /// </summary>
    [Fact]
    public async Task A_typed_sign_in_that_finds_no_password_box_hands_the_page_over()
    {
        // Everything except the password box, which is how a redesigned DigiD
        // form arrives.
        var page = StubLoginPage.Showing(SelfRadio, SmsMethod, UsernameBox, Continue);
        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.Contains(ctx.Notes, n => n.Contains("handed over", StringComparison.Ordinal));
    }

    /// <summary>
    /// AND IT SAYS WHICH STEP MISSED, not only that one did.
    /// </summary>
    /// <remarks>
    /// The owner connected DUO twice on their own machine on 2026-09-28 and the
    /// first attempt landed here. The whole of the evidence was "the typed
    /// sign-in did not complete (ProviderChanged)" - and ProviderChanged covers
    /// DUO's own chooser, DigiD's method list, either credential box, the sign-in
    /// button and all six code boxes, which are entirely different repairs. The
    /// exception already carried the answer; it was being thrown away one line
    /// from the note.
    /// <para>
    /// IT CANNOT CARRY A CREDENTIAL. The message is this adapter's own prose
    /// about its own selectors, built in one place from DuoOptions, and nothing
    /// a typed value reaches is ever put in it - which is asserted here by
    /// spelling the note out in full, so a message that started carrying
    /// anything else would fail rather than merely look longer.
    /// </para>
    /// <para>
    /// The page's own shape rides along, as ASN's pooled adapter attaches to
    /// every ConnectorException it raises. It is worth more here than there: a
    /// hand-over is about to stream this exact page to the account holder, so
    /// the only person a shape could tell anything is already looking at it,
    /// while the operator reading these notes tomorrow is not.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_hand_over_says_which_step_missed_and_what_the_page_was()
    {
        // The method WAS chosen and the credential form is not there, which is
        // the other half of the pair below: a chosen method means the box really
        // is the step that missed, and the note has to say so rather than blame
        // the chooser that worked.
        var page = StubLoginPage.Showing(SelfRadio, SmsMethod, Continue);
        var portal = SignedIn();

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), portal, cts.Token);

        Assert.Equal(
            [
                "duo: the typed sign-in did not complete (ProviderChanged): no element for DigiD's username " +
                "box; tried [#authentication_username, input[name='authentication[username]']]. The page is " +
                "being handed over instead",
                "duo: when that happened, the page was - " + portal.Shape,
            ],
            ctx.Notes);
    }

    /// <summary>
    /// A MISSED METHOD CHOICE IS REPORTED AS THE CHOOSER, never as the username
    /// box standing behind it.
    /// </summary>
    /// <remarks>
    /// STEP 2 COULD NOT FAIL, and that is what made the first note misleading
    /// rather than merely thin. The click on DigiD's "Hoe wilt u inloggen?"
    /// ignored its own result, so a chooser that could not be driven surfaced
    /// two statements later as "DigiD's username box is missing" - which is
    /// true, and points at DigiD's credential form, which was fine. The box is
    /// absent precisely because the page never left the chooser.
    /// <para>
    /// The selectors in the message are what makes this actionable and they are
    /// also the weakest in the file: DigiD's method list was captured by the
    /// words on the control rather than by an id, because the capture recorded
    /// inputs and headings and not every anchor. A reworded link is exactly the
    /// failure this note now describes.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_missed_method_choice_is_reported_as_the_chooser_and_not_as_the_username_box()
    {
        // DUO's fork answered, and then nothing: no method list, and therefore
        // no credential form behind it.
        var page = StubLoginPage.Showing(SelfRadio, Continue);
        var portal = SignedIn();

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), portal, cts.Token);

        Assert.Equal(
            [
                "duo: the typed sign-in did not complete (ProviderChanged): no element for DigiD's method " +
                "choice on \"Hoe wilt u inloggen?\", so the page never left it and the credential form behind " +
                "it does not exist yet; tried [a:has-text('sms-controle'), button:has-text('sms-controle'), " +
                "label:has-text('sms-controle')]. The page is being handed over instead",
                "duo: when that happened, the page was - " + portal.Shape,
            ],
            ctx.Notes);

        // The misdiagnosis this replaces, named so it cannot come back.
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("username box", StringComparison.Ordinal));

        // And it still costs a streamed login rather than a failed connect,
        // which is what makes a label-matched selector safe to ship at all.
        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    /// <summary>
    /// AND A CREDENTIAL FORM THAT ARRIVES WITHOUT A METHOD CHOICE IS STILL
    /// TYPED, which is why the miss is reported rather than thrown.
    /// </summary>
    /// <remarks>
    /// The obvious fix for the test above is to make step 2 a failure outright,
    /// and it would be wrong. DigiD does some of its own routing, and a page
    /// that shows the credential boxes without having asked which method to use
    /// is a page this signs in on today - turning a best-effort step into a
    /// throw would hand that page to a human for no reason and cost them the
    /// six digits they were about to be asked for anyway.
    /// <para>
    /// So the change is to the DIAGNOSIS and never to the path: the click's
    /// answer is carried to the step whose miss it would otherwise be blamed
    /// for, and is only spoken about when that step misses too.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_credential_form_that_arrives_without_a_method_choice_is_still_typed()
    {
        var page = StubLoginPage.Showing(SelfLabel, Continue, UsernameBox, PasswordBox);

        // The chooser as DUO really serves it: a card, with the real input
        // parked off-screen.
        page.Unclickable(SelfRadio);

        var submits = 0;

        page.WhenClicked = (showing, clicked) =>
        {
            // The credential form's own submit is what brings up the six boxes.
            // The first submit is DUO's fork; the method screen never appears.
            if (clicked == Continue && ++submits == 2)
            {
                showing.Reveal(CodeBox(0), CodeBox(1), CodeBox(2), CodeBox(3), CodeBox(4), CodeBox(5));
            }
        };

        using var ctx = Typing("904137");

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        // Nothing streamed and nothing complained about: this is an ordinary
        // tier-two sign-in on a page that asked one question fewer.
        Assert.Equal(ChallengeType.MfaCode, Assert.Single(ctx.Asked).Type);
        Assert.Empty(ctx.Notes);

        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
        Assert.Equal(["9", "0", "4", "1", "3", "7"], Enumerable.Range(0, 6).Select(i => page.Filled[CodeBox(i)]));
    }

    /// <summary>
    /// AND A SHAPE PROBE THAT BLOWS UP COSTS NOTHING, because the hand-over is
    /// the only thing in that catch clause that matters.
    /// </summary>
    /// <remarks>
    /// This tier has already shipped the opposite twice, and both times it
    /// reached the account holder as "This login failed" at the "Signing in"
    /// step - the one outcome the whole tier was built to be incapable of. A
    /// second exception on the way to the fallback takes the fallback with it,
    /// so a diagnostic added to the failure path has to be incapable of
    /// becoming the failure.
    /// </remarks>
    [Fact]
    public async Task A_page_that_cannot_be_described_is_still_handed_over()
    {
        var page = StubLoginPage.Showing(SelfRadio, SmsMethod, UsernameBox, Continue);
        var portal = SignedIn();

        portal.DescribeThrows = new InvalidOperationException("the probe itself broke");

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), portal, cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        Assert.Equal(
            "duo: when that happened, the page was - it could not be read (InvalidOperationException)",
            ctx.Notes[1]);
    }

    /// <summary>
    /// A step the browser FINDS but cannot click hands the page over too.
    ///
    /// This is the one that failed live, and it failed in the worst way: "This
    /// login failed", at the "Signing in" step, on the tier whose entire
    /// promise is that it cannot do that. DUO styles its sign-in chooser as
    /// cards and parks the real radio off-screen, so Playwright found the
    /// input, scrolled to it, reported "element is outside of the viewport"
    /// and retried until it timed out - and a TimeoutException is not a
    /// ConnectorException, so the hand-over above never saw it.
    /// </summary>
    [Fact]
    public async Task A_step_the_browser_cannot_click_hands_the_page_over()
    {
        var page = SmsPage();

        // BOTH OF THEM, because the fixture already parks the input off-screen
        // the way DUO does - so with only the input unreachable this is now an
        // ordinary login that clicks the label and works. What this test is
        // about is a chooser that cannot be driven at all.
        page.Unclickable(SelfLabel, SelfRadio);

        var portal = SignedIn();

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), portal, cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        // AND THE PAGE'S SHAPE COMES WITH IT, on this route as much as on the
        // one below. It is worth more here: a ConnectorException names the step
        // it gave up on, and a browser that merely could not perform a click
        // names an exception type. "TimeoutException" on its own has sent two
        // diagnoses at this provider to the wrong page.
        Assert.Equal(
            [
                "duo: the browser could not drive a step of the typed sign-in (TimeoutException), so the page " +
                "is being handed over instead",
                "duo: when that happened, the page was - " + portal.Shape,
            ],
            ctx.Notes);
    }

    /// <summary>
    /// And the hand-over clears the password out of DigiD's form first.
    ///
    /// Version 1 deliberately did not clear, and was right not to: nothing was
    /// ever typed. Tier two types a DigiD password, and the still-capture path
    /// refuses to photograph a page while a password box holds content - so
    /// without this the hand-over would relay nothing at all.
    /// </summary>
    [Fact]
    public async Task The_hand_over_clears_the_password_out_of_digids_form()
    {
        var page = StubLoginPage.Showing(SelfRadio, SmsMethod, UsernameBox, Continue);
        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.False(page.HoldsSecret);
    }

    /// <summary>
    /// Half a credential is the same answer as none. There is nothing useful to
    /// type, and posting a lone username at DigiD - which counts failures - is
    /// worse than not trying.
    /// </summary>
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(false, false)]
    public async Task Without_both_credentials_the_page_is_streamed_and_nothing_is_typed(
        bool hasUsername, bool hasPassword)
    {
        var page = SmsPage();

        var inputs = new Dictionary<string, string>(StringComparer.Ordinal);
        if (hasUsername) inputs["username"] = Username;
        if (hasPassword) inputs["password"] = Password;

        using var ctx = new FakeJobContext { Inputs = inputs, AnswersNothing = true };
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.Empty(page.Filled);
    }

    /// <summary>
    /// The app method types the credentials and then hands over, because what
    /// is left is a code on a phone and a QR to scan - the human's own work, on
    /// their own screen.
    /// </summary>
    /// <summary>
    /// DigiD asks a second question on the app path - this device or another -
    /// and the answer is always another.
    ///
    /// Reported after a working QR sign-in: choosing the app still left one
    /// screen to click through by hand. There is no DigiD app in the agent's
    /// browser, and the QR exists precisely to reach a phone that is elsewhere,
    /// so there is nothing for a human to decide here.
    /// </summary>
    [Fact]
    public async Task The_app_path_says_the_phone_is_somewhere_else()
    {
        const string OtherDevice = "label:has-text('ander mobiel apparaat')";

        var page = SmsPage();
        page.Reveal(OtherDevice);
        page.Carrying(QrImage, "src", Png);

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["method"] = "app" },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.Contains(OtherDevice, page.Clicked);
    }

    /// <summary>
    /// And the sms path never sees that screen, so it must never click it -
    /// the selectors match on words, and words move between pages.
    /// </summary>
    [Fact]
    public async Task The_sms_path_never_answers_a_question_it_was_not_asked()
    {
        const string OtherDevice = "label:has-text('ander mobiel apparaat')";

        var page = SmsPage();
        page.Reveal(OtherDevice);

        using var ctx = Typing();

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        Assert.DoesNotContain(OtherDevice, page.Clicked);
    }

    [Fact]
    public async Task The_app_method_types_the_credentials_and_then_streams_for_the_qr()
    {
        var page = SmsPage();
        page.Carrying(QrImage, "src", Png);

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = Username,
                ["password"] = Password,
            },
            Config = new Dictionary<string, string>(StringComparer.Ordinal) { ["method"] = "app" },
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.Equal(Username, page.Filled[UsernameBox]);

        // No code was asked for - the app path has none to type - and the QR
        // was relayed.
        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.MfaCode);
        Assert.Contains(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
    }

    // ---- where it starts ----------------------------------------------------

    /// <summary>
    /// The protected page, and DUO's own redirects from there - never DigiD's
    /// entry URL. Hand-crafting an identity provider's start address is how a
    /// login succeeds at the IdP and leaves the site signed out, which bol.com
    /// taught this codebase once and Coolblue taught it again.
    /// </summary>
    [Fact]
    public async Task The_login_starts_at_duos_own_protected_page()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.Equal(["https://mijn.duo.nl/"], page.Visited);
        Assert.DoesNotContain(page.Visited, url => url.Contains("digid", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Nothing_is_ever_typed_or_pressed_by_this_connector()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        // The whole custody claim, in two assertions. A DigiD username and
        // password go into login.digid.nl's own form, typed by the only person
        // who should ever type them.
        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);
    }

    [Fact]
    public async Task The_page_is_streamed_and_landing_on_the_portal_ends_it()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        var result = await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        // The cookie jar IS the session - the SAML round trip ends with a
        // cookie and hands the browser no token worth storing - so a login
        // that did not carry it out would say "Connected" and leave every
        // fetch signed out.
        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("DUO", result.Account!.DisplayName);
    }

    /// <summary>
    /// Latched before the human touches anything, because after this point a
    /// lost lease must fail the job rather than requeue it: a requeued DigiD
    /// login is a second authentication attempt against an account whose
    /// failures Logius counts.
    /// </summary>
    [Fact]
    public async Task The_attempt_is_latched_before_anyone_types_into_digid()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_sign_in_that_never_reaches_the_portal_is_blocked()
    {
        var page = Page();

        // Answers immediately, which is a consumer closing the live view: the
        // human gave up, or never started.
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 99), SignedIn(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    /// <summary>
    /// The account holder's own name is right there in DUO's
    /// <c>profielklantmenu</c>, beside a persoonsId and a date of birth. A
    /// label on a connection card is not worth reading any of that for.
    /// </summary>
    [Fact]
    public async Task The_connection_is_labelled_with_the_provider_and_never_the_person()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        var result = await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 1), SignedIn(), cts.Token);

        Assert.Null(result.Account!.ExternalId);
        Assert.Equal(Now.AddSeconds(900), result.ExpiresAt);
    }

    // ---- the QR -------------------------------------------------------------

    /// <summary>
    /// What the second live capture was run to settle.
    ///
    /// DigiD draws its login QR as a 196x196 PNG inline in the markup, so the
    /// exact bytes it generated are already in the DOM. Relaying those is
    /// lossless by construction - which matters because the live view's own
    /// JPEG stream fails to decode roughly 1.5% of QR codes, the worst
    /// possible rate because it works almost always.
    /// </summary>
    [Fact]
    public async Task A_qr_is_relayed_as_the_bytes_digid_drew()
    {
        var page = Page();
        page.Carrying(QrImage, "src", Png);
        page.Carrying(QrBlock, "data-code", Payload);

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        var qr = Assert.Single(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);

        // Decoded, not re-encoded. The first eight bytes are a PNG's magic
        // number, so what left here is a picture and not a base64 string
        // somebody has to work out what to do with.
        Assert.NotNull(qr.Image);
        Assert.Equal([0x89, 0x50, 0x4E, 0x47], qr.Image!.Take(4));

        // And the payload the picture encodes, verbatim, so a consumer running
        // ON the phone can offer a tap - nobody can photograph the screen they
        // are reading the QR from.
        Assert.Equal(Payload, qr.Url);
    }

    /// <summary>
    /// The trap, and the reason the selector is anchored on <c>data:image</c>.
    ///
    /// There are three images in DigiD's QR block and only one is the code: its
    /// own 44x44 logo is FIRST, a remote copy sits inside a noscript, and a
    /// hidden canvas is where the code is drawn. Relaying the wrong one sends a
    /// DigiD logo to somebody's phone and then waits out the whole login on a
    /// scan that cannot happen - silently, because a picture did arrive.
    /// </summary>
    [Fact]
    public async Task A_remote_image_is_never_relayed_as_a_qr()
    {
        var page = Page();
        page.Carrying(QrImage, "src", "/assets/digid_eo_rgb-820f0a1b.svg");

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);

        // Refused out loud. A QR that quietly never arrives is a login that
        // hangs for no stated reason.
        Assert.Contains(ctx.Notes, n => n.Contains("not an inline image", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_data_url_that_will_not_decode_is_refused_rather_than_relayed()
    {
        var page = Page();
        page.Carrying(QrImage, "src", "data:image/png;base64,not-base64-at-all!!");

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
        Assert.Contains(ctx.Notes, n => n.Contains("would not decode", StringComparison.Ordinal));
    }

    /// <summary>
    /// A data url does not have to be base64: it may carry its payload as
    /// literal text, and only the <c>;base64</c> marker says which it is.
    /// </summary>
    /// <remarks>
    /// The payload below is deliberately VALID base64 - it is the same 1x1
    /// image, with the marker taken off. A malformed string would prove
    /// nothing here, because the decoder would refuse it whether or not the
    /// marker was checked; this one decodes happily, so without the check
    /// something that was never a picture is relayed as one.
    /// </remarks>
    [Fact]
    public async Task A_data_url_that_is_not_base64_is_never_decoded_as_though_it_were()
    {
        var page = Page();
        page.Carrying(QrImage, "src", Png.Replace(";base64,", ",", StringComparison.Ordinal));

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
        Assert.Contains(ctx.Notes, n => n.Contains("would not decode", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_same_qr_is_relayed_once_however_many_times_it_is_seen()
    {
        var page = Page();
        page.Carrying(QrImage, "src", Png);

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        // Five passes of the watch loop before the sign-in lands.
        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 5), SignedIn(), cts.Token);

        Assert.Single(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
    }

    /// <summary>
    /// Whether DigiD expires or rotates its QR is UNKNOWN - the captured
    /// session went from code to scan in about six seconds and nothing
    /// refreshed in that window. So the image is re-read every pass and relayed
    /// again when it changes: re-reading an unchanged QR costs nothing, and
    /// handing somebody a stale picture costs them the login.
    /// </summary>
    [Fact]
    public async Task A_replaced_qr_is_relayed_again()
    {
        var page = Page();
        page.Carrying(QrImage, "src", Png);

        const string Second =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        // Swapped on the SECOND pass, so the first QR has already been relayed
        // when the page changes underneath - which is what a rotation looks
        // like from here. Swapping on the first pass would only ever prove the
        // second image can be relayed once.
        var passes = 0;
        var watcher = new StubSignedInThen(Portal, 4, () =>
        {
            if (++passes == 2) page.Carrying(QrImage, "src", Second);
        });

        await Adapter().LoginAsync(ctx, page, watcher, SignedIn(), cts.Token);

        var relayed = ctx.Asked.Where(c => c.Type == ChallengeType.QrDisplay).ToList();

        Assert.Equal(2, relayed.Count);
        Assert.NotEqual(relayed[0].Image, relayed[1].Image);
    }

    [Fact]
    public async Task A_sign_in_with_no_qr_on_screen_relays_none()
    {
        var page = Page();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 3), SignedIn(), cts.Token);

        // The sms path, and every screen of the app path before the QR. It is
        // also what a page that cannot read attributes says at all, which
        // degrades to the streamed relay rather than to a broken login.
        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    // ---- what counts as signed in -------------------------------------------

    /// <summary>
    /// What counts as signed in, and the two guards around it.
    ///
    /// DUO's SAML entry point is ON mijn.duo.nl and carries the dashboard's own
    /// address inside it as <c>Target=</c>, so the first url of the login chain
    /// very nearly reads as success. It escapes on one detail - DUO writes
    /// <c>mijn.duo.nl:443</c> and the marker has no port - which is an accident
    /// rather than a defence, and the row below without the port is what makes
    /// the guard load-bearing.
    ///
    /// A login reported as finished before DigiD has even been reached seals a
    /// session that is not one: it says "Connected" and then fails on every
    /// fetch.
    /// </summary>
    [Theory]

    // OBSERVED, exactly as captured on 2026-08-10.
    [InlineData(
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?NameIdFormat=Transient" +
        "&Target=https://mijn.duo.nl:443/particulier/portaal/dashboard&ForceAuthn=true",
        false)]

    // CONSTRUCTED: the same url with the default port left off, which is how
    // most SAML deployments write one and is a configuration change away.
    // WITHOUT this row the /isam/ guard is an equivalent mutant - every
    // observed url is decided before it is reached, because ":443" alone keeps
    // the portal marker from matching. Removing it here would leave the guard
    // looking like dead code to whoever reads only the capture.
    [InlineData(
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?NameIdFormat=Transient" +
        "&Target=https://mijn.duo.nl/particulier/portaal/dashboard&ForceAuthn=true",
        false)]
    [InlineData("https://login.digid.nl/inloggen", false)]
    [InlineData("https://login.digid.nl/inloggen_app_qr?utf8=x", false)]

    // CONSTRUCTED, and labelled so rather than dressed up as a capture. Both
    // sessions were searched and not one DigiD url mentions duo at all, so
    // this shape has never been observed - it is what a SAML RelayState
    // carrying its target would look like, which is the case the host clause
    // of the watcher exists for. Without this row that clause is an equivalent
    // mutant: every other row here is decided before it is reached.
    [InlineData(
        "https://login.digid.nl/saml/v4/idp/redirect_with_artifact" +
        "?RelayState=https://mijn.duo.nl/particulier/portaal/dashboard",
        false)]
    [InlineData("https://mijn.duo.nl/", false)]
    [InlineData("https://mijn.duo.nl/particulier/portaal/dashboard", true)]
    [InlineData("https://mijn.duo.nl/particulier/portaal/klantportaal/klantportaal/mijn.html#/mijn-schulden", true)]
    [InlineData(null, false)]
    [InlineData("", false)]
    public void Only_a_portal_page_outside_the_login_chain_counts_as_signed_in(string? url, bool signedIn)
    {
        Assert.Equal(signedIn, DuoSignedInWatcher.SignedIn(url, Options));
    }
}

/// <summary>
/// Reports the sign-in as landed after a stated number of checks, running a
/// hook on every check before that - so a test can change the page underneath
/// a running login.
/// </summary>
internal sealed class StubSignedInThen(string? url, int afterWaits, Action onWait) : IRedirectWaiter
{
    private int _waits;

    public Task<string?> WaitAsync(TimeSpan patience, CancellationToken ct)
    {
        if (_waits++ >= afterWaits) return Task.FromResult(url);

        onWait();
        return Task.FromResult<string?>(null);
    }
}
