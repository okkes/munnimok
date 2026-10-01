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

// The public wire shapes, in one file. Snake case comes from the serializer,
// so these read as ordinary C# and still land on the contract in the spec.

public sealed record CatalogResponse
{
    public required IReadOnlyList<JsonObject> Providers { get; init; }

    public required ServiceDescriptor Service { get; init; }
}

public sealed record ServiceDescriptor
{
    /// <summary>
    /// The kinds this control plane hosts — <c>bank</c>, <c>store</c>,
    /// <c>registry</c> — read from the manifests it serves. One munni
    /// environment runs one control plane for every pack, so the catalogue
    /// says which kinds are present instead of pretending to be one product.
    /// </summary>
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

    /// <summary>
    /// A credential bundle this connector sealed earlier, offered instead of
    /// asking the human again.
    ///
    /// Read only when <see cref="Inputs"/> is empty, so a caller that sends
    /// both is taken at the word of what it typed rather than what it
    /// remembered. What comes out is fed through the manifest's own validator
    /// exactly as posted inputs are, so a bundle cannot carry a field the
    /// provider never declared.
    /// </summary>
    public string? CredentialBundle { get; init; }

    /// <summary>Non-secret settings the provider needs on every call.</summary>
    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public ConsentRecord? Consent { get; init; }

    /// <summary>
    /// Where this run should happen: an agent id, the reserved word
    /// <see cref="RunOn.Fleet"/>, or nothing at all. Required for a
    /// <c>device_persistent</c> provider.
    /// </summary>
    /// <remarks>
    /// THREE ANSWERS, AND UNTIL 2026-09-21 THERE WERE ONLY TWO. Absent has
    /// always meant "no preference", which the queue honours by giving the
    /// caller's own live machine a head start; naming an agent has always
    /// meant that machine. What had no spelling was "the operator's fleet,
    /// please" - so a consumer offering both options sent nothing for the
    /// fleet, and nothing is not a choice. The account holder picked the fleet
    /// for DUO that day and watched it run on their own NAS again, because a
    /// standing preference the queue infers was beating an explicit one the
    /// wire could not carry.
    /// <para>
    /// The reserved word rather than a field beside this one, for the reason
    /// <see cref="RunOn"/> gives: one field cannot contradict itself, and an
    /// agent id cannot be spelt <c>fleet</c>.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// What the human typed, sealed for this device to keep - present exactly
    /// once, and only where the provider declares
    /// <c>offers_credential_store</c>.
    ///
    /// Offer it back as <c>credential_bundle</c> on the next login and the same
    /// human is not asked again. Store it the way the device class allows: on
    /// web that is the tab and nothing longer, because a sealed password
    /// surviving a browser restart is the thing the whole custody model exists
    /// to avoid.
    /// </summary>
    public string? CredentialBundle { get; init; }

    public DateTimeOffset? ExpiresAt { get; init; }

    public ProviderAccount? ProviderAccount { get; init; }

    public ChallengeView? Challenge { get; init; }

    public ProgressView? Progress { get; init; }

    /// <summary><c>ephemeral</c> for a web client, so the consumer can say "sign in again to sync".</summary>
    public string? Custody { get; init; }

    public string? Label { get; init; }

    public IReadOnlyDictionary<string, string>? Config { get; init; }

    /// <summary>
    /// What the adapter said while signing in. See <see cref="JobResponse.Notes"/>.
    /// </summary>
    /// <remarks>
    /// THE SIGN-IN IS WHERE MOST NOTES ARE WRITTEN and it was the one outcome
    /// that carried none. An adapter says which of two doors the provider
    /// opened, whether the password form appeared at all, what scope the
    /// session came back with, which endpoints it touched - and every one of
    /// those went to the agent's stdout, on whichever machine ran the job, while
    /// the person watching the screen was told only "connected".
    /// <para>
    /// Read from the same login job the progress trail comes from, so a note
    /// appears the moment it is written rather than at the end.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> Notes { get; init; } = [];
}

public sealed record ChallengeView
{
    public required string Id { get; init; }

    public required ChallengeType Type { get; init; }

    /// <summary>
    /// Tells the consumer to draw a tappable picture instead of a text box.
    /// This is the last hop before munni, and the only field on this view that
    /// changes what the human is shown rather than what they are told.
    /// </summary>
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

/// <summary>
/// Typed progress, never prose. A free-text status cannot be translated,
/// cannot drive a progress bar, and becomes a de-facto API the moment a
/// consumer string-matches it.
/// </summary>
public sealed record ProgressView
{
    public required JobStep Step { get; init; }

    public required IReadOnlyList<JobStep> StepsDone { get; init; }

    public static ProgressView From(JobRow job)
    {
        ArgumentNullException.ThrowIfNull(job);
        return new ProgressView
        {
            Step = job.Step,
            StepsDone = ConnectorJson.DeserializeOr<IReadOnlyList<JobStep>>(job.StepsDoneJson, []),
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

/// <summary>
/// The optional body of <c>DELETE /v1/{provider}/sessions/{id}</c>.
///
/// Optional because disconnecting must always succeed: a caller that has lost
/// its bundle, or never held one, is still entitled to remove the connection.
/// Supplying it is what makes an upstream logout possible at all - custody is
/// the user's device, so the only copy of the credential is the one they hand
/// back here, and a provider declaring <c>logout: none</c> ignores it entirely.
/// </summary>
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
}

public sealed record DataResponse
{
    public required string Resource { get; init; }

    public required JsonArray Data { get; init; }

    public string? Cursor { get; init; }

    public required bool Complete { get; init; }

    /// <summary>
    /// What the adapter said about this run. See <see cref="JobResponse.Notes"/>.
    /// </summary>
    /// <remarks>
    /// Here as well as on <see cref="JobResponse"/> because a fetch that
    /// finishes inside the wait window never becomes a job the caller polls -
    /// it comes straight back as data. A note that appeared only on the slow
    /// path would be a note that vanished whenever the provider was quick.
    /// </remarks>
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

    /// <summary>
    /// What the adapter said about this run, in the order it said it.
    /// </summary>
    /// <remarks>
    /// Operator-facing prose, and deliberately NOT part of
    /// <see cref="ProgressView"/> - that type is a closed, translatable
    /// vocabulary, and these are sentences an adapter author wrote in whatever
    /// language they wrote them in. Both are true at once and neither can do
    /// the other's job.
    /// <para>
    /// They exist because the outcomes most in need of explaining are the ones
    /// that already look like success: a page of transactions that is partial,
    /// an account type a provider would not list, a balance it does not serve.
    /// Without this the explanation was in the agent's stdout, on whichever
    /// machine happened to run the job.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> Notes { get; init; } = [];

    public ConnectorError? Error { get; init; }
}

public sealed record AckRequest
{
    public required string Cursor { get; init; }
}

/// <summary>
/// What a disconnect actually did about the provider's own session.
/// </summary>
/// <remarks>
/// The local purge always happens - a user disconnecting must always succeed
/// here. <see cref="LoggedOut"/> says whether an upstream logout was dispatched
/// as well, which depends on the manifest declaring one, the session still
/// being active, and the caller having handed over the bundle to do it with.
/// <para>
/// It exists because this route used to answer 204 in every case, so a consumer
/// could only repeat the manifest's claim - and did, telling people their bank
/// had been signed out of when nothing had been sent.
/// </para>
/// </remarks>
public sealed record DisconnectResponse
{
    /// <summary>
    /// Whether a sign-out was DISPATCHED - not whether it landed.
    /// </summary>
    /// <remarks>
    /// The distinction is the whole reason <see cref="JobId"/> is here. This
    /// endpoint queues a logout job and returns; the job then drives a browser
    /// for as long as that takes. So true means "the provider is being told",
    /// and the consuming app said "the connector logged out upstream" - past
    /// tense, completed - over a job that had not started.
    /// <para>
    /// The adapters know the difference and say so: ASN's logout confirms the
    /// signed-out page it reaches and notes "signed out upstream" or "the
    /// sign-out was clicked but the signed-out page never arrived". That
    /// sentence lives on the job, which is why the id comes back.
    /// </para>
    /// </remarks>
    [JsonPropertyName("logged_out")]
    public required bool LoggedOut { get; init; }

    /// <summary>
    /// The logout job, for a caller that wants to know whether it worked.
    /// Null when nothing was dispatched.
    /// </summary>
    [JsonPropertyName("job_id")]
    public string? JobId { get; init; }

    /// <summary>
    /// Why not, when <see cref="LoggedOut"/> is false. Null when it is true.
    /// </summary>
    /// <remarks>
    /// Four of the five branches are the caller's to fix - most of all "the
    /// caller sent no bundle to log out with", which is a consumer bug that
    /// looks exactly like a provider without a logout. Operator prose rather
    /// than a copy key, on the same footing as a note: the audience is whoever
    /// is debugging the consumer, not the account holder.
    /// </remarks>
    public string? Reason { get; init; }
}

/// <summary>
/// Enrolling the operator's own connection as a provider's canary.
/// </summary>
/// <remarks>
/// The bundle is the one a normal login handed back, for an account the
/// OPERATOR owns and created for this. <see cref="Subject"/> has to carry the
/// canary marker, which is what makes it impossible to enrol a real user's
/// connection here by mistake - see <c>CanaryService.SubjectPrefix</c>.
/// </remarks>
public sealed record CanaryEnrolmentRequest
{
    public required string Subject { get; init; }

    public required string Bundle { get; init; }

    /// <summary>Which resource to read. The cheapest one that exercises the parser.</summary>
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
}

/// <summary>The caller's standing with the hosted private agents (#420 A2).</summary>
public sealed record PrivateAgentStatusResponse
{
    /// <summary>Whether this control plane has any hosted slot at all; false hides the whole offer.</summary>
    public required bool Offered { get; init; }

    /// <summary>Slots online, unbound and clean - what an approval can hand out right now.</summary>
    public required int Free { get; init; }

    /// <summary>The caller's latest request, whatever its state.</summary>
    public PrivateAgentRequestView? Request { get; init; }

    /// <summary>The slot bound to the caller, if one is.</summary>
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

/// <summary>
/// The agent's challenge upload. The image arrives base64 rather than as a
/// multipart part: an agent posts JSON everywhere else, and one encoding for
/// the whole protocol is worth the third of a byte.
/// </summary>
public sealed record AgentChallengeRequest
{
    public required ChallengeType Type { get; init; }

    /// <summary>
    /// Must mirror <see cref="Connector.Kit.AgentProtocol.RaiseChallengeRequest"/>
    /// field for field - that record is what the agent SENDS, this one is what
    /// the server BINDS, and nothing but review keeps the two in step.
    /// </summary>
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
