using System.Collections.Concurrent;
using System.Globalization;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent.Tests.Execution;

// several lease loops in one container share adapters, one browser budget and one scratch root: what held by
// construction for one connector has to be made true on purpose
public sealed class OneAgentManyConnectorsTests
{
    private const string Bank = "bank";
    private const string Registry = "registry";

    // a code is signed with the minting connector's key and names its subject, so each goes to the right connector;
    // the online line carries the connector's name because one machine prints it once per connector
    [Fact]
    public async Task Two_connectors_enroll_independently_and_both_come_online()
    {
        using var machine = new Machine(TimeProvider.System, concurrency: 1, new NeverRunsAdapter());

        try
        {
            await machine.StartAsync();

            Assert.True(
                await Machine.UntilAsync(() => machine.Log.Lines.Count(Online) == 2),
                "both connectors should have come online: " + string.Join(" | ", machine.Log.Lines));

            Assert.Contains(
                "bank: agent agt_bank online: providers explore, test-provider; runtimes browser_interactive; " +
                "concurrency 1 for the whole machine",
                machine.Log.Lines);
            Assert.Contains(
                "registry: agent agt_registry online: providers explore, test-provider; runtimes browser_interactive; " +
                "concurrency 1 for the whole machine",
                machine.Log.Lines);

            var bank = Assert.Single(machine.Control(Bank).Enrollments);
            var registry = Assert.Single(machine.Control(Registry).Enrollments);

            Assert.Equal("AGNT-BANK-0001", bank.Code);
            Assert.Equal("AGNT-REGISTRY-0002", registry.Code);

            Assert.Equal("agt_bank", machine.State.Load(machine.Control(Bank).BaseAddress.AbsoluteUri)?.AgentId);
            Assert.Equal(
                "agt_registry", machine.State.Load(machine.Control(Registry).BaseAddress.AbsoluteUri)?.AgentId);
        }
        finally
        {
            await machine.StopAsync();
        }
    }

    // the limit is per machine, not per host: three connectors would open three browsers under a setting of 1
    // both connectors have work, so the second job is held back, not slow: releasing the first lets it through
    [Fact]
    public async Task One_slot_holds_across_connectors_and_the_second_job_waits_its_turn()
    {
        var adapter = new ParkingAdapter();
        using var machine = new Machine(TimeProvider.System, concurrency: 1, adapter);

        machine.Control(Bank).Enqueue(TestRig.Login(budgetSeconds: 60));
        machine.Control(Registry).Enqueue(TestRig.Login(budgetSeconds: 60));

        try
        {
            await machine.StartAsync();

            Assert.True(
                await Machine.UntilAsync(() => Volatile.Read(ref adapter.Started) >= 1),
                "neither connector ever started its job");

            await Task.Delay(300);

            Assert.Equal(1, Volatile.Read(ref adapter.Peak));
            Assert.Equal(1, Volatile.Read(ref adapter.Started));

            adapter.Release();

            Assert.True(
                await Machine.UntilAsync(() => Volatile.Read(ref adapter.Started) == 2),
                "the second connector's job never ran at all, so the slot was not released to it");
        }
        finally
        {
            adapter.Release();
            await machine.StopAsync();
        }
    }

    // control: "never more than one" also passes on a rig where the connectors cannot overlap
    [Fact]
    public async Task Two_slots_really_do_run_a_job_from_each_connector_at_once()
    {
        var adapter = new ParkingAdapter();
        using var machine = new Machine(TimeProvider.System, concurrency: 2, adapter);

        machine.Control(Bank).Enqueue(TestRig.Login(budgetSeconds: 60));
        machine.Control(Registry).Enqueue(TestRig.Login(budgetSeconds: 60));

        try
        {
            await machine.StartAsync();

            Assert.True(
                await Machine.UntilAsync(() => Volatile.Read(ref adapter.Peak) >= 2),
                "only one job ever ran, so this harness cannot observe two connectors at once and the case "
                + "above proves nothing");
        }
        finally
        {
            adapter.Release();
            await machine.StopAsync();
        }
    }

    // a revoke is commonly a connector restored from a backup older than this agent (401): the old agent wiped every profile,
    // the state and the process. Profiles, state, process and the revoked lease loop (else it long-polls all night) were shared
    [Fact]
    public async Task A_revoke_from_one_connector_leaves_the_others_browsers_enrollment_and_process_alone()
    {
        var clock = new TestClock();
        using var machine = new Machine(clock, concurrency: 1, new NeverRunsAdapter());

        var bankProfile = machine.PlantProfile(Bank, "own-agt_bank-test-provider");
        var registryProfile = machine.PlantProfile(Registry, "own-agt_registry-test-provider");

        try
        {
            await machine.StartAsync();

            Assert.True(
                await Machine.UntilAsync(() => machine.Log.Lines.Count(Online) == 2),
                "both connectors should have come online first");

            machine.Control(Bank).Revokes = true;

            Assert.True(
                await clock.RunUntilAsync(
                    () => machine.Roster.Retired.Contains(Bank), budget: TimeSpan.FromMinutes(2)),
                "the revoked connector never retired");

            Assert.False(Directory.Exists(bankProfile), "the revoked connector's browser profile is still on disk");
            Assert.Null(machine.State.Load(machine.Control(Bank).BaseAddress.AbsoluteUri));

            Assert.True(Directory.Exists(registryProfile), "the other connector's signed-in browser was wiped");
            Assert.Equal(
                "agt_registry", machine.State.Load(machine.Control(Registry).BaseAddress.AbsoluteUri)?.AgentId);

            Assert.False(machine.Lifetime.Stopped, "the process stopped over one connector's 401");
            Assert.Equal([Bank], machine.Roster.Retired);

            // the roster hears of the retire from the heartbeat loop, the lease loop ends on the same token a moment later: wait for it
            Assert.True(
                await Machine.UntilAsync(() => machine.Host(Bank).ExecuteTask?.IsCompleted == true),
                "the revoked connector is still running");
            Assert.False(machine.Host(Registry).ExecuteTask?.IsCompleted, "the other connector stopped too");

            // when the last connector goes there is nothing left to serve, so the container exits
            machine.Control(Registry).Revokes = true;

            Assert.True(
                await clock.RunUntilAsync(() => machine.Lifetime.Stopped, budget: TimeSpan.FromMinutes(2)),
                "the process kept running with no connector left to serve");
        }
        finally
        {
            await machine.StopAsync();
        }
    }

    private static bool Online(string line) => line.Contains(" online: providers ", StringComparison.Ordinal);

    // built through the registration, as it is half the claim: hand-wiring two hosts with one AgentSlots proves only arithmetic
    private sealed class Machine : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(), "agent-many-connectors", Guid.NewGuid().ToString("N"));

        private readonly Dictionary<string, FakeControlPlane> _controls = new(StringComparer.Ordinal);
        private readonly Dictionary<string, AgentHost> _hosts = new(StringComparer.Ordinal);
        private readonly ServiceProvider _provider;

        public Machine(TimeProvider time, int concurrency, IProviderAdapter adapter)
        {
            foreach (var (name, code) in new[] { (Bank, "AGNT-BANK-0001"), (Registry, "AGNT-REGISTRY-0002") })
            {
                _controls[name] = new FakeControlPlane
                {
                    Time = time,
                    BaseAddress = new Uri($"https://{name}.internal:8392/"),
                    AgentId = "agt_" + name,
                };

                Settings[$"ConnectorAgent:Connections:{_controls.Count - 1}:Name"] = name;
                Settings[$"ConnectorAgent:Connections:{_controls.Count - 1}:ControlPlaneBaseUrl"] =
                    _controls[name].BaseAddress.AbsoluteUri;
                Settings[$"ConnectorAgent:Connections:{_controls.Count - 1}:EnrollmentCode"] = code;
            }

            Settings["ConnectorAgent:MaxConcurrency"] = concurrency.ToString(CultureInfo.InvariantCulture);
            Settings["ConnectorAgent:WorkRootDirectory"] = Path.Combine(_root, "work");
            Settings["ConnectorAgent:ProfileRootDirectory"] = ProfileRoot;
            Settings["ConnectorAgent:StateFilePath"] = Path.Combine(_root, "agent-state.json");

            var services = new ServiceCollection();
            services.AddSingleton(time);
            services.AddSingleton<IHostApplicationLifetime>(Lifetime);
            services.AddLogging(builder => builder.AddProvider(new RecordingProvider(Log)));

            services.AddConnectorAgent(
                new ConfigurationBuilder().AddInMemoryCollection(Settings).Build(),
                agent => agent.AddAdapter(adapter));

            // the last registration wins: the agent's named clients are replaced by fakes, one per connector, picked by client name
            services.AddSingleton<IHttpClientFactory>(new Switchboard(_controls));

            _provider = services.BuildServiceProvider();

            var hosts = _provider.GetServices<IHostedService>().Cast<AgentHost>().ToArray();
            _hosts[Bank] = hosts[0];
            _hosts[Registry] = hosts[1];

            State = _provider.GetRequiredService<AgentStateStore>();
            Roster = _provider.GetRequiredService<AgentRoster>();
        }

        public Dictionary<string, string?> Settings { get; } = new(StringComparer.Ordinal);

        public RecordingLogger Log { get; } = new();

        public AgentStateStore State { get; }

        public AgentRoster Roster { get; }

        public StubLifetime Lifetime { get; } = new();

        public string ProfileRoot => Path.Combine(_root, "profiles");

        public FakeControlPlane Control(string connection) => _controls[connection];

        public string PlantProfile(string connection, string profileId)
        {
            var directory = Path.Combine(ProfileRoot, connection, profileId);
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "Cookies"), "a session somebody signed in for");
            return directory;
        }

        public AgentHost Host(string connection) => _hosts[connection];

        public async Task StartAsync()
        {
            foreach (var host in _hosts.Values) await host.StartAsync(CancellationToken.None);
        }

        public async Task StopAsync()
        {
            foreach (var host in _hosts.Values)
            {
                try
                {
                    await host.StopAsync(CancellationToken.None);
                }
                catch (OperationCanceledException)
                {
                    // A host that has already retired is not a failure to stop.
                }
            }

            Dispose();
        }

        public static async Task<bool> UntilAsync(Func<bool> done, int seconds = 10)
        {
            var deadline = DateTimeOffset.UtcNow.AddSeconds(seconds);

            while (DateTimeOffset.UtcNow < deadline)
            {
                if (done()) return true;
                await Task.Delay(20);
            }

            return done();
        }

        public void Dispose()
        {
            _provider.Dispose();

            try
            {
                if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
            }
            catch (IOException)
            {
                // a browser profile the OS has not finished with is not a failure
            }
        }

        // the name carries the connector (`...-keepalive#registry`): how one process keeps calls, authorities and tokens apart
        private sealed class Switchboard(IReadOnlyDictionary<string, FakeControlPlane> byConnection)
            : IHttpClientFactory
        {
            public HttpClient CreateClient(string name) =>
                byConnection[name[(name.IndexOf('#', StringComparison.Ordinal) + 1)..]].CreateClient(name);
        }
    }

    private sealed class RecordingLogger : ILogger
    {
        private readonly ConcurrentQueue<string> _lines = new();

        public IReadOnlyList<string> Lines => [.. _lines];

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel level) => true;

        public void Log<TState>(
            LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            _lines.Enqueue(formatter(state, exception));
        }

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }

    private sealed class RecordingProvider(RecordingLogger logger) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => logger;

        public void Dispose()
        {
        }
    }

    private sealed class StubLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public bool Stopped => _stopping.IsCancellationRequested;

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }

    private sealed class ParkingAdapter : IProviderAdapter
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private int _running;

        public int Peak;

        public int Started;

        public ProviderManifest Describe() => TestRig.Manifest;

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

    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => TestRig.Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
