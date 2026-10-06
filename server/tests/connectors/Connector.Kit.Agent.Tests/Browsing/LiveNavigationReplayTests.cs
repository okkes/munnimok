using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The navigation vocabulary on the agent (#441 L3): refused as a whole batch
/// on a view that does not navigate, dispatched as a parsed address on one
/// that does.
/// </summary>
public class LiveNavigationReplayTests
{
    private static readonly (int Width, int Height) Frame = (390, 844);

    private static LiveInput Navigate(string url) => new() { Kind = LiveInputKind.Navigate, Url = url };

    private static Task<int> ReplayAsync(ILiveSurface surface, IReadOnlyList<LiveInput> events, bool navigation) =>
        LiveInputReplay.ReplayAsync(events, Frame, surface, NullLogger.Instance, CancellationToken.None, navigation);

    [Fact]
    public async Task A_view_that_does_not_navigate_refuses_the_whole_batch()
    {
        var surface = new RecordingLiveSurface();

        var dispatched = await ReplayAsync(surface, [new LiveInput { Kind = LiveInputKind.Move, X = 0.5, Y = 0.5 }, Navigate("https://www.example.com/")], navigation: false);

        Assert.Equal(0, dispatched);
        Assert.Empty(surface.Trace);
    }

    [Fact]
    public async Task A_view_that_navigates_dispatches_the_parsed_address_then_back_then_reload_in_order()
    {
        var surface = new RecordingLiveSurface();

        var dispatched = await ReplayAsync(surface,
            [Navigate("https://www.example.com/orders?page=2"), new LiveInput { Kind = LiveInputKind.Back }, new LiveInput { Kind = LiveInputKind.Reload }],
            navigation: true);

        Assert.Equal(3, dispatched);
        Assert.Equal(["navigate https://www.example.com/orders?page=2", "back", "reload"], surface.Trace);
        Assert.Equal(new Uri("https://www.example.com/orders?page=2"), Assert.Single(surface.Navigations));
    }

    [Fact]
    public async Task An_address_the_kit_refuses_never_reaches_the_surface_even_on_a_navigating_view()
    {
        var surface = new RecordingLiveSurface();

        var dispatched = await ReplayAsync(surface, [Navigate("http://10.0.0.1/admin")], navigation: true);

        Assert.Equal(0, dispatched);
        Assert.Empty(surface.Navigations);
    }
}
