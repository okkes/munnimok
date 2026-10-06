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

/// <summary>
/// The portable implementation: a candidate SELECT followed by a conditional
/// UPDATE, retried on a lost race.
///
/// <c>SELECT … FOR UPDATE SKIP LOCKED</c> would be shorter and is Postgres
/// only, and the tests run on Sqlite. Optimistic claiming costs one extra
/// round trip when two agents collide and works identically on both, which is
/// worth more than the round trip: a queue whose real behaviour is only
/// exercised in production is a queue nobody can trust.
/// </summary>
public sealed class EfLeasedJobQueue(
    ConnectorDbContext db,
    IProviderRegistry registry,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<EfLeasedJobQueue> logger) : ILeasedJobQueue
{
    /// <summary>
    /// One lease, one recovery, then done. The second attempt exists so a
    /// deploy or a crashed agent does not lose work; a third would be a retry
    /// loop, and for a login job a retry loop is an account lockout.
    /// </summary>
    public const int MaxAttempts = 2;

    private const int CandidateBatch = 16;
    private const int RaceRetries = 4;

    /// <summary>
    /// How long the fleet leaves a job alone when its owner has a machine of
    /// their own online.
    /// </summary>
    /// <remarks>
    /// LONG ENOUGH TO WIN A POLL, SHORT ENOUGH NOT TO STRAND ANYTHING. An
    /// agent long-polls, so it usually takes work the instant it is queued and
    /// this window never elapses; what the window is really for is the case
    /// where their machine cannot take it at all - busy, an older build, a
    /// bank agent looking at a shop job - and something has to give the work
    /// back rather than hold it for a machine that was never going to lease
    /// it.
    /// </remarks>
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

    /// <summary>
    /// Turns work away once the backlog is longer than the fleet can drain.
    /// </summary>
    /// <remarks>
    /// A QUEUE NOBODY BOUNDS IS A QUEUE THAT LIES. Past what the agents can
    /// work through, an accepted job is somebody watching a spinner that is
    /// really a waiting list, with no signal and no estimate. Refusing is the
    /// kinder answer: <c>rate_limited</c> carries <c>user_action: wait</c>, so
    /// a consumer can say "busy, try shortly" instead of showing progress that
    /// is not progressing.
    /// <para>
    /// A LOGOUT IS NEVER REFUSED, whatever the queue looks like. Disconnecting
    /// must always succeed - the platform says so everywhere else - and
    /// somebody told "too busy to sign you out of your bank" is somebody whose
    /// only remaining option is to leave the session running.
    /// </para>
    /// <para>
    /// Counted rather than reserved: this is a backstop against pile-up, and a
    /// race that lets one extra job past under load is not worth a transaction.
    /// </para>
    /// </remarks>
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

        // WHOSE MACHINE THIS IS, off the agent's own row and not off the
        // capabilities it just sent.
        //
        // A provider whose manifest says it runs on the account holder's own
        // computer had nothing enforcing it. `CanServe` asks the questions the
        // agent is entitled to answer about itself - which providers it
        // carries, which runtimes it can drive, and where its traffic leaves
        // from - and `AgentClass` appeared in this file
        // only in the fleet's head start below, as a reason to WAIT twenty
        // seconds and then take the work anyway. So the operator's pooled fleet
        // leased DUO's login on the twenty-first second: a DigiD sign-in from a
        // datacenter address, on a browser wiped when the job ends, for a
        // provider whose manifest says in as many words that this must never
        // happen. Logius scores those authentications and the score lands on
        // the citizen, not on us.
        //
        // The row rather than the request, because `capabilities.Class` arrives
        // on the agent's own heartbeat and a machine that wanted this work
        // would simply call itself byo - the same reason the lease route takes
        // the owner scope off the row. Revocation is not restated here: a
        // revoked agent's token hash no longer matches anything, so it is
        // answered 401 at the filter and never reaches this call. The clause
        // below is about OTHER agents' rows, which is why it checks.
        //
        // AND EGRESS, WHICH `CanServe` NOW COMPARES - and the objection that
        // kept it out of here for so long is worth recording as ANSWERED
        // rather than deleted, because it was a good one. It was: the only
        // source for an agent's address is the agent's own
        // `capabilities.egress`, the same self-declaration this clause exists
        // to stop trusting, and enforcing it would turn away the one machine
        // that genuinely satisfies it while admitting any that lies -
        // `deploy/byo` shipped no egress setting at all, so every household
        // NAS that followed the README claimed nothing.
        //
        // What changed is the second half. Every deployment that must serve a
        // residential provider now claims one, in the same change that turned
        // this on and checked by a test that reads the compose files, so the
        // gate no longer strands the honest machines - which is what it would
        // have done the day before. The first half stands and is not a
        // defence anybody should lean on: a claim is believed, never
        // measured, and what stops a machine taking somebody else's work is
        // the enrollment code above, not this. What the comparison buys is
        // that an HONEST deployment is not handed work its address cannot
        // carry - the datacenter fleet quietly leasing Jumbo's logins and
        // being tarpitted for it, with nothing in the failure naming the
        // address. Measuring it - the agent reporting what an IP-echo service
        // says it left from - would make the claim worth more, and is a
        // separate piece of work.
        //
        // AND IT HAS TO BE SERVING ONE PERSON. A machine whose owner is named
        // in FleetSubjects asks with no owner scope at all, which is the
        // platform's way of saying "this one serves everybody" - and a machine
        // serving everybody is not somebody's own, whatever class it enrolled
        // as. That is the arrangement the manifest names: many different
        // citizens authenticating from one address. The login will not pin such
        // a machine either, and the two have to agree, or a caller told "you
        // have no machine of your own" would watch their work run on the
        // operator's.
        var ownMachine = ownerSubject is not null
                         && await db.Agents.AnyAsync(a => a.Id == agentId && a.Class == AgentClass.Byo, ct);

        var serveable = ServeableProviders(paused, capabilities, ownMachine);

        if (serveable.Count == 0) return null;

        // T4: a job pinned to a profile may only ever go to the agent that
        // holds it. Nothing else can drive a browser that is already logged in.
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

    /// <summary>
    /// The providers this agent may be offered work for: not paused, within
    /// its capabilities, and - for a provider that runs only on the account
    /// holder's own machine - only when this is one.
    /// </summary>
    private HashSet<string> ServeableProviders(HashSet<string> paused, AgentCapabilities capabilities, bool ownMachine) =>
        registry.Manifests
            .Where(m => !paused.Contains(m.Id)
                        && capabilities.CanServe(m)
                        && (ownMachine || !m.Agent.NeedsOwnMachine))
            .Select(m => m.Id)
            .ToHashSet(StringComparer.Ordinal);

    private HashSet<string> HeadedOnlyLogins(AgentCapabilities capabilities)
    {
        // Logins this agent could lease and could not finish. A provider whose
        // sign-in can meet an interactive wall needs somebody at the browser,
        // and a headless agent taking one drives it for two minutes before
        // failing blocked_by_provider - a wasted lease for the user, a wasted
        // run against the provider, and an error that reads like the account is
        // broken. Only the LOGIN is withheld: the same agent still serves every
        // fetch for the same provider, which is most of the work.
        return capabilities.Headed
            ? []
            : registry.Manifests
                .Where(m => m.LoginNeedsHeadedAgent)
                .Select(m => m.Id)
                .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// One race round's page of candidates: the oldest queued jobs this agent
    /// may take, read untracked because the claim is a conditional UPDATE.
    /// </summary>
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

    /// <summary>
    /// Every queued job this agent could take on its own account: a provider
    /// it serves, a kind it asked for, a profile it holds or none, and a
    /// session nothing else is running against.
    /// </summary>
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
                        // An OR chain over constants rather than a
                        // Contains over a collection of value-converted
                        // enums: that one shape is not reliably
                        // translatable on every provider, and this queue
                        // must behave identically on both.
                        && ((wantsLogin && j.Kind == JobKind.Login
                             && !headedOnlyLogins.Contains(j.ProviderId))
                            || (wantsFetch && j.Kind == JobKind.Fetch)
                            || (wantsRefresh && j.Kind == JobKind.Refresh)
                            || (wantsLogout && j.Kind == JobKind.Logout))
                        && (j.ProfileId == null || ownedProfiles.Contains(j.ProfileId))
                        // Per-session concurrency is 1, always. Two runs
                        // against one account at once is the fastest way
                        // to look like a bot.
                        && !db.Jobs.Any(other => other.SessionId == j.SessionId
                                                 && other.Id != j.Id
                                                 && (other.State == JobState.Leased
                                                     || other.State == JobState.Running
                                                     || other.State == JobState.AwaitingInput)));
    }

    /// <summary>
    /// The clauses an agent that serves one person carries: only that
    /// person's work, and none of it that they asked the fleet for.
    /// </summary>
    private IQueryable<JobRow> OwnedBy(IQueryable<JobRow> queued, string ownerSubject)
    {
        // Ownership. An agent may only ever serve the subject that
        // enrolled it, which is what the enrollment endpoint means when it
        // takes the subject off the one-time code rather than the request.
        // Until this clause existed that was a comment and an index and
        // nothing else: any enrolled machine could lease any user's login
        // job, and Materialize would hand it that user's password in
        // plaintext.
        //
        // Added as a separate Where rather than a term in the big
        // predicate so the fleet and in-process cases emit no clause at
        // all, and so this reads as the rule it is.
        queued = queued.Where(j => db.Sessions.Any(
            s => s.Id == j.SessionId && s.Subject == ownerSubject));

        // AND THE WORK THEY ASKED THE FLEET FOR IS NOT THEIRS TO TAKE.
        //
        // The mirror image of the profile clause above: that one says
        // a pinned job goes to the agent holding the browser and to
        // nobody else, and this one says a job whose caller asked for
        // the operator's fleet goes to anybody BUT the caller's own
        // machines. Both are an answer somebody gave about one
        // connection, and both have to outrank what the queue would
        // otherwise infer.
        //
        // Without it the head start below settles every such request
        // the wrong way round. On 2026-09-21 the account holder chose
        // "the operator's fleet" for DUO, their NAS polled first,
        // nothing stopped it, and it ran the sign-in - job
        // job_98ef049e691d586ed949be7f819500ad on
        // connector-byo-registry-1, while the fleet agent that was
        // online throughout logged nothing at all. An explicit choice
        // that usually loses is worse than no choice: it is a control
        // that reports a decision it did not make.
        //
        // A separate Where, like the ownership clause, so the fleet
        // and in-process cases emit no clause at all - they are the
        // pollers this job is FOR, and asking them to prove they are
        // not the caller's machine would be asking the question
        // backwards. `ownerSubject is null` is exactly "serves
        // everybody": the lease route derives it from FleetSubjects
        // and never from anything an agent sends.
        return queued.Where(j => !j.FleetOnly);
    }

    /// <summary>
    /// The clause the fleet and the in-process runner carry: a job whose
    /// owner has a machine of their own online is left to it for a while.
    /// </summary>
    private IQueryable<JobRow> AfterOwnersHeadStart(IQueryable<JobRow> queued)
    {
        // THE OWNER'S OWN MACHINE GETS FIRST REFUSAL.
        //
        // A user who has brought an agent has said where they want
        // their work to run, and until this clause the fleet and their
        // laptop simply raced for it - so the same connection ran in a
        // datacenter one day and at home the next, with a different
        // browser, a different address and a different profile each
        // time. That is not a preference anybody expressed.
        //
        // Expressed as the FLEET STANDING BACK rather than as a
        // priority queue, because standing back is self-healing: the
        // moment their machine stops beating it stops being live here,
        // and the fleet picks the work up on the next poll with no
        // state to unwind and nobody to tell.
        //
        // AND IT IS A HEAD START, NOT AN EXCLUSION, which is the part
        // that took a second try. An exclusion strands work: an agent
        // that is online but cannot serve THIS provider - a bank agent
        // for a shop job, an older build, a machine already busy -
        // would hold a job nobody else was allowed to take, forever,
        // with the user watching a queue that never moves. Capability
        // lives in a json blob this query cannot read, so the answer
        // is not to ask: wait a few seconds, then let anyone have it.
        //
        // "Live" is the platform's one definition of online, which
        // used to be restated here as a constant of its own. Now that
        // a persistent login is REFUSED by that definition, this
        // clause must agree with it: an agent the queue stands back
        // for is an agent a login may be pinned to.
        //
        // AND IT STANDS BACK FOR A PREFERENCE, NEVER FOR A CHOICE,
        // which is what `j.FleetOnly ||` says. The head start exists
        // because a user who brought an agent has SAID something by
        // bringing it; a user who picked the operator's fleet out of a
        // dropdown has said something louder, about this one
        // connection, and waiting twenty seconds to honour it would
        // make the fleet the slow answer to the question it just won.
        // Nothing else can take that job either - the owner-scoped
        // clause above refuses it to their own machines - so the wait
        // would be twenty seconds of nobody, every time.
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

    /// <summary>
    /// The lease itself: a conditional UPDATE that lands only while the job
    /// is still queued and unowned, so two agents racing for it cannot both
    /// win. Null when another agent got there first.
    /// </summary>
    private async Task<LeasedJob?> TryClaimAsync(JobRow candidate, string agentId, TimeSpan leaseTtl, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var leaseExpiresAt = now + leaseTtl;

        var claimed = await db.Jobs
            .Where(j => j.Id == candidate.Id && j.State == JobState.Queued && j.LeaseOwner == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Leased)
                .SetProperty(j => j.LeaseOwner, agentId)
                .SetProperty(j => j.LeaseExpiresAt, leaseExpiresAt)
                .SetProperty(j => j.Attempts, j => j.Attempts + 1)
                .SetProperty(j => j.Step, JobStep.AgentAssigned)
                .SetProperty(j => j.UpdatedAt, now), ct);

        if (claimed != 1) return null;   // another agent won; try the next candidate

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

        // A job that produced a result was running, whether or not it ever got
        // round to saying so: both runtimes flush their progress before they
        // report an outcome, but an agent's report can still be lost on the
        // wire.
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

    /// <summary>
    /// Records typed progress - and never, ever resurrects a finished job.
    ///
    /// Progress is reported asynchronously by design: the inline runner drains
    /// a channel and a remote agent posts over HTTP, so a report is routinely
    /// still in flight when the run that produced it finishes. That makes the
    /// obvious implementation - read the row, set the fields, SaveChanges -
    /// a read-modify-write race against <see cref="CompleteAsync"/>, and the
    /// losing write puts <c>running</c> back over <c>succeeded</c>.
    ///
    /// The damage is out of all proportion to the courtesy: nothing owns the
    /// lease any more, so nothing will ever finish that job again, and because
    /// per-session concurrency is 1 the session's every later job then sits
    /// queued and is never leased. The user's next sync does not fail - it
    /// simply never happens, and no error is ever raised to say so. Observed
    /// as a fetch stuck at <c>queued</c> behind a job that had already
    /// returned its data.
    ///
    /// So every guard lives in the WHERE clause of a conditional UPDATE rather
    /// than in a decision made beforehand on a row this context read moments
    /// ago. One statement per rule, for the reason <see cref="BurnAsync"/> is
    /// split the same way: a CASE over a value-converted enum in a SET list is
    /// the kind of thing that translates on one provider and not the other.
    /// </summary>
    public async Task ProgressAsync(string jobId, string? leaseOwner, ProgressReport report, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(report);

        // Untracked: every write below is a conditional UPDATE, and a tracked
        // copy left behind would be a stale row waiting for somebody else's
        // SaveChanges to flush it back.
        var job = await RequireOwnedAsync(jobId, leaseOwner, tracked: false, ct);
        if (JobStateMachine.IsTerminal(job.State)) return;

        // `leased -> running` only. AwaitingInput must survive untouched: a job
        // parked on a challenge that reports a step is still parked.
        if (job.State == JobState.Leased)
        {
            await db.Jobs
                .Where(j => j.Id == jobId && j.State == JobState.Leased)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.State, JobState.Running), ct);
        }

        // Latch only, never unlatch: an agent that reports false after true
        // would silently re-arm the retry it is there to prevent. Its own
        // statement, so a report that latches nothing cannot write the latch
        // back at all, and one that does is not conditional on a state this
        // context may already have misread - a credential that went upstream
        // is a fact, and recording it late is safer than losing it.
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

        // Nothing applied means the run reached its outcome first, and that
        // outcome has already woken everyone waiting on it.
        if (applied == 0) return;

        signals.Signal(ConnectorSignals.Job(job.Id));
        signals.Signal(ConnectorSignals.Session(job.SessionId));
    }

    public async Task<int> RequeueExpiredLeasesAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();

        // Recoverable: the agent went away before anything was submitted and
        // this job has a life left. It goes back exactly once.
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

        // Unrecoverable, and the two reasons are genuinely different. A
        // credential that went upstream may or may not have counted; we do not
        // find out by trying again, so the user signs in again. An agent that
        // vanished twice is simply not there.
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

    /// <summary>
    /// The job nobody came for.
    ///
    /// Every other cleanup here keys on <c>LeaseExpiresAt</c> - a lease that
    /// ran out - and a job that was never leased has none, so it was reached by
    /// nothing at all. A login for a browser-tier provider whose pooled agent
    /// is offline sat Queued holding the password it was enqueued with, for as
    /// long as the row existed, which was forever: the row is never deleted and
    /// there is no retention pass over jobs.
    ///
    /// Failed rather than merely scrubbed. A queued login stripped of its
    /// inputs would eventually be leased and fail somewhere further in for a
    /// reason nobody could reconstruct; <c>agent_unavailable</c> is what
    /// actually happened, and it is the same code a job that exhausted its
    /// attempts reports.
    /// </summary>
    public async Task<int> ExpireAbandonedAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var cutoff = now.AddSeconds(-_options.Timeouts.AbandonedJobSeconds);

        var expired = await db.Jobs
            // Queued with no lease is precisely "never taken, or requeued and
            // not taken again" - and a requeue stamps UpdatedAt, so the window
            // starts again for a job that genuinely got a second chance.
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

    /// <summary>
    /// One conditional update per reason. Splitting them keeps the SET list
    /// free of a CASE over a value-converted enum, which is the kind of thing
    /// that translates on one provider and not the other.
    /// </summary>
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

    /// <summary>
    /// The one place retry is decided. Every clause is a separate reason to
    /// stop, and any of them alone is enough.
    /// </summary>
    private static bool MayRetry(JobRow job, ErrorCode code) =>
        !ErrorCatalog.NeverRetry.Contains(code)
        && ErrorCatalog.IsRetriable(code)
        && !job.CredentialSubmitted
        && job.Attempts < MaxAttempts
        && JobStateMachine.CanTransition(job.State, JobState.Queued);

    /// <summary>
    /// The job, if this owner may act on it. <paramref name="tracked"/> is
    /// false for callers that write by conditional UPDATE: handing them a
    /// tracked entity would leave a stale row in the context behind a write
    /// the change tracker never saw.
    /// </summary>
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

    /// <summary>
    /// Inputs and material live only while the job might still need them.
    /// A terminal job holding a credential is a credential at rest with no
    /// reason to exist.
    /// </summary>
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

                // The operator sets a floor for every provider; a manifest may
                // ask for more of its own, never less. Whichever is larger is
                // the one that gets honoured, so an operator tuning the fleet
                // down cannot quietly undo a gap an adapter author widened for
                // a reason - and the reason is written where they wrote it.
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
