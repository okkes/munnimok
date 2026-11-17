using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Execution;

// AgentExclusivityTests only checks the fleet's config; the semaphore in AgentHost that honours it is proven here
public sealed class AgentConcurrencyTests
{
    // the gate makes concurrency observable: without it a job finishes before the next lease and one slot looks like four
    private sealed class ParkingAdapter : IProviderAdapter
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private int _running;

        public int Peak;

        public int Started;

        public ProviderManifest Manifest { get; } = TestRig.Manifest;

        public ProviderManifest Describe() => Manifest;

        public void Release() => _release.TrySetResult();

        public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
        {
            Interlocked.Increment(ref Started);

            var now = Interlocked.Increment(ref _running);

            // high-water mark: a brief overlap is missed by any later sample
            int seen;
            while (now > (seen = Volatile.Read(ref Peak))
                   && Interlocked.CompareExchange(ref Peak, now, seen) != seen)
            {
            }

            try
            {
                await _release.Task.WaitAsync(ct).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.Decrement(ref _running);
            }

            return new LoginResult { Material = new SessionMaterial { StorageState = "{}" } };
        }

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private static (AgentHost Host, ParkingAdapter Adapter, FakeControlPlane Control, string Root) Rig(
        int concurrency, int jobs)
    {
        var root = Path.Combine(Path.GetTempPath(), "agent-concurrency", Guid.NewGuid().ToString("N"));

        var adapter = new ParkingAdapter();
        var control = new FakeControlPlane();

        control.Enqueue([.. Enumerable.Range(0, jobs).Select(_ => TestRig.Login(budgetSeconds: 60))]);

        var options = new ConnectorAgentOptions
        {
            ControlPlaneBaseUrl = new Uri("https://control-plane.test/"),
            WorkRootDirectory = Path.Combine(root, "work"),
            ProfileRootDirectory = Path.Combine(root, "profiles"),
            StateFilePath = Path.Combine(root, "agent-state.json"),
            EnrollmentCode = "AGNT-TEST-0000",
            MaxConcurrency = concurrency,
            Headless = true,
        };

        var client = new ControlPlaneClient(control, NullLogger<ControlPlaneClient>.Instance);
        var identity = new AgentIdentity();
        var registry = new TestRig.SingleAdapterRegistry(adapter, TestRig.Manifest);

        var runner = new JobRunner(
            registry,
            client,
            new PolitenessGate(),
            new ProfileStore(options.ProfileRootDirectory, NullLogger<ProfileStore>.Instance),
            identity,
            options,
            NullLoggerFactory.Instance,
            TimeProvider.System);

        var connection = new AgentConnection(
            options.ResolvedConnections()[0],
            identity,
            client,
            new ProfileStore(options.ProfileRootDirectory, NullLogger<ProfileStore>.Instance),
            runner);

        var host = new AgentHost(
            connection,
            options,
            new AgentStateStore(options.StateFilePath, NullLogger<AgentStateStore>.Instance),
            registry,
            new AgentSlots(options.MaxConcurrency),
            new WorkRoot(options, NullLogger<WorkRoot>.Instance),
            new AgentRoster(1, new StubLifetime(), NullLogger<AgentRoster>.Instance),
            NullLogger<AgentHost>.Instance,
            TimeProvider.System);

        return (host, adapter, control, root);
    }

    private sealed class StubLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }

    private static async Task<bool> UntilStartedAsync(ParkingAdapter adapter, int wanted)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(10);

        while (DateTimeOffset.UtcNow < deadline)
        {
            if (Volatile.Read(ref adapter.Started) >= wanted) return true;
            await Task.Delay(20);
        }

        return false;
    }

    // the fleet scales by more agents, not more slots, so one agent never serves two account holders
    [Fact]
    public async Task An_agent_set_to_one_never_runs_two_jobs_at_once()
    {
        var (host, adapter, _, root) = Rig(concurrency: 1, jobs: 4);

        try
        {
            await host.StartAsync(CancellationToken.None);

            Assert.True(await UntilStartedAsync(adapter, 1), "no job ever started");

            await Task.Delay(300);

            Assert.Equal(1, Volatile.Read(ref adapter.Peak));
            Assert.Equal(1, Volatile.Read(ref adapter.Started));
        }
        finally
        {
            adapter.Release();
            await host.StopAsync(CancellationToken.None);
            Cleanup(root);
        }
    }

    // control: "never more than one" also passes on a rig where jobs cannot overlap
    [Fact]
    public async Task An_agent_set_to_two_really_does_run_two()
    {
        var (host, adapter, _, root) = Rig(concurrency: 2, jobs: 4);

        try
        {
            await host.StartAsync(CancellationToken.None);

            Assert.True(
                await UntilStartedAsync(adapter, 2),
                "only one job ever started, so this harness cannot observe concurrency at all and the "
                + "test above proves nothing");

            await Task.Delay(300);

            Assert.Equal(2, Volatile.Read(ref adapter.Peak));
        }
        finally
        {
            adapter.Release();
            await host.StopAsync(CancellationToken.None);
            Cleanup(root);
        }
    }

    private static void Cleanup(string root)
    {
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // A browser profile the OS has not finished with is not a failure.
        }
    }
}
