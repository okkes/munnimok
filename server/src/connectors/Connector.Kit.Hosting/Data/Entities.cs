using System.Text.Json.Serialization;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;

namespace Connector.Kit.Hosting.Data;

/// where the bundle lives, so how long it may live: custody says who holds the secret, device class how long
[JsonConverter(typeof(JsonStringEnumConverter<DeviceClass>))]
public enum DeviceClass
{
    /// <summary>An encrypted store on the user's device. The bundle survives restarts.</summary>
    Native,

    /// <summary>The tab session only. The bundle's TTL is capped hard.</summary>
    Web,
}

/// a connection; under client custody the row holds no secret, only who it is for, what it is, whether it works
public sealed class SessionRow
{
    public string Id { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    /// <summary>Pseudonymous and consumer-minted. The connector cannot map it to a person.</summary>
    public string Subject { get; set; } = string.Empty;

    public SessionState State { get; set; } = SessionState.Queued;

    /// <summary>Sealed into every bundle as AAD, so a stale bundle is rejected rather than misread.</summary>
    public int ManifestVersion { get; set; }

    public string? AgentId { get; set; }

    /// the persistent browser profile; jobs for this session route only there
    public string? ProfileId { get; set; }

    /// the caller named the operator's fleet: none of their machines may take this connection's work
    /// false is not "fleet may have it": nothing was expressed, and the queue gives the caller's own machine a head start
    public bool FleetOnly { get; set; }

    /// <summary>Non-secret provider settings (country, language). Loggable.</summary>
    public string ConfigJson { get; set; } = "{}";

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Echoed back so a user can tell two connections apart. Never sent upstream.</summary>
    public string? Label { get; set; }

    public DateTimeOffset? ConsentAcceptedAt { get; set; }

    public string? ConsentTermsVersion { get; set; }

    public DeviceClass DeviceClass { get; set; } = DeviceClass.Native;

    /// what the provider called this connection, so a user with two connections to one store can tell them apart
    public string? ProviderAccountJson { get; set; }

    /// sealed bundle waiting to be collected: a login finishes on an agent minutes after the request returned
    /// ciphertext the control plane cannot read; cleared the moment it is handed over
    public string? PendingBundle { get; set; }

    /// sealed credentials waiting to be collected, for providers with a credential store
    /// handed over and cleared with PendingBundle
    public string? PendingCredentialBundle { get; set; }
}

public sealed class JobRow
{
    public string Id { get; set; } = string.Empty;

    public string SessionId { get; set; } = string.Empty;

    /// <summary>Denormalised from the session: leasing filters on it and must stay one table.</summary>
    public string ProviderId { get; set; } = string.Empty;

    public JobKind Kind { get; set; }

    public JobState State { get; set; } = JobState.Queued;

    /// <summary>The validated <see cref="ResourceRequest"/>. Never raw caller input.</summary>
    public string ParamsJson { get; set; } = "{}";

    public string? ResourceId { get; set; }

    public string? LeaseOwner { get; set; }

    /// <summary>
    /// The agent that last held the lease, kept after it ends (#441 L4): the
    /// lease owner is cleared when a job settles, and the history has to
    /// say which machine ran a job long after that.
    /// </summary>
    public string? AgentId { get; set; }

    public DateTimeOffset? LeaseExpiresAt { get; set; }

    /// <summary>Incremented on every lease. Two is the ceiling; see the queue.</summary>
    public int Attempts { get; set; }

    /// <summary>
    /// Latches true once a credential has gone upstream. After this a lost
    /// lease fails the job permanently instead of requeuing it - retrying a
    /// login that may already have counted is how bank accounts get locked.
    /// </summary>
    public bool CredentialSubmitted { get; set; }

    public JobStep Step { get; set; } = JobStep.Queued;

    public string StepsDoneJson { get; set; } = "[]";

    /// <summary>Records the agent reported gathering so far; null until it counted anything.</summary>
    public int? Found { get; set; }

    public const string UserTrigger = "user";

    public const string ScheduleTrigger = "schedule";

    /// <summary>The relay's scheduler fetching older history after a partial pass (#460): paced like a schedule, on its own clock.</summary>
    public const string BackfillTrigger = "backfill";

    /// <summary>The operator's lab (#441): a run from the test bench, held like a person's and read like the operator's own.</summary>
    public const string LabTrigger = "lab";

    /// <summary>A canary's run (#441 L1): the operator's own connection, on its schedule or on demand.</summary>
    public const string CanaryTrigger = "canary";

    /// who asked: a person, the relay's scheduler, the lab, a canary, or null (the platform's own work, pre-column rows)
    /// the provider's sync interval is enforced between scheduled jobs only; failure-picture ownership follows it too
    public string? Trigger { get; set; }

    /// <summary>Record this run (#441 L3). Set only through the lab's door; the agent and the inline runner read it.</summary>
    public bool Record { get; set; }

    /// false when the adapter stopped short of the window's end (a first connect on a heavy account paginates)
    /// the caller is told which of the two it got
    public bool Complete { get; set; } = true;

    /// the adapter's notes, a JSON array of strings; on the job, not the result rows, so a job that staged nothing keeps them
    /// purged with the job row; nothing here is a record or acked
    public string NotesJson { get; set; } = "[]";

    public ErrorCode? ErrorCode { get; set; }

    /// <summary>Operator-facing. Never localised, never shown to an end user.</summary>
    public string? ErrorDetail { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    /// login inputs, plaintext by choice. Not cleared at lease time: a lost lease requeues once and the retry needs them
    /// bounded by a terminal job, a burnt lease, a disconnect and ExpireAbandonedAsync (a login nobody took kept its password)
    public string? InputsJson { get; set; }

    /// the unsealed session material (a cookie-jar provider: the whole jar), under the same four rules as InputsJson
    /// the only place the control plane holds credential material unsealed
    public string? MaterialJson { get; set; }

    /// <summary>Non-secret provider settings, copied from the session at enqueue.</summary>
    public string ConfigJson { get; set; } = "{}";

    /// <summary>T4 affinity, denormalised from the session for the same reason as the provider.</summary>
    public string? ProfileId { get; set; }

    /// asked for on the operator's fleet: the caller's own machine is not offered it
    /// denormalised so the lease query reads one table
    public bool FleetOnly { get; set; }
}

public sealed class ChallengeRow
{
    public string Id { get; set; } = string.Empty;

    public string JobId { get; set; } = string.Empty;

    public ChallengeType Type { get; set; }

    /// <summary>The non-image part of the challenge, as the consumer will see it.</summary>
    public string PayloadJson { get; set; } = "{}";

    /// <summary>Redacted PNG. Purged on answer or expiry; never logged, never in a webhook.</summary>
    public byte[]? ImageBytes { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? AnsweredAt { get; set; }

    public string? AnswerValue { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// Staged output, not owned data. Purged on ack, or after a hard TTL if the
/// caller never acks. The connector stays a pipe.
/// </summary>
public sealed class ResultRow
{
    public string Id { get; set; } = string.Empty;

    public string JobId { get; set; } = string.Empty;

    public string SessionId { get; set; } = string.Empty;

    public string Resource { get; set; } = string.Empty;

    /// the provider's own id; with session and resource the dedupe key (an account is staged again beside its transactions)
    public string ExternalId { get; set; } = string.Empty;

    public string PayloadJson { get; set; } = "{}";

    /// the provider's raw answer when include=raw asked, else null; on this row so ack and retention purge it
    /// the more sensitive of the two: it must never outlive its record
    public string? RawJson { get; set; }

    /// position in the adapter's batch: the order is a decision (Amazon newest first) and CreatedAt is identical within a batch
    /// per job: a row re-staged by a later pass takes that pass's position
    public int Sequence { get; set; }

    /// <summary>Changes when any meaningful value does, so a re-fetch overlaps for free.</summary>
    public string ContentHash { get; set; } = string.Empty;

    public string Cursor { get; set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class AgentRow
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public AgentClass Class { get; set; } = AgentClass.Pooled;

    /// the subject that enrolled the agent, from the one-time code, never the agent's request; it may serve only this subject
    /// except the operator's own fleet (ConnectorOptions.FleetSubjects); set for every agent, pooled included
    public string? OwnerSubject { get; set; }

    public string CapabilitiesJson { get; set; } = "{}";

    /// <summary>SHA-256 of the bearer token. The token itself is shown exactly once.</summary>
    public string TokenHash { get; set; } = string.Empty;

    public DateTimeOffset LastHeartbeatAt { get; set; }

    public bool Revoked { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// enrolled through the private-slot code (#420 A2): munni's container serving one person at a time
    /// decided from the code's subject, never the agent's request
    public bool Hosted { get; set; }

    /// <summary>When the person holding this slot was given it; null while it is free.</summary>
    public DateTimeOffset? BoundAt { get; set; }

    /// a release asked for a wipe the agent has not confirmed: the slot is free to nobody
    /// the previous person's sign-ins are still on its disk
    public DateTimeOffset? ResetRequestedAt { get; set; }
}

/// one row per browser directory on an agent: one machine, one provider, one account
public sealed class ProfileRow
{
    public string Id { get; set; } = string.Empty;

    public string AgentId { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    /// whose browser this is, part of the key: reused for every session of the same subject on the same agent
    /// null for a profile the agent derived on a heartbeat (its id carries the agent), so the unique index must tolerate null
    public string? Subject { get; set; }

    public bool Healthy { get; set; }

    public DateTimeOffset? LastOkAt { get; set; }
}

/// <summary>Providers are code; only their health is state. This table is the kill switch.</summary>
public sealed class ProviderStatusRow
{
    public string ProviderId { get; set; } = string.Empty;

    public ProviderState State { get; set; } = ProviderState.Healthy;

    public DateTimeOffset Since { get; set; }

    /// <summary>Consumer-owned copy key. Never prose.</summary>
    public string? ReasonKey { get; set; }
}

/// the one deliberate exception to the custody model: an operator's own connection, kept here as nobody is present
/// a reserved subject no consumer can mint keeps it apart from a person's; enrolled only through an admin route
/// a USER's credential is never stored here
public sealed class CanaryRow
{
    public string ProviderId { get; set; } = string.Empty;

    /// the subject the bundle was sealed for; it must carry the operator marker (CanaryService.SubjectPrefix)
    /// a bundle opens only against its subject, so a user's bundle (an HMAC subject) is refused at enrolment
    public string Subject { get; set; } = string.Empty;

    /// the operator's sealed bundle, opaque here; rotated in place whenever a run returns a new one
    /// rotation is mandatory: a stale bundle fails to open and looks like the provider changed
    public string Bundle { get; set; } = string.Empty;

    /// <summary>Which resource to read. The cheapest one that exercises the parser.</summary>
    public string ResourceId { get; set; } = string.Empty;

    /// <summary>How often to run, in minutes.</summary>
    public int IntervalMinutes { get; set; }

    public DateTimeOffset? LastRunAt { get; set; }

    /// <summary>The job that last ran, so an operator can read its notes and its error.</summary>
    public string? LastJobId { get; set; }

    /// <summary>
    /// What the last run concluded. Prose for an operator, never for a user.
    /// </summary>
    public string? LastVerdict { get; set; }

    /// <summary>Whether the last run got its records. Null before the first one.</summary>
    public bool? LastIntact { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}

/// a one-time agent enrollment code; only its hash is stored
/// the subject rides along so a BYO agent serves only whoever enrolled it
public sealed class EnrollmentRow
{
    public string CodeHash { get; set; } = string.Empty;

    public string Subject { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? RedeemedAt { get; set; }
}

/// one person's request for a hosted private agent (#420 A2) and the operator's decision
/// the subject is the pseudonym the relay mints
public sealed class PrivateAgentRequestRow
{
    public string Id { get; set; } = string.Empty;

    public string Subject { get; set; } = string.Empty;

    public PrivateAgentRequestState State { get; set; } = PrivateAgentRequestState.Pending;

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? DecidedAt { get; set; }

    /// <summary>The slot an approval bound; null otherwise.</summary>
    public string? AgentId { get; set; }
}

public enum PrivateAgentRequestState
{
    Pending,
    Approved,
    Denied,
    /// <summary>Taken back by the person before anybody decided.</summary>
    Withdrawn,
    /// <summary>Approved once; the slot has since been given back or taken away.</summary>
    Released,
}

/// what a failed run left behind (#441 L1): the redacted page picture and a digest of its shape, one set per job
/// a person's picture stays Pending and served by no route until they say otherwise
public sealed class JobArtifactRow
{
    public string JobId { get; set; } = string.Empty;

    public string SessionId { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    public ArtifactStatus Status { get; set; }

    /// <summary>Redacted PNG; null when the agent could not photograph the page, or when the picture outgrew the cap.</summary>
    public byte[]? Screenshot { get; set; }

    /// <summary>A hash of the page's shape: two failures with the same digest are the same page, whatever the pictures look like.</summary>
    public string? DomDigest { get; set; }

    public DateTimeOffset CapturedAt { get; set; }

    /// <summary>Pending: when the unanswered question lapses and the row goes. Retained: when the report has served its purpose.</summary>
    public DateTimeOffset ExpiresAt { get; set; }

    /// <summary>When the person said yes - or, for the operator's own run, when it was captured.</summary>
    public DateTimeOffset? SharedAt { get; set; }
}

public enum ArtifactStatus
{
    /// <summary>Held unread until the person whose run it was says the operator may look.</summary>
    Pending,

    /// <summary>The person said yes, or the run was the operator's own (the lab's, a canary's): readable until it expires.</summary>
    Retained,
}

/// a run's recording (#441 L3): the gzipped trace as the agent posted it and the digest rendered from it
/// one per job, the operator's to read until it expires
public sealed class JobTraceRow
{
    public string JobId { get; set; } = string.Empty;

    public string SessionId { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    public int Entries { get; set; }

    public int Dropped { get; set; }

    public bool Truncated { get; set; }

    /// <summary>The packed size, kept beside the bytes so a listing never loads them.</summary>
    public int ByteCount { get; set; }

    public byte[] Bytes { get; set; } = [];

    /// <summary>digest.md: the page an adapter author reads first.</summary>
    public string Digest { get; set; } = string.Empty;

    public DateTimeOffset StartedAt { get; set; }

    public DateTimeOffset EndedAt { get; set; }

    public DateTimeOffset CapturedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
}
