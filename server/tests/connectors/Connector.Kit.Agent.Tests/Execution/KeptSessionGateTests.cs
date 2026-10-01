using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// Whether this job's browser could ALREADY be signed in - the one question
/// <c>SessionProbe</c> checks before it asks an adapter anything.
///
/// <para>
/// It is not a claim that anybody is signed in. It is the precondition for the
/// question being worth asking: a browser handed nothing by a previous run
/// cannot be holding a session, so asking would buy a guaranteed "no" at the
/// price of a settle window - on every first connect, which is the one run
/// somebody is sitting and watching.
/// </para>
///
/// <para>
/// Read off the browser options this job is really opened with, never derived
/// a second time from the agent class or the manifest. Those two would be the
/// same answer today and a wrong one on the fleet's refresh jobs, which get no
/// profile and a full cookie jar.
/// </para>
/// </summary>
public sealed class KeptSessionGateTests
{
    private static ProviderManifest Manifest(AgentClass agent) => TestRig.Manifest with
    {
        Agent = new AgentRequirement { Required = true, Class = agent },
    };

    /// <summary>
    /// The context a runner on this class of agent would really build, lease
    /// options included.
    /// </summary>
    /// <remarks>
    /// Through <c>BrowserOptionsForTest</c> so the link being asserted is the
    /// whole one - the runner deciding this job gets a profile, and the context
    /// reading that decision off the browser. A hand-built
    /// <c>BrowserLeaseOptions</c> here would assert the second half against a
    /// fixture and leave the first untested.
    /// </remarks>
    private static AgentJobContext ContextFor(TestRig rig, AgentClass agentClass, LeasedJob job)
    {
        var manifest = Manifest(agentClass);
        rig.Options.Class = agentClass;

        return rig.Context(job, manifest, rig.Runner.BrowserOptionsForTest(job, manifest));
    }

    /// <summary>
    /// ON SOMEBODY'S OWN MACHINE THE PROFILE IS KEPT, so the question is worth
    /// asking.
    /// </summary>
    /// <remarks>
    /// A BYO agent gets a profile directory for EVERY non-HTTP provider, not
    /// only the persistent tier - the point of installing one is that the
    /// browser keeps what browsers keep. So the second connect to a provider
    /// there usually opens a browser that is already inside, and this is the
    /// flag that lets an adapter find that out before it drives a sign-in.
    /// </remarks>
    [Fact]
    public async Task A_browser_with_a_kept_profile_may_already_hold_a_session()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        var job = TestRig.Login(budgetSeconds: 30);

        await using var context = ContextFor(rig, AgentClass.Byo, job);

        Assert.True(context.KeepsSession);
    }

    /// <summary>
    /// AND A FIRST CONNECT ON THE FLEET KEPT NOTHING.
    /// </summary>
    /// <remarks>
    /// A pooled agent is handed a fresh browser per job and no profile
    /// directory at all, and a first connect carries no material either - so
    /// there is nothing a session could be riding on, and the settle window an
    /// already-signed-in check would spend is pure latency.
    /// </remarks>
    [Fact]
    public async Task A_first_connect_on_the_fleet_kept_nothing()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        var job = TestRig.Login(budgetSeconds: 30);

        Assert.Null(job.Material);

        await using var context = ContextFor(rig, AgentClass.Pooled, job);

        Assert.False(context.KeepsSession);
    }

    /// <summary>
    /// BUT A REFRESH ON THE FLEET DID: the bundle's cookie jar is restored
    /// into the browser, and that IS a session it may still be holding.
    /// </summary>
    /// <remarks>
    /// THE CASE THAT DECIDED THE SHAPE OF THIS FLAG. Gating on "is this a BYO
    /// agent?" would have been the same answer everywhere else and wrong here,
    /// and wrong in the expensive direction: Amazon's refresh has skipped its
    /// sign-in off exactly this restored jar since before the seam existed, and
    /// a gate keyed on the agent class would have taken that away and started
    /// driving a full sign-in - password, one-time code and all - at a browser
    /// that was already on the order list.
    /// </remarks>
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

        // No profile anywhere on this agent - the jar alone is what opens the
        // gate.
        Assert.Null(rig.Runner.BrowserOptionsForTest(job, Manifest(AgentClass.Pooled)).ProfileDirectory);
        Assert.True(context.KeepsSession);
    }

    /// <summary>
    /// And a context built outside the runner claims nothing, which is the
    /// contract's own default.
    /// </summary>
    /// <remarks>
    /// The inline runner in the control plane, every test double, anything with
    /// no browser at all: none of them kept a session, so none of them may say
    /// they might have. The dangerous direction is the other one - a "maybe"
    /// from somewhere that has no browser sends an adapter navigating to ask a
    /// provider about a page that does not exist.
    /// </remarks>
    [Fact]
    public async Task A_context_with_no_browser_of_its_own_keeps_nothing()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());

        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        Assert.False(context.KeepsSession);
    }
}
