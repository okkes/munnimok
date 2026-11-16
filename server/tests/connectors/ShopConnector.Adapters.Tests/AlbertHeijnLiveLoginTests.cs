using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.AlbertHeijn;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// LiveLogin ships true, so this is every real connect's path; AlbertHeijnAdapterTests cover only the typed form.
// pinned: the adapter types nothing, asks for nothing, latches no credential, and ENDS the view at sign-in.
// an agent runs one job at a time, so a login that never lets go wedges every later one
public sealed class AlbertHeijnLiveLoginTests
{
    private const string Code = "signed-in-on-ahs-own-page";

    private const string Redirect = $"appie://login-exit?code={Code}";

    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    // the shipped options on purpose: hand-built ones would stop describing the connect a user gets
    private static AlbertHeijnAdapter Adapter(AlbertHeijnOptions? options = null) =>
        new(options ?? new AlbertHeijnOptions(), new FixedTimeProvider(Now));

    private static StubRedirectWaiter Arrives(int afterWaits = 0) => new(Redirect, afterWaits);

    private static StubRedirectWaiter Never() => new(redirect: null, afterWaits: 0);

    private static StubLoginPage Page() => StubLoginPage.Showing();

    [Fact]
    public async Task The_streamed_login_opens_ahs_own_page_and_finishes_on_the_redirect_alone()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        var code = await Adapter().LiveCodeAsync(ctx, page, Arrives(), CancellationToken.None);

        // the code, not the URL: the callback carries a live credential and is never handed on whole
        Assert.Equal(Code, code);

        Assert.Equal(Adapter().AuthorizeUrl(), Assert.Single(page.Visited));

        // OpeningProvider belongs to the caller that leases the browser
        Assert.Equal([JobStep.AwaitingHuman, JobStep.Authenticating], ctx.Steps);
    }

    [Fact]
    public async Task The_streamed_login_types_nothing_even_when_credentials_were_handed_to_it()
    {
        var page = Page();

        // a consumer sent them anyway: the manifest declares no fields so this cannot arrive via the control plane,
        // but the path must not use a password regardless
        using var ctx = new FakeJobContext
        {
            AnswersNothing = true,
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = "shopper@example.com",
                ["password"] = "hunter2",
            },
        };

        var code = await Adapter().LiveCodeAsync(ctx, page, Arrives(), CancellationToken.None);

        Assert.Equal(Code, code);

        Assert.Empty(page.Filled);
        Assert.Empty(page.Clicked);
        Assert.Empty(page.Calls);

        Assert.True(page.HoldsSecret);
        Assert.DoesNotContain("clear-secrets", page.Calls);

        // NOT latched: the latch protects against requeuing a login whose password counted, and here the attempts
        // are the human's own on AH's page; latching would fail jobs permanently
        Assert.False(ctx.CredentialWasSubmitted);
    }

    [Fact]
    public async Task The_human_is_asked_once_for_a_passive_live_view_and_never_for_a_string()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        await Adapter().LiveCodeAsync(ctx, page, Arrives(afterWaits: 2), CancellationToken.None);

        // once, not once per poll
        var challenge = Assert.Single(ctx.Asked);

        Assert.Equal(ChallengeType.LiveView, challenge.Type);
        Assert.Equal("connect.challenge.live_login", challenge.PromptKey);

        Assert.True(challenge.IsPassive);
        Assert.Equal(ChallengeAnswerKind.Text, challenge.AnswerKind);

        // not a picture and not a paste, the adapter's other two asks: confusing them shows the wrong UI mid-login
        Assert.Null(challenge.Image);
        Assert.Null(challenge.Url);
        Assert.Null(challenge.ReturnPattern);
        Assert.NotEqual(ChallengeType.Image, challenge.Type);
        Assert.NotEqual(ChallengeType.Redirect, challenge.Type);
    }

    [Theory]
    [InlineData(900)]
    [InlineData(240)]
    public async Task The_window_the_human_gets_is_the_configured_one(int seconds)
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        await Adapter(new AlbertHeijnOptions { LiveLoginSeconds = seconds })
            .LiveCodeAsync(ctx, page, Arrives(), CancellationToken.None);

        // the option reaches the expiry the consumer renders a clock from; it decides when an agent is released
        Assert.Equal(Now.AddSeconds(seconds), Assert.Single(ctx.Asked).ExpiresAt);
    }

    [Fact]
    public void The_shipped_window_is_fifteen_minutes_and_the_shipped_login_is_the_streamed_one()
    {
        var options = new AlbertHeijnOptions();

        // generous: covers reading an SMS, finding a password manager and a captcha with several rounds
        Assert.Equal(900, options.LiveLoginSeconds);

        Assert.True(options.LiveLogin);
    }

    [Fact]
    public async Task The_view_is_ended_when_the_redirect_lands_and_not_merely_abandoned()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        await Adapter().LiveCodeAsync(ctx, page, Arrives(), CancellationToken.None);

        // without ending, the shutter keeps photographing, the agent stays occupied
        // and the human sees a frozen picture of a finished step
        Assert.True(Assert.Single(ctx.AskTokens).IsCancellationRequested);
    }

    [Fact]
    public async Task The_view_is_ended_when_the_window_runs_out_too()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };
        var watcher = Never();

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(new AlbertHeijnOptions { LiveLoginSeconds = 0 })
                .LiveCodeAsync(ctx, page, watcher, CancellationToken.None));

        // somebody may still be looking: disposing the linked source only unlinks it from the job's token and orphans the ask
        Assert.True(Assert.Single(ctx.AskTokens).IsCancellationRequested);

        // a zero window is spent before it is polled: the deadline is checked ahead of the wait
        Assert.Equal(0, watcher.Waits);
    }

    [Fact]
    public async Task A_human_who_closes_the_view_ends_the_login_rather_than_polling_out_the_window()
    {
        var page = Page();

        // the answer to a passive challenge is the empty string; its arrival means the consumer's UI is done with this view
        using var ctx = new FakeJobContext { Answer = _ => string.Empty };
        var watcher = Never();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LiveCodeAsync(ctx, page, watcher, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);

        // without the completed-ask guard this spins the full fifteen minutes with nobody there
        Assert.Equal(1, watcher.Waits);
    }

    [Fact]
    public async Task A_login_that_never_reached_the_callback_is_blocked_and_never_a_wrong_password()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(new AlbertHeijnOptions { LiveLoginSeconds = 0 })
                .LiveCodeAsync(ctx, page, Never(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);

        // not a credential failure: nobody typed a password into anything of ours, and a credential error is never retried
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.Equal(
            "ah: the live login ended without reaching the callback; the sign-in was not completed",
            error.Detail);
    }

    [Fact]
    public async Task A_callback_carrying_no_code_is_a_shape_change_and_still_ends_the_view()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LiveCodeAsync(
                ctx, page, new StubRedirectWaiter("appie://login-exit?state=xyz", afterWaits: 0),
                CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Equal("ah: the callback carried no authorization code", error.Detail);

        Assert.True(Assert.Single(ctx.AskTokens).IsCancellationRequested);
    }

    [Fact]
    public async Task The_redirect_finishes_the_login_even_though_nobody_ever_answers_the_view()
    {
        var page = Page();

        using var ctx = new FakeJobContext { AnswersNothing = true };
        var watcher = Arrives(afterWaits: 2);

        var code = await Adapter().LiveCodeAsync(ctx, page, watcher, CancellationToken.None);

        Assert.Equal(Code, code);
        Assert.Equal(3, watcher.Waits);
    }

    [Fact]
    public async Task The_view_is_asked_under_the_jobs_own_token_so_a_cancelled_job_ends_it()
    {
        var page = Page();
        using var ctx = new FakeJobContext { AnswersNothing = true };
        var watcher = Never();

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => Adapter().LiveCodeAsync(ctx, page, watcher, cts.Token));

        // linked, not independent: a cancelled job must be able to END the ask instead of leaving it holding a browser
        Assert.Equal(0, watcher.Waits);
    }
}
