using System.Text.Json.Serialization;

namespace Connector.Kit.Hosting;

/// in Production the service refuses to start without real bundle keys, a client-certificate allowlist and a JWT authority
public sealed class ConnectorOptions
{
    public const string SectionName = "Connector";

    public ConnectorMode Mode { get; set; } = ConnectorMode.Development;

    public ConnectorDatabaseOptions Database { get; set; } = new();

    public ConnectorAuthOptions Auth { get; set; } = new();

    public BundleKeyOptions Bundle { get; set; } = new();

    public ConnectorTimeouts Timeouts { get; set; } = new();

    /// bound on waiting jobs: past what the fleet drains, accepting is a spinner that is really a waiting list; refuse instead
    /// 50 is generous for a two-agent fleet: a backstop, not a throttle; per-session concurrency is already one
    public int MaxQueuedJobs { get; set; } = 50;

    /// largest decoded failed-run screenshot (#441 L1); a larger picture is dropped and its digest kept
    public int MaxArtifactBytes { get; set; } = 1_048_576;

    /// largest packed run recording (#441 L3); the agent bounds its own well below, this guards a post not from the agent
    public int MaxTraceBytes { get; set; } = 8 * 1_048_576;


    /// per-stack key; a development default is minted in memory
    public string? EnrollmentHmacKey { get; set; }

    /// subjects whose agents are the operator's fleet and serve every user; every other agent serves only who enrolled it
    /// operator config, not agent-declared: AgentClass is self-declared and rewritten each heartbeat
    /// empty = all owner-scoped: the failure is an unleased pooled job, not a credential on the wrong machine
    public IList<string> FleetSubjects { get; set; } = [];

    /// development only: fixed code seeded at start-up so a compose-file agent enrolls unattended
    /// serving everybody still needs DevFleetSubject in FleetSubjects
    /// refused in production: a reusable code is a password, and this one sits in a checked-in compose file
    public string? DevEnrollmentCode { get; set; }

    /// not a pseudonym of any person: no HMAC of a user id can collide with it
    public const string DevFleetSubject = "dev-fleet";

    /// the operator's fleet enrolls with this platform-rendered secret (#367 M2), in production too, unattended
    /// re-armed on every start like DevEnrollmentCode, which stays dev-only because its code sits in a checked-in file
    public string? FleetEnrollmentCode { get; set; }

    /// <summary>The subject a <see cref="FleetEnrollmentCode"/> enrollment belongs to; no user's HMAC can collide with it.</summary>
    public const string FleetSubject = "fleet";

    /// hosted private agents (#420 A2): standing code for the private-slot containers, enrolled under PrivateSlotSubject
    /// not the fleet: a free slot is leased nobody's work; the operator binds it to a person, and a release wipes its profiles
    /// refused when equal to FleetEnrollmentCode: one code cannot enroll both kinds of machine
    public string? PrivateEnrollmentCode { get; set; }

    /// <summary>The subject a free private slot belongs to: no user's HMAC can collide with it, and it is never the fleet.</summary>
    public const string PrivateSlotSubject = "slot";

    /// every subject whose agents serve everybody: the configured list plus the fleet code's subject; every fleet rule reads it
    public IReadOnlyList<string> EffectiveFleetSubjects =>
        string.IsNullOrWhiteSpace(FleetEnrollmentCode) || FleetSubjects.Contains(FleetSubject, StringComparer.Ordinal)
            ? [.. FleetSubjects]
            : [.. FleetSubjects, FleetSubject];

    public bool IsFleet(string? subject) =>
        subject is not null && EffectiveFleetSubjects.Contains(subject, StringComparer.Ordinal);

    public bool IsProduction => Mode == ConnectorMode.Production;
}

[JsonConverter(typeof(JsonStringEnumConverter<ConnectorMode>))]
public enum ConnectorMode
{
    Development,
    Production,
}

public sealed class ConnectorDatabaseOptions
{
    public ConnectorDatabaseProvider Provider { get; set; } = ConnectorDatabaseProvider.Sqlite;

    public string ConnectionString { get; set; } = "Data Source=connector.db";
}

/// Postgres in production, Sqlite for tests and local runs: every mapping is provider-agnostic
[JsonConverter(typeof(JsonStringEnumConverter<ConnectorDatabaseProvider>))]
public enum ConnectorDatabaseProvider
{
    Sqlite,
    Postgres,
}

public sealed class ConnectorAuthOptions
{
    /// <summary>Development only: the value expected in <c>X-Connector-Key</c>.</summary>
    public string? SharedSecret { get; set; }

    /// <summary>Production: the OIDC authority that issues the M2M token.</summary>
    public string? Authority { get; set; }

    public string? Audience { get; set; }

    /// where discovery is fetched when not the authority: a private compose network reaches Logto by service name over http
    /// while the issuer stays the browser url; absent, the authority is fetched
    public string? MetadataAddress { get; set; }

    /// <summary>False only for a discovery document fetched over a private network; the issuer in the token is still the https one.</summary>
    public bool RequireHttpsMetadata { get; set; } = true;

    /// production: a scope every token must carry on top of the audience (space-separated scope claim); null accepts any
    public string? RequiredScope { get; set; }

    /// production: the scope that opens /v1/admin/*; a consumer token without it gets 403; dev uses the shared secret alone
    public string AdminScope { get; set; } = "connector:admin";
}

public sealed class BundleKeyOptions
{
    public string? CurrentKid { get; set; }

    /// <summary>kid to base64 AES-256 key. Rotation is a kid bump, never a mass re-login.</summary>
    public IDictionary<string, string> Keys { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);

    public bool HasKeys => !string.IsNullOrWhiteSpace(CurrentKid) && Keys.Count > 0;
}

public sealed class ConnectorTimeouts
{
    /// <summary>Ticket lifetime. Short on purpose: it is a bearer capability over one connection.</summary>
    public int TicketSeconds { get; set; } = 900;

    public int LeaseSeconds { get; set; } = 120;

    /// how often an agent checks in; handed out at enrollment and kept across restarts
    /// capped at a third of AgentLiveness.OfflineAfterSeconds: the platform refuses to start otherwise, in every mode
    public int HeartbeatSeconds { get; set; } = 30;

    /// <summary>How long an agent's lease long-poll may hang before returning 204.</summary>
    public int AgentPollSeconds { get; set; } = 30;

    /// <summary>
    /// How long <c>POST /login</c> waits for an inline provider to finish
    /// before answering 202. Kept small: the caller has SSE and polling.
    /// </summary>
    public int LoginWaitSeconds { get; set; } = 3;

    /// <summary>How long a fetch waits inline before degrading to a 202 job handle.</summary>
    public int FetchWaitSeconds { get; set; } = 25;

    public int JobTimeoutSeconds { get; set; } = 300;

    /// how long a never-leased job may keep its credentials: every cleanup path keys on an expired lease, so an unleased
    /// job (pooled agent offline) held a plaintext password indefinitely
    public int AbandonedJobSeconds { get; set; } = 1800;

    /// shorter than a session bundle on purpose: a password does not rotate and cannot be revoked from here, so the
    /// window in which a stolen blob is worth anything is what can be made small
    public int CredentialBundleDays { get; set; } = 30;

    public int PolitenessMs { get; set; } = 800;

    /// <summary>Grace after a challenge expires before its image bytes are purged.</summary>
    public int ChallengeGraceSeconds { get; set; } = 300;

    /// seconds, not the agent's thirty: this leg is on a phone, and a long hang gets killed by mobile network or screen lock
    public int LiveFramePollSeconds { get; set; } = 5;

    /// longest the pushed live view (#429) holds one response; the consumer reconnects past the frame it drew, losing nothing
    public int LiveStreamSeconds { get; set; } = 600;

    /// keep-alive interval, well under the minute a reverse proxy (nginx, the NAS's) gives an idle upstream
    public int LiveStreamKeepAliveSeconds { get; set; } = 10;

    /// a day, not a week: a backstop for a consumer that broke before acking; days would keep everyone's purchase history here
    public int ResultRetentionDays { get; set; } = 1;

    /// how long a failed run's picture waits for the person's consent (#441 L1); 48h so an unanswered question is no store
    public int ArtifactConsentHours { get; set; } = 48;

    /// retention of a shared report or the operator's own run picture: a month, the time an adapter fix takes to ship
    public int ArtifactRetentionDays { get; set; } = 30;

    public int EnrollmentCodeSeconds { get; set; } = 900;

    public int ExpirySweepSeconds { get; set; } = 15;

    /// the sweep, not the canary interval (each canary has its own, floor fifteen minutes): how promptly a due one is noticed
    public int CanarySweepSeconds { get; set; } = 60;


    /// web bundle cap, null = manifest TTL; caps the sealed wrapper, not the credential inside (a refresh token lasts weeks)
    /// the tab (sessionStorage) is already the boundary, so a second deadline only hits the person using it correctly
    /// no renewal: the control plane holds credentials only on JobRow, and a swap would let a leaked bundle renew for ever
    public int? WebBundleMaxTtlSeconds { get; set; }
}
