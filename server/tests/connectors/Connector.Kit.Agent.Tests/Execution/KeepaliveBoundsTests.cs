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

// one 70s timeout (long polls) also covered renew and heartbeat: a renew abandoned at 70s came after a 2-minute
// lease lapsed; a swallowed beat put the next one 130s out, past the 90s liveness window
// TestClock with production numbers; the 250ms renewal test cannot see that the loop went round in time
public sealed class KeepaliveBoundsTests
{
    // AgentLiveness.OfflineAfterSeconds, restated: it lives in the hosting library and this suite touches no socket or database
    private static readonly TimeSpan OfflineAfter = TimeSpan.FromSeconds(90);

    [Fact]
    public async Task A_renew_that_black_holes_is_abandoned_and_retried_inside_the_lease()
    {
        var clock = new TestClock();
        var parked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var rig = new TestRig(new ScriptedAdapter((_, ct) => parked.Task.WaitAsync(ct)), time: clock);
        rig.Control.StallRenewals(1);

        var leaseSeconds = new HeartbeatResponse().LeaseTtlSeconds;
        var job = TestRig.Login(budgetSeconds: 3600, leaseSeconds: leaseSeconds);

        var running = rig.RunAsync(job, leaseTtlSeconds: leaseSeconds);

        // two lease-lengths of virtual time: the old bound gave up at 130s and renewed at 135s
        var renewed = await clock.RunUntilAsync(
            () => rig.Control.Renewals >= 1, budget: TimeSpan.FromSeconds(leaseSeconds * 2));

        parked.SetResult();
        await running.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.True(renewed, "no renewal ever landed after the one the client gave up on");

        // the renew goes out on the keepalive client's ten seconds, not the long polls' seventy
        var abandoned = Assert.Single(rig.Control.GaveUp);
        Assert.EndsWith("/renew", abandoned.Path, StringComparison.Ordinal);
        Assert.Equal(rig.Options.KeepaliveTimeout, abandoned.Bound);
        Assert.InRange(abandoned.Held, abandoned.Bound, abandoned.Bound + (2 * TestClock.Step));

        // the retry must land while the lease is still ours: after expiry the sweep has requeued the job
        var landedAt = rig.Control.RenewedAt[0];
        Assert.True(
            landedAt < job.LeaseExpiresAt,
            $"the renewal landed {(landedAt - job.LeaseExpiresAt).TotalSeconds:F0}s after the lease expired");

        // a lease read as lost cancels the job and posts nothing
        Assert.Equal(0, rig.Control.FailureCount);
        Assert.NotNull(rig.Control.Result);
    }

    // two in a row is what the 90s window is sized for: one swallowed beat is 30+10+30=70 and passes on the shorter bound alone,
    // two are 110 and went offline; with the failed beat retried in five it is 60 (three missed beats forgiven, not one)
    [Fact]
    public async Task Heartbeats_that_black_hole_are_beaten_again_inside_the_liveness_window()
    {
        var clock = new TestClock();
        var (host, control, options, root) = Agent(clock);

        try
        {
            await host.StartAsync(CancellationToken.None);

            // the window is measured between beats that landed, so one must land first
            Assert.True(
                await clock.RunUntilAsync(() => control.BeatsAt.Count >= 1, budget: TimeSpan.FromMinutes(1)),
                "the agent never beat at all, so this test can say nothing about the gap between beats");

            control.StallHeartbeats(2);

            // four minutes: the old behaviour beat at 230s, so a failure reports the wrong number
            var beatAgain = await clock.RunUntilAsync(
                () => control.BeatsAt.Count >= 2, budget: TimeSpan.FromMinutes(4));

            Assert.True(beatAgain, "the agent never beat again after the ones the client gave up on");

            var gap = control.BeatsAt[1] - control.BeatsAt[0];

            // the claim: the control plane never had cause to call this agent offline, which refuses every login and fetch naming it
            Assert.True(
                gap < OfflineAfter,
                $"the agent was silent for {gap.TotalSeconds:F0}s against a {OfflineAfter.TotalSeconds:F0}s " +
                "liveness window, so every login and fetch naming it was refused");

            // about 60s in a quiet run, not asserted: a loaded runner lags whole clock steps (65s, 44s seen); old: 230s

            // the black-holed beats went out on the keepalive client and cost its ten seconds each; at least the two stalled ones
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

    // Timeout surfaces as TaskCanceledException, which the frame POST, input poll and renew loops each read as "stop" and quit
    // the heartbeat arm survives by asking whose token fired; that filter is the whole margin, so the 408 shape is asserted
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

    // the cases above prove only which client name each call asks for; this checks what the registration gives each client
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

        // named per connection: a process serving several registers a pair per connector, each with its own address and token
        var connection = options.ResolvedConnections()[0].Name;

        Assert.Equal(
            options.ControlPlaneTimeout,
            factory.CreateClient(ControlPlaneClient.ClientNameFor(connection)).Timeout);
        Assert.Equal(
            options.KeepaliveTimeout,
            factory.CreateClient(ControlPlaneClient.KeepaliveClientNameFor(connection)).Timeout);

        // the numbers themselves: two clients with the same bound is the defect wearing the fix's clothes
        Assert.Equal(TimeSpan.FromSeconds(70), options.ControlPlaneTimeout);
        Assert.Equal(TimeSpan.FromSeconds(10), options.KeepaliveTimeout);
    }

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

    private sealed class StopsQuietly : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }
}
