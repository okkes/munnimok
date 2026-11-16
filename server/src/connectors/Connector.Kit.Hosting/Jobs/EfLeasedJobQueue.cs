using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Jobs;

// portable claim: candidate SELECT plus conditional UPDATE, retried on a lost race; FOR UPDATE SKIP LOCKED is Postgres-only
// and the tests run on Sqlite, so the real behaviour is exercised identically on both
public sealed class EfLeasedJobQueue(
    ConnectorDbContext db,
    IProviderRegistry registry,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<EfLeasedJobQueue> logger) : ILeasedJobQueue
{
    // one lease, one recovery: a third attempt is a retry loop, and for a login job that is an account lockout
    public const int MaxAttempts = 2;

    private const int CandidateBatch = 16;
    private const int RaceRetries = 4;

    // head start for an owner's own online machine; not an exclusion, so work it cannot take is not stranded
    private const int OwnAgentHeadStartSeconds = 20;

    private readonly ConnectorOptions _options = options.Value;

    public async Task<JobRow> EnqueueAsync(NewJob job, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);

        await RefuseIfSwampedAsync(job, ct);

        var now = time.GetUtcNow();
        var row = new JobRow
        {
            Id = Ids.New(Ids.Job),
            SessionId = job.SessionId,
            ProviderId = job.ProviderId,
            Kind = job.Kind,
            State = JobState.Queued,
            ParamsJson = job.Request is null ? "{}" : ConnectorJson.Serialize(job.Request),
            ResourceId = job.ResourceId,
            Step = JobStep.Queued,
            StepsDoneJson = "[]",
            ConfigJson = ConnectorJson.Serialize(job.Config),
            InputsJson = job.Inputs is null ? null : ConnectorJson.Serialize(job.Inputs),
            MaterialJson = job.Material is null ? null : ConnectorJson.Serialize(job.Material),
            ProfileId = job.ProfileId,
            FleetOnly = job.FleetOnly,
            Trigger = job.Trigger,
            Record = job.Record,
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.Jobs.Add(row);
        await db.SaveChangesAsync(ct);

        signals.Signal(ConnectorSignals.Queue);
        return row;
    }

    // a logout is never refused: disconnecting must always succeed
    // counted, not reserved: a backstop against pile-up; rate_limited carries user_action wait
    private async Task RefuseIfSwampedAsync(NewJob job, CancellationToken ct)
    {
        var cap = options.Value.MaxQueuedJobs;
        if (cap <= 0 || job.Kind == JobKind.Logout) return;

        var waiting = await db.Jobs.CountAsync(j => j.State == JobState.Queued, ct);
        if (waiting < cap) return;

        throw new ConnectorException(
            ErrorCode.RateLimited,
            $"{waiting} job(s) are already waiting, which is more than this fleet can drain. This was "
            + "refused rather than queued behind them, so nobody is left watching a spinner that is "
            + "really a waiting list");
    }

    public async Task<LeasedJob?> TryLeaseAsync(
        string agentId,
        string? ownerSubject,
        AgentCapabilities capabilities,
        IReadOnlyList<JobKind> accept,
        TimeSpan leaseTtl,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(capabilities);
        ArgumentNullException.ThrowIfNull(accept);
        if (accept.Count == 0) return null;

        var paused = await PausedProvidersAsync(ct);

        // own machine is read off the agent's row, not capabilities.Class, which a heartbeat could set to byo.
        // the pooled fleet once leased DUO's DigiD login (Logius scores those sign-ins, on the citizen)
        // an owner named in FleetSubjects asks with no owner scope = serves everybody, not somebody's own machine
        var ownMachine = ownerSubject is not null
                         && await db.Agents.AnyAsync(a => a.Id == agentId && a.Class == AgentClass.Byo, ct);

        var serveable = ServeableProviders(paused, capabilities, ownMachine);

        if (serveable.Count == 0) return null;

        // T4: a job pinned to a profile goes only to the agent holding it; nothing else drives an already logged-in browser
        var ownedProfiles = await db.Profiles
            .Where(p => p.AgentId == agentId)
            .Select(p => p.Id)
            .ToListAsync(ct);

        var headedOnlyLogins = HeadedOnlyLogins(capabilities);

        for (var round = 0; round < RaceRetries; round++)
        {
            var candidates = await CandidatesAsync(
                ownerSubject, serveable, accept, ownedProfiles, headedOnlyLogins, ct);

            if (candidates.Count == 0) return null;

            foreach (var candidate in candidates)
            {
                if (await TryClaimAsync(candidate, agentId, leaseTtl, ct) is { } leased) return leased;
            }
        }

        logger.LogDebug("agent {AgentId} lost every lease race in this pass", agentId);
        return null;
    }

    private HashSet<string> ServeableProviders(HashSet<string> paused, AgentCapabilities capabilities, bool ownMachine) =>
        registry.Manifests
            .Where(m => !paused.Contains(m.Id)
                        && capabilities.CanServe(m)
                        && (ownMachine || !m.Agent.NeedsOwnMachine))
            .Select(m => m.Id)
            .ToHashSet(StringComparer.Ordinal);

    private HashSet<string> HeadedOnlyLogins(AgentCapabilities capabilities)
    {
        // a headless agent leasing a login that can meet an interactive wall fails blocked_by_provider after two minutes.
        // only logins are withheld, fetches are still served
        return capabilities.Headed
            ? []
            : registry.Manifests
                .Where(m => m.LoginNeedsHeadedAgent)
                .Select(m => m.Id)
                .ToHashSet(StringComparer.Ordinal);
    }

    private Task<List<JobRow>> CandidatesAsync(
        string? ownerSubject,
        HashSet<string> serveable,
        IReadOnlyList<JobKind> accept,
        List<string> ownedProfiles,
        HashSet<string> headedOnlyLogins,
        CancellationToken ct)
    {
        var queued = QueuedFor(serveable, accept, ownedProfiles, headedOnlyLogins);

        queued = ownerSubject is not null
            ? OwnedBy(queued, ownerSubject)
            : AfterOwnersHeadStart(queued);

        return queued
            .OrderBy(j => j.CreatedAt)
            .ThenBy(j => j.Id)
            .Take(CandidateBatch)
            .AsNoTracking()
            .ToListAsync(ct);
    }

    private IQueryable<JobRow> QueuedFor(
        HashSet<string> serveable,
        IReadOnlyList<JobKind> accept,
        List<string> ownedProfiles,
        HashSet<string> headedOnlyLogins)
    {
        var wantsLogin = accept.Contains(JobKind.Login);
        var wantsFetch = accept.Contains(JobKind.Fetch);
        var wantsRefresh = accept.Contains(JobKind.Refresh);
        var wantsLogout = accept.Contains(JobKind.Logout);

        return db.Jobs
            .Where(j => j.State == JobState.Queued
                        && serveable.Contains(j.ProviderId)
                        // OR chain over constants: Contains over value-converted enums is not reliably translatable on every provider
                        && ((wantsLogin && j.Kind == JobKind.Login
                             && !headedOnlyLogins.Contains(j.ProviderId))
                            || (wantsFetch && j.Kind == JobKind.Fetch)
                            || (wantsRefresh && j.Kind == JobKind.Refresh)
                            || (wantsLogout && j.Kind == JobKind.Logout))
                        && (j.ProfileId == null || ownedProfiles.Contains(j.ProfileId))
                        // per-session concurrency is 1: two runs against one account at once look like a bot
                        && !db.Jobs.Any(other => other.SessionId == j.SessionId
                                                 && other.Id != j.Id
                                                 && (other.State == JobState.Leased
                                                     || other.State == JobState.Running
                                                     || other.State == JobState.AwaitingInput)));
    }

    private IQueryable<JobRow> OwnedBy(IQueryable<JobRow> queued, string ownerSubject)
    {
        // ownership: an agent serves only the subject that enrolled it (before this, any enrolled machine could lease any login)
        queued = queued.Where(j => db.Sessions.Any(
            s => s.Id == j.SessionId && s.Subject == ownerSubject));

        // a job whose caller chose the operator's fleet goes to anybody but the caller's own machines (mirror of the profile clause)
        // else DUO's sign-in went to the caller's NAS, which polled first (2026-09-21, connector-byo-registry-1)
        return queued.Where(j => !j.FleetOnly);
    }

    private IQueryable<JobRow> AfterOwnersHeadStart(IQueryable<JobRow> queued)
    {
        // first refusal as a head start, not an exclusion: capability sits in a json blob this query cannot read
        // "live" is the platform's one definition of online (AgentLiveness): an agent stood back for is one a login may be pinned to
        // FleetOnly skips the wait: the owner-scoped clause refuses it to their own machines, so waiting would be 20s of nobody
        var now = time.GetUtcNow();
        var live = AgentLiveness.OnlineSince(now);
        var young = now.AddSeconds(-OwnAgentHeadStartSeconds);

        return queued.Where(j => j.FleetOnly || j.CreatedAt < young || !db.Sessions.Any(
            s => s.Id == j.SessionId
                 && db.Agents.Any(a => a.OwnerSubject == s.Subject
                                       && a.Class == AgentClass.Byo
                                       && !a.Revoked
                                       && a.LastHeartbeatAt > live)));
    }

    private async Task<LeasedJob?> TryClaimAsync(JobRow candidate, string agentId, TimeSpan leaseTtl, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var leaseExpiresAt = now + leaseTtl;

        var claimed = await db.Jobs
            .Where(j => j.Id == candidate.Id && j.State == JobState.Queued && j.LeaseOwner == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Leased)
                .SetProperty(j => j.LeaseOwner, agentId)
                .SetProperty(j => j.AgentId, agentId)
                .SetProperty(j => j.LeaseExpiresAt, leaseExpiresAt)
                .SetProperty(j => j.Attempts, j => j.Attempts + 1)
                .SetProperty(j => j.Step, JobStep.AgentAssigned)
                .SetProperty(j => j.UpdatedAt, now), ct);

        if (claimed != 1) return null;

        signals.Signal(ConnectorSignals.Job(candidate.Id));
        signals.Signal(ConnectorSignals.Session(candidate.SessionId));
        return Materialize(candidate, leaseExpiresAt);
    }

    public async Task<DateTimeOffset?> RenewLeaseAsync(string jobId, string agentId, TimeSpan leaseTtl, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var leaseExpiresAt = now + leaseTtl;

        var renewed = await db.Jobs
            .Where(j => j.Id == jobId
                        && j.LeaseOwner == agentId
                        && (j.State == JobState.Leased || j.State == JobState.Running || j.State == JobState.AwaitingInput))
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.LeaseExpiresAt, leaseExpiresAt)
                .SetProperty(j => j.UpdatedAt, now), ct);

        return renewed == 1 ? leaseExpiresAt : null;
    }

    public async Task<JobRow> CompleteAsync(string jobId, string? leaseOwner, CancellationToken ct)
    {
        var job = await RequireOwnedAsync(jobId, leaseOwner, tracked: true, ct);
        if (JobStateMachine.IsTerminal(job.State)) return job;

        // a job that produced a result was running, even if the agent's progress report was lost on the wire
        if (job.State is JobState.Leased or JobState.AwaitingInput) job.State = JobState.Running;

        JobStateMachine.EnsureTransition(job.State, JobState.Succeeded);
        job.State = JobState.Succeeded;
        job.Step = JobStep.Finalizing;
        job.LeaseOwner = null;
        job.LeaseExpiresAt = null;
        job.UpdatedAt = time.GetUtcNow();
        ClearSecrets(job);

        await db.SaveChangesAsync(ct);
        signals.Signal(ConnectorSignals.Job(job.Id));
        signals.Signal(ConnectorSignals.Session(job.SessionId));
        return job;
    }

    public async Task<JobRow> FailAsync(string jobId, string? leaseOwner, ErrorCode code, string? detail, CancellationToken ct)
    {
        var job = await RequireOwnedAsync(jobId, leaseOwner, tracked: true, ct);
        if (JobStateMachine.IsTerminal(job.State)) return job;

        var now = time.GetUtcNow();
        job.ErrorCode = code;
        job.ErrorDetail = Truncate(detail);
        job.LeaseOwner = null;
        job.LeaseExpiresAt = null;
        job.UpdatedAt = now;

        if (MayRetry(job, code))
        {
            job.State = JobState.Queued;
            job.Step = JobStep.Queued;
            await db.SaveChangesAsync(ct);
            signals.Signal(ConnectorSignals.Queue);
        }
        else
        {
            JobStateMachine.EnsureTransition(job.State, JobState.Failed);
            job.State = JobState.Failed;
            ClearSecrets(job);
            await db.SaveChangesAsync(ct);
        }

        signals.Signal(ConnectorSignals.Job(job.Id));
        signals.Signal(ConnectorSignals.Session(job.SessionId));
        return job;
    }

    // progress never resurrects a finished job: read-modify-write races CompleteAsync and puts running back over succeeded,
    // so nothing finishes it and the session's later jobs queue forever; every guard sits in a conditional UPDATE's WHERE
    public async Task ProgressAsync(string jobId, string? leaseOwner, ProgressReport report, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(report);

        // untracked: every write is a conditional UPDATE, and a tracked copy would be a stale row for someone else's SaveChanges
        var job = await RequireOwnedAsync(jobId, leaseOwner, tracked: false, ct);
        if (JobStateMachine.IsTerminal(job.State)) return;

        // leased -> running only: AwaitingInput must survive a reported step
        if (job.State == JobState.Leased)
        {
            await db.Jobs
                .Where(j => j.Id == jobId && j.State == JobState.Leased)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.State, JobState.Running), ct);
        }

        // latch only, never unlatch: false after true would re-arm the retry; its own statement, as a submitted credential is a fact
        if (report.CredentialSubmitted)
        {
            await db.Jobs
                .Where(j => j.Id == jobId && !j.CredentialSubmitted)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.CredentialSubmitted, true), ct);
        }

        var applied = await db.Jobs
            .Where(j => j.Id == jobId
                        && j.State != JobState.Succeeded
                        && j.State != JobState.Failed
                        && j.State != JobState.Expired)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Step, report.Step)
                // a report without a count leaves the last count standing
                .SetProperty(j => j.Found, j => report.Found ?? j.Found)
                .SetProperty(j => j.StepsDoneJson,
                    report.StepsDone.Count > 0 ? ConnectorJson.Serialize(report.StepsDone) : job.StepsDoneJson)
                .SetProperty(j => j.UpdatedAt, time.GetUtcNow()), ct);

        // nothing applied: the run reached its outcome first, which already woke the waiters
        if (applied == 0) return;

        signals.Signal(ConnectorSignals.Job(job.Id));
        signals.Signal(ConnectorSignals.Session(job.SessionId));
    }

    public async Task<int> RequeueExpiredLeasesAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();

        // recoverable: the agent left before anything was submitted and attempts remain; back exactly once
        var requeued = await db.Jobs
            .Where(j => j.LeaseExpiresAt != null
                        && j.LeaseExpiresAt < now
                        && (j.State == JobState.Leased || j.State == JobState.Running || j.State == JobState.AwaitingInput)
                        && !j.CredentialSubmitted
                        && j.Attempts < MaxAttempts)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Queued)
                .SetProperty(j => j.Step, JobStep.Queued)
                .SetProperty(j => j.LeaseOwner, (string?)null)
                .SetProperty(j => j.LeaseExpiresAt, (DateTimeOffset?)null)
                .SetProperty(j => j.UpdatedAt, now), ct);

        // unrecoverable, two reasons: a submitted credential may have counted, so the user signs in again.
        // an agent gone twice is just gone
        var submitted = await BurnAsync(now, credentialSubmitted: true,
            ErrorCode.SessionExpired, "lease lost after a credential went upstream; never retried", ct);

        var exhausted = await BurnAsync(now, credentialSubmitted: false,
            ErrorCode.AgentUnavailable, "no agent completed this job within its attempts", ct);

        var burnt = submitted + exhausted;

        if (requeued > 0) signals.Signal(ConnectorSignals.Queue);
        if (requeued + burnt > 0)
        {
            logger.LogInformation("reclaimed {Requeued} expired lease(s), failed {Burnt}", requeued, burnt);
        }

        return requeued + burnt;
    }

    // other cleanups key on LeaseExpiresAt, which a never-leased job lacks: a queued login kept its password forever
    // failed, not scrubbed: a scrubbed login would fail further in for an unknown reason; agent_unavailable is what happened
    public async Task<int> ExpireAbandonedAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var cutoff = now.AddSeconds(-_options.Timeouts.AbandonedJobSeconds);

        var expired = await db.Jobs
            // queued with no lease = never taken or requeued and not retaken; a requeue stamps UpdatedAt, so the window restarts
            .Where(j => j.State == JobState.Queued
                        && j.LeaseExpiresAt == null
                        && j.UpdatedAt < cutoff)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Failed)
                .SetProperty(j => j.ErrorCode, ErrorCode.AgentUnavailable)
                .SetProperty(j => j.ErrorDetail, "no agent took this job before its credentials had to be discarded")
                .SetProperty(j => j.InputsJson, (string?)null)
                .SetProperty(j => j.MaterialJson, (string?)null)
                .SetProperty(j => j.UpdatedAt, now), ct);

        if (expired > 0)
        {
            logger.LogInformation("discarded credentials on {Expired} job(s) nobody leased", expired);
        }

        return expired;
    }

    // one conditional update per reason: keeps a CASE over a value-converted enum out of the SET list (not portable)
    private Task<int> BurnAsync(DateTimeOffset now, bool credentialSubmitted, ErrorCode code, string detail, CancellationToken ct) =>
        db.Jobs
            .Where(j => j.LeaseExpiresAt != null
                        && j.LeaseExpiresAt < now
                        && (j.State == JobState.Leased || j.State == JobState.Running || j.State == JobState.AwaitingInput)
                        && j.CredentialSubmitted == credentialSubmitted
                        && (credentialSubmitted || j.Attempts >= MaxAttempts))
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Failed)
                .SetProperty(j => j.ErrorCode, code)
                .SetProperty(j => j.ErrorDetail, detail)
                .SetProperty(j => j.LeaseOwner, (string?)null)
                .SetProperty(j => j.LeaseExpiresAt, (DateTimeOffset?)null)
                .SetProperty(j => j.InputsJson, (string?)null)
                .SetProperty(j => j.MaterialJson, (string?)null)
                .SetProperty(j => j.UpdatedAt, now), ct);

    private static bool MayRetry(JobRow job, ErrorCode code) =>
        !ErrorCatalog.NeverRetry.Contains(code)
        && ErrorCatalog.IsRetriable(code)
        && !job.CredentialSubmitted
        && job.Attempts < MaxAttempts
        && JobStateMachine.CanTransition(job.State, JobState.Queued);

    // tracked=false for callers writing by conditional UPDATE: a tracked entity would be a stale row behind an unseen write
    private async Task<JobRow> RequireOwnedAsync(string jobId, string? leaseOwner, bool tracked, CancellationToken ct)
    {
        var jobs = tracked ? db.Jobs : db.Jobs.AsNoTracking();

        var job = await jobs.FirstOrDefaultAsync(j => j.Id == jobId, ct)
                  ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");

        if (leaseOwner is not null && !string.Equals(job.LeaseOwner, leaseOwner, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"job '{jobId}' is not leased to '{leaseOwner}'");
        }

        return job;
    }

    // a terminal job holding a credential is a credential at rest with no reason to exist
    private static void ClearSecrets(JobRow job)
    {
        job.InputsJson = null;
        job.MaterialJson = null;
    }

    private async Task<HashSet<string>> PausedProvidersAsync(CancellationToken ct)
    {
        var rows = await db.ProviderStatuses.AsNoTracking().ToListAsync(ct);
        return rows
            .Where(r => !ProviderStatusService.ToStatus(r).AcceptsWork)
            .Select(r => r.ProviderId)
            .ToHashSet(StringComparer.Ordinal);
    }

    private LeasedJob Materialize(JobRow job, DateTimeOffset leaseExpiresAt)
    {
        var manifest = registry.RequireManifest(job.ProviderId);
        return new LeasedJob
        {
            JobId = job.Id,
            SessionId = job.SessionId,
            Provider = job.ProviderId,
            Kind = job.Kind,
            Inputs = ConnectorJson.DeserializeOr(job.InputsJson, EmptyStrings),
            Config = ConnectorJson.DeserializeOr(job.ConfigJson, EmptyStrings),
            Material = job.MaterialJson is null ? null : ConnectorJson.Deserialize<SessionMaterial>(job.MaterialJson),
            Request = job.Kind == JobKind.Fetch
                ? ConnectorJson.DeserializeOr<ResourceRequest?>(job.ParamsJson, null)
                : null,
            ProfileId = job.ProfileId,
            LeaseExpiresAt = leaseExpiresAt,
            Record = job.Record,
            Limits = new JobLimits
            {
                TimeoutSeconds = Math.Max(_options.Timeouts.JobTimeoutSeconds, LongestResourceSeconds(manifest)),

                // the operator's value is a floor: a manifest may ask for more, never less,
                // so tuning down cannot undo an adapter author's gap
                PolitenessMs = Math.Max(_options.Timeouts.PolitenessMs, manifest.Limits.MinRequestGapMs),
            },
        };
    }

    private static int LongestResourceSeconds(ProviderManifest manifest) =>
        manifest.Resources.Count == 0 ? 0 : manifest.Resources.Max(r => r.TypicalDurationSeconds) * 4;

    private static string? Truncate(string? detail) =>
        detail is null || detail.Length <= 1024 ? detail : detail[..1024];

    private static readonly IReadOnlyDictionary<string, string> EmptyStrings =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
