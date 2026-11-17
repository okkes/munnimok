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
using Connector.Kit.Logging;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Jobs;

// every outcome path (agent result, agent failure, inline runner) lands here,
// so the mapping to session, bundle and health cannot drift
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

    // the failures only a developer can answer; every other code names something the person does: a warning, never an event
    internal static readonly IReadOnlySet<ErrorCode> PagesTheOperator =
        new HashSet<ErrorCode> { ErrorCode.Internal, ErrorCode.ProviderChanged, ErrorCode.ReconciliationFailed };

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

            // sealed from this job's inputs before CompleteAsync clears them at terminal state, which is why it sits in the success path
            var inputs = Infrastructure.ConnectorJson.DeserializeOr<IReadOnlyDictionary<string, string>>(
                job.InputsJson, EmptyInputs);

            session.PendingCredentialBundle =
                sessions.SealCredentials(session, inputs) ?? session.PendingCredentialBundle;
        }

        // job recorded succeeded BEFORE the session goes active: the sync interval reads the job table, and a scheduled login
        // that followed too closely found no succeeded run to measure from and was let through
        await queue.CompleteAsync(job.Id, leaseOwner, ct);

        // a session parked on a question is running again by definition: there is no edge awaiting_input -> active
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

        // recovers only `degraded` (machine-set): `paused` and `retired` are human decisions a success must not overrule
        await providerStatus.RecoverAsync(job.ProviderId, ct);

        await PurgeChallengeAnswersAsync(job.Id, ct);
        live.Drop(job.Id);

        logger.LogInformation("job {JobId} ({Kind}/{Provider}) succeeded with {Count} record(s) via {Via}",
            job.Id, job.Kind, job.ProviderId, result.Accounts.Count + result.Transactions.Count + result.Receipts.Count,
            LogSafe.Line(result.Via ?? "-"));

        return new JobOutcome(job, session, bundle, cursor, result.Complete);
    }

    public async Task<JobRow> FailAsync(string jobId, string? leaseOwner, JobFailRequest failure, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(failure);

        var code = ParseCode(failure.Code);
        var job = await queue.FailAsync(jobId, leaseOwner, code, failure.Detail, ct);

        // notes carry the reason on a failed job, which has no staged records
        if (failure.Notes.Count > 0)
        {
            job.NotesJson = Infrastructure.ConnectorJson.Serialize(failure.Notes);
            await db.SaveChangesAsync(ct);
        }

        // kept by whose run it was (#441 L1)
        if (failure.Artifacts is { } artifacts) await artifactStore.KeepAsync(job, artifacts, ct);

        if (code == ErrorCode.ProviderChanged)
        {
            await providerStatus.DegradeAsync(job.ProviderId, "connect.provider.changed", ct);
        }

        // a retried job is still alive and its answer may still be wanted
        if (job.State != JobState.Failed) return job;

        await PurgeChallengeAnswersAsync(job.Id, ct);

        // dropped here, not beside the requeue check: a job to be tried again still has a human in front of it
        live.Drop(job.Id);

        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct);
        if (session is not null)
        {
            await sessions.TransitionOrTerminateAsync(session, SessionStateFor(code, session.State, job.Kind), ct);
        }

        // a failure needing a developer is an error (reaches GlitchTip); one the person can act on is only a warning
        if (PagesTheOperator.Contains(code))
        {
            logger.LogError("job {JobId} ({Kind}/{Provider}) failed: {Code} {Detail}",
                job.Id, job.Kind, job.ProviderId, ErrorCatalog.Wire(code), LogSafe.Line(failure.Detail ?? "-"));
        }
        else
        {
            logger.LogWarning("job {JobId} ({Kind}/{Provider}) failed: {Code} {Detail}",
                job.Id, job.Kind, job.ProviderId, ErrorCatalog.Wire(code), LogSafe.Line(failure.Detail ?? "-"));
        }

        return job;
    }

    // a challenge answer is credential material (Lidl Plus's redirect_url carries a live authorization code)
    // purged at terminal state, not at answer time: the adapter reads it back out of this column
    private Task<int> PurgeChallengeAnswersAsync(string jobId, CancellationToken ct) =>
        db.Challenges
            .Where(c => c.JobId == jobId && c.AnswerValue != null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.AnswerValue, (string?)null), ct);

    // the provider no longer honours the session: only a person signing in again mends these
    internal static readonly IReadOnlySet<ErrorCode> SignInCodes = new HashSet<ErrorCode>
    {
        ErrorCode.InvalidCredentials, ErrorCode.SessionExpired, ErrorCode.MfaFailed, ErrorCode.ConsentExpired, ErrorCode.AgentRevoked,
    };

    // each terminal code has a user meaning (sign in again / provider refusing / broken); one generic state would blur them
    // a failure not the session's leaves a working session working: an ING rate_limited once ended one, so every resume
    // failed and a second session burnt the bank's daily budget beside it (prod 2026-10-08)
    public static SessionState SessionStateFor(ErrorCode code, SessionState current, JobKind kind) => code switch
    {
        ErrorCode.BlockedByProvider => SessionState.Blocked,
        _ when SignInCodes.Contains(code) => current == SessionState.Active ? SessionState.NeedsReauth : SessionState.Failed,
        _ when current == SessionState.Active => SessionState.Active,
        _ when current == SessionState.Running && kind != JobKind.Login => SessionState.Active,
        _ => SessionState.Failed,
    };

    // an unknown wire code is internal, not a guess at the nearest match
    public static ErrorCode ParseCode(string? wire)
    {
        if (string.IsNullOrWhiteSpace(wire)) return ErrorCode.Internal;

        return Enum.GetValues<ErrorCode>().FirstOrDefault(
            candidate => string.Equals(ErrorCatalog.Wire(candidate), wire, StringComparison.OrdinalIgnoreCase),
            ErrorCode.Internal);
    }
}

public readonly record struct JobOutcome(JobRow Job, SessionRow Session, string? Bundle, string Cursor, bool Complete);
