using Connector.Kit.Adapters;
using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Networking;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Configuration;

/// CanServe asks for provider AND runtime: the BYO agent once advertised only the pooled tiers, never leased a
/// browser_persistent job, and those died as agent_unavailable. On a BYO agent the tiers come from the adapters and a
/// config leaving one out is refused at startup; a pooled agent keeps its list: the NAS agents cannot run a browser tier
public sealed class AdvertisedRuntimesTests
{
    // Ids that are not substrings of one another, so "named in the message"
    // and "not named in the message" can both be asserted on plain text.
    private const string Persistent = "asn-persistent";
    private const string Interactive = "abn-amro";
    private const string Http = "ing-nl";

    private static readonly ProviderRuntime[] PooledList =
        [ProviderRuntime.Http, ProviderRuntime.BrowserOnce, ProviderRuntime.BrowserInteractive];

    private static ConnectorAgentOptions Options(AgentClass agentClass, params ProviderRuntime[] runtimes)
    {
        var options = new ConnectorAgentOptions { Class = agentClass };
        foreach (var runtime in runtimes) options.Runtimes.Add(runtime);
        return options;
    }

    private static IReadOnlyList<ProviderManifest> BankImage() =>
    [
        Manifest(Persistent, ProviderRuntime.BrowserPersistent),
        Manifest(Interactive, ProviderRuntime.BrowserInteractive),
        Manifest(Http, ProviderRuntime.Http),
    ];

    private static ProviderManifest Manifest(string id, ProviderRuntime runtime) => new()
    {
        Id = id,
        Name = id,
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = runtime,
        Agent = new AgentRequirement
        {
            Required = runtime != ProviderRuntime.Http,
            Class = runtime switch
            {
                ProviderRuntime.Http => AgentClass.Inline,
                ProviderRuntime.BrowserPersistent => AgentClass.Byo,
                _ => AgentClass.Pooled,
            },
        },
        SecretCustody = runtime == ProviderRuntime.BrowserPersistent ? SecretCustody.Agent : SecretCustody.Client,
        UnattendedFetch = runtime == ProviderRuntime.BrowserPersistent,
        Auth = new AuthSpec
        {
            Flow = runtime == ProviderRuntime.BrowserPersistent ? AuthFlow.DevicePersistent : AuthFlow.Password,
            Steps = [],
            Session = new SessionSpec { TtlSeconds = 3600, Refreshable = false },
        },
        Resources = [new ResourceSpec { Id = "accounts", Returns = ResourceShape.Account }],
    };

    /// exact, in enum order: advertising ONLY persistent would be as wrong,
    /// the same image serves ordinary providers persistently on a BYO box
    [Fact]
    public void An_agent_on_your_own_machine_advertises_every_tier_its_adapters_need()
    {
        var capabilities = Options(AgentClass.Byo).BuildCapabilities(BankImage());

        // #562: and the browser it drives, so the control plane can say when that one is behind
        Assert.Equal(AgentBrowser.Version, capabilities.BrowserVersion);

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// the shipped config (the pooled list, in a compose file that never overrode it) gave a healthy-looking useless agent;
    /// the message names the tier as a compose file spells it and the provider that needs it
    [Fact]
    public void A_BYO_configuration_that_leaves_out_a_tier_is_refused_and_names_it()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => Options(AgentClass.Byo, PooledList).BuildCapabilities(BankImage()));

        Assert.Contains("'browser_persistent'", ex.Message, StringComparison.Ordinal);
        Assert.Contains(Persistent, ex.Message, StringComparison.Ordinal);

        Assert.DoesNotContain(Interactive, ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(Http, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_tier_the_configuration_leaves_out_is_named_at_once()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => Options(AgentClass.Byo, ProviderRuntime.Http).BuildCapabilities(BankImage()));

        Assert.Contains("'browser_interactive'", ex.Message, StringComparison.Ordinal);
        Assert.Contains(Interactive, ex.Message, StringComparison.Ordinal);
        Assert.Contains("'browser_persistent'", ex.Message, StringComparison.Ordinal);
        Assert.Contains(Persistent, ex.Message, StringComparison.Ordinal);
    }

    /// a superset is harmless (the provider list gates a lease) but does not leak into the claim:
    /// what is advertised is what the adapters need
    [Fact]
    public void A_BYO_list_that_covers_every_tier_is_accepted_and_the_adapters_still_decide()
    {
        var capabilities = Options(AgentClass.Byo, [.. PooledList, ProviderRuntime.BrowserPersistent])
            .BuildCapabilities(BankImage());

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// the production NAS agents advertise http alone: their egress is a datacenter address browser-tier providers judge;
    /// deriving every agent's tiers from its adapters would put Jumbo's login on the NAS
    [Fact]
    public void A_pooled_agent_is_held_to_the_list_it_was_configured_with()
    {
        var capabilities = Options(AgentClass.Pooled, ProviderRuntime.Http).BuildCapabilities(BankImage());

        Assert.Equal([ProviderRuntime.Http], capabilities.Runtimes);
    }

    /// safe now that every persistent job is pinned to a profile only its owning agent is offered
    [Fact]
    public void A_pooled_agent_with_no_list_advertises_what_its_adapters_need()
    {
        var capabilities = Options(AgentClass.Pooled).BuildCapabilities(BankImage());

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// a BYO agent narrowed to one HTTP provider has no use for browser_persistent: refusing it would misfire
    [Fact]
    public void Only_the_providers_an_agent_advertises_decide_which_tiers_it_needs()
    {
        var options = Options(AgentClass.Byo, ProviderRuntime.Http);
        options.Providers.Add(Http);

        var capabilities = options.BuildCapabilities(BankImage());

        Assert.Equal([Http], capabilities.Providers);
        Assert.Equal([ProviderRuntime.Http], capabilities.Runtimes);
    }

    /// capabilities are built in the host's constructor: a bad claim fails Host.RunAsync before enrollment, like a manifest
    /// that does not validate; deferred to the lease loop it would be the healthy-looking agent again
    [Fact]
    public void An_agent_configured_out_of_a_tier_it_needs_does_not_construct()
    {
        var root = Path.Combine(Path.GetTempPath(), "advertised-runtimes", Guid.NewGuid().ToString("N"));

        try
        {
            Assert.Throws<InvalidOperationException>(() => Host(Options(AgentClass.Byo, PooledList), root));

            // the control: rules out the rig itself being what throws
            using var host = Host(Options(AgentClass.Byo), root);
            Assert.NotNull(host);
        }
        finally
        {
            Cleanup(root);
        }
    }

    private static AgentHost Host(ConnectorAgentOptions options, string root)
    {
        options.ControlPlaneBaseUrl = new Uri("https://control-plane.test/");
        options.WorkRootDirectory = Path.Combine(root, "work");
        options.ProfileRootDirectory = Path.Combine(root, "profiles");
        options.StateFilePath = Path.Combine(root, "agent-state.json");

        var adapter = new NeverRunsAdapter();
        var manifest = Manifest(Persistent, ProviderRuntime.BrowserPersistent);
        var registry = new TestRig.SingleAdapterRegistry(adapter, manifest);
        var control = new FakeControlPlane();
        var client = new ControlPlaneClient(control, NullLogger<ControlPlaneClient>.Instance);
        var identity = new AgentIdentity();
        var profiles = new ProfileStore(options.ProfileRootDirectory, NullLogger<ProfileStore>.Instance);

        var runner = new JobRunner(
            registry,
            client,
            new PolitenessGate(),
            profiles,
            identity,
            options,
            NullLoggerFactory.Instance,
            TimeProvider.System);

        return new AgentHost(
            new AgentConnection(options.ResolvedConnections()[0], identity, client, profiles, runner),
            options,
            new AgentStateStore(options.StateFilePath, NullLogger<AgentStateStore>.Instance),
            registry,
            new AgentSlots(options.MaxConcurrency),
            new WorkRoot(options, NullLogger<WorkRoot>.Instance),
            new AgentRoster(1, new NeverStops(), NullLogger<AgentRoster>.Instance),
            NullLogger<AgentHost>.Instance,
            TimeProvider.System);
    }

    private static void Cleanup(string root)
    {
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory the OS is still holding is not a test failure.
        }
    }

    private sealed class NeverRunsAdapter : IProviderAdapter
    {
        public ProviderManifest Describe() => Manifest(Persistent, ProviderRuntime.BrowserPersistent);

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private sealed class NeverStops : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => CancellationToken.None;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication()
        {
        }
    }
}
