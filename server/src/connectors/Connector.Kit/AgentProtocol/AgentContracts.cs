using System.Text.Json.Serialization;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace Connector.Kit.AgentProtocol;

// every call is outbound FROM the agent: the control plane never connects to one, so an agent can sit behind NAT, in a home
// lab or on a user's own machine
public sealed record AgentCapabilities
{
    /// <summary>Provider ids this agent can serve. Empty means any.</summary>
    public IReadOnlyList<string> Providers { get; init; } = [];

    public IReadOnlyList<ProviderRuntime> Runtimes { get; init; } = [];

    // where this agent's traffic leaves from; null makes no claim, and no claim satisfies no requirement
    // (EgressRequirement.IsSatisfiedBy)
    public EgressRequirement? Egress { get; init; }

    [JsonPropertyName("max_concurrency")]
    public int MaxConcurrency { get; init; } = 1;

    [JsonPropertyName("class")]
    public AgentClass Class { get; init; } = AgentClass.Pooled;

    // the digest of the adapter catalogue this agent runs; a differing digest means other adapter code or config and the
    // control plane leases it nothing (a login driven by an undocumented form fails unreadably); null = no claim
    [JsonPropertyName("catalog_digest")]
    public string? CatalogDigest { get; init; }

    // the browser this agent runs (#562); null from an agent built before the claim, which itself answers "is it behind"
    [JsonPropertyName("browser_version")]
    public string? BrowserVersion { get; init; }

    // false by default (as headless is): a login declaring LoginNeedsHeadedAgent is never offered to a machine that cannot
    // finish it; such an agent used to lease it, drive two minutes, meet the widget and fail blocked_by_provider
    public bool Headed { get; init; }

    // not a function of Headed: the headed need is about the login job kind only; a headless agent can run Amazon's fetches
    // Egress was compared by nobody: a datacenter fleet was offered Dutch-residential-line logins and met the tarpit
    // a manifest asking nothing is served by anybody. LoginEndpoints: a login nobody can serve is refused at once
    public bool CanServe(ProviderManifest manifest) =>
        (Providers.Count == 0 || Providers.Contains(manifest.Id, StringComparer.Ordinal))
        && (Runtimes.Count == 0 || Runtimes.Contains(manifest.Runtime))
        && (manifest.Agent.Egress?.IsSatisfiedBy(Egress) ?? true);
}

public sealed record EnrollRequest
{
    /// <summary>One-time, HMAC-signed, and carries the subject - so a BYO agent can only serve whoever enrolled it.</summary>
    public required string Code { get; init; }

    public required string Name { get; init; }

    public required AgentCapabilities Capabilities { get; init; }
}

public sealed record EnrollResponse
{
    [JsonPropertyName("agent_id")]
    public required string AgentId { get; init; }

    /// <summary>Scoped to /agent/v1/* and nothing else. Revocable individually.</summary>
    public required string Token { get; init; }

    [JsonPropertyName("heartbeat_seconds")]
    public int HeartbeatSeconds { get; init; } = 30;
}

public sealed record HeartbeatRequest
{
    public required AgentCapabilities Capabilities { get; init; }

    /// <summary>Persistent browser profiles this agent holds, for T4 routing.</summary>
    public IReadOnlyList<ProfileHealth> Profiles { get; init; } = [];

    public int Running { get; init; }

    // the agent wiped every browser profile since the beat that asked (ResetProfiles); a released hosted slot (#420 A2)
    // is free to the next person only once this arrives
    [JsonPropertyName("reset_done")]
    public bool ResetDone { get; init; }
}

public sealed record ProfileHealth
{
    public required string Id { get; init; }

    public required string Provider { get; init; }

    public required bool Healthy { get; init; }

    [JsonPropertyName("last_ok")]
    public DateTimeOffset? LastOk { get; init; }
}

public sealed record HeartbeatResponse
{
    [JsonPropertyName("lease_ttl_seconds")]
    public int LeaseTtlSeconds { get; init; } = 120;

    /// <summary>An agent that learns it is revoked stops and wipes its profiles.</summary>
    public bool Revoked { get; init; }

    // wipe every browser profile and carry on (#420 A2): the hosted slot was released and the next person must find nothing of
    // the last; asked every beat until the agent answers ResetDone
    [JsonPropertyName("reset_profiles")]
    public bool ResetProfiles { get; init; }

    // the control plane's digest, so an agent whose CatalogDigest differs can say so in its log, the only place its
    // operator looks
    [JsonPropertyName("catalog_digest")]
    public string? CatalogDigest { get; init; }
}

public sealed record LeaseRequest
{
    public IReadOnlyList<JobKind> Accept { get; init; } =
        [JobKind.Login, JobKind.Fetch, JobKind.Refresh, JobKind.Logout];
}

// unsealed once; the agent holds it in memory for the job and never persists it
public sealed record LeasedJob
{
    [JsonPropertyName("job_id")]
    public required string JobId { get; init; }

    [JsonPropertyName("session_id")]
    public required string SessionId { get; init; }

    public required string Provider { get; init; }

    public required JobKind Kind { get; init; }

    /// <summary>Login inputs. Present only for a login job.</summary>
    public IReadOnlyDictionary<string, string> Inputs { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>Unsealed session material. Null on a first login.</summary>
    public SessionMaterial? Material { get; init; }

    /// <summary>What to fetch. Null for a login or logout job.</summary>
    public ResourceRequest? Request { get; init; }

    /// <summary>T4: the persistent profile this job must use.</summary>
    [JsonPropertyName("profile_id")]
    public string? ProfileId { get; init; }

    [JsonPropertyName("lease_expires_at")]
    public required DateTimeOffset LeaseExpiresAt { get; init; }

    public JobLimits Limits { get; init; } = new();

    // record this run (#441 L3): browser and HTTP calls, redacted, posted when the run ends; only on a lab run,
    // refused on any other door
    public bool Record { get; init; }
}

public sealed record JobLimits
{
    [JsonPropertyName("timeout_seconds")]
    public int TimeoutSeconds { get; init; } = 300;

    /// <summary>Minimum gap between outbound provider calls.</summary>
    [JsonPropertyName("politeness_ms")]
    public int PolitenessMs { get; init; } = 800;
}

public sealed record ProgressReport
{
    public required JobStep Step { get; init; }

    [JsonPropertyName("steps_done")]
    public IReadOnlyList<JobStep> StepsDone { get; init; } = [];

    // latches true once a credential has gone upstream: a lost lease then fails the job instead of requeuing (a retried login
    // that may have counted locks accounts)
    [JsonPropertyName("credential_submitted")]
    public bool CredentialSubmitted { get; init; }

    // null leaves the last count standing rather than resetting it
    [JsonPropertyName("found")]
    public int? Found { get; init; }
}

public sealed record RaiseChallengeRequest
{
    public required ChallengeType Type { get; init; }

    // what the answer must contain: without it every agent-raised challenge reaches the consumer as Text, and browser-tier
    // providers (the only ones with a captcha) would not relay taps
    [JsonPropertyName("answer_kind")]
    public ChallengeAnswerKind AnswerKind { get; init; } = ChallengeAnswerKind.Text;

    [JsonPropertyName("prompt_key")]
    public string? PromptKey { get; init; }

    [JsonPropertyName("expires_at")]
    public required DateTimeOffset ExpiresAt { get; init; }

    public string? Code { get; init; }

    public string? Delivery { get; init; }

    public int? Length { get; init; }

    public IReadOnlyList<ChallengeOption>? Options { get; init; }

    public string? Url { get; init; }

    [JsonPropertyName("return_pattern")]
    public string? ReturnPattern { get; init; }

    /// <summary>Base64 PNG, already redacted by the agent before it leaves the machine.</summary>
    [JsonPropertyName("image_base64")]
    public string? ImageBase64 { get; init; }
}

public sealed record RaiseChallengeResponse
{
    [JsonPropertyName("challenge_id")]
    public required string ChallengeId { get; init; }
}

public sealed record JobResultRequest
{
    public IReadOnlyList<Account> Accounts { get; init; } = [];

    public IReadOnlyList<Transaction> Transactions { get; init; } = [];

    public IReadOnlyList<Receipt> Receipts { get; init; } = [];

    /// <summary>What a registry states you owe. A standing position, not an event.</summary>
    public IReadOnlyList<CreditRegistration> Registrations { get; init; } = [];

    // its own list like Registrations: a record shape not carried here is invisible however correctly an adapter produced it;
    // DUO shipped without it and a fetch succeeded, "complete", staging nothing, which reads as "no student debt"
    public IReadOnlyList<StudentDebt> Debts { get; init; } = [];

    /// <summary>Sealed by the control plane into a new bundle for the caller.</summary>
    [JsonPropertyName("session_material")]
    public SessionMaterial? SessionMaterial { get; init; }

    [JsonPropertyName("provider_account")]
    public Adapters.ProviderAccount? ProviderAccount { get; init; }

    public IReadOnlyList<ReachableAccount> Reachable { get; init; } = [];

    [JsonPropertyName("expires_at")]
    public DateTimeOffset? ExpiresAt { get; init; }

    public bool Complete { get; init; } = true;

    public string? Via { get; init; }

    // operator-facing prose, scrubbed of credential values by the agent, never localised, and not part of ProgressReport
    // (a closed translatable set); explains outcomes that look like success (a partial page, an unlistable account type)
    public IReadOnlyList<string> Notes { get; init; } = [];

    // staged onto the same row as the normalised record, so the ack that purges one purges the other;
    // raw gets no lifetime of its own
    public IReadOnlyDictionary<string, string> Raw { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);
}

// the host decides (only it knows the retry policy) and the agent acts (only it holds the browser): the queue may requeue,
// and an agent tidying up after attempt one would hand attempt two a dead session
public sealed record AgentFailResponse
{
    public required JobState State { get; init; }
}

public sealed record JobFailRequest
{
    /// <summary>Wire form of an <see cref="Errors.ErrorCode"/>.</summary>
    public required string Code { get; init; }

    /// <summary>Operator-facing. Never localised, never shown to an end user.</summary>
    public string? Detail { get; init; }

    // what the adapter said BEFORE it failed, which is usually where the reason is
    public IReadOnlyList<string> Notes { get; init; } = [];

    // redacted screenshot and DOM digest; never captured while a secret field holds content
    public FailureArtifacts? Artifacts { get; init; }
}

public sealed record FailureArtifacts
{
    [JsonPropertyName("screenshot_base64")]
    public string? ScreenshotBase64 { get; init; }

    [JsonPropertyName("dom_digest")]
    public string? DomDigest { get; init; }
}
