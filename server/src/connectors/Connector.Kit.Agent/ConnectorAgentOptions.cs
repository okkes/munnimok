using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent;

/// <summary>
/// Everything that makes one agent different from another.
///
/// A pooled agent on the operator's NAS and a user's own BYO agent run the
/// identical image and differ only by what is in here: which providers they
/// advertise, which runtimes they can serve, where their egress is, and
/// whether they hold persistent profiles.
///
/// <para>
/// The settings divide in two, and the division is the shape of the whole
/// agent. Everything from <see cref="Connections"/> is PER CONNECTOR: a
/// control plane, a code, an authority, an identity, a lease loop. Everything
/// else - the adapters, the concurrency limit, the profile root, the browser -
/// is a property of the MACHINE, and is shared by every connector this process
/// serves. Putting the browser limit on the connector would mean three
/// connectors is three Chromiums on a household NAS, which is the failure mode
/// the limit exists to prevent.
/// </para>
/// </summary>
public sealed class ConnectorAgentOptions
{
    public const string SectionName = "ConnectorAgent";

    private readonly List<ServiceDescriptor> _adapters = [];

    /// <summary>
    /// The connectors this agent attaches to, one entry each.
    /// </summary>
    /// <remarks>
    /// <b>Empty is the ordinary single-connector deployment</b>, which
    /// configures its one control plane through
    /// <see cref="ControlPlaneBaseUrl"/> and friends below;
    /// <see cref="ResolvedConnections"/> turns that into exactly one
    /// connection, so three shipped images and every compose file in
    /// <c>deploy/</c> go on working with nothing to change.
    /// <para>
    /// Fill it - <c>ConnectorAgent:Connections:0:Name</c> and so on, which the
    /// environment spells <c>ConnectorAgent__Connections__0__Name</c> - and
    /// one process serves several connectors: one browser root, one
    /// concurrency limit, one container for the household, several lease loops
    /// inside it.
    /// </para>
    /// </remarks>
    public IList<ConnectorConnection> Connections { get; } = [];

    /// <summary>
    /// The control plane's root, e.g. <c>https://ledgerbridge.internal/</c>.
    /// The one-connection shorthand: setting this is the same as listing a
    /// single entry in <see cref="Connections"/>.
    /// </summary>
    public Uri? ControlPlaneBaseUrl { get; set; }

    /// <summary>
    /// The one-time enrollment code. Only needed until the agent has enrolled;
    /// after that the state file carries the identity and this is ignored.
    /// </summary>
    public string? EnrollmentCode { get; set; }

    /// <summary>Operator-facing, shown in the user's agent list.</summary>
    public string AgentName { get; set; } = Environment.MachineName;

    /// <summary>Provider ids this agent serves. Empty means "everything registered here".</summary>
    public IList<string> Providers { get; } = [];

    /// <summary>Runtime tiers this agent can serve. Empty means "everything registered here".</summary>
    public IList<ProviderRuntime> Runtimes { get; } = [];

    /// <summary>Where this agent's traffic leaves from. Null means it makes no claim.</summary>
    public EgressRequirement? Egress { get; set; }

    /// <summary>
    /// How many jobs this MACHINE runs at once, across every connector it
    /// serves.
    /// </summary>
    /// <remarks>
    /// Not per connector, and the difference is the point. A job is a browser,
    /// and the BYO compose file says why one at a time is the whole idea:
    /// "Two jobs on one agent are two browsers in one process, and a fault in
    /// the process is a fault across both". A limit each would have made a
    /// household running the bank, the shopping and the registry connectors
    /// run three Chromiums under a setting that reads <c>1</c>.
    /// </remarks>
    public int MaxConcurrency { get; set; } = 1;

    public AgentClass Class { get; set; } = AgentClass.Pooled;

    /// <summary>
    /// Where the agent ids and tokens are kept between restarts - one entry
    /// per connection, keyed by the control plane that issued it.
    ///
    /// This path, <see cref="ProfileRootDirectory"/> and
    /// <see cref="WorkRootDirectory"/> must be unique per agent PROCESS. Two
    /// agent processes sharing them would sweep each other's scratch
    /// directories out from under running jobs; several connectors inside one
    /// process share all three safely, because each is divided by connection -
    /// the state file by control plane, the profile root by name, and the work
    /// root by job.
    /// </summary>
    public string StateFilePath { get; set; } = Path.Combine(DefaultDataRoot(), "agent-state.json");

    /// <summary>
    /// The root under which persistent browser profiles live. One connector
    /// owns it outright; several get a sub-directory each - see
    /// <see cref="ConnectorConnection.OwnsTheRoot"/>.
    /// </summary>
    public string ProfileRootDirectory { get; set; } = Path.Combine(DefaultDataRoot(), "profiles");

    /// <summary>
    /// The root under which per-job scratch directories are created and
    /// deleted, and which is swept clean at startup. Temp rather than the data
    /// root: nothing here is meant to survive a job, let alone a restart.
    /// </summary>
    public string WorkRootDirectory { get; set; } = Path.Combine(Path.GetTempPath(), "connector-agent-work");

    public bool Headless { get; set; } = true;

    /// <summary>
    /// An honest Playwright device descriptor for a provider that serves a
    /// different site to a phone.
    ///
    /// A phone by default, and that is a decision about the STREAMED LOGIN
    /// rather than about scraping. The page is photographed and shown to
    /// somebody who is very likely holding a phone; a 1280x720 desktop layout
    /// arrives as a postage stamp they have to pinch at, and its links and
    /// boxes are too small to hit accurately through a picture. A mobile
    /// layout is one column of finger-sized targets, which is what the whole
    /// relay needs, and it fits a phone screen with no zooming at all.
    ///
    /// Pixel 5 rather than an iPhone because it is Chromium reporting itself
    /// as Chromium: the agent really is running Chrome, so the user agent is
    /// true rather than a claim about a browser this is not.
    ///
    /// Set to null for desktop Chromium as it ships.
    /// </summary>
    public string? BrowserDevice { get; set; } = "Pixel 5";

    /// <summary>
    /// An installed browser to drive instead of the bundled one, by
    /// Playwright's channel name - <c>chrome</c>, <c>msedge</c>.
    /// </summary>
    /// <remarks>
    /// <b>NULL BY DEFAULT, which is bundled Chromium, because an agent is a
    /// CONTAINER.</b> This defaulted to <c>chrome</c> for one commit, on a
    /// reading of "bring your own agent" as "a Windows desktop with Chrome on
    /// it". A BYO agent is a container on the account holder's own NAS - the
    /// same shape as a pooled one, in a different house - and there is no
    /// Chrome installed in it to drive. Defaulting to one would have failed
    /// every launch on the machines this is actually for.
    /// <para>
    /// Kept configurable because an image that DOES ship Chrome is a
    /// reasonable thing to build, and a provider that refuses Chromium is a
    /// reasonable reason to build one.
    /// </para>
    /// </remarks>
    public string? BrowserChannel { get; set; }

    public string? BrowserLocale { get; set; }

    public string? BrowserTimezoneId { get; set; }

    /// <summary>
    /// How long a browser profile on THIS machine keeps the session cookies its
    /// last browser closed holding. Ignored on any agent that is not somebody's
    /// own machine, which keeps none at all.
    /// </summary>
    /// <remarks>
    /// <b>TWELVE HOURS, and it is a judgment rather than a measurement.</b> The
    /// browser's own rule is that a session cookie dies with the browser, and
    /// <see cref="Browsing.KeptSessionStore"/> exists to break that rule on
    /// purpose - so the question is how far, not whether. Twelve hours covers
    /// what the promise is actually about: the connect somebody did this
    /// morning still covers the fetch this evening and the sync that follows
    /// it, which is the run-to-run reuse a BYO agent is installed for. It stops
    /// well short of carrying a live bank session across a weekend on a machine
    /// nobody is sitting at, which is the shape of exposure that would be hard
    /// to defend to the account holder whose house it is in.
    /// <para>
    /// It is not a promise that the session lasts that long, and nothing reads
    /// it as one - most providers are stricter by far (DUO's is fifteen minutes
    /// of inactivity), and every persistent adapter asks the provider whether
    /// it is still signed in rather than trusting a cookie's age.
    /// </para>
    /// <para>
    /// An option because households differ: a provider synced once a week is a
    /// reason to lengthen it, and <see cref="TimeSpan.Zero"/> turns the carry
    /// off and hands the browser's own rule back.
    /// </para>
    /// </remarks>
    public TimeSpan KeptSessionLifetime { get; set; } = TimeSpan.FromHours(12);

    /// <summary>How long a single provider HTTP call may take.</summary>
    public TimeSpan ProviderHttpTimeout { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>Backstop between challenge-answer long-polls.</summary>
    public TimeSpan AnswerPollInterval { get; set; } = TimeSpan.FromSeconds(2);

    /// <summary>
    /// How long a control-plane call may take. Seventy seconds because of the
    /// LONG POLLS: the lease poll hangs for thirty by contract, the answer poll
    /// for as long as the control plane holds it, and a client that gave up
    /// first would turn every ordinary empty poll into a failure.
    /// </summary>
    /// <seealso cref="KeepaliveTimeout"/>
    public TimeSpan ControlPlaneTimeout { get; set; } = TimeSpan.FromSeconds(70);

    /// <summary>
    /// How long a KEEPALIVE - a lease renewal or a heartbeat - may hang before
    /// the agent abandons it and tries again.
    /// </summary>
    /// <remarks>
    /// <b>TEN SECONDS, AND THE NUMBER COMES FROM THE WINDOWS THESE TWO CALLS
    /// SIT INSIDE</b> rather than from how long a control plane might take to
    /// answer a POST with no body. Both used to be bounded by
    /// <see cref="ControlPlaneTimeout"/>, because one client served every call
    /// and the long polls needed seventy seconds; each was therefore given up
    /// on long after the thing it exists to keep alive had already died.
    /// <para>
    /// A renewal is due at half the remaining lease, so on the lease the
    /// control plane hands out - <c>HeartbeatResponse.LeaseTtlSeconds</c>, two
    /// minutes - the first one leaves a minute before the lease lapses. At
    /// seventy it was abandoned at a hundred and thirty seconds, ten seconds
    /// after the lease had gone and an expiry sweep had already requeued the
    /// job: the retry that the renewal loop dutifully performs was
    /// structurally too late, and the second agent picking the job up found
    /// this one still driving a bank's twelve-minute registration. At ten the
    /// agent gives up at seventy seconds with fifty of lease in hand and
    /// renews again at ninety-five, with twenty-five to spare and room for one
    /// more attempt after that.
    /// </para>
    /// <para>
    /// A heartbeat is due every thirty seconds and the control plane calls an
    /// agent offline after ninety - <c>AgentLiveness.OfflineAfterSeconds</c>,
    /// three beats, deliberately not one, "a machine that misses a single one
    /// on a busy network has not gone away". At seventy, one beat that
    /// black-holed cost seventy seconds and the loop then slept a whole
    /// interval on top, so the next beat to land was a hundred and thirty
    /// seconds after the last: one blip, and every login and every fetch
    /// naming this agent was refused by a rule meant to tolerate three. At ten,
    /// with the shortened retry in <see cref="AgentHost"/>'s heartbeat loop, a
    /// failed beat costs fifteen seconds rather than a hundred: three in a row
    /// still put a good beat at seventy-five, and it takes four to reach
    /// ninety.
    /// </para>
    /// <para>
    /// Not shorter, because this is also the allowance for a residential
    /// uplink having a bad moment, and a renewal abandoned while its answer is
    /// on the way loses the job for the opposite reason.
    /// </para>
    /// </remarks>
    public TimeSpan KeepaliveTimeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>
    /// A PEM certificate authority to trust for the control plane, on top of
    /// whatever the machine already trusts.
    /// </summary>
    /// <remarks>
    /// <b>Without this, the production topology cannot connect to itself.</b>
    /// The control planes terminate TLS with an internally-issued certificate
    /// - a LAN is not a trust boundary, so they do not serve plaintext - and
    /// an agent has nothing to validate that against: a container's trust
    /// store holds public roots and no private one. Every enrollment failed
    /// with "the remote certificate is invalid according to the validation
    /// procedure", which was found by bringing the stack up rather than by
    /// reading it, and the compose file had been carrying the option's name in
    /// a comment marked NOT IMPLEMENTED.
    /// <para>
    /// ADDED TO the machine's trust rather than replacing it: an agent also
    /// talks to real providers over the public web, and a custom root store
    /// would break every one of them.
    /// </para>
    /// <para>
    /// Null on a control plane with a publicly-trusted certificate, and null
    /// in development, where it is plain HTTP.
    /// </para>
    /// </remarks>
    public string? ControlPlaneCaPath { get; set; }

    /// <summary>
    /// How long a shutdown waits for in-flight jobs before aborting them. Long
    /// enough for a fetch to finish; a login waiting on a human is not worth
    /// holding a deploy for, and it fails cleanly when the window closes.
    ///
    /// This plus <see cref="ShutdownAbortGrace"/> must fit inside the host's
    /// own <c>HostOptions.ShutdownTimeout</c> (30s by default) - raise both or
    /// the host stops waiting first and the drain buys nothing.
    /// </summary>
    public TimeSpan ShutdownDrainTimeout { get; set; } = TimeSpan.FromSeconds(20);

    /// <summary>How long aborted jobs get to report their failure upstream.</summary>
    public TimeSpan ShutdownAbortGrace { get; set; } = TimeSpan.FromSeconds(8);

    /// <summary>Longest wait between failed lease polls.</summary>
    public TimeSpan MaxLeaseBackoff { get; set; } = TimeSpan.FromSeconds(30);

    internal IReadOnlyList<ServiceDescriptor> AdapterDescriptors => _adapters;

    /// <summary>Registers an adapter to be constructed from the container.</summary>
    public ConnectorAgentOptions AddAdapter<T>() where T : class, IProviderAdapter
    {
        _adapters.Add(ServiceDescriptor.Singleton<IProviderAdapter, T>());
        return this;
    }

    /// <summary>Registers an already-constructed adapter.</summary>
    public ConnectorAgentOptions AddAdapter(IProviderAdapter adapter)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        _adapters.Add(ServiceDescriptor.Singleton(adapter));
        return this;
    }

    // RequireBaseAddress used to live here, and it is now
    // ConnectorConnection's: "the control plane" is not a property of the
    // machine any more, and a method on this object that answers with the
    // shorthand's address would be right for one connector and quietly wrong
    // - or an exception - for a machine that lists several.

    /// <summary>
    /// The connectors this agent will actually serve: the <see cref="Connections"/>
    /// list, or the top-level settings read as the single connection they have
    /// always been.
    /// </summary>
    /// <remarks>
    /// The shorthand is not a compatibility shim to be removed later. One
    /// connector is the common case - a pooled agent in the operator's rack
    /// serves exactly one, for ever - and making it write a list of one to say
    /// so would be a worse file for the commoner case.
    /// <para>
    /// The synthesized connection keeps the profile root itself rather than a
    /// sub-directory of it, which is what lets an agent that is already
    /// running find the browsers it already has. See
    /// <see cref="ConnectorConnection.OwnsTheRoot"/>.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// What this agent advertises.
    ///
    /// An unset provider or runtime list is filled from the adapters actually
    /// registered rather than left empty. Empty means "any" on the wire, and
    /// claiming to serve any provider when the image contains three adapters
    /// earns jobs this agent can only fail.
    ///
    /// <para>
    /// On a BYO agent the runtimes are the adapters' whatever the
    /// configuration says, and a list that leaves one out is refused rather
    /// than honoured - see <see cref="OwnMachineRuntimes"/>.
    /// </para>
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// A BYO agent configured with a Runtimes list that omits a tier one of
    /// its providers runs on. Thrown from here rather than from
    /// <see cref="Validate"/> because this is the first place the manifests
    /// are known; <see cref="AgentHost"/> calls it in its constructor so the
    /// throw is the host refusing to start.
    /// </exception>
    public AgentCapabilities BuildCapabilities(IReadOnlyList<ProviderManifest> manifests)
    {
        ArgumentNullException.ThrowIfNull(manifests);

        // The providers this agent will actually be asked about: every one it
        // carries, or the ones a Providers list names. The tiers it needs are
        // theirs - a runtime that only a provider it does not advertise runs
        // on is not one it needs, and not one it should be refused over.
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
            // The same setting AgentJobContext.Attended is built from, read
            // once here so the claim this agent makes to the queue and the
            // condition its adapters meet at run time cannot drift apart.
            Headed = !Headless,
        };
    }

    /// <summary>
    /// The capabilities plus the catalogue digest of the registry the agent
    /// really runs - what the host advertises, so that the control plane can
    /// tell an agent on the same adapter code from one that is not.
    /// </summary>
    public AgentCapabilities BuildCapabilities(IProviderRegistry registry)
    {
        ArgumentNullException.ThrowIfNull(registry);

        // The agent-served digest: the one the control plane compares (IProviderRegistry.AgentCatalogDigest)
        return BuildCapabilities(registry.Manifests) with { CatalogDigest = registry.AgentCatalogDigest };
    }

    /// <summary>
    /// The tiers to advertise: a household agent serves every tier its
    /// providers run on; a pooled one what it was configured with, or the
    /// tiers its providers need when nothing was.
    /// </summary>
    private IReadOnlyList<ProviderRuntime> AdvertisedRuntimes(
        IReadOnlyList<ProviderManifest> served, IReadOnlyList<ProviderRuntime> needed)
    {
        if (Class == AgentClass.Byo) return OwnMachineRuntimes(served, needed);

        return Runtimes.Count > 0 ? [.. Runtimes] : needed;
    }

    /// <summary>
    /// The tiers somebody's own machine serves: every one its providers run
    /// on, and a configuration that says otherwise is wrong.
    /// </summary>
    /// <remarks>
    /// <b>A BYO agent advertising fewer tiers than its adapters need is a
    /// healthy-looking instance that never picks up work, and that is what
    /// shipped.</b> Every agent image's appsettings carried the pooled fleet's
    /// list - http, browser_once, browser_interactive - beside a comment saying
    /// a user's own agent "overrides this to browser_persistent", and the BYO
    /// compose file set the class and never touched the runtimes. The agent
    /// enrolled, heartbeated and logged asn-persistent as online - the
    /// "online" line listed PROVIDERS, which come from the adapters and looked
    /// right - and never leased a single persistent login, because
    /// <see cref="AgentCapabilities.CanServe"/> asks for the tier and the tier
    /// was not there. Each login sat queued for half an hour and died as
    /// agent_unavailable, with the machine that existed to serve it idling
    /// beside it.
    /// <para>
    /// So on a BYO agent a Runtimes list cannot take a tier away. One that
    /// leaves out a tier a provider here runs on is refused, with the tier and
    /// the provider named, in the same spirit as an agent with no control
    /// plane refusing to boot: the failure an operator can read beats the one
    /// they have to infer from a queue that never moves.
    /// </para>
    /// <para>
    /// The fear the old comment recorded - that a pooled agent advertising
    /// browser_persistent would "claim a BYO-only first login it can never
    /// serve" - is obsolete, which is why the pooled fleet needs no restriction
    /// either to stay off those logins. Every persistent job is pinned to a
    /// profile on the agent named by prefer_agent: the control plane's
    /// ResolveProfileAsync mints or reuses the profile row and stamps its id on
    /// the login job, fetches and logouts carry the session's, and the queue
    /// offers a pinned job to the agent that owns the profile and nobody else.
    /// A pooled agent that advertises the tier claims nothing it cannot serve;
    /// the local stack's pooled agents do, so they can host demo profiles.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// <c>browser_persistent</c>, as configuration and the wire spell it, for
    /// a message an operator will match against their compose file.
    /// </summary>
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

    /// <summary>
    /// What is wrong with the connectors this agent was pointed at.
    /// </summary>
    /// <remarks>
    /// Every rule here is a mistake that would otherwise produce a healthy
    /// agent doing the wrong thing quietly, which is the failure this codebase
    /// keeps paying for:
    /// <list type="bullet">
    /// <item>No connector at all: the agent would enroll nowhere, lease
    /// nothing, and look perfectly well while it did it.</item>
    /// <item>Two connections with one name: they are directory names under the
    /// profile root, so the second would drive the first's browsers - two
    /// connectors sharing one signed-in session is not a collision anybody
    /// would think to look for.</item>
    /// <item>Two connections onto one control plane: the state file is keyed by
    /// control plane, because that is what a token belongs to. Two of them
    /// would take turns overwriting one enrollment, and each restart would
    /// burn a one-time code to get back to the same place.</item>
    /// <item>Both shapes at once: the top-level settings ARE the one-connection
    /// shorthand, so a list beside them means one of the two is being ignored,
    /// and neither the operator nor this class can say which was meant.</item>
    /// </list>
    /// </remarks>
    /// <summary>
    /// The single-connection shorthand set beside a Connections list, named,
    /// or null when the two shapes are not mixed.
    /// </summary>
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
            // The message the single-connector deployment has always had, plus
            // the way out that now exists. An agent with nowhere to call
            // refuses to boot rather than idling as a healthy-looking instance
            // that never picks up work.
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
            // Case-insensitively, because the name is a directory and two of
            // the file systems this runs on would fold `Bank` into `bank`
            // without being asked.
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

    /// <summary>
    /// A per-user data directory, falling back to the install directory in a
    /// container where the user profile is empty.
    /// </summary>
    private static string DefaultDataRoot()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var root = string.IsNullOrEmpty(local) ? AppContext.BaseDirectory : local;
        return Path.Combine(root, "connector-agent");
    }
}
