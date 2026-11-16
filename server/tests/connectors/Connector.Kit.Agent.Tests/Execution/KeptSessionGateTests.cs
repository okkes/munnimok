using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests.Execution;

// precondition for SessionProbe asking an adapter: a browser handed nothing holds no session, and asking costs
// a settle window on every first connect; read off the job's browser options, never derived from class or manifest
public sealed class KeptSessionGateTests
{
    private static ProviderManifest Manifest(AgentClass agent) => TestRig.Manifest with
    {
        Agent = new AgentRequirement { Required = true, Class = agent },
    };

    // through BrowserOptionsForTest so the whole link is asserted, not a hand-built BrowserLeaseOptions fixture
    private static AgentJobContext ContextFor(TestRig rig, AgentClass agentClass, LeasedJob job)
    {
        var manifest = Manifest(agentClass);
        rig.Options.Class = agentClass;

        return rig.Context(job, manifest, rig.Runner.BrowserOptionsForTest(job, manifest));
    }

    // a BYO agent gets a profile directory for every non-HTTP provider, so a second connect usually opens a signed-in browser
    [Fact]
    public async Task A_browser_with_a_kept_profile_may_already_hold_a_session()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        var job = TestRig.Login(budgetSeconds: 30);

        await using var context = ContextFor(rig, AgentClass.Byo, job);

        Assert.True(context.KeepsSession);
    }

    // a pooled agent gets a fresh browser and no profile, and a first connect has no material: the check is pure latency
    [Fact]
    public async Task A_first_connect_on_the_fleet_kept_nothing()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        var job = TestRig.Login(budgetSeconds: 30);

        Assert.Null(job.Material);

        await using var context = ContextFor(rig, AgentClass.Pooled, job);

        Assert.False(context.KeepsSession);
    }

    // the fleet's refresh restores the bundle's cookie jar and Amazon's refresh skips sign-in off it: gating on agent class
    // would drive a full sign-in (password, one-time code) at an already signed-in browser
    [Fact]
    public async Task A_refresh_on_the_fleet_carries_the_bundles_cookie_jar()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());

        var job = TestRig.Login(budgetSeconds: 30) with
        {
            Kind = JobKind.Refresh,
            Material = new SessionMaterial
            {
                StorageState = """{"cookies":[{"name":"session","value":"x","domain":".provider.test"}]}""",
            },
        };

        await using var context = ContextFor(rig, AgentClass.Pooled, job);

        Assert.Null(rig.Runner.BrowserOptionsForTest(job, Manifest(AgentClass.Pooled)).ProfileDirectory);
        Assert.True(context.KeepsSession);
    }

    // contexts built outside the runner have no browser: a "maybe" from there sends an adapter after a page that is not there
    [Fact]
    public async Task A_context_with_no_browser_of_its_own_keeps_nothing()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());

        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        Assert.False(context.KeepsSession);
    }
}
