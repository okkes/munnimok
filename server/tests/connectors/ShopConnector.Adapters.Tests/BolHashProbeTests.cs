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

    private static readonly BolOptions Quick = new() { HashProbeMs = 20, ProbeMs = 1 };

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
}
