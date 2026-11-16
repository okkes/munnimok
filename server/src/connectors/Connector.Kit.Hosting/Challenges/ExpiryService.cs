using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Hosting.Live;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Hosting.Staging;
using Connector.Kit.Hosting.Tickets;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Challenges;

/// one loop closes every deadline: pending challenges, dangling leases, unacked staged rows
public sealed class ExpiryService(
    IServiceScopeFactory scopes,
    ITicketStore tickets,
    IIdempotencyStore idempotency,
    LiveChannel live,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<ExpiryService> logger) : BackgroundService
{
    private readonly ConnectorOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, _options.Timeouts.ExpirySweepSeconds));
        using var timer = new PeriodicTimer(interval, time);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepAsync(stoppingToken);
            }
            // A call that timed out is an OperationCanceledException too: only
            // the host's own stop ends the sweeps.
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // a failed sweep must not stop the service: the next one finds the same rows
                logger.LogError(ex, "expiry sweep failed");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken)) return;
        }
    }

    public async Task SweepAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var provider = scope.ServiceProvider;
        var db = provider.GetRequiredService<ConnectorDbContext>();
        var queue = provider.GetRequiredService<ILeasedJobQueue>();
        var challenges = provider.GetRequiredService<ChallengeService>();
        var results = provider.GetRequiredService<ResultService>();
        var outcomes = provider.GetRequiredService<JobOutcomeService>();

        await FailJobsOnExpiredChallengesAsync(db, outcomes, ct);
        await challenges.SweepAsync(ct);
        await queue.RequeueExpiredLeasesAsync(ct);

        // before the reconcile: failing never-taken jobs is what makes their session say something true
        await queue.ExpireAbandonedAsync(ct);

        await ReconcileStrandedSessionsAsync(db, provider.GetRequiredService<SessionService>(), ct);
        await ExpireSessionsAsync(db, ct);
        await results.SweepAsync(ct);
        // A question nobody answered, a report past its month (#441 L1).
        await provider.GetRequiredService<JobArtifactService>().SweepAsync(ct);
        await provider.GetRequiredService<JobTraceService>().SweepAsync(ct);
        await ExpireEnrollmentsAsync(db, ct);
        tickets.Sweep();
        idempotency.Sweep();

        // a login abandoned mid-stream leaves a frame in memory; this closes the channel the job-outcome paths did not
        live.Sweep();
    }

    /// a lease expiry fails its job in bulk without loading the session; this makes the session say something true
    /// instead of "running" until its TTL
    private static async Task ReconcileStrandedSessionsAsync(ConnectorDbContext db, SessionService sessions, CancellationToken ct)
    {
        var stranded = await db.Sessions
            .Where(s => (s.State == SessionState.Queued
                         || s.State == SessionState.Running
                         || s.State == SessionState.AwaitingInput)
                        && db.Jobs.Any(j => j.SessionId == s.Id)
                        && !db.Jobs.Any(j => j.SessionId == s.Id
                                             && (j.State == JobState.Queued
                                                 || j.State == JobState.Leased
                                                 || j.State == JobState.Running
                                                 || j.State == JobState.AwaitingInput)))
            // oldest first with a tiebreak: an unordered batch could return the same unsettled rows and starve the rest
            .OrderBy(s => s.UpdatedAt)
            .ThenBy(s => s.Id)
            .Take(64)
            .ToListAsync(ct);

        foreach (var session in stranded)
        {
            var last = await db.Jobs
                .Where(j => j.SessionId == session.Id)
                .OrderByDescending(j => j.CreatedAt)
                .ThenByDescending(j => j.Id)
                .FirstOrDefaultAsync(ct);

            // A succeeded job already moved the session itself; only a
            // failure can leave one behind.
            if (last is null || last.State is not (JobState.Failed or JobState.Expired)) continue;

            var next = JobOutcomeService.SessionStateFor(last.ErrorCode ?? ErrorCode.Internal, session.State, last.Kind);
            await sessions.TransitionOrTerminateAsync(session, next, ct);
        }
    }

    private async Task FailJobsOnExpiredChallengesAsync(ConnectorDbContext db, JobOutcomeService outcomes, CancellationToken ct)
    {
        var now = time.GetUtcNow();

        var stranded = await db.Jobs
            .Where(j => j.State == JobState.AwaitingInput
                        && !db.Challenges.Any(c => c.JobId == j.Id && c.AnsweredAt == null && c.ExpiresAt > now))
            // ordered so a batch cannot revisit the same rows forever
            .OrderBy(j => j.UpdatedAt)
            .ThenBy(j => j.Id)
            .Select(j => j.Id)
            .Take(64)
            .ToListAsync(ct);

        foreach (var jobId in stranded)
        {
            await outcomes.FailAsync(jobId, leaseOwner: null, new JobFailRequest
            {
                Code = ErrorCatalog.Wire(ErrorCode.ChallengeExpired),
                Detail = "no answer before the challenge expired",
            }, ct);
        }
    }

    private async Task ExpireSessionsAsync(ConnectorDbContext db, CancellationToken ct)
    {
        var now = time.GetUtcNow();

        // a disabled session stays disabled: "the user turned this off" and "this ran out" are different things to say
        await db.Sessions
            .Where(s => s.ExpiresAt < now
                        && (s.State == SessionState.Queued
                            || s.State == SessionState.Running
                            || s.State == SessionState.AwaitingInput
                            || s.State == SessionState.Active
                            || s.State == SessionState.NeedsReauth))
            .ExecuteUpdateAsync(u => u
                .SetProperty(s => s.State, SessionState.Expired)
                .SetProperty(s => s.PendingBundle, (string?)null)
                // both bundles: a credential bundle clears only when collected, so an uncollected one would sit on an expired row
                .SetProperty(s => s.PendingCredentialBundle, (string?)null)
                .SetProperty(s => s.UpdatedAt, now), ct);
    }

    private async Task ExpireEnrollmentsAsync(ConnectorDbContext db, CancellationToken ct)
    {
        var cutoff = time.GetUtcNow().AddDays(-1);
        await db.Enrollments.Where(e => e.ExpiresAt < cutoff).ExecuteDeleteAsync(ct);
    }
}
