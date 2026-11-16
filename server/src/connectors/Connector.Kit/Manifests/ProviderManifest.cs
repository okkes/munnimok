using System.Text.Json.Serialization;

namespace Connector.Kit.Manifests;

// the only contract a consumer codes against: adding a provider is a manifest plus an adapter, never a consumer change
public sealed record ProviderManifest
{
    /// <summary>Route namespace: <c>/v1/{id}/*</c>. Lowercase, kebab-case.</summary>
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required ProviderKind Kind { get; init; }

    /// <summary>ISO-3166 alpha-2, uppercase.</summary>
    public required string Country { get; init; }

    // bumped on any breaking change to the session material's shape; sealed into every bundle as AAD, so an older
    // bundle is rejected, not misread
    public required int ManifestVersion { get; init; }

    public required ProviderRuntime Runtime { get; init; }

    public required AgentRequirement Agent { get; init; }

    // the FETCH axis only: Albert Heijn and Lidl Plus declare it true though neither login finishes without a person
    // (a stored refresh token fetches alone at 3 am). The LOGIN's need: LoginNeedsHeadedAgent plus Auth's challenges
    public required bool UnattendedFetch { get; init; }

    // true when the login can meet a wall only a person at the agent's own browser can pass; false means whoever is needed
    // is reachable from anywhere (relayed captcha, live view). Declared, not discovered: a pooled headless agent would
    // lease an Amazon login, drive it two minutes and fail it blocked_by_provider
    public bool LoginNeedsHeadedAgent { get; init; }

    // the operator's alone (#441 L3): left out of every consumer catalogue and refused on every door but the lab's
    public bool OperatorOnly { get; init; }

    // the platform's own stand-in party (mocks, #526): runs on every door, but is no shop or bank a person would connect,
    // so a consumer leaves it out of its offers and the lab lists it apart
    public bool Fixture { get; init; }

    // what disconnecting does upstream: without it DELETE /sessions/{id} ran LogoutAsync on every provider (a no-op for
    // most) and the consuming app claimed "logged out upstream" even when nothing happened
    public LogoutSupport Logout { get; init; } = LogoutSupport.None;

    // a sealed copy of the typed credential for the user's own device, only for a non-refreshable session (Jumbo's Auth0
    // cookie wants a sign-in daily); refused with no fields, a refreshable session, or non-client custody. Cost: a password
    // re-submitted by machine can be wrong unwatched, and a submitted credential is never retried (lockout)
    public bool OffersCredentialStore { get; init; }

    /// <summary>Where the long-lived secret lives at rest.</summary>
    public required SecretCustody SecretCustody { get; init; }

    // web bundles are never persisted across a browser restart, so web users re-authenticate each visit
    public WebSupport WebSupport { get; init; } = WebSupport.Ephemeral;

    public required AuthSpec Auth { get; init; }

    public required IReadOnlyList<ResourceSpec> Resources { get; init; }

    public ProviderLimits Limits { get; init; } = new();

    /// <summary>Consumer-owned copy key for any provider-specific caveat.</summary>
    public string? NotesKey { get; init; }

    public string? LogoRef { get; init; }

    public ResourceSpec? Resource(string resourceId) =>
        Resources.FirstOrDefault(r => string.Equals(r.Id, resourceId, StringComparison.Ordinal));
}

[JsonConverter(typeof(JsonStringEnumConverter<ProviderKind>))]
public enum ProviderKind
{
    Bank,
    Store,

    // a registry holds an official record ABOUT you (BKR credit, pension, student debt) as a standing position; modelling
    // it as a transaction would force an invented date and amount
    Registry,

    Lab,
}

// a provider's tier is a finding established by reading the provider, and may move either way
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

// three different promises to the person disconnecting: signing them out of the grocery app on their phone is a surprise
[JsonConverter(typeof(JsonStringEnumConverter<LogoutSupport>))]
public enum LogoutSupport
{
    // nothing upstream: disconnect purges only what is held here; the default
    None,

    // only the credential this connection holds stops working; the user's own app is untouched
    Session,

    // the account's other sessions go too; declaring it lets a consumer warn first
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

    // true when only a machine the account holder owns may drive this provider: read by the job queue, the login and the
    // pinning of a second sign-in. DUO makes it a safety rule: Logius scores DigiD on IP, failed attempts and BSN, and a
    // pooled fleet signing in many citizens from one address looks like abuse. Not on the wire (computed from two fields)
    [JsonIgnore]
    public bool NeedsOwnMachine => Required && Class == AgentClass.Byo;

    // escape hatch: amazon.nl's mobile sign-in does not submit in a containerised headed Chromium (no request at all,
    // password filled correctly), while the same run without device emulation posts at once
    public bool DesktopBrowser { get; init; }

    public static AgentRequirement Inline { get; } = new() { Required = false, Class = AgentClass.Inline };
}

// one record for both sides (what a provider needs, what an agent claims), so IsSatisfiedBy is the only place they meet.
// A CLAIM, not a measurement: it stops an honest datacenter agent taking Jumbo's logins, not a lying one
public sealed record EgressRequirement
{
    /// <summary>A home line. What a provider means when it will not accept a datacenter.</summary>
    public const string Residential = "residential";

    /// <summary>Anything, as long as the country matches.</summary>
    public const string Any = "any";

    /// <summary>ISO-3166 alpha-2, uppercase.</summary>
    public required string Country { get; init; }

    public required string Kind { get; init; }

    // country matches case-insensitively; Any is weaker than Residential, not a wildcard; a null claim satisfies nothing
    // (silence must not make the check opt-in); an unknown kind demands an exact match, never widened to Any
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
    // ADVISORY: published as min_interval_seconds and nothing reads it back; enforcing needs to tell a schedule from a person
    // who pressed a button. What really paces a provider is MinRequestGapMs and the agent's politeness gate, inside one fetch
    public int MinIntervalSeconds { get; init; } = 21_600;

    /// <summary>Per session. Always 1; the field exists to make that explicit.</summary>
    public int Concurrency { get; init; } = 1;

    // the smallest gap between two REQUESTS inside one sync (MinIntervalSeconds is between syncs): a first Amazon connect
    // walks an invoice per order, 134 on one account. Zero = no more than the politeness floor; a stated preference
    public int MinRequestGapMs { get; init; }

    public int MaxHistoryDays { get; init; } = 365;

    // a caller-supplied since is widened by this: fetching strictly since the last sync loses late-settling rows invisibly
    public int SettlementLagDays { get; init; }

    // hour in the account's own zone (derived from the IBAN's country) at which an unattended fetch is worth running: banks
    // book overnight, so 03:00 gets whole days; null = any hour once MinIntervalSeconds passed; advisory
    [System.Text.Json.Serialization.JsonPropertyName("preferred_fetch_hour_local")]
    public int? PreferredFetchHourLocal { get; init; }
}
