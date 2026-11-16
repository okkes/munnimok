using Connector.Kit.Agent.Exploring;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Exploring;
using Connector.Kit.Tracing;

namespace Connector.Kit.Agent.Tests.Exploring;

public sealed class ExploreAdapterTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(90);

    private static LeasedJob Explore(string url) => TestRig.Login(budgetSeconds: 60) with
    {
        Provider = ExploreProvider.Id,
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { [ExploreProvider.UrlField] = url },
        Record = true,
    };

    private static TestRig Rig() => new(new ExploreAdapter(), manifest: ExploreProvider.Manifest);

    [Fact]
    public async Task A_private_address_is_refused_before_a_browser_opens()
    {
        using var rig = Rig();

        await rig.RunAsync(Explore("http://192.168.1.1/")).WaitAsync(Patience);

        Assert.True(rig.Control.FailedWith(ErrorCode.InvalidRequest), rig.Control.FailureCode);
        Assert.Equal(0, rig.Control.ChallengesRaised);
    }

    [Fact]
    public async Task The_operator_drives_until_they_say_done_and_the_run_leaves_a_session_and_a_recording()
    {
        using var rig = Rig();
        rig.Control.Answer(ExploreProvider.Done);

        // an unresolvable address leaves the page blank and the run going (the operator has an address bar); the recording notes it
        await rig.RunAsync(Explore("https://provider.test/")).WaitAsync(Patience);

        Assert.Null(rig.Control.Failure);
        var result = rig.Control.Result;
        Assert.NotNull(result);
        Assert.NotNull(result.SessionMaterial?.StorageState);
        Assert.Equal("provider.test", result.ProviderAccount?.DisplayName);
        Assert.Contains(result.Notes, n => n.Contains("did not load", StringComparison.Ordinal));
        Assert.Contains(result.Notes, n => n.StartsWith("explored up to", StringComparison.Ordinal));

        Assert.Equal(ChallengeType.LiveView, rig.Control.Raised?.Type);
        Assert.Equal(ExploreProvider.PromptKey, rig.Control.Raised?.PromptKey);

        var trace = rig.Control.Trace;
        Assert.NotNull(trace);
        Assert.Equal(ExploreProvider.Id, trace.Provider);
        Assert.Contains(trace.Entries, e => e.Kind == TraceKind.Note && e.Text == "the run ended");
    }

    [Fact]
    public async Task A_window_nobody_answered_ends_the_run_as_a_success_with_what_was_seen()
    {
        using var rig = Rig();
        rig.Control.SaysNothingYet();

        // the window is thirty minutes by contract: a challenge that expires at once exercises the adapter's timeout handling
        var adapter = new ExploreAdapter(new ExpiredWindowClock());
        using var quick = new TestRig(adapter, manifest: ExploreProvider.Manifest);
        quick.Control.SaysNothingYet();

        await quick.RunAsync(Explore("https://provider.test/")).WaitAsync(Patience);

        Assert.Null(quick.Control.Failure);
        Assert.NotNull(quick.Control.Result);
        Assert.Contains(quick.Control.Result!.Notes, n => n.Contains("nobody at the view", StringComparison.Ordinal));
    }

    private sealed class ExpiredWindowClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UtcNow.AddMinutes(-ExploreProvider.WindowMinutes - 1);
    }
}
