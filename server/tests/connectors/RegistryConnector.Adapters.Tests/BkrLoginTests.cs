using Connector.Kit.Challenges;
using RegistryConnector.Adapters.Bkr;
using RegistryConnector.Adapters.Support;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// BKR's sign-in, driven offline through the page seam.
///
/// Three tiers, decided only by what the user chose to store - and a wizard
/// underneath all of them. The wizard is the part that failed live: BKR asks
/// for the e-mail, then "Start inzage", then the password on a second screen,
/// so the password box does not exist when the first one is on show. The
/// first version of this adapter filled both up front and passed every
/// offline test, because the stub it was tested against showed every box at
/// once. The stub here does not.
/// </summary>
public sealed class BkrLoginTests
{
    private const string Email = "someone@example.test";
    private const string Password = "hunter2";

    /// <summary>A valid base32 secret. Not anybody's.</summary>
    private const string Seed = "JBSWY3DPEHPK3PXP";

    private static readonly DateTimeOffset Now = new(2026, 8, 5, 9, 0, 0, TimeSpan.Zero);

    private static readonly BkrOptions Options = new();

    private static readonly string EmailBox = Options.UsernameSelectors[0];
    private static readonly string PasswordBox = Options.PasswordSelectors[0];
    private static readonly string Submit = Options.SubmitSelectors[0];
    private static readonly string CodeBox = Options.CodeSelectors[0];
    private static readonly string CodeSubmit = Options.CodeSubmitSelectors[0];

    private static BkrAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    /// <summary>
    /// BKR's real page: the e-mail box and one button. The password box and
    /// then the code box arrive only as the wizard advances.
    /// </summary>
    private static StubLoginPage Wizard()
    {
        var page = StubLoginPage.Showing(EmailBox, Submit);

        page.WhenClicked = (p, _) =>
        {
            if (!p.Filled.ContainsKey(PasswordBox)) p.Reveal(PasswordBox);
            else p.Reveal(CodeBox, CodeSubmit);
        };

        return page;
    }

    // ---- tier three: everything stored --------------------------------------

    [Fact]
    public async Task With_a_seed_the_whole_sign_in_happens_without_asking_anybody()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(seed: Seed),
        };

        await Adapter().LoginAsync(ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 0),
            CancellationToken.None);

        // Nobody was disturbed. That is the entire point of storing the seed,
        // and it is the assertion that would break if the code were still
        // being relayed.
        Assert.Empty(ctx.Asked);

        Assert.Equal(Email, page.Filled[EmailBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);

        // Six digits, computed here from the seed and the clock.
        var code = Assert.Contains(CodeBox, (IDictionary<string, string>)page.Filled);
        Assert.Equal(6, code.Length);
        Assert.All(code, c => Assert.InRange(c, '0', '9'));
        Assert.Equal(Totp.Generate(Totp.FromBase32(Seed), Now), code);
    }

    /// <summary>
    /// The wizard, which is what the live page does and what a stub showing
    /// every box at once hides. Two clicks on the same button: "Start inzage"
    /// and then "Inloggen".
    /// </summary>
    [Fact]
    public async Task The_email_and_the_password_are_submitted_on_separate_screens()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed) };

        await Adapter().LoginAsync(ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 0),
            CancellationToken.None);

        // The same id both times - BKR relabels it and does not rename it.
        Assert.Equal([Submit, Submit, CodeSubmit], page.Clicked);
    }

    // ---- tier two: credentials but no seed ----------------------------------

    [Fact]
    public async Task Without_a_seed_the_six_digits_are_asked_for_rather_than_streamed()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(seed: null),
            Answer = _ => "424242",
        };

        await Adapter().LoginAsync(ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 0),
            CancellationToken.None);

        // A code box is a question the challenge protocol carries well, and
        // streaming a whole browser to type six digits would be the worse
        // experience.
        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, asked.Type);
        Assert.Equal(6, asked.Length);

        Assert.Equal("424242", page.Filled[CodeBox]);
    }

    // ---- tier one: nothing stored -------------------------------------------

    [Theory]
    [InlineData(null, Password)]
    [InlineData(Email, null)]
    [InlineData(null, null)]
    public async Task Without_both_credentials_the_page_is_streamed_and_nothing_is_typed(
        string? username, string? password)
    {
        var page = Wizard();
        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(username, password, seed: null),
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 1),
            cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);

        // Half a credential is the same answer as none: there is nothing this
        // adapter can usefully type, and posting a lone e-mail at a page that
        // may be counting attempts is worse than not trying.
        Assert.Empty(page.Filled);

        // And the page holds no secret before it is photographed.
        Assert.False(page.HoldsSecret);
    }

    /// <summary>
    /// A typed sign-in that fails hands the browser over rather than ending
    /// the connect. The page moving, the register refusing us, a computed code
    /// rejected by a drifted clock - all of them are answerable by the person
    /// sitting there.
    /// </summary>
    [Fact]
    public async Task A_typed_sign_in_that_fails_hands_the_page_over()
    {
        // The password box never appears, so the wizard cannot be walked.
        var page = StubLoginPage.Showing(EmailBox, Submit);

        using var ctx = new FakeJobContext
        {
            Inputs = Credentials(seed: Seed),
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        await Adapter().LoginAsync(ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 1),
            cts.Token);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.False(page.HoldsSecret);
    }

    /// <summary>
    /// The bug that made a working login useless.
    ///
    /// BKR's session is a cookie - B2C hands the portal an id_token by
    /// form_post and the browser is never given a token to store instead - so
    /// a LoginResult carrying only a device id says "Connected", mints a real
    /// bundle, and leaves every fetch to open a fresh browser with no cookies,
    /// land on the sign-in page, and report the portal as rebuilt.
    /// </summary>
    [Fact]
    public async Task The_cookie_jar_leaves_with_the_login_because_it_is_the_session()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed) };

        var result = await Adapter().LoginAsync(
            ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 0), CancellationToken.None);

        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
    }

    /// <summary>
    /// And the streamed path carries it too - somebody who signed in on the
    /// page in front of them has exactly the same session as somebody whose
    /// password was typed for them.
    /// </summary>
    [Fact]
    public async Task A_streamed_sign_in_carries_the_same_jar()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal),
            AnswersNothing = true,
        };

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));

        var result = await Adapter().LoginAsync(
            ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 1), cts.Token);

        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
    }

    // ---- a browser the portal is still letting in ---------------------------
    //
    // BKR's policy is B2C_1A_SignUp_SignIn_SmsOrTotp and it asks for a second
    // factor EVERY time: there is no refresh token, so until now every sync a
    // user ever made cost them a password and six digits. On an agent that
    // keeps a browser profile the portal's own cookie is still in it, and a
    // connect made while it lives asks for neither.

    private const string Portal = "https://portaal.mijnkredietregistratie.nl/";

    private const string B2C = "https://login.mijnkredietregistratie.nl/bkrconsp.onmicrosoft.com/oauth2/v2.0/authorize";

    /// <summary>
    /// The adapter with timers that do not wait, so the bounce window runs at
    /// its SHIPPED length rather than at one a test shortened to stay quick.
    /// </summary>
    private static BkrAdapter Patient() => new(Options, new InstantTimeProvider(Now));

    /// <summary>
    /// THE PAYOFF, as a test: a browser the portal still knows signs nobody in
    /// again.
    /// </summary>
    /// <remarks>
    /// The page here is the full wizard - the e-mail box and the button are on
    /// it, and the credentials are stored - so a check placed after the inputs
    /// were read would still type at B2C and would still be caught below. What
    /// must happen is that none of it is reached.
    /// </remarks>
    [Fact]
    public async Task A_browser_still_inside_the_portal_is_not_signed_in_again()
    {
        var page = Wizard();
        page.Url = Portal;

        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed), KeepsSession = true };

        var result = await Patient().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), CancellationToken.None);

        // Nothing typed, nothing pressed, nobody asked.
        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);
        Assert.Empty(ctx.Asked);

        // AND NOTHING LATCHED, because nothing was submitted upstream. A
        // connect that touched neither B2C nor the portal's sign-in chain is
        // still safe for the control plane to requeue.
        Assert.False(ctx.CredentialWasSubmitted);

        // The same session a finished sign-in returns, because it is the same
        // method that builds it: the portal cookie IS the credential here.
        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("BKR", result.Account!.DisplayName);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in to the portal", StringComparison.Ordinal));
    }

    /// <summary>
    /// And the other side: a browser the portal bounces to B2C signs in the
    /// ordinary way.
    /// </summary>
    /// <remarks>
    /// The address is the ONLY witness this register offers - a completed B2C
    /// sign-in POSTs an id_token to <c>/signin-oidc</c> and the portal answers
    /// with a cookie, so there is no session endpoint to ask - which is why
    /// being on the login host has to be believed the moment it is seen.
    /// </remarks>
    [Fact]
    public async Task A_browser_the_portal_sent_to_b2c_signs_in_the_ordinary_way()
    {
        var page = Wizard();
        page.Url = B2C;

        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed), KeepsSession = true };

        await Patient().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), CancellationToken.None);

        Assert.Equal(Email, page.Filled[EmailBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still signed in to the portal", StringComparison.Ordinal));
    }

    /// <summary>
    /// AND THE QUESTION IS NOT EVEN ASKED OF A BROWSER THAT WAS HANDED
    /// NOTHING.
    /// </summary>
    /// <remarks>
    /// The same page as the payoff test, standing on the portal, on a run with
    /// no kept profile and no restored cookie jar. Nothing could be holding a
    /// session, so <c>SessionProbe</c> answers "cannot tell" without looking
    /// and the sign-in runs.
    /// <para>
    /// What the gate buys here is the whole <c>SignedOutBounceSeconds</c>
    /// window - ten seconds, on the first connect, which is the one run
    /// somebody is sitting and watching - to learn an answer that was never in
    /// doubt. The adapter is the SHIPPED one rather than
    /// <see cref="Patient"/> deliberately: with real timers this test would
    /// take those ten seconds if the gate ever stopped working, so its speed
    /// is part of the assertion.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_browser_with_nothing_kept_is_never_asked_whether_it_is_inside()
    {
        var page = Wizard();
        page.Url = Portal;

        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed) };

        await Adapter().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), CancellationToken.None);

        Assert.Equal(Email, page.Filled[EmailBox]);
        Assert.True(ctx.CredentialWasSubmitted);
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("still signed in to the portal", StringComparison.Ordinal));
    }

    private static Dictionary<string, string> Credentials(
        string? username = Email, string? password = Password, string? seed = null)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal);

        if (username is not null) inputs["username"] = username;
        if (password is not null) inputs["password"] = password;
        if (seed is not null) inputs["totp"] = seed;

        return inputs;
    }
}
