#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Live;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Jobs;

/// <summary>
/// What happens after a job stops running - once, for every path that can
/// stop one.
///
/// An agent posting a result, an agent posting a failure, and the in-process
/// runner finishing all land here, so the mapping from a job outcome to a
/// session state, a sealed bundle and a provider's health cannot drift
/// between them.
/// </summary>
public sealed class JobOutcomeService(
    ConnectorDbContext db,
    ILeasedJobQueue queue,
    SessionService sessions,
    ResultService results,
    ProviderStatusService providerStatus,
    JobArtifactService artifactStore,
    LiveChannel live,
    ILogger<JobOutcomeService> logger)
{
    private static readonly IReadOnlyDictionary<string, string> EmptyInputs =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// The failures only a developer can answer: an adapter that threw, a
    /// party whose site changed, a reconciliation that did not add up. Every
    /// other code names something the person does (sign in again, wait,
    /// start the agent) and is a warning, never an event (2026-10-05).
    /// </summary>
    internal static readonly IReadOnlySet<ErrorCode> PagesTheOperator =
        new HashSet<ErrorCode> { ErrorCode.Internal, ErrorCode.ProviderChanged, ErrorCode.ReconciliationFailed };

    /// <summary>
    /// Records success: stage the records, seal a new bundle where the
    /// adapter produced material, and move the session to active.
    /// </summary>
    public async Task<JobOutcome> SucceedAsync(string jobId, string? leaseOwner, JobResultRequest result, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(result);

        var job = await db.Jobs.FirstOrDefaultAsync(j => j.Id == jobId, ct)
                  ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");

        if (leaseOwner is not null && !string.Equals(job.LeaseOwner, leaseOwner, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"job '{jobId}' is not leased to '{leaseOwner}'");
        }

        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct)
                      ?? throw ConnectorException.Unsupported($"unknown session '{job.SessionId}'");

        var cursor = await results.StageAsync(job, result, ct);
        job.Complete = result.Complete;
        job.NotesJson = Infrastructure.ConnectorJson.Serialize(result.Notes);

        // Kept because the consumer shows it: without a name from the provider,
        // two connections to the same store are indistinguishable in a UI.
        if (result.ProviderAccount is { } account)
        {
            session.ProviderAccountJson = Infrastructure.ConnectorJson.Serialize(account);
        }

        string? bundle = null;
        if (result.SessionMaterial is { } material)
        {
            var sealedSession = sessions.Seal(session, material, result.Reachable, result.ExpiresAt);
            bundle = sealedSession.Bundle;
            session.ExpiresAt = sealedSession.ExpiresAt;
            session.PendingBundle = bundle;

            // T4 pointers name the machine that holds the real session; the
            // session row has to agree, or the next job routes nowhere.
            if (material.AgentId is { } agentId) session.AgentId = agentId;
            if (material.ProfileId is { } profileId) session.ProfileId = profileId;

            // Sealed from the inputs this very job used, and only where the
            // manifest offers a credential store. It has to happen before
            // CompleteAsync below, which clears the job's inputs the moment the
            // job goes terminal - that ordering is the whole reason this sits
            // in the success path rather than somewhere tidier.
            //
            // A job that carried no inputs - a fetch, or a login that redeemed
            // a stored bundle - seals nothing and leaves alone whatever is
            // waiting to be collected.
            var inputs = Infrastructure.ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(
                job.InputsJson, EmptyInputs);

            session.PendingCredentialBundle =
                sessions.SealCredentials(session, inputs) ?? session.PendingCredentialBundle;
        }

        // A session that was still parked on a question is running again by
        // definition - the answer that unparked it is what produced this
        // result. There is no edge straight from awaiting_input to active.
        if (session.State == SessionState.AwaitingInput)
        {
            await sessions.TransitionAsync(session, SessionState.Running, ct);
        }

        if (SessionStateMachine.CanTransition(session.State, SessionState.Active))
        {
            await sessions.TransitionAsync(session, SessionState.Active, ct);
        }
        else
        {
            await db.SaveChangesAsync(ct);
        }

        await queue.CompleteAsync(job.Id, leaseOwner, ct);

        // A working provider must be allowed to say so. `degraded` is a
        // machine-set observation - one job hit a shape it did not recognise -
        // and without this it was permanent: the catalogue went on telling
        // every user "the provider's site changed and an engineer is on it"
        // long after the runs had started succeeding again. Recovery closes
        // the loop that DegradeAsync opens.
        //
        // Only `degraded`. `paused` and `retired` are decisions a human made,
        // and a successful job is not grounds to overrule one - that is the
        // difference between a health signal and a kill switch.
        await providerStatus.RecoverAsync(job.ProviderId, ct);

        await PurgeChallengeAnswersAsync(job.Id, ct);
        live.Drop(job.Id);

        logger.LogInformation("job {JobId} ({Kind}/{Provider}) succeeded with {Count} record(s) via {Via}",
            job.Id, job.Kind, job.ProviderId, result.Accounts.Count + result.Transactions.Count + result.Receipts.Count,
            result.Via ?? "-");

        return new JobOutcome(job, session, bundle, cursor, result.Complete);
    }

    /// <summary>
    /// Records a failure. The queue decides whether it may be tried again;
    /// this decides what the user is told and whether an operator is paged.
    /// </summary>
    public async Task<JobRow> FailAsync(string jobId, string? leaseOwner, JobFailRequest failure, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(failure);

        var code = ParseCode(failure.Code);
        var job = await queue.FailAsync(jobId, leaseOwner, code, failure.Detail, ct);

        // What the adapter said before it gave up, which is usually where the
        // reason is - and on a failed job there are no staged records to carry
        // it instead.
        if (failure.Notes.Count > 0)
        {
            job.NotesJson = Infrastructure.ConnectorJson.Serialize(failure.Notes);
            await db.SaveChangesAsync(ct);
        }

        // What the run left behind, kept by the rules of whose run it was
        // (#441 L1): the operator's own at once, a person's pending their word.
        if (failure.Artifacts is { } artifacts) await artifactStore.KeepAsync(job, artifacts, ct);

        if (code == ErrorCode.ProviderChanged)
        {
            await providerStatus.DegradeAsync(job.ProviderId, "connect.provider.changed", ct);
        }

        // A retried job is still alive; nothing user-facing has happened yet -
        // and its answer may still be wanted, so it keeps it.
        if (job.State != JobState.Failed) return job;

        await PurgeChallengeAnswersAsync(job.Id, ct);

        // The last picture of the login page goes with the run that produced
        // it. Here rather than beside the requeue check on purpose: a job that
        // is going to be tried again still has a human in front of it.
        live.Drop(job.Id);

        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct);
        if (session is not null)
        {
            await sessions.TransitionOrTerminateAsync(session, SessionStateFor(code, session.State), ct);
        }

        // 2026-10-05 (user rule): a failure that needs a developer is an error
        // (it reaches GlitchTip through the logging integration); one the
        // person can act on — sign in again, wait, start the agent — is not
        if (PagesTheOperator.Contains(code))
        {
            logger.LogError("job {JobId} ({Kind}/{Provider}) failed: {Code} {Detail}",
                job.Id, job.Kind, job.ProviderId, ErrorCatalog.Wire(code), failure.Detail ?? "-");
        }
        else
        {
            logger.LogWarning("job {JobId} ({Kind}/{Provider}) failed: {Code} {Detail}",
                job.Id, job.Kind, job.ProviderId, ErrorCatalog.Wire(code), failure.Detail ?? "-");
        }

        return job;
    }

    /// <summary>
    /// Clears what this job's challenges were answered with, once the job can
    /// no longer want it.
    ///
    /// A challenge answer is credential material and was being kept like a
    /// diagnostic. The picture is dropped the instant it is answered, and the
    /// login inputs are gone at terminal state - but the ANSWER was written
    /// once and never cleared, so it rested in the table until the row was
    /// deleted a day after expiry. That is not a hypothetical: Lidl Plus
    /// declares its <c>redirect_url</c> field <c>Secret</c> precisely because
    /// "the pasted address carries a live authorization code... it buys the
    /// same access", and an SMS code arrives the same way.
    ///
    /// Terminal state rather than answer time, because the answer is read back
    /// out of this column to hand to the adapter - purging it on answer would
    /// take it away before the thing that asked for it could read it. A job
    /// that is still alive keeps its answer; one that is finished has no use
    /// for it.
    /// </summary>
    private Task<int> PurgeChallengeAnswersAsync(string jobId, CancellationToken ct) =>
        db.Challenges
            .Where(c => c.JobId == jobId && c.AnswerValue != null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.AnswerValue, (string?)null), ct);

    /// <summary>
    /// Each terminal code has a user-facing meaning, and the meaning is the
    /// point: "sign in again", "the provider is refusing us", "this is
    /// broken". A single generic failure state would make all three
    /// indistinguishable to the consumer.
    /// </summary>
    public static SessionState SessionStateFor(ErrorCode code, SessionState current) => code switch
    {
        ErrorCode.BlockedByProvider => SessionState.Blocked,
        ErrorCode.InvalidCredentials or ErrorCode.SessionExpired or ErrorCode.MfaFailed or ErrorCode.ConsentExpired =>
            current == SessionState.Active ? SessionState.NeedsReauth : SessionState.Failed,
        _ => SessionState.Failed,
    };

    /// <summary>
    /// Wire code to enum. An agent naming a code we do not know is reporting
    /// something we cannot reason about, which is <c>internal</c> - not a
    /// guess at the nearest match.
    /// </summary>
    public static ErrorCode ParseCode(string? wire)
    {
        if (string.IsNullOrWhiteSpace(wire)) return ErrorCode.Internal;

        return Enum.GetValues<ErrorCode>().FirstOrDefault(
            candidate => string.Equals(ErrorCatalog.Wire(candidate), wire, StringComparison.OrdinalIgnoreCase),
            ErrorCode.Internal);
    }
}

public readonly record struct JobOutcome(JobRow Job, SessionRow Session, string? Bundle, string Cursor, bool Complete);
