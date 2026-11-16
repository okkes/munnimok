using Connector.Kit.Challenges;
using RegistryConnector.Adapters.Bkr;
using RegistryConnector.Adapters.Support;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// BKR's sign-in is a wizard: e-mail, "Start inzage", then the password on a second screen; a stub showing every box
// at once let an adapter that filled both up front pass offline
public sealed class BkrLoginTests
{
    private const string Email = "someone@example.test";
    private const string Password = "hunter2";

    private const string Seed = "JBSWY3DPEHPK3PXP";

    private static readonly DateTimeOffset Now = new(2026, 8, 5, 9, 0, 0, TimeSpan.Zero);

    private static readonly BkrOptions Options = new();

    private static readonly string EmailBox = Options.UsernameSelectors[0];
    private static readonly string PasswordBox = Options.PasswordSelectors[0];
    private static readonly string Submit = Options.SubmitSelectors[0];
    private static readonly string CodeBox = Options.CodeSelectors[0];
    private static readonly string CodeSubmit = Options.CodeSubmitSelectors[0];

    private static BkrAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

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

        Assert.Empty(ctx.Asked);

        Assert.Equal(Email, page.Filled[EmailBox]);
        Assert.Equal(Password, page.Filled[PasswordBox]);

        var code = Assert.Contains(CodeBox, (IDictionary<string, string>)page.Filled);
        Assert.Equal(6, code.Length);
        Assert.All(code, c => Assert.InRange(c, '0', '9'));
        Assert.Equal(Totp.Generate(Totp.FromBase32(Seed), Now), code);
    }

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

        // a code box fits the challenge protocol; streaming a whole browser to type six digits is worse
        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.MfaCode, asked.Type);
        Assert.Equal(6, asked.Length);

        Assert.Equal("424242", page.Filled[CodeBox]);
    }

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

        // half a credential is none: a lone e-mail posted at a page that may count attempts is worse than not trying
        Assert.Empty(page.Filled);

        Assert.False(page.HoldsSecret);
    }

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

    // BKR's session is a cookie (B2C form_posts an id_token): a result with only a device id says "Connected" but every
    // fetch opens a cookieless browser and lands on the sign-in page
    [Fact]
    public async Task The_cookie_jar_leaves_with_the_login_because_it_is_the_session()
    {
        var page = Wizard();
        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed) };

        var result = await Adapter().LoginAsync(
            ctx, page, new StubSignedIn("https://portaal.mijnkredietregistratie.nl/", 0), CancellationToken.None);

        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
    }

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

    // BKR asks a second factor EVERY time (no refresh token); an agent's kept browser profile may still hold the portal
    // cookie, and then a connect asks for neither

    private const string Portal = "https://portaal.mijnkredietregistratie.nl/";

    private const string B2C = "https://login.mijnkredietregistratie.nl/bkrconsp.onmicrosoft.com/oauth2/v2.0/authorize";

    // timers that do not wait, so the bounce window runs at its shipped length
    private static BkrAdapter Patient() => new(Options, new InstantTimeProvider(Now));

    // full wizard with stored credentials: a check placed after the inputs were read would still type at B2C
    [Fact]
    public async Task A_browser_still_inside_the_portal_is_not_signed_in_again()
    {
        var page = Wizard();
        page.Url = Portal;

        using var ctx = new FakeJobContext { Inputs = Credentials(seed: Seed), KeepsSession = true };

        var result = await Patient().LoginAsync(ctx, page, new StubSignedIn(Portal, 0), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);
        Assert.Empty(ctx.Asked);

        // nothing submitted upstream, so nothing latched: the control plane may still requeue
        Assert.False(ctx.CredentialWasSubmitted);

        Assert.Equal(StubBrowserLease.Jar, result.Material.StorageState);
        Assert.Equal("BKR", result.Account!.DisplayName);

        Assert.Contains(ctx.Notes, n => n.Contains("still signed in to the portal", StringComparison.Ordinal));
    }

    // the address is the only witness this register offers (id_token POSTed to /signin-oidc, portal answers with a
    // cookie), so being on the login host is believed at once
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

    // no kept profile, no restored jar: SessionProbe answers "cannot tell" unasked; the shipped adapter is used so the
    // test would take the full ten-second window if the gate broke
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
