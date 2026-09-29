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

/// <summary>
/// THE OTHER HALF OF EXCLUSIVITY: that the agent honours the setting.
///
/// <para>
/// <c>AgentExclusivityTests</c> asserts the production fleet is configured for
/// one job per agent, and says in as many words what it cannot reach: "it does
/// not prove the agent honours the setting; that is the semaphore in AgentHost
/// and wants a harness this suite does not have yet". So the guarantee - that
/// an agent serving somebody is not also serving somebody else - rested on a
/// config file and a reading of the code.
/// </para>
///
/// <para>
/// This is the harness. The control plane hands out jobs as fast as they are
/// asked for, and the adapter parks in the middle of every one of them, so any
/// slot the host is willing to open is a job visibly in flight.
/// </para>
/// </summary>
public sealed class AgentConcurrencyTests
{
    /// <summary>
    /// An adapter that stops dead in the middle of a login and stays there.
    /// </summary>
    /// <remarks>
    /// The gate is what makes concurrency observable at all: without it a job
    /// finishes before the next lease returns, and one slot and four look
    /// identical from outside. Every login here is in flight until the test
    /// says otherwise.
    /// </remarks>
    private sealed class ParkingAdapter : IProviderAdapter
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private int _running;

        /// <summary>The most jobs this adapter was ever inside at once.</summary>
        public int Peak;

        /// <summary>How many logins have started, whether or not they finished.</summary>
        public int Started;

        public ProviderManifest Manifest { get; } = TestRig.Manifest;

        public ProviderManifest Describe() => Manifest;

        public void Release() => _release.TrySetResult();

        public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
        {
            Interlocked.Increment(ref Started);

            var now = Interlocked.Increment(ref _running);

            // A high-water mark rather than a sample: two jobs can overlap for
            // a moment that no later reading would catch.
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

    /// <summary>A host wired to fakes, with the concurrency under test.</summary>
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

        // The one connection the top-level settings above describe, which is
        // what every single-connector deployment configures and what
        // AddConnectorAgent would resolve them into.
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

    /// <summary>
    /// Waits until the adapter has been entered <paramref name="wanted"/> times
    /// or the budget runs out, so a test never sleeps longer than it must.
    /// </summary>
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

    /// <summary>
    /// AT ONE, THE AGENT HOLDS EXACTLY ONE ACCOUNT HOLDER'S JOB.
    /// </summary>
    /// <remarks>
    /// The production fleet is scaled by running more agents rather than by
    /// giving each more slots, precisely so that "an agent serving somebody is
    /// not also serving somebody else" is arithmetic instead of scheduling.
    /// This is the arithmetic being checked against the code that performs it.
    /// </remarks>
    [Fact]
    public async Task An_agent_set_to_one_never_runs_two_jobs_at_once()
    {
        var (host, adapter, _, root) = Rig(concurrency: 1, jobs: 4);

        try
        {
            await host.StartAsync(CancellationToken.None);

            // One job is in flight, and three are waiting to be leased. If the
            // host were willing to open a second slot it would already have.
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

    /// <summary>
    /// AND THE HARNESS CAN SEE TWO, which is what makes the test above mean
    /// anything.
    /// </summary>
    /// <remarks>
    /// A test asserting "never more than one" passes just as well against a
    /// rig where jobs cannot overlap at all - a lease route that hands out one
    /// job, an adapter that returns before the next arrives, a host that was
    /// never asked to do two things. Raising the setting and watching two
    /// logins sit inside the adapter together is the control.
    /// </remarks>
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
