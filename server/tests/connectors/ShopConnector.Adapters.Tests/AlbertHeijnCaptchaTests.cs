using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.AlbertHeijn;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// login.ah.nl is fronted by hCaptcha (probed): the challenge iframe is photographed, relayed as Image with answer kind Taps,
// and the taps are replayed with the mouse; nobody here reads or scores a grid.
// the redactor refusing a page with a full password field once killed a job with nobody asked
public sealed class AlbertHeijnCaptchaTests
{
    private const string Redirect = "appie://login-exit?code=arrived-after-the-wall";

    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    private static readonly AlbertHeijnOptions Options = new();

    // literal, not Options.CaptchaGridSelectors[0]: the adapter's own list would let a wrong list pass (cost a live ASN fetch).
    // hCaptcha's two frames differ only by their #frame= fragment
    private const string Grid = "iframe[src*='hcaptcha.com'][src*='#frame=challenge']";

    private const string Checkbox = "iframe[src*='hcaptcha.com'][src*='#frame=checkbox']";

    // a widget whose parts we cannot name: what the fallback list matches when the two frames are not distinguishable
    private const string OpaqueWidget = "[data-hcaptcha-widget-id]";

    private static readonly string[] GridRelayed = ["clear-secrets", "settle", "screenshot", "tap"];

    private static readonly string[] CheckboxTicked = ["clear-secrets", "click"];

    /// <summary>A checkbox that escalated: the tick, then the relay, and never a second tick.</summary>
    private static readonly string[] CheckboxTickedThenGridRelayed = ["clear-secrets", "click", "settle", "screenshot", "tap"];

    private static readonly string[] SecretsClearedOnly = ["clear-secrets"];

    private static AlbertHeijnAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    // the three selector lists overlap by construction, so probe order (most specific first) is the mechanism.
    // reversed, every solvable puzzle silently downgrades to the generic widget and no other test fails
    [Fact]
    public async Task A_grid_that_also_matches_the_widget_selectors_is_relayed_as_a_grid()
    {
        var page = StubLoginPage.Showing(Grid, OpaqueWidget);
        var lease = new StubBrowserLease(page);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = lease,
            Answer = _ => new TapAnswer { Taps = [new Tap(0.5, 0.5)], Submit = true }.Format(),
        };

        await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);

        // taps because the grid won; probed the other way it would be an AppApproval nobody can act on
        Assert.Equal(ChallengeType.Image, challenge.Type);
        Assert.Equal(ChallengeAnswerKind.Taps, challenge.AnswerKind);
        Assert.NotEmpty(challenge.Image!);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task An_hcaptcha_grid_is_relayed_as_a_picture_to_tap_and_never_as_an_app_approval(bool attended)
    {
        var page = StubLoginPage.Showing(Grid);
        var lease = new StubBrowserLease(page);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            // both attendance values give the same result: a phone elsewhere answers better,
            // and attendance is what the old answer turned on
            Attended = attended,
            Browser = lease,
            Answer = _ => new TapAnswer
            {
                Taps = [new Tap(0.5, 0.25), new Tap(0.125, 0.875)],
                Submit = true,
            }.Format(),
        };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);

        var challenge = Assert.Single(ctx.Asked);

        // an image with taps: not AppApproval ("solve it where the browser is"), not text, which no grid can be answered with
        Assert.Equal(ChallengeType.Image, challenge.Type);
        Assert.Equal(ChallengeAnswerKind.Taps, challenge.AnswerKind);
        Assert.NotEqual(ChallengeType.AppApproval, challenge.Type);
        Assert.False(challenge.IsPassive);

        // the crop lets the redactor drop the rest of the page, and is the frame the answer is measured against
        Assert.NotEmpty(challenge.Image!);
        Assert.Equal(StubLoginPage.Box, challenge.Crop);
        Assert.Equal(StubLoginPage.Box, lease.LastCrop);

        // a key, never prose, and the same as a typed captcha: answer_kind says which control to draw
        Assert.Equal("connect.challenge.captcha", challenge.PromptKey);

        // long enough to cover noticing a prompt on a phone
        Assert.Equal(Now.AddSeconds(600), challenge.ExpiresAt);
        Assert.Equal(600, Options.InteractiveCaptchaSeconds);

        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);
        Assert.Equal(1, taps.Dispatches);
    }

    [Fact]
    public async Task The_taps_land_in_page_pixels_measured_from_the_rectangle_that_was_photographed()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        // corners and middle pin both origin and scale: a forgotten origin and a wrong scale look alike from one point
        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),
            Answer = _ => new TapAnswer
            {
                Taps = [new Tap(0, 0), new Tap(0.5, 0.25), new Tap(1, 1)],
                Submit = true,
            }.Format(),
        };

        await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        // box is (12, 34) 300x80; taps are fractions of the relayed image, so 0 is its left edge, not the viewport's
        Assert.Equal(new[] { (12d, 34d), (162d, 54d), (312d, 114d) }, taps.Points);

        // in the human's order: some grids want tiles in sequence
        Assert.Equal(1, taps.Dispatches);
    }

    [Fact]
    public async Task The_password_is_cleared_out_of_the_dom_before_anything_photographs_the_page()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),
            Answer = _ => new TapAnswer { Taps = [new Tap(0.5, 0.5)], Submit = true }.Format(),
        };

        await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        // the order is the fix: the redactor refuses to photograph while a secret field holds content,
        // so a capture made first comes back empty
        Assert.Equal(GridRelayed, page.Calls);
        Assert.False(page.HoldsSecret);

        var challenge = Assert.Single(ctx.Asked);
        Assert.NotEmpty(challenge.Image!);
    }

    [Fact]
    public async Task A_capture_the_redactor_refuses_is_blocked_by_provider_and_nobody_is_asked_to_tap_anything()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        // the redactor also declines whatever it cannot verify, not only a page still holding a password
        var lease = new StubBrowserLease(page) { Refuses = true };

        using var ctx = new FakeJobContext { Attended = true, Browser = lease };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(
                ctx, page, new StubRedirectWaiter(redirect: null, afterWaits: 0), taps, CancellationToken.None));

        // named and immediate: a blank rectangle is worse than admitting we are stuck, and a grid nobody looked at is never clicked
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("photographed", error.Detail, StringComparison.Ordinal);

        Assert.Empty(ctx.Asked);
        Assert.Equal(0, taps.Dispatches);
    }

    [Fact]
    public async Task A_typed_answer_to_a_grid_clicks_nothing_at_all()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        // a consumer ignoring answer_kind sends typed text: the contract is that nothing happens,
        // a tap inferred from prose is a click no human chose
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(page), Answer = _ => "7GQX" };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(
                ctx, page, new StubRedirectWaiter(redirect: null, afterWaits: 0), taps, CancellationToken.None));

        Assert.Equal(0, taps.Dispatches);
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);

        // the grid, then the last resort: finish on AH's own page and hand back the redirect
        Assert.Equal([ChallengeType.Image, ChallengeType.Redirect], ctx.Asked.Select(c => c.Type));
    }

    [Fact]
    public async Task A_grid_that_never_goes_away_stops_after_its_rounds_instead_of_asking_forever()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),
            Answer = _ => new TapAnswer { Taps = [new Tap(0.5, 0.5)], Submit = true }.Format(),
        };

        // the redirect never comes and the widget keeps asking: the exit would otherwise belong to hCaptcha's JavaScript
        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(
                ctx, page, new StubRedirectWaiter(redirect: null, afterWaits: 0), taps, CancellationToken.None));

        Assert.Equal(Options.CaptchaRelayRounds, ctx.Asked.Count);
        Assert.Equal(4, Options.CaptchaRelayRounds);

        // unattended: nobody at the browser to hand it to either
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    // once taps can be sent without ending the relay, each tap spent one of the provider's four rounds:
    // four correct answers, nothing failing, then the paste-a-URL fallback
    [Fact]
    public async Task A_human_still_working_through_a_grid_does_not_spend_the_providers_rounds()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),
            Answer = _ => new TapAnswer { Taps = [new Tap(0.5, 0.5)], Submit = false }.Format(),
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(
                ctx, page, new StubRedirectWaiter(redirect: null, afterWaits: 0), taps, CancellationToken.None));

        var pictures = ctx.Asked.Count(c => c.Type == ChallengeType.Image);

        // it stops on the loop's own backstop: the wall clock does not bound this,
        // every ask parks the job budget while a human thinks
        Assert.True(
            pictures > Options.CaptchaRelayRounds,
            $"a human answering was cut off after {pictures} picture(s), the provider's escalation budget");
        Assert.Equal(24, pictures);

        Assert.Equal(pictures, taps.Dispatches);
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
    }

    [Fact]
    public async Task A_human_who_is_not_finished_gets_the_next_picture_without_a_wasted_poll()
    {
        var page = StubLoginPage.Showing(Grid);
        var taps = new StubTapSurface(page);
        var round = 0;

        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),

            // taps now, finished later: leaving the marker off means the human is still choosing, which a client may send
            Answer = _ => new TapAnswer
            {
                Taps = [new Tap(0.5, 0.5)],
                Submit = round++ > 0,
            }.Format(),
        };

        var watcher = new StubRedirectWaiter(Redirect, afterWaits: 1);

        var captured = await Adapter().SettleAsync(ctx, page, watcher, taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);
        Assert.Equal(2, ctx.Asked.Count);
        Assert.Equal(2, taps.Dispatches);

        // one poll before the wall and one after the finished round, none between: a half-done grid gives nothing to move on
        Assert.Equal(2, watcher.Waits);
    }

    [Fact]
    public async Task A_checkbox_on_its_own_is_ticked_and_nobody_is_asked_anything()
    {
        var page = StubLoginPage.Showing(Checkbox);
        var lease = new StubBrowserLease(page);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext { Browser = lease };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);

        Assert.Equal(CheckboxTicked, page.Calls);
        Assert.Equal(Checkbox, Assert.Single(page.Clicked));

        Assert.Empty(ctx.Asked);
        Assert.Equal(0, lease.Captures);
        Assert.Equal(0, taps.Dispatches);
    }

    [Fact]
    public async Task A_checkbox_that_escalates_into_a_grid_relays_the_grid_and_is_never_ticked_twice()
    {
        // hCaptcha decides after the tick; the box stays on the page either way, so a second tick would undo the first
        var page = StubLoginPage.Showing(Checkbox);
        page.WhenClicked = (clicked, _) => clicked.Reveal(Grid);

        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = new StubBrowserLease(page),
            Answer = _ => new TapAnswer { Taps = [new Tap(0.5, 0.5)], Submit = true }.Format(),
        };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 2), taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);

        Assert.Equal(CheckboxTickedThenGridRelayed, page.Calls);
        Assert.Equal(Checkbox, Assert.Single(page.Clicked));

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.Image, challenge.Type);
        Assert.Equal(ChallengeAnswerKind.Taps, challenge.AnswerKind);
        Assert.Equal(1, taps.Dispatches);
    }

    [Fact]
    public async Task A_tick_that_does_not_take_relays_the_box_so_the_human_can_press_it_themselves()
    {
        // our click lands mid-frame, which is the words beside the box; no offset is guessed (wrong the week they restyle),
        // so the frame is relayed as a picture
        var page = StubLoginPage.Showing(Checkbox);
        var lease = new StubBrowserLease(page);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Browser = lease,
            Answer = _ => new TapAnswer { Taps = [new Tap(0.05, 0.5)], Submit = true }.Format(),
        };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 2), taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);
        Assert.Equal(CheckboxTickedThenGridRelayed, page.Calls);

        // ticked once, not again: that would undo it
        Assert.Equal(Checkbox, Assert.Single(page.Clicked));

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeAnswerKind.Taps, challenge.AnswerKind);
        Assert.Equal(StubLoginPage.Box, challenge.Crop);

        // against the box the CHECKBOX frame occupies, the rectangle that was photographed
        Assert.Equal([(27d, 74d)], taps.Points);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task A_plain_image_captcha_is_still_relayed_as_a_picture_and_answered_in_text(bool attended)
    {
        var page = StubLoginPage.Showing("img[alt*='captcha' i]", "input[name='captcha']");
        var lease = new StubBrowserLease(page);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext
        {
            Attended = attended,
            Browser = lease,
            Answer = _ => "7GQX",
        };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), taps, CancellationToken.None);

        Assert.Equal(Redirect, captured);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.Image, challenge.Type);

        // text, stated not assumed: one challenge type carries two answer kinds, and a tappable grid here would be the wrong control
        Assert.Equal(ChallengeAnswerKind.Text, challenge.AnswerKind);

        Assert.Equal("connect.challenge.captcha", challenge.PromptKey);
        Assert.Equal(Now.AddSeconds(300), challenge.ExpiresAt);
        Assert.Equal(StubLoginPage.Box, challenge.Crop);
        Assert.Equal(StubLoginPage.Box, lease.LastCrop);

        // credentials are not resubmitted: a second submission of a password that may have counted is how an account gets locked
        Assert.Equal("7GQX", page.Answered);
        Assert.Equal(0, taps.Dispatches);
    }

    [Fact]
    public async Task A_widget_with_no_grid_and_nobody_at_the_browser_is_refused_at_once()
    {
        var page = StubLoginPage.Showing(OpaqueWidget);
        var taps = new StubTapSurface(page);

        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(page) };

        // the redirect never comes; waiting for one would hang as the live run did
        var watcher = new StubRedirectWaiter(redirect: null, afterWaits: 0);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(ctx, page, watcher, taps, CancellationToken.None));

        // blocked, not internal nor invalid_credentials: the password and we are fine,
        // there is no grid and nobody at this browser to show it to
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Contains("unattended", error.Detail, StringComparison.Ordinal);

        // no question: a challenge here pins a job to an agent until its budget expires
        Assert.Empty(ctx.Asked);
        Assert.Equal(0, taps.Dispatches);

        // immediately: one redirect poll, then the refusal; the live failure was 300 seconds of this loop
        Assert.Equal(1, watcher.Waits);
    }

    [Fact]
    public async Task A_widget_with_no_grid_still_asks_the_human_at_the_browser_to_pass_it_there()
    {
        var page = StubLoginPage.Showing(OpaqueWidget);
        var lease = new StubBrowserLease(page);

        using var ctx = new FakeJobContext { Attended = true, Browser = lease, Answer = _ => string.Empty };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 2), new StubTapSurface(page),
            CancellationToken.None);

        Assert.Equal(Redirect, captured);

        var challenge = Assert.Single(ctx.Asked);

        // passive: no picture and nothing to type back, so the redirect is the only proof the wall came down
        Assert.Equal(ChallengeType.AppApproval, challenge.Type);
        Assert.True(challenge.IsPassive);
        Assert.Equal(ChallengeAnswerKind.Text, challenge.AnswerKind);
        Assert.Null(challenge.Image);
        Assert.Equal("connect.challenge.captcha_in_browser", challenge.PromptKey);

        // nothing captured, but the job may fail later and the runner's artifact must not be refused over a password nobody needs
        Assert.Equal(SecretsClearedOnly, page.Calls);
        Assert.Equal(0, lease.Captures);
    }

    [Fact]
    public async Task A_widget_solved_silently_at_the_browser_still_finishes_on_the_redirect()
    {
        var page = StubLoginPage.Showing(OpaqueWidget);

        // nobody answers: the normal case, the person solves it in the browser and has no reason to return to the consumer's UI
        using var ctx = new FakeJobContext
        {
            Attended = true,
            Browser = new StubBrowserLease(page),
            AnswersNothing = true,
        };

        // a ceiling so a regression into awaiting the answer fails instead of hanging the suite
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 1), cts.Token);

        Assert.Equal(Redirect, captured);
        Assert.Single(ctx.Asked);
    }

    [Fact]
    public async Task A_page_that_states_a_credential_error_still_ends_the_login_as_one()
    {
        var page = StubLoginPage.Showing(":text('e-mailadres of wachtwoord')");
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(page) };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().SettleAsync(
                ctx, page, new StubRedirectWaiter(redirect: null, afterWaits: 0), CancellationToken.None));

        // the only path allowed to say this, and never retried: guessing "wrong password" from silence
        // sends a user to reset a fine one
        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
        Assert.Empty(ctx.Asked);
    }

    [Fact]
    public async Task A_login_with_no_wall_at_all_just_returns_the_redirect()
    {
        var page = StubLoginPage.Showing();
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(page) };

        var captured = await Adapter().SettleAsync(
            ctx, page, new StubRedirectWaiter(Redirect, afterWaits: 0), new StubTapSurface(page),
            CancellationToken.None);

        Assert.Equal(Redirect, captured);
        Assert.Empty(ctx.Asked);
        Assert.Empty(page.Calls);
    }
}
