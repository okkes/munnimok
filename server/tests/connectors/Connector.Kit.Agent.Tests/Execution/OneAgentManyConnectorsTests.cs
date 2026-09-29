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

/// <summary>
/// ONE AGENT, SEVERAL CONNECTORS - running.
///
/// <para>
/// <c>ConnectorListTests</c> is about the configuration. This is about the
/// process it produces: several lease loops in one container, each enrolled
/// with its own connector, sharing one set of adapters, one browser budget and
/// one scratch root. Everything asserted here is something that was true by
/// construction while a process served one connector and has to be made true
/// on purpose now that it serves three.
/// </para>
/// </summary>
public sealed class OneAgentManyConnectorsTests
{
    private const string Bank = "bank";
    private const string Registry = "registry";

    /// <summary>
    /// BOTH CONNECTORS ENROLL, EACH WITH ITS OWN CODE, AND BOTH SAY SO.
    /// </summary>
    /// <remarks>
    /// A code is signed with the minting connector's key and names the subject
    /// it was minted for, so redeeming the bank's code at the registry
    /// connector fails - and a process holding two of them has to hand each to
    /// the right one. The online line is asserted in full because it is now
    /// printed once per connector by one machine: without the connector's name
    /// in it, three of them are the same sentence three times and the one
    /// question a reader has - did they all come up - has no answer.
    /// </remarks>
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
                "bank: agent agt_bank online: providers test-provider; runtimes browser_interactive; " +
                "concurrency 1 for the whole machine",
                machine.Log.Lines);
            Assert.Contains(
                "registry: agent agt_registry online: providers test-provider; runtimes browser_interactive; " +
                "concurrency 1 for the whole machine",
                machine.Log.Lines);

            // Its own code at its own connector, exactly once each.
            var bank = Assert.Single(machine.Control(Bank).Enrollments);
            var registry = Assert.Single(machine.Control(Registry).Enrollments);

            Assert.Equal("AGNT-BANK-0001", bank.Code);
            Assert.Equal("AGNT-REGISTRY-0002", registry.Code);

            // And one state file holds both identities, each under the control
            // plane that issued it.
            Assert.Equal("agt_bank", machine.State.Load(machine.Control(Bank).BaseAddress.AbsoluteUri)?.AgentId);
            Assert.Equal(
                "agt_registry", machine.State.Load(machine.Control(Registry).BaseAddress.AbsoluteUri)?.AgentId);
        }
        finally
        {
            await machine.StopAsync();
        }
    }

    /// <summary>
    /// ONE JOB AT A TIME MEANS ONE JOB ON THE MACHINE, not one per connector.
    /// </summary>
    /// <remarks>
    /// The limit used to be a semaphore inside each host, which is the same
    /// number and a different meaning: three connectors would have opened three
    /// browsers under a setting that reads <c>1</c>. The BYO compose file says
    /// what that costs - "Two jobs on one agent are two browsers in one
    /// process, and a fault in the process is a fault across both" - and a
    /// household NAS is exactly the machine where nobody is watching when it
    /// happens.
    /// <para>
    /// Both connectors have work waiting, so the second job is not slow to
    /// arrive: it is being held back. Releasing the first lets it through,
    /// which is what tells a shared limit from a dropped job.
    /// </para>
    /// </remarks>
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

            // Long enough for the other connector's lease loop to have leased
            // and started its job, had anything been willing to let it.
            await Task.Delay(300);

            Assert.Equal(1, Volatile.Read(ref adapter.Peak));
            Assert.Equal(1, Volatile.Read(ref adapter.Started));

            // And the one that waited is not one that was dropped.
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

    /// <summary>
    /// AND THE HARNESS CAN SEE TWO, which is what makes the case above mean
    /// anything.
    /// </summary>
    /// <remarks>
    /// "Never more than one" passes just as well against a rig where two
    /// connectors could never overlap - one adapter that is never entered
    /// twice, a control plane that hands out one job. Raising the machine's
    /// limit and watching a job from each connector sit inside the adapter
    /// together is the control.
    /// </remarks>
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

    /// <summary>
    /// A REVOKE FROM ONE CONNECTOR COSTS THAT CONNECTOR AND NOTHING ELSE.
    /// </summary>
    /// <remarks>
    /// The commonest way to meet a revoke is not somebody revoking anything:
    /// it is a connector restored from a backup taken before this agent
    /// enrolled, which answers 401 to everything it holds. On the old agent
    /// that wiped every browser profile on the machine, cleared the state file
    /// and stopped the process - so one connector's database restore would take
    /// the DigiD session DUO depends on with it, and DUO has no pooled fleet to
    /// fall back to.
    /// <para>
    /// Four separate things have to be true, and each was a single shared
    /// object until this change: the profiles, the state file, the process, and
    /// the revoked connector's own lease loop - which must stop, or it spends
    /// the night long-polling a control plane that has told it to go away.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_revoke_from_one_connector_leaves_the_others_browsers_enrollment_and_process_alone()
    {
        var clock = new TestClock();
        using var machine = new Machine(clock, concurrency: 1, new NeverRunsAdapter());

        // A signed-in browser on each, as previous connects left them - under
        // the connector's own directory, which is where the composition puts
        // this connector's profiles.
        var bankProfile = machine.PlantProfile(Bank, "own-agt_bank-test-provider");
        var registryProfile = machine.PlantProfile(Registry, "own-agt_registry-test-provider");

        try
        {
            await machine.StartAsync();

            Assert.True(
                await Machine.UntilAsync(() => machine.Log.Lines.Count(Online) == 2),
                "both connectors should have come online first");

            // And then one connector - and only one - says it has never heard
            // of this agent.
            machine.Control(Bank).Revokes = true;

            Assert.True(
                await clock.RunUntilAsync(
                    () => machine.Roster.Retired.Contains(Bank), budget: TimeSpan.FromMinutes(2)),
                "the revoked connector never retired");

            // The revoked one loses exactly what a revoke is about.
            Assert.False(Directory.Exists(bankProfile), "the revoked connector's browser profile is still on disk");
            Assert.Null(machine.State.Load(machine.Control(Bank).BaseAddress.AbsoluteUri));

            // And the other one loses nothing.
            Assert.True(Directory.Exists(registryProfile), "the other connector's signed-in browser was wiped");
            Assert.Equal(
                "agt_registry", machine.State.Load(machine.Control(Registry).BaseAddress.AbsoluteUri)?.AgentId);

            Assert.False(machine.Lifetime.Stopped, "the process stopped over one connector's 401");
            Assert.Equal([Bank], machine.Roster.Retired);

            // The revoked connector is not merely quiet: its loops are over.
            // A host still running is one still polling a control plane that
            // has revoked it, which nothing at either end would say.
            Assert.True(machine.Host(Bank).ExecuteTask?.IsCompleted, "the revoked connector is still running");
            Assert.False(machine.Host(Registry).ExecuteTask?.IsCompleted, "the other connector stopped too");

            // And when the last connector goes, there is nothing left to
            // serve, so the container is meant to exit.
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

    /// <summary>
    /// One machine serving two connectors, composed the way a
    /// <c>Program.cs</c> composes one: the real
    /// <c>AddConnectorAgent</c> over a configuration in the environment's own
    /// shape, with the control planes, the clock, the log and the process
    /// lifetime swapped for things a test can hold.
    /// </summary>
    /// <remarks>
    /// <b>Built through the registration rather than by hand, because the
    /// registration is half of what is being claimed.</b> A rig that
    /// constructed two hosts and passed them one <see cref="AgentSlots"/>
    /// would prove that a shared limit is shared - which is arithmetic - and
    /// nothing about whether the agent a person installs shares one. The same
    /// goes for every other object on the machine's side of the line: the
    /// adapters, the state file, the scratch root and the roster are shared
    /// here because <c>AddConnectorAgent</c> shares them.
    /// </remarks>
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

            // The last registration wins, so the agent's own named clients are
            // registered and then answered by the fakes - one per connector,
            // picked out by the name the client was asked for.
            services.AddSingleton<IHttpClientFactory>(new Switchboard(_controls));

            _provider = services.BuildServiceProvider();

            // In registration order, which is the order of the list above:
            // the composition builds one host per connection, in the order the
            // configuration states them.
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

        /// <summary>The machine's profile root; each connector has a directory under it.</summary>
        public string ProfileRoot => Path.Combine(_root, "profiles");

        public FakeControlPlane Control(string connection) => _controls[connection];

        /// <summary>
        /// A signed-in browser for one connector, as a previous connect would
        /// have left it: a directory under that connector's own profile root.
        /// </summary>
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

        /// <summary>
        /// Waits on the wall clock until <paramref name="done"/> holds, for the
        /// cases that run on real time rather than a <see cref="TestClock"/>.
        /// </summary>
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
                // A browser profile the OS has not finished with is not a
                // test failure.
            }
        }

        /// <summary>
        /// Routes each named client to the control plane it belongs to.
        /// </summary>
        /// <remarks>
        /// The name carries the connector - <c>...-keepalive#registry</c> - and
        /// that is the whole of how one process keeps two connectors' calls,
        /// authorities and tokens apart. A switchboard that ignored the name
        /// and answered everything from one fake would pass just as well with
        /// both connectors wired to one control plane, which is the defect.
        /// </remarks>
        private sealed class Switchboard(IReadOnlyDictionary<string, FakeControlPlane> byConnection)
            : IHttpClientFactory
        {
            public HttpClient CreateClient(string name) =>
                byConnection[name[(name.IndexOf('#', StringComparison.Ordinal) + 1)..]].CreateClient(name);
        }
    }

    /// <summary>The log, as the lines a person would read in <c>docker logs</c>.</summary>
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

    /// <summary>Every category in the process writes into the one recording.</summary>
    private sealed class RecordingProvider(RecordingLogger logger) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => logger;

        public void Dispose()
        {
        }
    }

    /// <summary>A lifetime that records whether anything asked the process to stop.</summary>
    private sealed class StubLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _stopping = new();

        public bool Stopped => _stopping.IsCancellationRequested;

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => _stopping.Cancel();
    }

    /// <summary>An adapter that stops dead in the middle of a login and stays there.</summary>
    private sealed class ParkingAdapter : IProviderAdapter
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        private int _running;

        /// <summary>The most jobs this adapter was ever inside at once.</summary>
        public int Peak;

        /// <summary>How many logins have started, whether or not they finished.</summary>
        public int Started;

        public ProviderManifest Describe() => TestRig.Manifest;

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

    /// <summary>An adapter for the cases where no job is ever queued.</summary>
    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => TestRig.Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
