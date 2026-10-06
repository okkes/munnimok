using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Jobs;

/// <summary>
/// What a failed run leaves behind, and who may look at it (#441 L1).
///
/// An agent that fails a job sends the last picture of the page and a digest
/// of its shape - the two things that make a broken adapter fixable without
/// spending somebody's real sign-in on each guess. Until now they went to a
/// temp directory outside production and nowhere inside it, which is where
/// the failures worth reading happen.
///
/// Whose picture it is decides what happens to it. The operator's own runs -
/// the lab's, a canary's - are retained at once: there is nobody to ask. A
/// person's run is held PENDING, readable by nobody, until that person says
/// the operator may see it: the app asks "report this failure?" beside the
/// error. Yes retains it for a month; no deletes it on the spot; no answer
/// inside the consent window deletes it too. A pending picture is served by
/// no route, so the operator sees exactly the failures people chose to report
/// and nothing else.
/// </summary>
public sealed class JobArtifactService(
    ConnectorDbContext db,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<JobArtifactService> logger)
{
    private readonly ConnectorOptions _options = options.Value;

    /// <summary>Whether a job's trigger makes its pictures the operator's own rather than a person's.</summary>
    public static bool IsOperatorRun(JobRow job)
    {
        ArgumentNullException.ThrowIfNull(job);
        return job.Trigger is JobRow.LabTrigger or JobRow.CanaryTrigger;
    }

    /// <summary>
    /// Keeps what the agent sent: retained for the operator's own run, pending
    /// the person's answer otherwise. Never fatal - this is diagnostics, and a
    /// picture that cannot be kept must not turn a job that already failed
    /// into a request that also fails.
    /// </summary>
    public async Task KeepAsync(JobRow job, FailureArtifacts artifacts, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(job);
        ArgumentNullException.ThrowIfNull(artifacts);

        var screenshot = Decode(job.Id, artifacts.ScreenshotBase64);
        if (screenshot is null && string.IsNullOrWhiteSpace(artifacts.DomDigest)) return;

        var now = time.GetUtcNow();
        var retained = IsOperatorRun(job);
        var row = new JobArtifactRow
        {
            JobId = job.Id,
            SessionId = job.SessionId,
            ProviderId = job.ProviderId,
            Status = retained ? ArtifactStatus.Retained : ArtifactStatus.Pending,
            Screenshot = screenshot,
            DomDigest = artifacts.DomDigest,
            CapturedAt = now,
            SharedAt = retained ? now : null,
            ExpiresAt = retained
                ? now.AddDays(_options.Timeouts.ArtifactRetentionDays)
                : now.AddHours(_options.Timeouts.ArtifactConsentHours),
        };

        try
        {
            // A job tried twice fails twice; the later picture is the one that
            // shows where it really stopped.
            await db.JobArtifacts.Where(a => a.JobId == job.Id).ExecuteDeleteAsync(ct);
            db.JobArtifacts.Add(row);
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex)
        {
            // Detached, so the failed insert cannot ride along on the next
            // save the outcome makes for the session.
            db.Entry(row).State = EntityState.Detached;
            logger.LogWarning(ex, "job {JobId}: failure artifacts could not be kept", job.Id);
            return;
        }

        logger.LogInformation(
            "job {JobId} ({Provider}) failure artifacts kept as {Status}: dom {Digest}, screenshot {Bytes} bytes",
            job.Id, job.ProviderId, row.Status, row.DomDigest ?? "-", row.Screenshot?.Length ?? 0);
    }

    /// <summary>
    /// The job whose picture waits on this person's answer, if any, newest
    /// first - what a view carries so the consumer knows to ask.
    /// </summary>
    public Task<bool> IsPendingAsync(string jobId, CancellationToken ct) =>
        db.JobArtifacts.AsNoTracking().AnyAsync(a => a.JobId == jobId && a.Status == ArtifactStatus.Pending, ct);

    /// <summary>
    /// The person said yes: readable by the operator from now until the
    /// retention runs out. Saying yes twice is one yes; null when the job left
    /// nothing to share.
    /// </summary>
    public async Task<JobArtifactRow?> ShareAsync(string jobId, CancellationToken ct)
    {
        var row = await db.JobArtifacts.FirstOrDefaultAsync(a => a.JobId == jobId, ct);
        if (row is null) return null;

        if (row.Status == ArtifactStatus.Pending)
        {
            var now = time.GetUtcNow();
            row.Status = ArtifactStatus.Retained;
            row.SharedAt = now;
            row.ExpiresAt = now.AddDays(_options.Timeouts.ArtifactRetentionDays);
            await db.SaveChangesAsync(ct);
        }

        return row;
    }

    /// <summary>The person said no - or changed their mind about a yes: gone now, whatever its status.</summary>
    public async Task<bool> DeclineAsync(string jobId, CancellationToken ct) =>
        await db.JobArtifacts.Where(a => a.JobId == jobId).ExecuteDeleteAsync(ct) > 0;

    /// <summary>A question nobody answered inside its window, or a report past its month.</summary>
    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        return await db.JobArtifacts.Where(a => a.ExpiresAt < now).ExecuteDeleteAsync(ct);
    }

    /// <summary>A picture the operator may see; null while pending, once declined, or when none was ever taken.</summary>
    public Task<JobArtifactRow?> RetainedAsync(string jobId, CancellationToken ct) =>
        db.JobArtifacts.AsNoTracking()
            .FirstOrDefaultAsync(a => a.JobId == jobId && a.Status == ArtifactStatus.Retained, ct);

    /// <summary>
    /// The screenshot as bytes, within the cap. A page photographed at a
    /// browser's full size weighs a few hundred kilobytes; a picture past the
    /// cap is dropped and the digest kept, so a runaway capture cannot make a
    /// diagnostics table the biggest thing in the database.
    /// </summary>
    private byte[]? Decode(string jobId, string? encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded)) return null;

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encoded);
        }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "job {JobId}: the screenshot was not base64 and was dropped", jobId);
            return null;
        }

        if (bytes.Length == 0) return null;

        if (bytes.Length > _options.MaxArtifactBytes)
        {
            logger.LogWarning(
                "job {JobId}: a {Bytes}-byte screenshot is past the {Cap}-byte cap and was dropped; the digest is kept",
                jobId, bytes.Length, _options.MaxArtifactBytes);
            return null;
        }

        return bytes;
    }
}
