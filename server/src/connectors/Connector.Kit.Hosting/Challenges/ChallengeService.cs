using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Challenges;

/// enforced here because an adapter cannot be trusted to remember: a challenge always expires (job fails, agent released),
/// and its image bytes are ephemeral: gone once answered or expired, never logged, never on a webhook
public sealed class ChallengeService(
    ConnectorDbContext db,
    ConnectorSignals signals,
    IOptions<ConnectorOptions> options,
    TimeProvider time)
{
    private readonly ConnectorOptions _options = options.Value;

    /// the job moves to AwaitingInput in the same call, so no consumer sees a running job with an unannounced question
    public async Task<ChallengeRow> RaiseAsync(string jobId, PendingChallenge challenge, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(challenge);

        var job = await db.Jobs.FirstOrDefaultAsync(j => j.Id == jobId, ct)
                  ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");

        if (JobStateMachine.IsTerminal(job.State))
        {
            throw ConnectorException.InvalidRequest($"job '{jobId}' is already {job.State}");
        }

        var now = time.GetUtcNow();
        if (challenge.ExpiresAt <= now)
        {
            throw ConnectorException.InvalidRequest("challenge expires_at is already in the past");
        }

        var row = new ChallengeRow
        {
            Id = Ids.New(Ids.Challenge),
            JobId = job.Id,
            Type = challenge.Type,
            PayloadJson = ConnectorJson.Serialize(challenge.Payload),
            ImageBytes = challenge.Image,
            ExpiresAt = challenge.ExpiresAt,
            CreatedAt = now,
        };

        db.Challenges.Add(row);

        if (job.State == JobState.Leased) job.State = JobState.Running;
        if (job.State != JobState.AwaitingInput)
        {
            JobStateMachine.EnsureTransition(job.State, JobState.AwaitingInput);
            job.State = JobState.AwaitingInput;
        }

        job.Step = JobStep.AwaitingHuman;
        job.UpdatedAt = now;

        var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct);
        if (session is not null && SessionStateMachine.CanTransition(session.State, SessionState.AwaitingInput))
        {
            session.State = SessionState.AwaitingInput;
            session.UpdatedAt = now;
        }

        await db.SaveChangesAsync(ct);

        signals.Signal(ConnectorSignals.Job(job.Id));
        signals.Signal(ConnectorSignals.Session(job.SessionId));
        return row;
    }

    /// <summary>The pending challenge for a job, or null. Expired ones do not count as pending.</summary>
    public async Task<ChallengeRow?> PendingAsync(string jobId, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        return await db.Challenges
            .Where(c => c.JobId == jobId && c.AnsweredAt == null && c.ExpiresAt > now)
            .OrderByDescending(c => c.CreatedAt)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<ChallengeRow?> FindAsync(string challengeId, string jobId, CancellationToken ct) =>
        await db.Challenges.FirstOrDefaultAsync(c => c.Id == challengeId && c.JobId == jobId, ct);

    /// null includes an answered or expired challenge: the bytes are gone by then
    public async Task<byte[]?> ImageAsync(string challengeId, string jobId, CancellationToken ct)
    {
        var row = await FindAsync(challengeId, jobId, ct);
        return row?.ImageBytes;
    }

    /// a second answer is a conflict, not an overwrite: the agent is already acting on the first
    public async Task<ChallengeRow> AnswerAsync(string challengeId, string jobId, string value, CancellationToken ct)
    {
        var row = await FindAsync(challengeId, jobId, ct)
                  ?? throw ConnectorException.Unsupported($"unknown challenge '{challengeId}'");

        // a live view carries no value: this route persists AnswerValue, so a posted password would land in the stored column
        // an empty answer is accepted: it is how a live view ends, and refusing it would hold the browser until timeout
        // refused here, not at the endpoint, which is not the only way in
        if (row.Type == ChallengeType.LiveView && !string.IsNullOrEmpty(value))
        {
            throw ConnectorException.Unsupported(
                $"challenge '{challengeId}' is a live view: it is answered by pointer and key events, " +
                "and a value posted here would be stored");
        }

        if (row.AnsweredAt is not null)
        {
            throw ConnectorHttpException.Conflict("challenge_already_answered");
        }

        var now = time.GetUtcNow();
        if (row.ExpiresAt <= now)
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, $"challenge '{challengeId}' expired");
        }

        row.AnsweredAt = now;
        row.AnswerValue = value;
        row.ImageBytes = null;

        var job = await db.Jobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job is not null && job.State == JobState.AwaitingInput)
        {
            job.State = JobState.Running;
            job.Step = JobStep.Authenticating;
            job.UpdatedAt = now;

            // the session returns with it: the state machine has no edge from awaiting_input to active
            var session = await db.Sessions.FirstOrDefaultAsync(s => s.Id == job.SessionId, ct);
            if (session is not null && session.State == SessionState.AwaitingInput)
            {
                session.State = SessionState.Running;
                session.UpdatedAt = now;
            }
        }

        await db.SaveChangesAsync(ct);

        signals.Signal(ConnectorSignals.Job(jobId));
        if (job is not null) signals.Signal(ConnectorSignals.Session(job.SessionId));
        return row;
    }

    /// null = expired unanswered: the caller fails the job cleanly instead of leaving a hung browser
    /// challengeId null = newest, right only while a job has one open question; an older agent sends no id
    public async Task<ChallengeAnswer?> AwaitAnswerAsync(
        string jobId, TimeSpan window, CancellationToken ct, string? challengeId = null)
    {
        var deadline = time.GetUtcNow() + window;

        while (!ct.IsCancellationRequested)
        {
            var now = time.GetUtcNow();
            var latest = await db.Challenges
                .AsNoTracking()
                .Where(c => c.JobId == jobId && (challengeId == null || c.Id == challengeId))
                .OrderByDescending(c => c.CreatedAt)
                .FirstOrDefaultAsync(ct);

            if (latest is null) return null;

            if (latest.AnsweredAt is not null)
            {
                return new ChallengeAnswer { ChallengeId = latest.Id, Value = latest.AnswerValue ?? string.Empty };
            }

            if (latest.ExpiresAt <= now) return null;
            if (now >= deadline) return null;

            var slice = Min(latest.ExpiresAt - now, deadline - now, TimeSpan.FromSeconds(2));
            await signals.WaitAsync(ConnectorSignals.Job(jobId), slice, ct);
            db.ChangeTracker.Clear();
        }

        return null;
    }

    /// two passes: expiry ends answerability at once, the bytes stay a grace window so a mid-render consumer is fine
    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var purgeBefore = now.AddSeconds(-_options.Timeouts.ChallengeGraceSeconds);

        var purged = await db.Challenges
            .Where(c => c.ImageBytes != null && (c.AnsweredAt != null || c.ExpiresAt < purgeBefore))
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.ImageBytes, (byte[]?)null), ct);

        // the answer is credential material (SMS code, callback URL); JobOutcomeService clears it at terminal state, this backstops
        // jobs that never get there; bounded by the grace window, not AnsweredAt, as a racing sweep would fail the login
        await db.Challenges
            .Where(c => c.AnswerValue != null
                        && (c.AnsweredAt < purgeBefore || c.ExpiresAt < purgeBefore))
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.AnswerValue, (string?)null), ct);

        await db.Challenges
            .Where(c => c.ExpiresAt < now.AddDays(-1))
            .ExecuteDeleteAsync(ct);

        return purged;
    }

    private static TimeSpan Min(TimeSpan a, TimeSpan b, TimeSpan c)
    {
        var min = a < b ? a : b;
        min = min < c ? min : c;
        return min < TimeSpan.Zero ? TimeSpan.Zero : min;
    }
}

public sealed record PendingChallenge
{
    public required ChallengeType Type { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Exactly what the consumer will be shown. No prose, only keys and values.</summary>
    public required ChallengePayload Payload { get; init; }

    /// <summary>Redacted PNG, already redacted before it left the agent.</summary>
    public byte[]? Image { get; init; }
}

public sealed record ChallengePayload
{
    /// carried because it decides what the consumer renders: dropping it makes every challenge Text, with tests still passing
    public ChallengeAnswerKind AnswerKind { get; init; } = ChallengeAnswerKind.Text;

    public string? PromptKey { get; init; }

    public string? Code { get; init; }

    public string? Delivery { get; init; }

    public int? Length { get; init; }

    public IReadOnlyList<ChallengeOption>? Options { get; init; }

    public string? Url { get; init; }

    public string? ReturnPattern { get; init; }

    public static ChallengePayload From(Challenge challenge)
    {
        ArgumentNullException.ThrowIfNull(challenge);
        return new ChallengePayload
        {
            AnswerKind = challenge.AnswerKind,
            PromptKey = challenge.PromptKey,
            Code = challenge.Code,
            Delivery = challenge.Delivery,
            Length = challenge.Length,
            Options = challenge.Options,
            Url = challenge.Url,
            ReturnPattern = challenge.ReturnPattern,
        };
    }
}
