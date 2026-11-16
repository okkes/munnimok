using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// Auth0's auth0_v2 captcha (Cloudflare Turnstile) walled a real connect on auth.jumbo.com/u/login (2026-07-31): its token is
// minted by its own JS in the rendering browser, so it cannot be relayed as picture or tap; the page is streamed to a human
// raised on a risk score, so both credentials stay optional: a quiet day signs in unattended, a walled day goes to the owner
public sealed class JumboLiveLoginTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    private const string Signed = "https://www.jumbo.com/mijn-jumbo/bestellingen";

    private static readonly string[] FormControls = ["input#username", "input#password", "button[type='submit']"];

    private static string Wall => new JumboOptions().InteractiveCaptchaSelectors
        .First(s => s.Contains("cloudflare", StringComparison.Ordinal));

    private static JumboAdapter Adapter(JumboOptions? options = null) =>
        new(options ?? new JumboOptions(), new FakeJumboGraphQl(), new FixedTimeProvider(Now));

    private static StubLoginPage FormPage(params string[] extra) =>
        StubLoginPage.Showing([.. FormControls, .. extra]);

    private static StubLoginPage BarePage() => StubLoginPage.Showing();

    private static FakeJobContext Context(
        StubLoginPage page, bool withCredentials, string? storageState = null) => new()
        {
            AnswersNothing = true,
            Browser = new JumboBrowserLease(page, storageState),
            Inputs = withCredentials
                ? JumboFixtures.Credentials
                : new Dictionary<string, string>(StringComparer.Ordinal),
        };

    private static StubRedirectWaiter Arrives(int afterWaits = 0) => new(Signed, afterWaits);

    private static StubRedirectWaiter Never() => new(redirect: null, afterWaits: 0);

    [Fact]
    public async Task Credentials_and_no_wall_sign_in_without_asking_anybody()
    {
        var page = FormPage();
        using var ctx = Context(page, withCredentials: true);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal("https://www.jumbo.com/account/inloggen", Assert.Single(page.Visited));

        Assert.Equal(JumboFixtures.Credentials["username"], page.Filled["input#username"]);
        Assert.Equal(JumboFixtures.Credentials["password"], page.Filled["input#password"]);
        Assert.Contains("button[type='submit']", page.Clicked);

        Assert.Empty(ctx.Asked);

        Assert.NotNull(result.Material.StorageState);
        Assert.Equal(Now.AddSeconds(86_400), result.ExpiresAt);
    }

    [Fact]
    public async Task A_submitted_credential_latches_so_a_lost_lease_never_replays_it()
    {
        var page = FormPage();
        using var ctx = Context(page, withCredentials: true);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        // A retried login is how an account gets locked.
        Assert.True(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task A_wall_before_the_click_hands_over_without_spending_an_attempt()
    {
        var page = FormPage(Wall);
        using var ctx = Context(page, withCredentials: true);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(JumboFixtures.Credentials["username"], page.Filled["input#username"]);

        // the password is NOT typed: the wall is checked first so it never enters a DOM handed to the shutter,
        // and the redactor refuses to photograph a page holding a secret
        Assert.DoesNotContain("input#password", page.Filled.Keys);
        Assert.False(page.HoldsSecret);

        // nothing submitted: no attempt spent against the account, nothing latched
        Assert.DoesNotContain("button[type='submit']", page.Clicked);
        Assert.False(ctx.CredentialWasSubmitted);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.LiveView, challenge.Type);
        Assert.True(challenge.IsPassive);

        Assert.NotNull(result.Material.StorageState);
    }

    [Fact]
    public async Task No_credentials_at_all_streams_the_page_from_the_start()
    {
        var page = BarePage();
        using var ctx = Context(page, withCredentials: false);

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);
        Assert.False(ctx.CredentialWasSubmitted);

        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.NotNull(result.Material.StorageState);
    }

    // a wall after the click, a one-time code or anything unseen is answerable by the account owner: hand over rather than fail
    [Fact]
    public async Task A_submit_that_reaches_no_session_hands_over_rather_than_failing()
    {
        var page = FormPage();
        using var ctx = Context(page, withCredentials: true);

        // afterWaits:1 is the one poll the spent settle budget affords, so the redirect arrives at the live view
        var result = await Adapter(new JumboOptions { LoginSettleSeconds = 0 })
            .LoginAsync(ctx, page, Arrives(afterWaits: 1), CancellationToken.None);

        Assert.Contains("button[type='submit']", page.Clicked);
        Assert.Equal(ChallengeType.LiveView, Assert.Single(ctx.Asked).Type);
        Assert.NotNull(result.Material.StorageState);
    }

    // a stated wrong password must reach the consumer so a stored credential is dropped, not re-submitted by machine tomorrow
    [Fact]
    public async Task A_stated_wrong_password_is_reported_and_never_escalated()
    {
        var page = FormPage(new JumboOptions().LoginErrorSelectors[0]);
        using var ctx = Context(page, withCredentials: true);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);

        Assert.Empty(ctx.Asked);
        Assert.False(error.Retriable);
    }

    [Fact]
    public async Task The_live_view_carries_the_configured_window_and_is_asked_once()
    {
        var page = BarePage();
        using var ctx = Context(page, withCredentials: false);

        await Adapter(new JumboOptions { LiveLoginSeconds = 240 })
            .LoginAsync(ctx, page, Arrives(afterWaits: 2), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);

        Assert.Equal(Now.AddSeconds(240), challenge.ExpiresAt);
        Assert.Equal("connect.challenge.live_login", challenge.PromptKey);

        // not a picture: Turnstile cannot be answered by relaying one
        Assert.Null(challenge.Image);
        Assert.NotEqual(ChallengeType.Image, challenge.Type);
    }

    [Fact]
    public async Task The_view_is_ended_when_the_session_appears_and_not_merely_abandoned()
    {
        var page = BarePage();
        using var ctx = Context(page, withCredentials: false);

        await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        // else the shutter keeps photographing and the agent stays occupied
        Assert.True(Assert.Single(ctx.AskTokens).IsCancellationRequested);
    }

    [Fact]
    public async Task A_live_view_that_runs_out_is_blocked_and_never_a_wrong_password()
    {
        var page = BarePage();
        using var ctx = Context(page, withCredentials: false);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(new JumboOptions { LiveLoginSeconds = 0 })
                .LoginAsync(ctx, page, Never(), CancellationToken.None));

        // nobody typed a password into anything of ours: calling this a credential failure sends the user to reset a fine one
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.True(Assert.Single(ctx.AskTokens).IsCancellationRequested);
    }

    // the URL is not the credential: a page that looks signed in but left no jumbo.com cookies yields nothing fetchable
    [Fact]
    public async Task A_session_that_left_no_cookies_behind_is_a_shape_change()
    {
        var page = BarePage();
        using var ctx = Context(page, withCredentials: false, storageState: """{"cookies":[],"origins":[]}""");

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Equal("jumbo: login left no jumbo.com cookies behind", error.Detail);
    }

    [Fact]
    public async Task A_reconnect_keeps_the_device_it_first_signed_in_as()
    {
        var page = FormPage(Wall);

        using var ctx = new FakeJobContext
        {
            AnswersNothing = true,
            Browser = new JumboBrowserLease(page),
            Inputs = JumboFixtures.Credentials,
            Material = new SessionMaterial { DeviceId = "dev-first-time" },
        };

        var result = await Adapter().LoginAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal("dev-first-time", result.Material.DeviceId);
    }

    [Fact]
    public void The_shipped_window_is_fifteen_minutes()
    {
        Assert.Equal(900, new JumboOptions().LiveLoginSeconds);
    }
}
