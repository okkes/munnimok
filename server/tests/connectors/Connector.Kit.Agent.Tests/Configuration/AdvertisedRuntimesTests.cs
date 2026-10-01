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

/// <summary>
/// Which tiers an agent tells the queue it can serve.
///
/// <para>
/// The claim is everything. <c>AgentCapabilities.CanServe</c> asks for the
/// provider AND the runtime, and a job whose tier an agent does not advertise
/// is never offered to it, however many adapters the image carries. The BYO
/// agent shipped advertising the pooled fleet's three tiers and not
/// browser_persistent - every image's appsettings said so, and the BYO compose
/// file set the class and never touched the runtimes - so it enrolled,
/// heartbeated, logged asn-persistent as online and never leased one of its
/// logins. Each sat queued for half an hour and died as agent_unavailable,
/// with the machine that existed to serve it idling beside it.
/// </para>
///
/// <para>
/// So on a BYO agent the tiers come from the adapters, always, and a
/// configuration that leaves one out is refused before the agent is online
/// rather than honoured into silence. A pooled agent keeps its configured
/// list: the production NAS agents genuinely cannot run a browser tier, and
/// saying so is the point of the setting.
/// </para>
/// </summary>
public sealed class AdvertisedRuntimesTests
{
    // Ids that are not substrings of one another, so "named in the message"
    // and "not named in the message" can both be asserted on plain text.
    private const string Persistent = "asn-persistent";
    private const string Interactive = "abn-amro";
    private const string Http = "ing-nl";

    /// <summary>The three tiers the pooled fleet's appsettings used to list.</summary>
    private static readonly ProviderRuntime[] PooledList =
        [ProviderRuntime.Http, ProviderRuntime.BrowserOnce, ProviderRuntime.BrowserInteractive];

    private static ConnectorAgentOptions Options(AgentClass agentClass, params ProviderRuntime[] runtimes)
    {
        var options = new ConnectorAgentOptions { Class = agentClass };
        foreach (var runtime in runtimes) options.Runtimes.Add(runtime);
        return options;
    }

    /// <summary>A bank image's worth of adapters: one provider per tier it ships.</summary>
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

    /// <summary>
    /// YOUR OWN MACHINE SERVES EVERY TIER ITS ADAPTERS NEED.
    /// </summary>
    /// <remarks>
    /// Exact, in the order the enum declares them: the persistent tier is
    /// the one that was missing, but an agent advertising ONLY that would be
    /// just as wrong the other way round - the same image serves ordinary
    /// providers persistently on a BYO box, and those have tiers of their own.
    /// </remarks>
    [Fact]
    public void An_agent_on_your_own_machine_advertises_every_tier_its_adapters_need()
    {
        var capabilities = Options(AgentClass.Byo).BuildCapabilities(BankImage());

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// <summary>
    /// AND A CONFIGURATION THAT LEAVES ONE OUT IS REFUSED, BY NAME.
    /// </summary>
    /// <remarks>
    /// This is the configuration that shipped: the pooled fleet's list, in a
    /// file the BYO compose never overrode. Honouring it produced an agent
    /// that was healthy in every way anyone looked at and useless in the one
    /// way that mattered. The message names the tier as the operator spells
    /// it in a compose file and the provider that needs it, because "invalid
    /// configuration" alone sends them back to the same file with nothing to
    /// look for.
    /// </remarks>
    [Fact]
    public void A_BYO_configuration_that_leaves_out_a_tier_is_refused_and_names_it()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => Options(AgentClass.Byo, PooledList).BuildCapabilities(BankImage()));

        Assert.Contains("'browser_persistent'", ex.Message, StringComparison.Ordinal);
        Assert.Contains(Persistent, ex.Message, StringComparison.Ordinal);

        // The providers whose tiers WERE listed are not blamed for the one
        // that was not.
        Assert.DoesNotContain(Interactive, ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(Http, ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Every missing tier is named, not just the first.
    /// </summary>
    /// <remarks>
    /// An operator fixing one line and restarting into the next error is
    /// the slowest way to learn what a file should say.
    /// </remarks>
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

    /// <summary>
    /// A BYO list that covers every tier is not an error, and still not the
    /// answer: the adapters decide.
    /// </summary>
    /// <remarks>
    /// A list carrying browser_once for an image with no browser_once
    /// provider is harmless - the provider list is what gates a lease - but
    /// what is advertised is what the adapters need, so a superset does not
    /// leak into the claim and an operator cannot be lulled by a file that
    /// happens to be complete today.
    /// </remarks>
    [Fact]
    public void A_BYO_list_that_covers_every_tier_is_accepted_and_the_adapters_still_decide()
    {
        var capabilities = Options(AgentClass.Byo, [.. PooledList, ProviderRuntime.BrowserPersistent])
            .BuildCapabilities(BankImage());

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// <summary>
    /// THE POOLED FLEET KEEPS ITS LIST.
    /// </summary>
    /// <remarks>
    /// The production NAS agents carry every bank adapter and advertise
    /// <c>http</c> alone, because their egress is a datacenter address that
    /// browser-tier providers judge them on. That restriction is honest and
    /// must survive: a rule that derived every agent's tiers from its adapters
    /// would put Jumbo's login on the NAS.
    /// </remarks>
    [Fact]
    public void A_pooled_agent_is_held_to_the_list_it_was_configured_with()
    {
        var capabilities = Options(AgentClass.Pooled, ProviderRuntime.Http).BuildCapabilities(BankImage());

        Assert.Equal([ProviderRuntime.Http], capabilities.Runtimes);
    }

    /// <summary>
    /// And with no list, a pooled agent advertises what its adapters need -
    /// browser_persistent included, which is safe now that every persistent
    /// job is pinned to a profile only its owning agent is offered.
    /// </summary>
    [Fact]
    public void A_pooled_agent_with_no_list_advertises_what_its_adapters_need()
    {
        var capabilities = Options(AgentClass.Pooled).BuildCapabilities(BankImage());

        Assert.Equal(
            [ProviderRuntime.Http, ProviderRuntime.BrowserInteractive, ProviderRuntime.BrowserPersistent],
            capabilities.Runtimes);
    }

    /// <summary>
    /// Only the providers an agent advertises decide which tiers it needs.
    /// </summary>
    /// <remarks>
    /// A BYO agent narrowed to one HTTP provider has no use for
    /// browser_persistent, and refusing it over a provider it will never be
    /// offered would be the rule misfiring on exactly the operator who read
    /// the settings most carefully.
    /// </remarks>
    [Fact]
    public void Only_the_providers_an_agent_advertises_decide_which_tiers_it_needs()
    {
        var options = Options(AgentClass.Byo, ProviderRuntime.Http);
        options.Providers.Add(Http);

        var capabilities = options.BuildCapabilities(BankImage());

        Assert.Equal([Http], capabilities.Providers);
        Assert.Equal([ProviderRuntime.Http], capabilities.Runtimes);
    }

    /// <summary>
    /// THE REFUSAL IS THE HOST NOT STARTING.
    /// </summary>
    /// <remarks>
    /// "Fails loudly" has to mean somewhere in particular. The capabilities
    /// are built in the host's constructor, so a bad claim is an exception
    /// out of <c>Host.RunAsync</c> before enrollment, before the online line,
    /// before a heartbeat - the same place the registry refuses a manifest
    /// that does not validate. Deferred to the lease loop it would be the
    /// healthy-looking agent this replaces, only with a log line.
    /// </remarks>
    [Fact]
    public void An_agent_configured_out_of_a_tier_it_needs_does_not_construct()
    {
        var root = Path.Combine(Path.GetTempPath(), "advertised-runtimes", Guid.NewGuid().ToString("N"));

        try
        {
            Assert.Throws<InvalidOperationException>(() => Host(Options(AgentClass.Byo, PooledList), root));

            // The control: the same host with the list dropped constructs,
            // which is what rules out the rig itself being the thing that
            // throws.
            using var host = Host(Options(AgentClass.Byo), root);
            Assert.NotNull(host);
        }
        finally
        {
            Cleanup(root);
        }
    }

    /// <summary>An <see cref="AgentHost"/> over fakes, carrying one persistent adapter.</summary>
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
