using System.Text.Json.Serialization;

namespace Connector.Kit.Manifests;

/// <summary>
/// What a provider needs from a user, and what it can deliver.
///
/// This is the only contract a consumer codes against: it renders login
/// forms from <see cref="Auth"/>, decides which resources to offer from
/// <see cref="Resources"/>, and knows before asking whether scheduled sync
/// is even offerable from <see cref="UnattendedFetch"/>. Adding a provider is a
/// manifest plus an adapter - never a change in the consuming app.
/// </summary>
public sealed record ProviderManifest
{
    /// <summary>Route namespace: <c>/v1/{id}/*</c>. Lowercase, kebab-case.</summary>
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required ProviderKind Kind { get; init; }

    /// <summary>ISO-3166 alpha-2, uppercase.</summary>
    public required string Country { get; init; }

    /// <summary>
    /// Bumped on any breaking change to the session material's shape. Sealed
    /// into every bundle as AAD, so a bundle minted before the change is
    /// rejected rather than misinterpreted.
    /// </summary>
    public required int ManifestVersion { get; init; }

    /// <summary>How the data is actually obtained. Drives agent routing.</summary>
    public required ProviderRuntime Runtime { get; init; }

    public required AgentRequirement Agent { get; init; }

    /// <summary>
    /// Can a FETCH complete with no human present?
    ///
    /// The fetch axis and nothing else. It was called <c>Unattended</c>, which
    /// read as a claim about the whole provider and was believed as one: Albert
    /// Heijn and Lidl Plus both declare it true while neither login can finish
    /// without a person - AH streams its own page to them, Lidl sends them to
    /// sign in in their own browser. Both are still true here, because a stored
    /// refresh token really does fetch on its own at three in the morning; what
    /// was wrong was the name promising something about the login too.
    ///
    /// Whether the LOGIN needs a human, and where that human has to be
    /// standing, is <see cref="LoginNeedsHeadedAgent"/> and the challenge list
    /// on <see cref="Auth"/>.
    /// </summary>
    public required bool UnattendedFetch { get; init; }

    /// <summary>
    /// True when this login can meet a wall only a human sitting at the agent's
    /// own browser can pass.
    ///
    /// False does not mean the login needs nobody. It means whoever is needed
    /// can be reached from anywhere - a captcha photographed and relayed to a
    /// phone, a live view of the provider's own page - so any agent will do.
    /// True means the wall is interactive and unrelayable, and the only person
    /// who can pass it is one with hands on that machine.
    ///
    /// Declared rather than discovered. The condition already exists at run
    /// time as <c>IJobContext.Attended</c>, which comes from the agent's own
    /// headless setting, so today a pooled headless agent leases an Amazon
    /// login, drives it for two minutes, meets the widget and fails it
    /// <c>blocked_by_provider</c> - having learnt nothing the catalogue could
    /// not have said up front.
    /// </summary>
    public bool LoginNeedsHeadedAgent { get; init; }

    /// <summary>
    /// What disconnecting does to the account upstream, if anything.
    ///
    /// There was no field, so <c>DELETE /sessions/{id}</c> called
    /// <c>LogoutAsync</c> on every provider - a no-op for fourteen of the
    /// sixteen, each costing a job row, a lease and an agent round trip - and
    /// the consuming app told the user "logged out upstream" every time,
    /// including when nothing of the sort had happened.
    /// </summary>
    public LogoutSupport Logout { get; init; } = LogoutSupport.None;

    /// <summary>
    /// Whether a successful login hands back a sealed copy of what the human
    /// typed, for their own device to keep.
    /// </summary>
    /// <remarks>
    /// For one shape of provider only: a session that cannot be refreshed, so a
    /// fresh username and password is wanted again within a day. Jumbo is the
    /// case - its Auth0 cookie is not refreshable and it wants a real sign-in
    /// roughly daily, so the alternative is asking the same human for the same
    /// password every morning.
    /// <para>
    /// The connector keeps no copy: the bundle is sealed to the user's subject
    /// and handed over once, exactly as a session bundle is. What it costs is
    /// real and belongs written down - a password re-submitted by machine on a
    /// schedule is one that can be wrong without anybody watching, and this
    /// platform never retries a submitted credential precisely because that is
    /// how accounts get locked.
    /// </para>
    /// <para>
    /// Refused at boot for a provider that declares no fields (there is nothing
    /// to store), for one whose session IS refreshable (the refresh already
    /// removes the reason), and for anything but client custody.
    /// </para>
    /// </remarks>
    public bool OffersCredentialStore { get; init; }

    /// <summary>Where the long-lived secret lives at rest.</summary>
    public required SecretCustody SecretCustody { get; init; }

    /// <summary>
    /// Whether browser clients may connect. Web bundles are never persisted
    /// across a browser restart, so web users re-authenticate each visit.
    /// </summary>
    public WebSupport WebSupport { get; init; } = WebSupport.Ephemeral;

    public required AuthSpec Auth { get; init; }

    public required IReadOnlyList<ResourceSpec> Resources { get; init; }

    public ProviderLimits Limits { get; init; } = new();

    /// <summary>Consumer-owned copy key for any provider-specific caveat.</summary>
    public string? NotesKey { get; init; }

    /// <summary>Asset hint; the consumer resolves the actual image itself.</summary>
    public string? LogoRef { get; init; }

    public ResourceSpec? Resource(string resourceId) =>
        Resources.FirstOrDefault(r => string.Equals(r.Id, resourceId, StringComparison.Ordinal));
}

[JsonConverter(typeof(JsonStringEnumConverter<ProviderKind>))]
public enum ProviderKind
{
    Bank,
    Store,

    /// <summary>
    /// A registry: somewhere that holds an official record ABOUT you rather
    /// than a stream of things you did.
    ///
    /// Bank and store are both event feeds - transactions, receipts - and a
    /// registry is not. BKR states what credit you have outstanding, right
    /// now, as a standing position; the same is true of a pension overview or
    /// a student-debt balance. Modelling those as another kind of transaction
    /// would force every one of them to invent a date and an amount it does
    /// not have.
    /// </summary>
    Registry,
}

/// <summary>
/// The four runtime tiers. A provider's tier is a finding, not a plan - it
/// is established by reading the provider, and it may move in either
/// direction as the provider changes.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<ProviderRuntime>))]
public enum ProviderRuntime
{
    /// <summary>T1. No browser, ever.</summary>
    Http,

    /// <summary>T2. Browser drives login once; a refresh token serves every fetch after.</summary>
    BrowserOnce,

    /// <summary>T3. Browser whenever the session is stale; the run may stop to ask a human.</summary>
    BrowserInteractive,

    /// <summary>T4. Persistent profile that stays logged in. The human authenticates once, ever.</summary>
    BrowserPersistent,
}

[JsonConverter(typeof(JsonStringEnumConverter<SecretCustody>))]
public enum SecretCustody
{
    /// <summary>The user's device holds an opaque sealed bundle. The default.</summary>
    Client,

    /// <summary>The service vault holds it, envelope-encrypted. Only where UnattendedFetch is true.</summary>
    Server,

    /// <summary>A BYO agent holds it. The control plane never has it at all.</summary>
    Agent,
}

[JsonConverter(typeof(JsonStringEnumConverter<WebSupport>))]
public enum WebSupport
{
    /// <summary>Web may connect; the bundle dies with the tab session.</summary>
    Ephemeral,

    /// <summary>Web may not connect - the login is too heavy to repeat per visit.</summary>
    None,
}

/// <summary>
/// What disconnecting reaches beyond this platform, if anything.
///
/// The three values are three different promises to make to the person
/// pressing the button, and telling them apart matters most at the far end:
/// signing somebody out of the grocery app on their own phone because they
/// tidied up a connection here is not a tidy-up, it is a surprise.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<LogoutSupport>))]
public enum LogoutSupport
{
    /// <summary>
    /// Nothing upstream. Disconnect purges what is held here and the provider
    /// never learns of it. The default, and true of most adapters.
    /// </summary>
    None,

    /// <summary>
    /// Only the credential this connection holds stops working. The user's own
    /// app, on their own phone, is untouched.
    /// </summary>
    Session,

    /// <summary>
    /// The account's other sessions go too. Declaring this is what lets a
    /// consumer warn somebody before it happens.
    /// </summary>
    Account,
}

[JsonConverter(typeof(JsonStringEnumConverter<AgentClass>))]
public enum AgentClass
{
    /// <summary>Runs in the control plane's own process. HTTP-only providers.</summary>
    Inline,

    /// <summary>The operator's agent fleet.</summary>
    Pooled,

    /// <summary>The user's own machine.</summary>
    Byo,
}

public sealed record AgentRequirement
{
    public required bool Required { get; init; }

    public required AgentClass Class { get; init; }

    public EgressRequirement? Egress { get; init; }

    /// <summary>
    /// Whether this provider may only ever be driven from a machine the
    /// account holder owns.
    /// </summary>
    /// <remarks>
    /// A READING OF THE TWO FIELDS ABOVE, in one place, because three readers
    /// now branch on it: the job queue, which must not offer such a provider to
    /// the operator's fleet; the login, which must refuse at once rather than
    /// queue work no agent may take; and the pinning that keeps a second
    /// sign-in on the machine holding the first one's cookies. Three copies of
    /// <c>Required &amp;&amp; Class == Byo</c> would be three chances to spell
    /// it differently, and the one that drifted would be a safety rule silently
    /// turning into a routing hint.
    /// <para>
    /// NEITHER FIELD MEANS THIS ON ITS OWN. <see cref="Required"/> is true of
    /// every browser provider there is, because a browser cannot run in the
    /// control plane; <see cref="Class"/> was, until something read it here, a
    /// preference nothing enforced. Together they are a promise about WHOSE
    /// computer, and DUO is what makes it a safety rule rather than a
    /// convenience: Logius scores DigiD authentications on IP, failed attempts
    /// and BSN, a pooled fleet signing in as many different citizens from one
    /// address is that signature exactly, and the consequence lands on the
    /// account holder - who files their taxes with that account.
    /// </para>
    /// <para>
    /// NOT ON THE WIRE. A consumer already receives <c>agent.required</c> and
    /// <c>agent.class</c>, so publishing a third field computed from them would
    /// be one more thing that can disagree with the two it is made of.
    /// </para>
    /// </remarks>
    [JsonIgnore]
    public bool NeedsOwnMachine => Required && Class == AgentClass.Byo;

    /// <summary>
    /// This provider's site must be driven as a DESKTOP browser, whatever
    /// device the agent otherwise emulates.
    /// </summary>
    /// <remarks>
    /// An escape hatch with one confirmed user, and it earned it. An agent
    /// emulates a phone by default because several providers serve a lighter,
    /// steadier page to one - but amazon.nl's mobile sign-in DOES NOT SUBMIT in
    /// a containerised headed Chromium. Not rejected: no request is made at
    /// all, by a button click or by Enter, while the password sits correctly in
    /// the field. The identical run with no device emulation posts immediately.
    /// <para>
    /// Four live sign-ins were spent on that before it was reproduced inside
    /// the agent's own container, where the network log made it obvious in one
    /// run: the e-mail step POSTs, the password step produces nothing.
    /// </para>
    /// </remarks>
    public bool DesktopBrowser { get; init; }

    public static AgentRequirement Inline { get; } = new() { Required = false, Class = AgentClass.Inline };
}

/// <summary>
/// An address a provider needs to be reached from, and - the same record, read
/// the other way - the address an agent says it leaves from.
/// </summary>
/// <remarks>
/// ONE RECORD FOR BOTH SIDES on purpose: the comparison in
/// <see cref="IsSatisfiedBy"/> is the only place the two meanings meet, and a
/// second type would mean two spellings of <c>residential</c> that agree only
/// while somebody keeps them agreeing.
/// <para>
/// A CLAIM, NOT A MEASUREMENT. Nothing here verifies that an agent saying
/// <c>residential</c> is on a domestic line; the agent's configuration says so
/// and it is believed. That is worth stating wherever this is read, because it
/// bounds what the check buys: it stops an HONEST deployment being routed work
/// its address cannot carry, which is the mistake that actually happens - a
/// datacenter agent quietly taking Jumbo's logins and being tarpitted for it.
/// It is not a defence against an agent that lies, and the answer to that is
/// the enrollment code deciding whose agent it is, not this field.
/// </para>
/// </remarks>
public sealed record EgressRequirement
{
    /// <summary>A home line. What a provider means when it will not accept a datacenter.</summary>
    public const string Residential = "residential";

    /// <summary>Anything, as long as the country matches.</summary>
    public const string Any = "any";

    /// <summary>ISO-3166 alpha-2, uppercase.</summary>
    public required string Country { get; init; }

    /// <summary><c>residential</c> or <c>any</c>.</summary>
    public required string Kind { get; init; }

    /// <summary>
    /// Whether an agent claiming <paramref name="claim"/> may be offered work
    /// for a provider asking for this.
    /// </summary>
    /// <remarks>
    /// Four rules, and two of them are the ones that decide whether this is a
    /// check or a decoration:
    /// <list type="bullet">
    /// <item>THE COUNTRY MUST MATCH, case-insensitively. A provider asking for
    /// NL is asking to be reached from the Netherlands, and
    /// <c>nl</c> typed into a compose file is the same country as
    /// <c>NL</c>.</item>
    /// <item><see cref="Any"/> IS WEAKER THAN <see cref="Residential"/>, NOT A
    /// WILDCARD. A provider asking for <c>any</c> is satisfied by a
    /// residential claim as readily as by a datacenter one - it asked for
    /// nothing beyond the country. A provider asking for <c>residential</c> is
    /// satisfied only by a residential claim: reading <c>any</c> as "matches
    /// anything" on the requirement side AND the claim side would make every
    /// requirement satisfiable by every agent, which is this check spelled
    /// correctly and doing nothing.</item>
    /// <item>AN AGENT THAT CLAIMS NOTHING SATISFIES NOTHING. A null claim is an
    /// address nobody has stated, not an address that will do - and the
    /// alternative reading is the dangerous one, because saying nothing is the
    /// default and would make the whole comparison opt-in for the deployments
    /// careful enough to fill it in. This is the rule that makes every shipped
    /// deployment's claim load-bearing, which is why they were all corrected in
    /// the same change that added this method: <c>deploy/byo</c> stated no
    /// egress at all until then.</item>
    /// <item>A KIND THIS RECORD DOES NOT KNOW demands an exact match. Nothing
    /// validates the string, so an unrecognised requirement is treated as a
    /// requirement rather than quietly widened to <see cref="Any"/>.</item>
    /// </list>
    /// </remarks>
    public bool IsSatisfiedBy(EgressRequirement? claim)
    {
        if (claim is null) return false;
        if (!string.Equals(Country, claim.Country, StringComparison.OrdinalIgnoreCase)) return false;

        return string.Equals(Kind, Any, StringComparison.OrdinalIgnoreCase)
               || string.Equals(Kind, claim.Kind, StringComparison.OrdinalIgnoreCase);
    }
}

public sealed record ProviderLimits
{
    /// <summary>
    /// How often a consumer SHOULD sync. Six hours by default - human
    /// plausible, not a firehose.
    /// </summary>
    /// <remarks>
    /// ADVISORY, and published so a consumer can honour it. This doc used to
    /// say "Enforced server-side, not advisory" and that was simply untrue:
    /// every manifest sets a value, the catalogue publishes it as
    /// <c>min_interval_seconds</c>, and nothing anywhere reads it back. A
    /// comment asserting an invariant nobody implements is worse than no
    /// comment, because it is believed.
    /// <para>
    /// Enforcing it is a real feature and deliberately not a silent one. On the
    /// day this was found, one account had six Amazon fetches inside three
    /// hours - all of them diagnosing a genuine defect - and a six-hour floor
    /// would have refused five. So enforcement has to answer a question this
    /// field does not currently carry: whether the caller is a schedule, which
    /// should be held to it, or a person who has just pressed a button, who has
    /// asked. Deciding that by adding a rate limit to the fetch endpoint would
    /// break every operator mid-debug and call it correctness.
    /// </para>
    /// <para>
    /// What ACTUALLY paces the provider today is a different thing entirely and
    /// does work: <see cref="MinRequestGapMs"/> and the agent's politeness gate
    /// govern the rate INSIDE one fetch, which is where the traffic that gets
    /// an account throttled comes from.
    /// </para>
    /// </remarks>
    public int MinIntervalSeconds { get; init; } = 21_600;

    /// <summary>Per session. Always 1; the field exists to make that explicit.</summary>
    public int Concurrency { get; init; } = 1;

    /// <summary>
    /// The smallest gap this provider wants between two REQUESTS, as opposed to
    /// between two fetches.
    ///
    /// <see cref="MinIntervalSeconds"/> governs how often a user may sync;
    /// this governs the cadence inside one sync, which is a different question
    /// with a different answer. A first Amazon connect walks an order list and
    /// then an invoice per order - on this account, a hundred and thirty-four of
    /// them - and at Chromium's own speed that is a burst no human produces.
    /// <para>
    /// Zero means the provider asks for nothing beyond the operator's own
    /// politeness floor, which is the default and true of most: they are
    /// answering a handful of calls per fetch and the floor already covers it.
    /// The value is a stated preference, not a measurement - no provider
    /// publishes its threshold - so raising one is a decision to spend wall
    /// clock on caution, and worth writing down where it is made.
    /// </para>
    /// </summary>
    public int MinRequestGapMs { get; init; }

    public int MaxHistoryDays { get; init; } = 365;

    /// <summary>
    /// How long a provider may take to surface a transaction that settles
    /// late. Any caller-supplied <c>since</c> is widened by this, because
    /// fetching strictly since the last sync loses late-settling rows
    /// permanently and invisibly.
    /// </summary>
    public int SettlementLagDays { get; init; }
}
