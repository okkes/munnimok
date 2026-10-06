using System.Text.Json.Serialization;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;

namespace Connector.Kit.Hosting.Data;

/// <summary>
/// Where the bundle lives, and therefore how long it may live. Custody says
/// <em>who</em> holds the secret; device class says <em>how long</em>.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<DeviceClass>))]
public enum DeviceClass
{
    /// <summary>An encrypted store on the user's device. The bundle survives restarts.</summary>
    Native,

    /// <summary>The tab session only. The bundle's TTL is capped hard.</summary>
    Web,
}

/// <summary>
/// A connection. Under <c>client</c> custody this row holds no secret at
/// all - only who it is for, what it is, and whether it still works.
/// </summary>
public sealed class SessionRow
{
    public string Id { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    /// <summary>Pseudonymous and consumer-minted. The connector cannot map it to a person.</summary>
    public string Subject { get; set; } = string.Empty;

    public SessionState State { get; set; } = SessionState.Queued;

    /// <summary>Sealed into every bundle as AAD, so a stale bundle is rejected rather than misread.</summary>
    public int ManifestVersion { get; set; }

    /// <summary>T4: the agent that owns this connection's profile.</summary>
    public string? AgentId { get; set; }

    /// <summary>T4: the persistent browser profile. Jobs for this session route only there.</summary>
    public string? ProfileId { get; set; }

    /// <summary>
    /// The caller asked for the operator's fleet by name, so no machine of
    /// theirs may take this connection's work.
    /// </summary>
    /// <remarks>
    /// THE MIRROR IMAGE OF <see cref="ProfileId"/>, and it is on the session
    /// for the same reason the pin is: the answer was given once, about a
    /// connection, and every job this session raises has to route the way that
    /// answer said. A choice honoured for the login and forgotten by the first
    /// fetch would be a choice that lasted one job.
    /// <para>
    /// False is the default and is not the same as "the fleet may have it".
    /// It means nobody expressed anything, which the queue answers by giving
    /// the caller's own live machine a head start - the behaviour every
    /// consumer that is not an agent picker relies on, and the behaviour this
    /// column was added to stop being the only one available. See
    /// <see cref="Connector.Kit.RunOn"/> for the day that mattered.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// What the provider called this connection, as the adapter reported it.
    /// Not a secret and not data - it exists so a user with two connections to
    /// the same store can tell which is which, which is the only thing that
    /// makes a second connection manageable.
    /// </summary>
    public string? ProviderAccountJson { get; set; }

    /// <summary>
    /// A sealed bundle waiting to be collected.
    ///
    /// A login finishes on an agent, minutes after the request that started it
    /// returned, so the result has to survive until the caller comes back for
    /// it. This is ciphertext the control plane cannot read without its own
    /// key, and it is cleared the moment it is handed over - the connector
    /// forgets what it has delivered.
    /// </summary>
    public string? PendingBundle { get; set; }

    /// <summary>
    /// The sealed credentials waiting to be collected, where the provider
    /// offers a credential store.
    ///
    /// Handed over and cleared in the same breath as
    /// <see cref="PendingBundle"/>, and ciphertext for the same reason: the
    /// control plane is the only party that can read it and it keeps no copy
    /// once delivered. Null for every provider that does not offer one, which
    /// is all but the ones whose session cannot be refreshed.
    /// </summary>
    public string? PendingCredentialBundle { get; set; }
}

/// <summary>
/// One unit of work for an agent. The lease columns are what make remote,
/// outbound-only agents possible at all.
/// </summary>
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

    /// <summary>The operator's lab (#441): a run from the test bench, held like a person's and read like the operator's own.</summary>
    public const string LabTrigger = "lab";

    /// <summary>A canary's run (#441 L1): the operator's own connection, on its schedule or on demand.</summary>
    public const string CanaryTrigger = "canary";

    /// <summary>
    /// Who asked for the job: a person (<see cref="UserTrigger"/>), the relay's scheduler
    /// (<see cref="ScheduleTrigger"/>), the operator's lab (<see cref="LabTrigger"/>), a canary
    /// (<see cref="CanaryTrigger"/>), or nobody in particular (null: the platform's own work,
    /// and every row from before the column existed). The provider's interval between syncs
    /// is enforced between scheduled jobs only; whose failure pictures are whose is decided by
    /// it too - see <see cref="Connector.Kit.Hosting.Jobs.JobArtifactService"/>.
    /// </summary>
    public string? Trigger { get; set; }

    /// <summary>
    /// False when the adapter stopped short of the end of the window. A first
    /// connect on a heavy account paginates rather than running for ten
    /// minutes, and the caller has to be told which of the two it got.
    /// </summary>
    public bool Complete { get; set; } = true;

    /// <summary>
    /// What the adapter said about this run, as a JSON array of strings.
    /// </summary>
    /// <remarks>
    /// On the JOB rather than on the result rows, and that is the point: a
    /// note explains an outcome, and the outcome most in need of explaining is
    /// the one that staged nothing. Notes on a failed job survive here too,
    /// where the staged records do not exist at all.
    /// <para>
    /// They live and die with the job row, so they are purged by whatever
    /// purges it. Nothing here is a record; nothing is acked.
    /// </para>
    /// </remarks>
    public string NotesJson { get; set; } = "[]";

    public ErrorCode? ErrorCode { get; set; }

    /// <summary>Operator-facing. Never localised, never shown to an end user.</summary>
    public string? ErrorDetail { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>
    /// Login inputs - a password, in plain text, by choice: no converter, no
    /// encryption, no key.
    ///
    /// Deliberately not cleared at lease time: a lease lost before the
    /// credential went upstream requeues once, and the retry needs them. What
    /// bounds it instead is four paths, and for a long time it was three - a
    /// job reaching a terminal state, a lost lease being burnt, and a
    /// disconnect purging the session. All three key on a job that got as far
    /// as being LEASED, so a login nobody ever took was reached by none of
    /// them and kept its password for as long as the row existed, which is
    /// forever. <c>ExpireAbandonedAsync</c> is the fourth.
    /// </summary>
    public string? InputsJson { get; set; }

    /// <summary>
    /// The unsealed session material, under the same four rules as
    /// <see cref="InputsJson"/>. For a cookie-jar provider this is the whole
    /// jar.
    ///
    /// This row is the only place the control plane holds credential material
    /// UNSEALED. The sealed kind rests elsewhere - a session's pending bundle
    /// is one - but that is a blob bound to a subject and a manifest version,
    /// which is a different thing from a password somebody could read.
    /// </summary>
    public string? MaterialJson { get; set; }

    /// <summary>Non-secret provider settings, copied from the session at enqueue.</summary>
    public string ConfigJson { get; set; } = "{}";

    /// <summary>T4 affinity, denormalised from the session for the same reason as the provider.</summary>
    public string? ProfileId { get; set; }

    /// <summary>
    /// This job was asked for on the operator's fleet, so the caller's own
    /// machine is not offered it. Denormalised from the session, exactly as
    /// <see cref="ProfileId"/> is and for the same reason: the lease query
    /// reads one table.
    /// </summary>
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

    /// <summary>
    /// The provider's own id. With the session and the resource it is the
    /// dedupe key - the resource included, because an account is staged again
    /// beside its transactions and must be its own row there.
    /// </summary>
    public string ExternalId { get; set; } = string.Empty;

    public string PayloadJson { get; set; } = "{}";

    /// <summary>
    /// The provider's own answer for this record, when <c>include=raw</c> asked
    /// for it. Null otherwise, which is almost always.
    ///
    /// On this row rather than a table of its own, deliberately: the ack and
    /// the retention sweep both work on rows, so raw is purged by the machinery
    /// that already exists instead of by a second lifetime somebody has to
    /// remember. It is the more sensitive of the two - normalisation drops what
    /// nobody asked for and this puts it back - so it must never outlive the
    /// record it belongs to.
    /// </summary>
    public string? RawJson { get; set; }

    /// <summary>
    /// Where this record sat in the batch the adapter produced.
    ///
    /// The adapter's order is a decision, not an accident - Amazon sorts newest
    /// first, and a consumer showing a purchase history wants it that way -
    /// and without this the read back was ordered by CreatedAt, which is
    /// IDENTICAL for every row of one batch. The result was a real ordering
    /// nobody chose: a hundred and thirty receipts in whatever sequence the
    /// database felt like, dates jumping about the page.
    ///
    /// Per job rather than global: a row re-staged by a later pass takes that
    /// pass's position, because that pass's order is the one the caller is
    /// about to read.
    /// </summary>
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

    /// <summary>
    /// The subject that enrolled this agent, taken from the one-time code and
    /// never from the agent's own request. An agent may only ever serve this
    /// subject - see <c>ConnectorOptions.FleetSubjects</c> for the operator's
    /// own fleet, which is the one exception and is named in configuration.
    ///
    /// Set for every agent, not only BYO ones: the pooled fleet enrolls
    /// through the same endpoint with an operator-chosen subject.
    /// </summary>
    public string? OwnerSubject { get; set; }

    public string CapabilitiesJson { get; set; } = "{}";

    /// <summary>SHA-256 of the bearer token. The token itself is shown exactly once.</summary>
    public string TokenHash { get; set; } = string.Empty;

    public DateTimeOffset LastHeartbeatAt { get; set; }

    public bool Revoked { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>
    /// Enrolled through the private-slot code (#420 A2): munni's own
    /// container that serves one person at a time. Decided at enrollment
    /// from the code's subject, never from the agent's request.
    /// </summary>
    public bool Hosted { get; set; }

    /// <summary>When the person holding this slot was given it; null while it is free.</summary>
    public DateTimeOffset? BoundAt { get; set; }

    /// <summary>
    /// A release asked the agent to wipe its browser profiles and the agent
    /// has not said it did. A slot in this state is free to nobody: the
    /// previous person's sign-ins are still on its disk.
    /// </summary>
    public DateTimeOffset? ResetRequestedAt { get; set; }
}

/// <summary>
/// T4 persistent-profile registry. One row per browser directory on an agent:
/// one machine, one provider, one account.
/// </summary>
public sealed class ProfileRow
{
    public string Id { get; set; } = string.Empty;

    public string AgentId { get; set; } = string.Empty;

    public string ProviderId { get; set; } = string.Empty;

    /// <summary>
    /// Whose browser this is, and part of the key: a profile is reused for
    /// every session the same subject opens on the same agent, which is what
    /// makes a phone and a laptop share one trusted browser rather than
    /// registering two.
    ///
    /// <para>
    /// Null for a profile the AGENT derived and reported on a heartbeat rather
    /// than one the control plane pinned. Those already carry the agent in
    /// their id, so they are unique without this - and a heartbeat has no
    /// subject to put here, which is exactly why the unique index below must
    /// tolerate a null.
    /// </para>
    ///
    /// <para>
    /// This replaces a <c>SessionId</c> that nothing ever assigned. It was
    /// read in two places and written in none, so the filter it fronted -
    /// "find the profile no session has claimed" - matched every row for ever,
    /// and the reuse it was meant to prevent was the only behaviour that ever
    /// happened. Keeping the good half is deliberate now rather than
    /// accidental; the half that was wrong is that a session is the wrong
    /// thing to key on at all.
    /// </para>
    /// </summary>
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

/// <summary>
/// An operator's own connection to a provider, kept so that a scheduled fetch
/// can prove the adapter still works before a user finds out it does not.
///
/// <para>
/// <b>THIS TABLE IS THE ONE EXCEPTION TO THE CUSTODY MODEL, AND IT IS
/// DELIBERATE.</b> Every other bundle on this platform belongs to a user, is
/// handed over exactly once, and is never held here - the control plane cannot
/// open a user's connection even to log it out, which is why a disconnect has
/// to be given the bundle back. A canary is the opposite by construction: it
/// runs with nobody present, so its bundle has to live somewhere, and that
/// somewhere is this column.
/// </para>
///
/// <para>
/// What keeps it honest is whose account it is. A canary is enrolled by an
/// operator, through an admin route, against a provider account the operator
/// owns and created for this purpose. It carries a reserved subject that no
/// consumer can mint, so it can never be confused with a person's connection,
/// and it is never created by anything a user can reach. An operator who
/// enrols their own personal bank login here has misused it; nothing in code
/// can tell the difference, so the documentation says so plainly and the
/// reserved subject makes the intent visible in every row.
/// </para>
///
/// <para>
/// The claim this platform makes therefore has to be stated exactly: a USER's
/// credential is never stored here. "Nothing is stored" was true before this
/// table and is not true after it, and a promise that has quietly stopped being
/// true is worse than a narrower one that holds.
/// </para>
/// </summary>
public sealed class CanaryRow
{
    public string ProviderId { get; set; } = string.Empty;

    /// <summary>
    /// The subject the bundle was minted for, which must carry the operator
    /// marker - see <c>CanaryService.SubjectPrefix</c>.
    /// </summary>
    /// <remarks>
    /// THE MARKER IS THE SAFETY PROPERTY, not decoration. A bundle only opens
    /// against the subject it was sealed for, so requiring the marker at
    /// enrolment means a user's bundle cannot be enrolled here even by an
    /// operator who pastes the wrong string: a real consumer's subject is an
    /// HMAC and will never carry it, and the enrolment is refused before
    /// anything is written.
    /// </remarks>
    public string Subject { get; set; } = string.Empty;

    /// <summary>
    /// The operator's sealed bundle. Opaque here - only the adapter's own
    /// sealing key opens it - and rotated in place whenever a run returns a
    /// new one.
    /// </summary>
    /// <remarks>
    /// ROTATION IS NOT OPTIONAL. A provider that hands back a fresh bundle on
    /// every fetch - which is most of them - leaves this one stale after a
    /// single run, and the next run then fails to open it. That failure looks
    /// exactly like the provider having changed, so a canary that did not
    /// rotate would spend its life reporting a break it had caused itself.
    /// </remarks>
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

/// <summary>
/// A one-time agent enrollment code. Only its hash is stored, so the table is
/// useless to anyone who reads it, and the subject rides along so a BYO agent
/// can only ever serve whoever enrolled it.
/// </summary>
public sealed class EnrollmentRow
{
    public string CodeHash { get; set; } = string.Empty;

    public string Subject { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public DateTimeOffset ExpiresAt { get; set; }

    public DateTimeOffset? RedeemedAt { get; set; }
}

/// <summary>
/// One person's request for a hosted private agent (#420 A2) and what the
/// operator decided. The subject is the pseudonym the relay mints; who that
/// is stays the relay's to say.
/// </summary>
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

/// <summary>
/// What a failed run left behind (#441 L1): the redacted picture of the page
/// it stopped on and a digest of that page's shape, one set per job.
/// </summary>
/// <remarks>
/// Keyed by the job rather than given an id of its own, because there is
/// nothing to say about a second picture of the same run: a job tried twice
/// keeps the later one. The row holds no secret - the agent never photographs
/// a page while a secret field holds content - but it is still a picture of
/// somebody's account, which is why <see cref="Status"/> exists: a person's
/// picture is <see cref="ArtifactStatus.Pending"/> and served by no route until
/// they say otherwise. See <c>JobArtifactService</c>.
/// </remarks>
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
