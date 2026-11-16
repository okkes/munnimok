using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// ForceAuthn=true and a remote_browser flow (no manifest fields): nothing is typed or stored by this connector.
// the tests cover where login starts, what ends it, and the QR relay
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

    private static FakeJobContext Streaming() => new() { AnswersNothing = true };

    private static StubDuoPortal SignedIn() => StubDuoPortal.Answering();

    // opening mijn.duo.nl redirects to the dashboard before bouncing into SAML, so the first poll sees a portal address
    // belonging to nobody (finished 80 ms in); the url cannot decide, so DUO is asked
    [Fact]
    public async Task Sitting_on_the_portal_url_is_not_a_finished_login()
    {
        var page = Page();
        var portal = StubDuoPortal.WithNoSession();

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);

        Assert.Contains(portal.Requested, u => u.EndsWith("sessietoken/rest/jwt", StringComparison.Ordinal));
    }

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

    // DUO is not asked while the url is still in the login chain: about two calls per sign-in, not one per poll
    [Fact]
    public async Task Duo_is_not_asked_about_a_session_while_the_url_is_still_digids()
    {
        var page = Page();
        var portal = SignedIn();
        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

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

    // a kept browser profile still holds DUO's session (15 min inactivity, cookies); ForceAuthn binds a started
    // authentication and opening a page starts none: why this provider is pinned to a local agent

    // typed context (stored credentials): a check placed after reading them would still drive the chooser and DigiD's form
    [Fact]
    public async Task A_profile_still_inside_duo_connects_without_asking_anything()
    {
        var page = Page();
        var portal = StubDuoPortal.Inside();
        using var ctx = Typing(keptProfile: true);

        var result = await Adapter()
            .LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);

        Assert.Equal(["https://mijn.duo.nl/"], page.Visited);

        // the cookie jar is the session: a connect carrying no jar says "Connected" and leaves every fetch signed out
        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("DUO", result.Account!.DisplayName);
        Assert.Equal(Now.AddSeconds(900), result.ExpiresAt);

        Assert.Equal([JobStep.OpeningProvider, JobStep.Finalizing], ctx.Steps);

        Assert.Contains(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // DUO itself said so: the address cannot, the portal address appears before the bounce
        Assert.Equal(
            "https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt",
            Assert.Single(portal.Requested));

        // exactly the option's window, the only thing between "still inside" and the address a bouncing browser sits on
        Assert.Equal(TimeSpan.FromSeconds(Options.SignedOutBounceSeconds), Assert.Single(portal.Waited));
    }

    // no latch: a requeued DigiD login is a second attempt Logius counts, and this connect made none
    // (EfLeasedJobQueue.RequeueExpiredLeasesAsync)
    [Fact]
    public async Task A_connect_that_asked_for_nothing_latches_no_attempt()
    {
        var page = Page();
        using var ctx = Typing(keptProfile: true);

        await Adapter()
            .LoginAsync(ctx, page, new StubSignedIn(Portal, 0), StubDuoPortal.Inside(), CancellationToken.None);

        Assert.False(ctx.CredentialWasSubmitted);
    }

    // nothing kept, nothing restored: SessionProbe answers "cannot tell" unasked,
    // saving the SignedOutBounceSeconds window on every first connect
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

    [Fact]
    public async Task A_profile_that_is_bounced_to_digid_signs_in_and_is_latched()
    {
        var page = SmsPage();
        var portal = SignedIn();
        portal.BouncesAfter = TimeSpan.FromSeconds(3);

        Assert.True(portal.BouncesAfter < TimeSpan.FromSeconds(Options.SignedOutBounceSeconds));

        using var ctx = Typing(keptProfile: true);

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), portal, CancellationToken.None);

        Assert.True(ctx.CredentialWasSubmitted);
        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(ChallengeType.MfaCode, Assert.Single(ctx.Asked).Type);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // a browser already bounced to DigiD is signed out: asking would be answered from inside SAML
        // and read as a session that just died
        Assert.Single(portal.Requested);
    }

    // ten seconds was never measured; a slow bounce is handed to DUO's session endpoint, which an address cannot fool,
    // and the window only saves that call
    [Fact]
    public async Task A_bounce_slower_than_the_window_leaves_the_answer_to_duo_itself()
    {
        var portal = StubDuoPortal.WithNoSession();
        portal.BouncesAfter = TimeSpan.FromSeconds(20);

        Assert.True(TimeSpan.FromSeconds(Options.SignedOutBounceSeconds) < TimeSpan.FromSeconds(20));

        using var ctx = Watching(keptProfile: true);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, Page(), new StubSignedIn(Portal, 0), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still inside DUO", StringComparison.Ordinal));

        // twice: the check's and the streamed loop's
        Assert.Equal(2, portal.Requested.Count);

        // said in the notes: waiting, then streaming DigiD with no stated reason, reads as a bug
        Assert.Contains(ctx.Notes, n => n.Contains("named no profile", StringComparison.Ordinal));

        var patient = StubDuoPortal.WithNoSession();
        patient.BouncesAfter = TimeSpan.FromSeconds(20);

        using var waiting = Watching(keptProfile: true);

        await Assert.ThrowsAsync<ConnectorException>(
            () => new DuoAdapter(Options with { SignedOutBounceSeconds = 25 }, new FixedTimeProvider(Now))
                .LoginAsync(waiting, Page(), new StubSignedIn(Portal, 0), patient, CancellationToken.None));

        Assert.Single(patient.Requested);
        Assert.DoesNotContain(waiting.Notes, n => n.Contains("named no profile", StringComparison.Ordinal));
    }

    // the immediate answer bounds the watch loop to one pass: its own deadline never arrives under a clock that does not move
    private static FakeJobContext Watching(bool keptProfile = false) => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal),
        KeepsSession = keptProfile,
    };

    private const string Username = "duo-fixture";

    private const string Password = "hunter2";

    private const string UsernameBox = "#authentication_username";

    private const string PasswordBox = "#authentication_password";

    private const string Continue = "#submit-button";

    private const string SelfRadio = "#ITFIM_WAYF_IDP_0";

    private const string SmsMethod = "a:has-text('sms-controle')";

    private const string AppMethod = "a:has-text('DigiD app')";

    private static string CodeBox(int i) => $"#smscode_smscode_field_{i}";

    private const string SelfLabel = "label[for='ITFIM_WAYF_IDP_0']";

    // a wizard (chooser, method, credentials, six boxes): a flat page cannot fail on order. The radio is present but
    // unclickable as DUO serves it (card styled, input off-screen), so the label comes first
    private static StubLoginPage SmsPage()
    {
        var page = StubLoginPage.Showing(SelfLabel, Continue);

        page.Unclickable(SelfRadio);

        var screen = 0;

        page.WhenClicked = (showing, clicked) =>
        {
            // either method leads to the credentials screen; the choice is only which second factor follows
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

    // keptProfile: the browser opens onto a profile an earlier run left; only then does SessionProbe ask
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

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.LiveView);

        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
    }

    // DUO's own fork is chosen explicitly: "als gemachtigde" signs in for somebody else and would fetch their debt
    [Fact]
    public async Task The_typed_path_says_it_is_signing_in_for_itself()
    {
        var page = SmsPage();
        using var ctx = Typing();

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        // the label, not the input: DUO parks the real radio off-screen, found but never actionable (failed live)
        Assert.Contains(SelfLabel, page.Clicked);
        Assert.DoesNotContain(SelfRadio, page.Clicked);
    }

    [Fact]
    public async Task The_six_boxes_are_filled_one_digit_each_in_order()
    {
        var page = SmsPage();
        using var ctx = Typing("478213");

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        // the POST carries one field but the browser types into six
        Assert.Equal(["4", "7", "8", "2", "1", "3"], Enumerable.Range(0, 6).Select(i => page.Filled[CodeBox(i)]));
    }

    // checked before any box is filled: half a code is a DigiD attempt, and DigiD locks accounts
    [Theory]
    [InlineData("123")]
    [InlineData("12345678")]
    [InlineData("12345a")]
    [InlineData("")]
    public async Task A_code_that_is_not_six_digits_never_touches_digids_form(string code)
    {
        var page = SmsPage();
        using var ctx = Typing(code);

        // falls back to the stream, as every tier-two problem does
        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        Assert.All(Enumerable.Range(0, 6), i => Assert.False(page.Filled.ContainsKey(CodeBox(i))));
        Assert.Contains(ctx.Asked, c => c.Type == ChallengeType.LiveView);
    }

    // label-matched selectors are safe to ship: finding nothing costs a streamed login, not a failed one
    [Fact]
    public async Task A_typed_sign_in_that_finds_no_password_box_hands_the_page_over()
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

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.Contains(ctx.Notes, n => n.Contains("handed over", StringComparison.Ordinal));
    }

    // says which step missed (ProviderChanged covers many different repairs).
    // the message is the adapter's own prose, never a typed value
    [Fact]
    public async Task The_hand_over_says_which_step_missed_and_what_the_page_was()
    {
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

    // a missed method choice is reported as the chooser: its click result was ignored, so it surfaced as a missing username box
    [Fact]
    public async Task A_missed_method_choice_is_reported_as_the_chooser_and_not_as_the_username_box()
    {
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

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("username box", StringComparison.Ordinal));

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    // a credential form without a method choice is still typed (DigiD routes some itself), so the miss is reported, not thrown
    [Fact]
    public async Task A_credential_form_that_arrives_without_a_method_choice_is_still_typed()
    {
        var page = StubLoginPage.Showing(SelfLabel, Continue, UsernameBox, PasswordBox);

        page.Unclickable(SelfRadio);

        var submits = 0;

        page.WhenClicked = (showing, clicked) =>
        {
            if (clicked == Continue && ++submits == 2)
            {
                showing.Reveal(CodeBox(0), CodeBox(1), CodeBox(2), CodeBox(3), CodeBox(4), CodeBox(5));
            }
        };

        using var ctx = Typing("904137");

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), SignedIn(), CancellationToken.None);

        Assert.Equal(ChallengeType.MfaCode, Assert.Single(ctx.Asked).Type);
        Assert.Empty(ctx.Notes);

        Assert.Equal(Username, page.Filled[UsernameBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
        Assert.Equal(["9", "0", "4", "1", "3", "7"], Enumerable.Range(0, 6).Select(i => page.Filled[CodeBox(i)]));
    }

    // a diagnostic on the failure path must not become the failure:
    // an exception escaping there shipped twice as "This login failed"
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

    // a found-but-unclickable step: Playwright times out, and a TimeoutException is no ConnectorException, so the
    // hand-over never saw it and it failed live as "This login failed"
    [Fact]
    public async Task A_step_the_browser_cannot_click_hands_the_page_over()
    {
        var page = SmsPage();

        // both unreachable: with only the input unreachable the label click works
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

        // the page shape rides along: "TimeoutException" alone sent diagnoses to the wrong page
        Assert.Equal(
            [
                "duo: the browser could not drive a step of the typed sign-in (TimeoutException), so the page " +
                "is being handed over instead",
                "duo: when that happened, the page was - " + portal.Shape,
            ],
            ctx.Notes);
    }

    // the hand-over clears the typed password: the still-capture refuses a page whose password box holds content
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

    // half a credential is none: posting a lone username at DigiD, which counts failures, is worse than not trying
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

    // the app method types credentials, then hands over (phone code and QR are the human's).
    // DigiD's this-device-or-another screen always gets "another": the agent's browser has no DigiD app
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

    // the sms path never sees that screen and must not click it: selectors match words, and words move
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

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.MfaCode);
        Assert.Contains(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
    }

    // start at DUO's protected page, never DigiD's entry URL: a hand-crafted IdP start signs in at the IdP
    // and leaves the site signed out (bol.com, Coolblue)
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

        // the SAML round trip ends with a cookie, no token: a login not carrying the jar says "Connected"
        // and leaves fetches signed out
        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("DUO", result.Account!.DisplayName);
    }

    // latched before the human touches anything: a requeued DigiD login is a second attempt Logius counts
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

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 99), SignedIn(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    // the name sits in profielklantmenu beside a persoonsId and date of birth: not read for a connection label
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

    // DigiD's QR is an inline 196x196 PNG, so relaying its bytes is lossless.
    // the live view's JPEG stream fails to decode ~1.5% of QR codes
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

        Assert.NotNull(qr.Image);
        Assert.Equal([0x89, 0x50, 0x4E, 0x47], qr.Image!.Take(4));

        // the payload verbatim, so a consumer running on the phone can offer a tap
        Assert.Equal(Payload, qr.Url);
    }

    // the QR block holds three images: DigiD's own 44x44 logo FIRST, a remote noscript copy, a hidden canvas.
    // the wrong one waits out the login silently
    [Fact]
    public async Task A_remote_image_is_never_relayed_as_a_qr()
    {
        var page = Page();
        page.Carrying(QrImage, "src", "/assets/digid_eo_rgb-820f0a1b.svg");

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 2), SignedIn(), cts.Token);

        Assert.DoesNotContain(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);

        // refused out loud: a QR that quietly never arrives hangs the login for no stated reason
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

    // the payload is valid base64 minus the marker: a malformed string would prove nothing, the decoder refuses it anyway
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

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 5), SignedIn(), cts.Token);

        Assert.Single(ctx.Asked, c => c.Type == ChallengeType.QrDisplay);
    }

    // whether DigiD rotates its QR is unknown (captured session: ~6 s, no refresh): re-read every pass, relay again on change
    [Fact]
    public async Task A_replaced_qr_is_relayed_again()
    {
        var page = Page();
        page.Carrying(QrImage, "src", Png);

        const string Second =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

        using var ctx = Streaming();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        // swapped on the second pass, after the first was relayed: that is what a rotation looks like
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

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
    }

    // DUO's SAML entry is on mijn.duo.nl and carries the dashboard as Target=; it escapes only by the ":443" port, an
    // accident, so the row without the port is what makes the guard load-bearing
    [Theory]

    // observed as captured on 2026-08-10
    [InlineData(
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?NameIdFormat=Transient" +
        "&Target=https://mijn.duo.nl:443/particulier/portaal/dashboard&ForceAuthn=true",
        false)]

    // constructed: the same url without the default port; without this row the /isam/ guard is an equivalent mutant,
    // since ":443" alone keeps the portal marker from matching
    [InlineData(
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?NameIdFormat=Transient" +
        "&Target=https://mijn.duo.nl/particulier/portaal/dashboard&ForceAuthn=true",
        false)]
    [InlineData("https://login.digid.nl/inloggen", false)]
    [InlineData("https://login.digid.nl/inloggen_app_qr?utf8=x", false)]

    // constructed, never observed (no DigiD url mentions duo): what a SAML RelayState carrying its target would look like.
    // without it the watcher's host clause is an equivalent mutant
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
