using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// The sign-in making bol's own page say the orders operation's hash. On
/// 2026-10-05 the page the sign-in landed on said nothing within the probe,
/// the configured hash stood, bol refused it, and every fetch failed as
/// provider_changed (user ss). The probe now opens the overview itself and,
/// failing that, presses "Toon meer" - each step drivable here.
/// </summary>
public sealed class BolHashProbeTests
{
    // Written out, not read off the options (the fixture rule): what bol's
    // overview carries, and where it lives.
    private const string Overview = "https://www.bol.com/nl/nl/account/bestellingen/overzicht/";
    private const string LoadMore = "button:has-text(\"Toon meer\")";

    private static readonly BolOptions Quick = new() { HashProbeMs = 20, ProbeMs = 1, LoadMoreMs = 1 };

    [Fact]
    public async Task A_landing_page_that_fires_the_operation_needs_no_navigation()
    {
        var page = StubLoginPage.Showing();
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, Task.FromResult("sha256:landing"), CancellationToken.None);

        Assert.Equal("sha256:landing", hash);
        Assert.Empty(page.Visited);
        Assert.Empty(page.Clicked);
    }

    [Fact]
    public async Task A_silent_landing_page_sends_the_browser_to_the_overview()
    {
        var learned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var page = StubLoginPage.Showing();
        page.WhenVisited = (_, url) =>
        {
            if (url == Overview) learned.TrySetResult("sha256:overview");
        };
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, learned.Task, CancellationToken.None);

        Assert.Equal("sha256:overview", hash);
        Assert.Equal(new[] { Overview }, page.Visited);
        Assert.Contains(ctx.Notes, n => n.Contains("once opened", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_cookie_wall_on_the_overview_is_dismissed_before_Toon_meer_is_pressed()
    {
        // 2026-10-06 (prod): the wall over the overview swallowed the press
        const string Consent = "[role='dialog'][data-state='open'] button:has-text('Weigeren')";
        var learned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var page = StubLoginPage.Showing(LoadMore);
        page.WhenVisited = (p, url) =>
        {
            if (url == Overview) p.Reveal(Consent);
        };
        page.WhenClicked = (p, selector) =>
        {
            if (selector == Consent) p.Hide(Consent);
            if (selector == LoadMore) learned.TrySetResult("sha256:more");
        };
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, learned.Task, CancellationToken.None);

        Assert.Equal("sha256:more", hash);
        Assert.Equal(new[] { Consent, LoadMore }, page.Clicked);
    }

    [Fact]
    public async Task A_server_rendered_overview_fires_the_operation_on_Toon_meer()
    {
        var learned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var page = StubLoginPage.Showing(LoadMore);
        page.WhenClicked = (_, selector) =>
        {
            if (selector == LoadMore) learned.TrySetResult("sha256:more");
        };
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, learned.Task, CancellationToken.None);

        Assert.Equal("sha256:more", hash);
        Assert.Equal(new[] { Overview }, page.Visited);
        Assert.Equal(new[] { LoadMore }, page.Clicked);
        Assert.Contains(ctx.Notes, n => n.Contains("Toon meer", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_page_that_never_says_it_leaves_the_configured_hash_standing()
    {
        var never = new TaskCompletionSource<string>();
        var page = StubLoginPage.Showing();
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, never.Task, CancellationToken.None);

        Assert.Null(hash);
        Assert.Equal(new[] { Overview }, page.Visited);
        Assert.Contains(ctx.Notes, n => n.Contains("the configured hash stands", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_Toon_meer_press_the_page_will_not_take_is_tried_once_more_after_the_walls()
    {
        // 2026-10-06/07 (prod, GlitchTip #25/#27/#33): the button was found, scrolled to, and the second
        // wall took the pointer - Playwright's click timed out and the whole sign-in died as internal
        var learned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var page = StubLoginPage.Showing(LoadMore);
        page.ClickThrows = new TimeoutException("Timeout 5000ms exceeded.\nCall log:\n  - attempting click action");
        page.WhenClicked = (_, selector) =>
        {
            if (selector == LoadMore) learned.TrySetResult("sha256:more");
        };
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, learned.Task, CancellationToken.None);

        Assert.Equal("sha256:more", hash);
        Assert.Equal(new[] { LoadMore }, page.Clicked);
        Assert.Contains(ctx.Notes, n => n.Contains("'Toon meer' did not take the press (TimeoutException, attempt 1 of 2)", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_Toon_meer_that_never_takes_a_press_leaves_the_configured_hash_standing_never_a_failed_login()
    {
        var never = new TaskCompletionSource<string>();
        var page = StubLoginPage.Showing(LoadMore);
        page.ClickThrows = new TimeoutException("Timeout 5000ms exceeded.");
        page.ClickThrowsTimes = 2;
        using var ctx = new FakeJobContext();

        var hash = await new BolHashProbe(Quick).LearnAsync(ctx, page, never.Task, CancellationToken.None);

        Assert.Null(hash);
        Assert.Empty(page.Clicked);
        Assert.Contains(ctx.Notes, n => n.Contains("attempt 2 of 2); the configured hash stands", StringComparison.Ordinal));
    }
}
