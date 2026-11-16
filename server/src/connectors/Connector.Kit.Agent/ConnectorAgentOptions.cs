using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent;

// pooled NAS agents and BYO agents run the same image and differ only by this; from Connections down is per CONNECTOR,
// the rest per MACHINE: a per-connector browser limit would mean three Chromiums on a household NAS
public sealed class ConnectorAgentOptions
{
    public const string SectionName = "ConnectorAgent";

    private readonly List<ServiceDescriptor> _adapters = [];

    // empty = the ordinary single-connector deployment via the ControlPlaneBaseUrl shorthand (ResolvedConnections yields one)
    // filled = one process with one browser root and concurrency limit, several lease loops
    public IList<ConnectorConnection> Connections { get; } = [];

    public Uri? ControlPlaneBaseUrl { get; set; }

    // only needed until enrolled; the state file carries the identity afterwards
    public string? EnrollmentCode { get; set; }

    /// <summary>Operator-facing, shown in the user's agent list.</summary>
    public string AgentName { get; set; } = Environment.MachineName;

    /// <summary>Provider ids this agent serves. Empty means "everything registered here".</summary>
    public IList<string> Providers { get; } = [];

    /// <summary>Runtime tiers this agent can serve. Empty means "everything registered here".</summary>
    public IList<ProviderRuntime> Runtimes { get; } = [];

    /// <summary>Where this agent's traffic leaves from. Null means it makes no claim.</summary>
    public EgressRequirement? Egress { get; set; }

    // per machine across all connectors: a job is a browser and two in one process share a fault
    // a per-connector limit would run several Chromiums under a setting that reads 1
    public int MaxConcurrency { get; set; } = 1;

    public AgentClass Class { get; set; } = AgentClass.Pooled;

    // this, ProfileRootDirectory and WorkRootDirectory must be unique per agent PROCESS: two would sweep each other's scratch
    // connectors in one process share them safely: state file by control plane, profile root by name, work root by job
    public string StateFilePath { get; set; } = Path.Combine(DefaultDataRoot(), "agent-state.json");

    // one connector owns the root outright; several get a sub-directory each (ConnectorConnection.OwnsTheRoot)
    public string ProfileRootDirectory { get; set; } = Path.Combine(DefaultDataRoot(), "profiles");

    // temp, not the data root: nothing here survives a job; swept clean at startup
    public string WorkRootDirectory { get; set; } = Path.Combine(Path.GetTempPath(), "connector-agent-work");

    public bool Headless { get; set; } = true;

    // a phone by default, for the STREAMED LOGIN: the page is shown to someone on a phone; desktop layouts are a postage stamp
    // Pixel 5 because it is Chromium reporting itself as Chromium, so the user agent is true. null = desktop Chromium
    public string? BrowserDevice { get; set; } = "Pixel 5";

    // null = bundled Chromium: an agent, BYO included, is a container with no Chrome; defaulting to chrome failed every launch
    // configurable for an image that ships Chrome or a provider that refuses Chromium
    public string? BrowserChannel { get; set; }

    public string? BrowserLocale { get; set; }

    public string? BrowserTimezoneId { get; set; }

    // 12h is a judgment, not a measurement: KeptSessionStore breaks the session-cookie rule on purpose
    // covers this morning's connect serving this evening's fetch, stops short of a bank session across a weekend
    // not a promise the session lasts (DUO: 15 min inactivity); Zero turns the carry off
    public TimeSpan KeptSessionLifetime { get; set; } = TimeSpan.FromHours(12);

    public TimeSpan ProviderHttpTimeout { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>Backstop between challenge-answer long-polls.</summary>
    public TimeSpan AnswerPollInterval { get; set; } = TimeSpan.FromSeconds(2);

    // 70s because of the long polls: the lease poll hangs 30s by contract, the answer poll as long as the control plane holds it
    // a shorter client would turn every empty poll into a failure
    public TimeSpan ControlPlaneTimeout { get; set; } = TimeSpan.FromSeconds(70);

    // 10s from the windows these calls sit in: renewal at half the remaining lease (2 min TTL), heartbeat every 30s,
    // offline at 90s; at 70s an abandoned renewal came after the lease lapsed and the job was requeued
    // not shorter: a residential uplink has bad moments
    public TimeSpan KeepaliveTimeout { get; set; } = TimeSpan.FromSeconds(10);

    // without it production cannot connect to itself: control planes use an internal-CA certificate a container lacks
    // ADDED to the machine's trust, not replacing it (providers use public roots); null for a public certificate or dev
    public string? ControlPlaneCaPath { get; set; }

    // a login waiting on a human is not worth holding a deploy for
    // this plus ShutdownAbortGrace must fit inside HostOptions.ShutdownTimeout (30s) or the host stops waiting first
    public TimeSpan ShutdownDrainTimeout { get; set; } = TimeSpan.FromSeconds(20);

    /// <summary>How long aborted jobs get to report their failure upstream.</summary>
    public TimeSpan ShutdownAbortGrace { get; set; } = TimeSpan.FromSeconds(8);

    /// <summary>Longest wait between failed lease polls.</summary>
    public TimeSpan MaxLeaseBackoff { get; set; } = TimeSpan.FromSeconds(30);

    internal IReadOnlyList<ServiceDescriptor> AdapterDescriptors => _adapters;

    public ConnectorAgentOptions AddAdapter<T>() where T : class, IProviderAdapter
    {
        _adapters.Add(ServiceDescriptor.Singleton<IProviderAdapter, T>());
        return this;
    }

    public ConnectorAgentOptions AddAdapter(IProviderAdapter adapter)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        _adapters.Add(ServiceDescriptor.Singleton(adapter));
        return this;
    }

    // the shorthand is not a compat shim: one connector is the common case and a list of one would be a worse file
    // the synthesized connection keeps the profile root itself, so a running agent finds its existing browsers (OwnsTheRoot)
    public IReadOnlyList<ConnectorConnection> ResolvedConnections() =>
        Connections.Count > 0
            ? [.. Connections]
            :
            [
                new ConnectorConnection
                {
                    Name = ConnectorConnection.DefaultName,
                    ControlPlaneBaseUrl = ControlPlaneBaseUrl,
                    EnrollmentCode = EnrollmentCode,
                    ControlPlaneCaPath = ControlPlaneCaPath,
                    OwnsTheRoot = true,
                },
            ];

    // an unset provider or runtime list is filled from the registered adapters: empty means "any" and earns jobs it can fail
    // BYO: runtimes are the adapters' and a list omitting one is refused (OwnMachineRuntimes), thrown where manifests are known
    public AgentCapabilities BuildCapabilities(IReadOnlyList<ProviderManifest> manifests)
    {
        ArgumentNullException.ThrowIfNull(manifests);

        // the tiers needed are those of the providers this agent will be asked about, not of ones it does not advertise
        IReadOnlyList<ProviderManifest> served = Providers.Count > 0
            ? [.. manifests.Where(m => Providers.Contains(m.Id, StringComparer.Ordinal))]
            : manifests;

        IReadOnlyList<ProviderRuntime> needed = [.. served.Select(m => m.Runtime).Distinct().Order()];

        return new AgentCapabilities
        {
            Providers = Providers.Count > 0
                ? [.. Providers]
                : [.. manifests.Select(m => m.Id).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)],
            Runtimes = AdvertisedRuntimes(served, needed),
            Egress = Egress,
            MaxConcurrency = MaxConcurrency,
            Class = Class,
            // same setting AgentJobContext.Attended is built from, read once so the queue claim and the run-time condition cannot drift
            Headed = !Headless,
            BrowserVersion = AgentBrowser.Version,
        };
    }

    // the digest of the registry the agent really runs, so the control plane can tell agents on the same adapter code apart
    public AgentCapabilities BuildCapabilities(IProviderRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        // The agent-served digest: the one the control plane compares (IProviderRegistry.AgentCatalogDigest)
        return BuildCapabilities(registry.Manifests) with { CatalogDigest = registry.AgentCatalogDigest };
    }

    private IReadOnlyList<ProviderRuntime> AdvertisedRuntimes(
        IReadOnlyList<ProviderManifest> served, IReadOnlyList<ProviderRuntime> needed)
    {
        if (Class == AgentClass.Byo) return OwnMachineRuntimes(served, needed);

        return Runtimes.Count > 0 ? [.. Runtimes] : needed;
    }

    // a BYO agent advertising fewer tiers than its adapters need looks healthy and never leases (CanServe asks for the tier)
    // so on BYO a Runtimes list cannot take a tier away: refused, with tier and provider named
    // pooled agents may advertise browser_persistent: persistent jobs are pinned (prefer_agent) to the agent owning the profile
    private IReadOnlyList<ProviderRuntime> OwnMachineRuntimes(
        IReadOnlyList<ProviderManifest> served,
        IReadOnlyList<ProviderRuntime> needed)
    {
        if (Runtimes.Count == 0) return needed;

        var missing = needed.Where(runtime => !Runtimes.Contains(runtime)).ToList();
        if (missing.Count == 0) return needed;

        var errors = missing.Select(runtime =>
            $"Runtimes leaves out '{WireName(runtime)}', which " +
            string.Join(", ", served.Where(m => m.Runtime == runtime).Select(m => m.Id).Order(StringComparer.Ordinal)) +
            " runs on; a BYO agent serves every tier its adapters need, so drop the Runtimes setting and " +
            "they are derived from the adapters");

        throw new InvalidOperationException(
            $"connector agent configuration is invalid:{Environment.NewLine}- " +
            string.Join(Environment.NewLine + "- ", errors));
    }

    // config and wire spelling (browser_persistent), for messages operators match against their compose file
    internal static string WireName(ProviderRuntime runtime) =>
        JsonNamingPolicy.SnakeCaseLower.ConvertName(runtime.ToString());

    public void Validate()
    {
        var errors = new List<string>();

        errors.AddRange(ConnectionProblems());

        if (string.IsNullOrWhiteSpace(AgentName)) errors.Add("AgentName is required");
        if (MaxConcurrency < 1) errors.Add("MaxConcurrency must be at least 1");
        if (string.IsNullOrWhiteSpace(StateFilePath)) errors.Add("StateFilePath is required");
        if (string.IsNullOrWhiteSpace(ProfileRootDirectory)) errors.Add("ProfileRootDirectory is required");
        if (string.IsNullOrWhiteSpace(WorkRootDirectory)) errors.Add("WorkRootDirectory is required");
        if (_adapters.Count == 0) errors.Add("register at least one adapter with AddAdapter");

        if (Egress is { } egress && egress.Kind is not ("residential" or "any"))
        {
            errors.Add($"Egress.Kind '{egress.Kind}' must be 'residential' or 'any'");
        }

        if (errors.Count > 0)
        {
            throw new InvalidOperationException(
                $"connector agent configuration is invalid:{Environment.NewLine}- " +
                string.Join(Environment.NewLine + "- ", errors));
        }
    }

    // each rule guards a quiet failure: no connector; duplicate names (a directory under the profile root);
    // two connections on one control plane (state file keyed by it, enrollment overwritten); shorthand beside a list
    private string? ShorthandBesideTheList()
    {
        var shorthand = new List<string>();
        if (ControlPlaneBaseUrl is not null) shorthand.Add("ControlPlaneBaseUrl");
        if (!string.IsNullOrWhiteSpace(EnrollmentCode)) shorthand.Add("EnrollmentCode");
        if (!string.IsNullOrWhiteSpace(ControlPlaneCaPath)) shorthand.Add("ControlPlaneCaPath");

        if (shorthand.Count == 0) return null;

        return $"{string.Join(" and ", shorthand)} " +
               $"{(shorthand.Count == 1 ? "is" : "are")} set beside a Connections list; the top-level " +
               "settings are the shorthand for a single connection, so move them into the list or " +
               "drop the list";
    }

    private IEnumerable<string> ConnectionProblems()
    {
        if (Connections.Count == 0 && ControlPlaneBaseUrl is null)
        {
            // no control plane: refuse to boot rather than idle as a healthy-looking agent that never picks up work
            yield return "ControlPlaneBaseUrl is required, or list the connectors this agent serves under " +
                         "Connections (ConnectorAgent:Connections:0:ControlPlaneBaseUrl)";
            yield break;
        }

        var resolved = ResolvedConnections();

        if (Connections.Count > 0 && ShorthandBesideTheList() is { } shorthand)
        {
            yield return shorthand;
        }

        foreach (var problem in resolved.SelectMany(connection => connection.Problems()))
        {
            yield return problem;
        }

        foreach (var duplicate in resolved
                     .GroupBy(connection => connection.Name, StringComparer.OrdinalIgnoreCase)
                     .Where(group => group.Count() > 1))
        {
            // case-insensitive: the name is a directory and some file systems fold Bank into bank
            yield return $"two connections are called '{duplicate.Key}'; the name is a directory under the " +
                         "profile root and has to tell them apart";
        }

        foreach (var duplicate in resolved
                     .Where(connection => connection.ControlPlaneBaseUrl is not null)
                     .GroupBy(connection => connection.RequireBaseAddress().AbsoluteUri, StringComparer.OrdinalIgnoreCase)
                     .Where(group => group.Count() > 1))
        {
            yield return $"connections {string.Join(" and ", duplicate.Select(c => $"'{c.Name}'").Order(StringComparer.Ordinal))} " +
                         $"both point at {duplicate.Key}; one enrollment belongs to one control plane, so they " +
                         "would overwrite each other's";
        }
    }

    // falls back to the install directory in a container where the user profile is empty
    private static string DefaultDataRoot()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = string.IsNullOrEmpty(local) ? AppContext.BaseDirectory : local;
        return Path.Combine(root, "connector-agent");
    }
}
