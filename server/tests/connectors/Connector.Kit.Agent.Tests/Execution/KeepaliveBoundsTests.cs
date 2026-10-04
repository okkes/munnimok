using System.Net;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Execution;

/// <summary>
/// The two calls that are holding something open, and the clock they are
/// allowed to spend on it.
/// </summary>
/// <remarks>
/// <para>
/// An agent had ONE timeout for every control-plane call, because the lease
/// poll and the answer poll are long polls and need seventy seconds. The two
/// calls that are not requests for information but claims - "this job is still
/// mine", "this machine is still here" - inherited it, and both are measured
/// against somebody else's clock.
/// </para>
/// <para>
/// A renewal is due at half the remaining lease, so on a two-minute lease it
/// leaves a minute before expiry; at seventy seconds it was abandoned ten
/// seconds AFTER the lease had lapsed and the sweep had requeued the job. The
/// retry the renewal loop performs - itself a fix, and a good one - could not
/// help, because there was nothing left to renew: a second agent had the job
/// while this one was still driving a bank's twelve-minute registration.
/// </para>
/// <para>
/// A heartbeat is due every thirty seconds against a ninety-second liveness
/// window that exists to forgive three missed beats; at seventy seconds one
/// swallowed beat, plus the full interval the loop then slept, put the next
/// successful beat a hundred and thirty seconds after the last. One blip and
/// every login and fetch naming the agent was refused.
/// </para>
/// <para>
/// These run on <see cref="TestClock"/>, so every number in them is the
/// production number and the whole file costs about two seconds of wall clock.
/// The renewal test beside them bounds its client at 250ms, which can see
/// that the loop went round again but not that it went round IN TIME - it
/// passes unchanged against the seventy-second bound that caused the incident.
/// </para>
/// </remarks>
public sealed class KeepaliveBoundsTests
{
    /// <summary>
    /// How long the control plane may have heard nothing before it calls this
    /// agent offline and refuses to route anything to it.
    /// </summary>
    /// <remarks>
    /// <c>AgentLiveness.OfflineAfterSeconds</c>, restated because it lives in
    /// the hosting library and this suite is the agent alone - deliberately, as
    /// nothing here opens a socket or talks to a database. It is the one number
    /// in this file that can drift, and the remark beside it over there says
    /// what it means: three missed beats, "not one".
    /// </remarks>
    private static readonly TimeSpan OfflineAfter = TimeSpan.FromSeconds(90);

    /// <summary>
    /// A renew that black-holes is given up on with the lease still in hand,
    /// and the next one lands while the job is still this agent's.
    /// </summary>
    [Fact]
    public async Task A_renew_that_black_holes_is_abandoned_and_retried_inside_the_lease()
    {
        var clock = new TestClock();
        var parked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var rig = new TestRig(new ScriptedAdapter((_, ct) => parked.Task.WaitAsync(ct)), time: clock);
        rig.Control.StallRenewals(1);

        // The lease a control plane really hands out, and a working budget far
        // longer than it, so that nothing but this test ends the job.
        var leaseSeconds = new HeartbeatResponse().LeaseTtlSeconds;
        var job = TestRig.Login(budgetSeconds: 3600, leaseSeconds: leaseSeconds);

        var running = rig.RunAsync(job, leaseTtlSeconds: leaseSeconds);

        // Two lease-lengths of virtual time: enough for the old bound to have
        // given up (at 130s) and renewed again (at 135s), so a failure here
        // reports the wrong NUMBER rather than a test that ran out of patience.
        var renewed = await clock.RunUntilAsync(
            () => rig.Control.Renewals >= 1, budget: TimeSpan.FromSeconds(leaseSeconds * 2));

        parked.SetResult();
        await running.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.True(renewed, "no renewal ever landed after the one the client gave up on");

        // Which client the renew went out on, which is the fix: the keepalive
        // one's ten seconds rather than the long polls' seventy. And the cost
        // in agent time, which is the same ten within a step of the clock.
        var abandoned = Assert.Single(rig.Control.GaveUp);
        Assert.EndsWith("/renew", abandoned.Path, StringComparison.Ordinal);
        Assert.Equal(rig.Options.KeepaliveTimeout, abandoned.Bound);
        Assert.InRange(abandoned.Held, abandoned.Bound, abandoned.Bound + (2 * TestClock.Step));

        // And the point of the bound: the retry arrived while the lease was
        // still ours. A renewal that lands after expiry renews nothing - the
        // sweep has already requeued the job and handed it to somebody else.
        var landedAt = rig.Control.RenewedAt[0];
        Assert.True(
            landedAt < job.LeaseExpiresAt,
            $"the renewal landed {(landedAt - job.LeaseExpiresAt).TotalSeconds:F0}s after the lease expired");

        // The run itself was never disturbed: a lease read as lost cancels the
        // job and posts nothing at all.
        Assert.Equal(0, rig.Control.FailureCount);
        Assert.NotNull(rig.Control.Result);
    }

    /// <summary>
    /// Beats that black-hole cost beats, not the agent's place in the fleet.
    /// </summary>
    /// <remarks>
    /// TWO IN A ROW, because that is the case the window is sized for and the
    /// case that needs both halves of the fix. One swallowed beat survives a
    /// ninety-second window on the shorter bound alone - thirty of interval,
    /// ten of bound, thirty of the interval the loop then slept, and seventy is
    /// under ninety. Two of them is a hundred and ten, and the agent goes
    /// offline over a link that came back almost immediately. It is sixty with
    /// the failed beat retried in five, which is what <c>AgentLiveness</c>
    /// means by forgiving three missed beats rather than one.
    /// </remarks>
    [Fact]
    public async Task Heartbeats_that_black_hole_are_beaten_again_inside_the_liveness_window()
    {
        var clock = new TestClock();
        var (host, control, options, root) = Agent(clock);

        try
        {
            await host.StartAsync(CancellationToken.None);

            // The first beat is the reference point: the window is measured
            // between beats that LANDED, so one has to land first.
            Assert.True(
                await clock.RunUntilAsync(() => control.BeatsAt.Count >= 1, budget: TimeSpan.FromMinutes(1)),
                "the agent never beat at all, so this test can say nothing about the gap between beats");

            control.StallHeartbeats(2);

            // Four minutes of budget, because the old behaviour's answer is a
            // beat at 230s: a failure should report the wrong NUMBER rather
            // than a test that ran out of patience.
            var beatAgain = await clock.RunUntilAsync(
                () => control.BeatsAt.Count >= 2, budget: TimeSpan.FromMinutes(4));

            Assert.True(beatAgain, "the agent never beat again after the ones the client gave up on");

            var gap = control.BeatsAt[1] - control.BeatsAt[0];

            // THE WHOLE CLAIM: the control plane never had cause to call this
            // agent offline. That window is what a login naming this agent, and
            // every fetch on it, is refused by.
            Assert.True(
                gap < OfflineAfter,
                $"the agent was silent for {gap.TotalSeconds:F0}s against a {OfflineAfter.TotalSeconds:F0}s " +
                "liveness window, so every login and fetch naming it was refused");

            // The number it is, in a quiet run: thirty seconds of interval, then
            // twice a ten-second bound and a five-second retry - sixty, give or
            // take the steps of the clock a beat is stamped late by. It is NOT
            // asserted. A loaded runner lets a continuation lag whole steps
            // behind the clock (CI, 2026-10-02: 65s; 2026-10-04: 44s, the client
            // having given up on a beat the fake went on to answer), and the
            // claim is the window - the old behaviour answered 230s, and that
            // is what the assertion above refuses.

            // The bound itself, read the same way as the renewal's: the beats
            // that black-holed went out on the keepalive client and cost its
            // ten seconds each. At least the two that were stalled - one more
            // is the runner, not the agent.
            Assert.True(
                control.GaveUp.Count >= 2,
                $"only {control.GaveUp.Count} beat(s) were given up on, so the two stalled ones were not both bounded");

            foreach (var abandoned in control.GaveUp)
            {
                Assert.EndsWith("/heartbeat", abandoned.Path, StringComparison.Ordinal);
                Assert.Equal(options.KeepaliveTimeout, abandoned.Bound);
                Assert.InRange(abandoned.Held, abandoned.Bound, abandoned.Bound + (2 * TestClock.Step));
            }
        }
        finally
        {
            await host.StopAsync(new CancellationTokenSource(TimeSpan.FromSeconds(30)).Token);
            host.Dispose();
            Cleanup(root);
        }
    }

    /// <summary>
    /// A beat the client gave up on comes back named as a timeout, not as a
    /// cancellation.
    /// </summary>
    /// <remarks>
    /// The distinction that has already cost this codebase three separate
    /// defects - the frame POST, the input poll, the renew. <c>Timeout</c>
    /// surfaces as a <c>TaskCanceledException</c>, which IS an
    /// <c>OperationCanceledException</c>, and each of those loops had an arm
    /// reading that as "we have been told to stop" and stopped for good.
    /// <para>
    /// The heartbeat loop survives one either way, because its arm asks whose
    /// token fired rather than what type arrived - but that single filter is
    /// the entire margin, the renew's looked just as safe, and a beat now has
    /// a bound it is expected to hit occasionally rather than one longer than
    /// anything that could go wrong. So the shape of the failure is asserted:
    /// a 408, transient, and nothing a caller could mistake for a shutdown.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_heartbeat_the_client_gives_up_on_is_a_timeout_rather_than_a_cancellation()
    {
        var clock = new TestClock();
        var control = new FakeControlPlane { Time = clock };
        control.StallHeartbeats(1);

        var client = new ControlPlaneClient(control, NullLogger<ControlPlaneClient>.Instance);
        var beating = client.HeartbeatAsync(
            new HeartbeatRequest { Capabilities = new AgentCapabilities() }, CancellationToken.None);

        Assert.True(
            await clock.RunUntilAsync(() => beating.IsCompleted, budget: TimeSpan.FromMinutes(2)),
            "the client never gave up on the beat at all");

        var failed = await Assert.ThrowsAsync<ControlPlaneException>(() => beating);
        Assert.Equal(HttpStatusCode.RequestTimeout, failed.Status);
        Assert.True(failed.IsTransient, "a beat nobody answered is worth sending again");
    }

    /// <summary>
    /// The composition an agent actually boots with puts the two bounds where
    /// this file assumes they are.
    /// </summary>
    /// <remarks>
    /// The cases above wire a <see cref="ControlPlaneClient"/> onto a fake
    /// factory, so they prove which CLIENT NAME each call asks for and nothing
    /// about what that name is worth in a running agent. This is the other
    /// half, in the style of <c>ByoAgentRuntimesTests</c>: the registration
    /// every <c>Program.cs</c> calls, asked what it gave each client.
    /// </remarks>
    [Fact]
    public void The_registration_bounds_the_keepalives_apart_from_the_long_polls()
    {
        var services = new ServiceCollection();
        services.AddConnectorAgent(new ConfigurationBuilder().Build(), agent =>
        {
            agent.ControlPlaneBaseUrl = new Uri("https://control-plane.test/");
            agent.AddAdapter(ScriptedAdapter.Wedges());
        });

        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();
        var options = provider.GetRequiredService<ConnectorAgentOptions>();

        // Named after the connector they belong to, because a process serving
        // several registers a pair per connector - each with its own base
        // address, its own authority and its own token. This agent has one, so
        // the pair is the one the default connection owns.
        var connection = options.ResolvedConnections()[0].Name;

        Assert.Equal(
            options.ControlPlaneTimeout,
            factory.CreateClient(ControlPlaneClient.ClientNameFor(connection)).Timeout);
        Assert.Equal(
            options.KeepaliveTimeout,
            factory.CreateClient(ControlPlaneClient.KeepaliveClientNameFor(connection)).Timeout);

        // The numbers themselves, because "two clients with the same bound" is
        // the defect wearing the fix's clothes.
        Assert.Equal(TimeSpan.FromSeconds(70), options.ControlPlaneTimeout);
        Assert.Equal(TimeSpan.FromSeconds(10), options.KeepaliveTimeout);
    }

    /// <summary>
    /// A host wired to fakes with nothing to do: no job is ever queued, so the
    /// only thing it does is beat.
    /// </summary>
    private static (AgentHost Host, FakeControlPlane Control, ConnectorAgentOptions Options, string Root) Agent(
        TimeProvider clock)
    {
        var root = Path.Combine(Path.GetTempPath(), "agent-keepalive", Guid.NewGuid().ToString("N"));
        var control = new FakeControlPlane { Time = clock };

        var options = new ConnectorAgentOptions
        {
            ControlPlaneBaseUrl = new Uri("https://control-plane.test/"),
            WorkRootDirectory = Path.Combine(root, "work"),
            ProfileRootDirectory = Path.Combine(root, "profiles"),
            StateFilePath = Path.Combine(root, "agent-state.json"),
            EnrollmentCode = "AGNT-TEST-0000",
        };

        var client = new ControlPlaneClient(control, NullLogger<ControlPlaneClient>.Instance);
        var identity = new AgentIdentity();
        var adapter = ScriptedAdapter.Wedges();
        var registry = new TestRig.SingleAdapterRegistry(adapter, TestRig.Manifest);
        var profiles = new ProfileStore(options.ProfileRootDirectory, NullLogger<ProfileStore>.Instance);

        var runner = new JobRunner(
            registry,
            client,
            new PolitenessGate(clock),
            profiles,
            identity,
            options,
            NullLoggerFactory.Instance,
            clock);

        var host = new AgentHost(
            new AgentConnection(options.ResolvedConnections()[0], identity, client, profiles, runner),
            options,
            new AgentStateStore(options.StateFilePath, NullLogger<AgentStateStore>.Instance),
            registry,
            new AgentSlots(options.MaxConcurrency),
            new WorkRoot(options, NullLogger<WorkRoot>.Instance),
            new AgentRoster(1, new StopsQuietly(), NullLogger<AgentRoster>.Instance),
            NullLogger<AgentHost>.Instance,
            clock);

        return (host, control, options, root);
    }

    private static void Cleanup(string root)
    {
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory the OS has not finished with is not a failure.
        }
    }

    /// <summary>A lifetime that records nothing: no path here asks to stop.</summary>
    private sealed class StopsQuietly : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }
}
