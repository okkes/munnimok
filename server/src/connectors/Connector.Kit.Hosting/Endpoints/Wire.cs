using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;

namespace Connector.Kit.Hosting.Endpoints;

// snake case comes from the serializer, so these read as ordinary C#

public sealed record CatalogResponse
{
    public required IReadOnlyList<JsonObject> Providers { get; init; }

    public required ServiceDescriptor Service { get; init; }
}

public sealed record ServiceDescriptor
{
    /// The kinds present in the manifests served: one environment runs one control plane for every pack.
    public required IReadOnlyList<ProviderKind> Kinds { get; init; }

    public required string Version { get; init; }

    public required string ManifestDigest { get; init; }
}

public sealed record LoginRequest
{
    public required string Subject { get; init; }

    /// <summary>Echoed back so a user can tell two connections apart. Never sent upstream.</summary>
    public string? Label { get; init; }

    public IReadOnlyDictionary<string, string> Inputs { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// A sealed credential bundle offered instead of asking the human again. Read only when Inputs is empty, and validated
    /// like posted inputs, so it cannot carry a field the provider never declared.
    public string? CredentialBundle { get; init; }

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public ConsentRecord? Consent { get; init; }

    /// <summary>Record the run (#441 L3). Honoured with the lab trigger only; refused otherwise.</summary>
    public bool Record { get; init; }

    /// An agent id, the reserved word <see cref="RunOn.Fleet"/>, or nothing (no preference: the queue gives the caller's own
    /// live machine a head start). Required for a <c>device_persistent</c> provider. A reserved word, not a second field:
    /// one field cannot contradict itself and an agent id cannot be spelt <c>fleet</c>.
    public string? PreferAgent { get; init; }
}

public sealed record ConsentRecord
{
    public DateTimeOffset? AcceptedAt { get; init; }

    public string? TermsVersion { get; init; }
}

public sealed record SessionResponse
{
    public required string SessionId { get; init; }

    public required SessionState State { get; init; }

    /// <summary>Present exactly once, when the session first becomes usable or rotates.</summary>
    public string? Bundle { get; init; }

    /// What the human typed, sealed for the device to keep; present once, only where the provider declares
    /// <c>offers_credential_store</c>. Offer it back as <c>credential_bundle</c>. On web keep it for the tab only:
    /// surviving a browser restart is what the custody model exists to avoid.
    public string? CredentialBundle { get; init; }

    public DateTimeOffset? ExpiresAt { get; init; }

    public ProviderAccount? ProviderAccount { get; init; }

    public ChallengeView? Challenge { get; init; }

    public ProgressView? Progress { get; init; }

    /// <summary><c>ephemeral</c> for a web client, so the consumer can say "sign in again to sync".</summary>
    public string? Custody { get; init; }

    public string? Label { get; init; }

    public IReadOnlyDictionary<string, string>? Config { get; init; }

    /// The adapter's sign-in notes, read from the login job so a note appears when written; see <see cref="JobResponse.Notes"/>.
    public IReadOnlyList<string> Notes { get; init; } = [];

    /// <summary>
    /// The failed sign-in whose last picture waits on this person's answer
    /// (#441 L1): the consumer asks "report this failure?" beside the error
    /// and posts the answer to <c>/jobs/{jobId}/artifacts/share</c>, or
    /// deletes <c>/jobs/{jobId}/artifacts</c>. Null when nothing waits.
    /// </summary>
    public string? ArtifactsJobId { get; init; }
}

public sealed record ChallengeView
{
    public required string Id { get; init; }

    public required ChallengeType Type { get; init; }

    /// Tells the consumer to draw a tappable picture instead of a text box.
    public ChallengeAnswerKind AnswerKind { get; init; } = ChallengeAnswerKind.Text;

    public string? PromptKey { get; init; }

    /// <summary>Authenticated, and only while the challenge is live.</summary>
    public string? ImageUrl { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }

    public string? Code { get; init; }

    public string? Delivery { get; init; }

    public int? Length { get; init; }

    public IReadOnlyList<ChallengeOption>? Options { get; init; }

    public string? Url { get; init; }

    public string? ReturnPattern { get; init; }

    public static ChallengeView From(ChallengeRow row, string providerId, string sessionId)
    {
        ArgumentNullException.ThrowIfNull(row);
        var payload = ConnectorJson.DeserializeOr(row.PayloadJson, new ChallengePayload());

        return new ChallengeView
        {
            Id = row.Id,
            Type = row.Type,
            AnswerKind = payload.AnswerKind,
            PromptKey = payload.PromptKey,
            ImageUrl = row.ImageBytes is null
                ? null
                : $"/v1/{providerId}/login/{sessionId}/challenges/{row.Id}/image",
            ExpiresAt = row.ExpiresAt,
            Code = payload.Code,
            Delivery = payload.Delivery,
            Length = payload.Length,
            Options = payload.Options,
            Url = payload.Url,
            ReturnPattern = payload.ReturnPattern,
        };
    }
}

/// Typed progress, never prose: free text cannot be translated and becomes a de-facto API once a consumer string-matches it.
public sealed record ProgressView
{
    public required JobStep Step { get; init; }

    public required IReadOnlyList<JobStep> StepsDone { get; init; }

    /// While waiting: queued jobs older than it, any party's (the fleet drains oldest first); null once it runs.
    public int? Ahead { get; init; }

    /// Records gathered so far, as the agent reported page by page; null until it counted anything.
    public int? Found { get; init; }

    public static ProgressView From(JobRow job)
    {
        ArgumentNullException.ThrowIfNull(job);
        return new ProgressView
        {
            Step = job.Step,
            StepsDone = ConnectorJson.DeserializeOr<IReadOnlyList<JobStep>>(job.StepsDoneJson, []),
            Found = job.Found,
        };
    }
}

public sealed record AnswerRequest
{
    public required string ChallengeId { get; init; }

    /// <summary>Empty for a passive challenge: the human acted somewhere we cannot observe.</summary>
    public string Value { get; init; } = string.Empty;
}

public sealed record ResumeRequest
{
    public required string Subject { get; init; }

    public required string Bundle { get; init; }
}

/// Optional so a disconnect always succeeds. Supplying it is what makes an upstream logout possible (custody is the
/// user's device); a provider declaring <c>logout: none</c> ignores it.
public sealed record DisconnectRequest
{
    public string? Bundle { get; init; }
}

public sealed record ResumeResponse
{
    public required string Ticket { get; init; }

    public required string SessionId { get; init; }

    public required int ExpiresIn { get; init; }

    public required SessionState State { get; init; }
}

public sealed record OneShotFetchRequest
{
    public required string Subject { get; init; }

    public required string Bundle { get; init; }

    /// <summary>Same vocabulary as the query string, validated against the same ParamSpec.</summary>
    public IReadOnlyDictionary<string, JsonNode?> Params { get; init; } =
        new Dictionary<string, JsonNode?>(StringComparer.Ordinal);

    /// <summary>Record the run (#441 L3). Honoured with the lab trigger only; refused otherwise.</summary>
    public bool Record { get; init; }
}

public sealed record DataResponse
{
    public required string Resource { get; init; }

    public required JsonArray Data { get; init; }

    public string? Cursor { get; init; }

    public required bool Complete { get; init; }

    /// Here as well as on <see cref="JobResponse"/>: a fetch finishing inside the wait window never becomes a polled job,
    /// so notes only on the slow path would vanish whenever the provider was quick.
    public IReadOnlyList<string> Notes { get; init; } = [];

    public SessionBundle? Session { get; init; }
}

public sealed record SessionBundle
{
    public required string Bundle { get; init; }

    public required bool Rotated { get; init; }
}

public sealed record JobAcceptedResponse
{
    public required string JobId { get; init; }

    public required JobState State { get; init; }

    public string? Poll { get; init; }

    public string? Events { get; init; }

    public ChallengeView? Challenge { get; init; }

    public ProgressView? Progress { get; init; }
}

public sealed record JobResponse
{
    public required string JobId { get; init; }

    public required string SessionId { get; init; }

    public required JobState State { get; init; }

    public string? Resource { get; init; }

    public required ProgressView Progress { get; init; }

    public ChallengeView? Challenge { get; init; }

    public JsonArray? Data { get; init; }

    public string? Cursor { get; init; }

    /// <summary>False when more remains beyond this pass.</summary>
    public bool Complete { get; init; } = true;

    public SessionBundle? Session { get; init; }

    /// Operator-facing prose, deliberately not part of <see cref="ProgressView"/> (a closed, translatable vocabulary). Meant for
    /// outcomes that look like success: a partial page, an unlisted account type, an unserved balance.
    public IReadOnlyList<string> Notes { get; init; } = [];

    public ConnectorError? Error { get; init; }

    /// <summary>This job, when its last picture waits on the person's answer; see <see cref="SessionResponse.ArtifactsJobId"/>.</summary>
    public string? ArtifactsJobId { get; init; }
}

public sealed record AckRequest
{
    public required string Cursor { get; init; }
}

/// The local purge always happens; <see cref="LoggedOut"/> says whether an upstream logout was dispatched. The route used
/// to answer 204 in every case, so consumers repeated the manifest's claim over a disconnect that sent nothing.
public sealed record DisconnectResponse
{
    /// Whether a sign-out was DISPATCHED, not whether it landed: the logout job drives a browser for as long as it takes,
    /// and its outcome notes live on the job, hence <see cref="JobId"/>.
    [JsonPropertyName("logged_out")]
    public required bool LoggedOut { get; init; }

    /// The logout job, to learn whether it worked; null when nothing was dispatched.
    [JsonPropertyName("job_id")]
    public string? JobId { get; init; }

    /// Why not, when <see cref="LoggedOut"/> is false. Operator prose, not a copy key: "no bundle sent" is a consumer bug
    /// that looks exactly like a provider without a logout.
    public string? Reason { get; init; }
}

/// The bundle is from a normal login for an account the OPERATOR owns. Subject must carry the canary marker, so a real
/// user's connection cannot be enrolled by mistake (see <c>CanaryService.SubjectPrefix</c>).
public sealed record CanaryEnrolmentRequest
{
    public required string Subject { get; init; }

    public required string Bundle { get; init; }

    public required string Resource { get; init; }

    public required int IntervalMinutes { get; init; }
}

/// <summary>
/// A canary, and what its last run concluded. Never its bundle.
/// </summary>
public sealed record CanaryView
{
    public required string ProviderId { get; init; }

    public required string Resource { get; init; }

    public required int IntervalMinutes { get; init; }

    public DateTimeOffset? LastRunAt { get; init; }

    /// <summary>The run itself, so an operator can read its notes and its error.</summary>
    public string? LastJobId { get; init; }

    /// <summary>Null before the first run has been read.</summary>
    public bool? Intact { get; init; }

    /// <summary>Operator prose. Never a record, and never a user's copy key.</summary>
    public string? Verdict { get; init; }

    /// <summary>The row as the operator sees it: everything but the bundle, which has no field here.</summary>
    public static CanaryView From(CanaryRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        return new CanaryView
        {
            ProviderId = row.ProviderId,
            Resource = row.ResourceId,
            IntervalMinutes = row.IntervalMinutes,
            LastRunAt = row.LastRunAt,
            LastJobId = row.LastJobId,
            Intact = row.LastIntact,
            Verdict = row.LastVerdict,
        };
    }
}

public sealed record CanaryListResponse
{
    public required IReadOnlyList<CanaryView> Canaries { get; init; }
}

public sealed record AgentEnrollmentRequest
{
    public required string Subject { get; init; }

    public required string Name { get; init; }
}

public sealed record AgentEnrollmentResponse
{
    public required string Code { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }
}

public sealed record AgentView
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required AgentClass Class { get; init; }

    public required bool Revoked { get; init; }

    public required DateTimeOffset LastHeartbeatAt { get; init; }

    public required bool Online { get; init; }

    /// <summary>
    /// True when the agent declared an adapter catalogue other than this
    /// control plane's: alive, enrolled, and leased nothing until it runs the
    /// same image and configuration.
    /// </summary>
    public required bool Stale { get; init; }

    public required IReadOnlyList<ProfileView> Profiles { get; init; }

    /// <summary>munni's own container that serves one person at a time (#420 A2).</summary>
    public bool Hosted { get; init; }

    /// <summary>A hosted slot somebody holds now (the caller, in their own listing).</summary>
    public bool Bound { get; init; }

    public DateTimeOffset? BoundAt { get; init; }

    /// <summary>A hosted slot that was released and has not wiped its profiles yet: free to nobody.</summary>
    public bool Resetting { get; init; }

    /// <summary>What the agent claimed on its last heartbeat (#441 L4): the parties and runtimes it serves, its egress, its concurrency.</summary>
    public AgentProtocol.AgentCapabilities? Capabilities { get; init; }

    /// <summary>
    /// #562: the agent runs an older browser than this platform (or one from before it said which). It still
    /// takes work - a bank may turn an outdated browser away, and its owner is the one who can renew it.
    /// </summary>
    public bool BrowserBehind { get; init; }

    /// <summary>The browser the agent said it runs; null when it never said.</summary>
    public string? BrowserVersion { get; init; }

    /// <summary>The browser this platform runs: what "behind" is measured against.</summary>
    public string? PlatformBrowserVersion { get; init; }
}

/// <summary>The caller's standing with the hosted private agents (#420 A2).</summary>
public sealed record PrivateAgentStatusResponse
{
    /// <summary>Whether this control plane has any hosted slot at all; false hides the whole offer.</summary>
    public required bool Offered { get; init; }

    /// <summary>Slots online, unbound and clean - what an approval can hand out right now.</summary>
    public required int Free { get; init; }

    public PrivateAgentRequestView? Request { get; init; }

    public AgentView? Agent { get; init; }
}

public sealed record PrivateAgentRequestView
{
    public required string Id { get; init; }

    public required string Subject { get; init; }

    /// <summary>pending, approved, denied, withdrawn or released.</summary>
    public required string State { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    public DateTimeOffset? DecidedAt { get; init; }

    public string? AgentId { get; init; }
}

public sealed record PrivateAgentRequestBody
{
    public required string Subject { get; init; }
}

/// <summary>The operator's view (#420 A2): every hosted slot with who holds it, and the requests.</summary>
public sealed record PrivateAgentAdminResponse
{
    public required int Total { get; init; }

    public required int Free { get; init; }

    public required IReadOnlyList<PrivateAgentSlotView> Slots { get; init; }

    public required IReadOnlyList<PrivateAgentRequestView> Requests { get; init; }
}

public sealed record PrivateAgentSlotView
{
    public required AgentView Agent { get; init; }

    /// <summary>The pseudonymous subject holding the slot; null while it is free.</summary>
    public string? Subject { get; init; }
}

public sealed record ProfileView
{
    public required string Id { get; init; }

    public required string Provider { get; init; }

    public required bool Healthy { get; init; }

    public DateTimeOffset? LastOkAt { get; init; }
}

public sealed record AgentListResponse
{
    public required IReadOnlyList<AgentView> Agents { get; init; }
}

public sealed record HealthResponse
{
    public required string Status { get; init; }

    public required string Version { get; init; }
}

public sealed record StatusResponse
{
    public required ServiceDescriptor Service { get; init; }

    public required IReadOnlyList<ProviderStatus> Providers { get; init; }

    public required AgentPoolView Agents { get; init; }

    public required QueueView Queue { get; init; }
}

public sealed record AgentPoolView
{
    public required int Total { get; init; }

    public required int Online { get; init; }

    public required int Revoked { get; init; }
}

public sealed record QueueView
{
    public required int Queued { get; init; }

    public required int Running { get; init; }

    public required int AwaitingInput { get; init; }
}

public sealed record ProviderStatusUpdate
{
    public required ProviderState State { get; init; }

    public string? ReasonKey { get; init; }
}

/// The image is base64 rather than multipart: an agent posts JSON everywhere else.
public sealed record AgentChallengeRequest
{
    public required ChallengeType Type { get; init; }

    /// Must mirror <see cref="Connector.Kit.AgentProtocol.RaiseChallengeRequest"/> field for field: that is what the agent
    /// SENDS, this is what the server BINDS, and only review keeps them in step.
    public ChallengeAnswerKind AnswerKind { get; init; } = ChallengeAnswerKind.Text;

    public string? PromptKey { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }

    public string? Code { get; init; }

    public string? Delivery { get; init; }

    public int? Length { get; init; }

    public IReadOnlyList<ChallengeOption>? Options { get; init; }

    public string? Url { get; init; }

    public string? ReturnPattern { get; init; }

    [JsonPropertyName("image_base64")]
    public string? ImageBase64 { get; init; }
}

public sealed record RenewResponse
{
    public required DateTimeOffset LeaseExpiresAt { get; init; }
}

/// <summary>The answer to a share: what is kept and until when. Never the picture - that is the operator's to read, under <c>/admin</c>.</summary>
public sealed record ArtifactShareResponse
{
    public required string JobId { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }
}

/// <summary>
/// A job as the operator reads it: every column that says what happened,
/// and none of the ones that say what was typed. Inputs and material are
/// not on this record and have no field to arrive through.
/// </summary>
public sealed record OperatorJobView
{
    public required string JobId { get; init; }

    public required string SessionId { get; init; }

    /// <summary>The session's pseudonymous subject; the consumer that minted it can say whose.</summary>
    public required string Subject { get; init; }

    public required string ProviderId { get; init; }

    public required JobKind Kind { get; init; }

    public required JobState State { get; init; }

    public string? Resource { get; init; }

    /// <summary><c>user</c>, <c>schedule</c>, <c>lab</c>, <c>canary</c>, or null for a run nobody in particular asked for.</summary>
    public string? Trigger { get; init; }

    public required ProgressView Progress { get; init; }

    public int Attempts { get; init; }

    public bool CredentialSubmitted { get; init; }

    public bool Complete { get; init; }

    /// <summary>The agent that last held the lease.</summary>
    public string? AgentId { get; init; }

    public string? ProfileId { get; init; }

    public bool FleetOnly { get; init; }

    public DateTimeOffset CreatedAt { get; init; }

    public DateTimeOffset UpdatedAt { get; init; }

    public ConnectorError? Error { get; init; }

    /// <summary>What the adapter said when it gave up. Operator-facing prose, never shown to an end user.</summary>
    public string? ErrorDetail { get; init; }

    public IReadOnlyList<string> Notes { get; init; } = [];

    /// <summary>The validated request: the resource and its window, never raw caller input.</summary>
    public JsonNode? Params { get; init; }

    public IReadOnlyDictionary<string, string>? Config { get; init; }

    /// <summary><c>none</c>, <c>pending</c> (held for the person's answer; nothing readable), or <c>retained</c>.</summary>
    public required string Artifacts { get; init; }

    public string? DomDigest { get; init; }

    public bool HasScreenshot { get; init; }

    public DateTimeOffset? ArtifactsExpireAt { get; init; }

    public TraceSummaryView? Trace { get; init; }
}

public sealed record TraceSummaryView
{
    public int Entries { get; init; }

    public int Dropped { get; init; }

    public bool Truncated { get; init; }

    public int Bytes { get; init; }

    public DateTimeOffset StartedAt { get; init; }

    public DateTimeOffset EndedAt { get; init; }

    public DateTimeOffset CapturedAt { get; init; }

    public DateTimeOffset ExpiresAt { get; init; }
}

public sealed record TraceAckResponse
{
    public int Entries { get; init; }

    public int Bytes { get; init; }
}

public sealed record JobListResponse
{
    public required IReadOnlyList<OperatorJobView> Jobs { get; init; }

    /// <summary>True when the limit cut the list: narrow the filters, or ask again with <c>before</c> at the last row's moment.</summary>
    public bool Truncated { get; init; }
}

public sealed record HealthReportResponse
{
    public required DateTimeOffset GeneratedAt { get; init; }

    public required IReadOnlyList<ProviderHealthView> Providers { get; init; }
}

public sealed record ProviderHealthView
{
    public required string ProviderId { get; init; }

    public required ProviderStatus Status { get; init; }

    public required IReadOnlyDictionary<string, HealthWindow> Windows { get; init; }

    /// <summary>Within the month the report covers; null when no run succeeded in it.</summary>
    public DateTimeOffset? LastSuccessAt { get; init; }

    public HealthFailure? LastFailure { get; init; }

    /// <summary>Sessions by state (<c>active</c>, <c>needs_reauth</c>, <c>blocked</c>, <c>awaiting_input</c>, ...), every state the table holds.</summary>
    public required IReadOnlyDictionary<string, int> Sessions { get; init; }

    public CanaryView? Canary { get; init; }

    public int Reports { get; init; }

    /// <summary>Pictures still waiting on a person's answer. A count and nothing else.</summary>
    public int PendingReports { get; init; }
}

public sealed record HealthWindow
{
    public int Total { get; init; }

    public int Succeeded { get; init; }

    public int Failed { get; init; }

    public int Expired { get; init; }

    public int Open { get; init; }

    public required IReadOnlyDictionary<string, int> ByCode { get; init; }

    public required IReadOnlyDictionary<string, int> ByTrigger { get; init; }

    /// <summary>Distinct sessions of people - not the operator's runs - whose run failed or expired.</summary>
    public int PeopleAffected { get; init; }
}

public sealed record HealthFailure
{
    public required string JobId { get; init; }

    public required string Code { get; init; }

    public string? Trigger { get; init; }

    public required DateTimeOffset At { get; init; }
}
