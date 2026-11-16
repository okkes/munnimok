using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Logging;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Jobs;

// failure pictures (#441 L1): operator runs (lab, canary) are retained at once;
// a person's is PENDING, served by no route, until they consent
// yes retains for the retention period; no, or no answer inside the consent window, deletes it
public sealed class JobArtifactService(
    ConnectorDbContext db,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<JobArtifactService> logger)
{
    private readonly ConnectorOptions _options = options.Value;

    public static bool IsOperatorRun(JobRow job)
    {
        ArgumentNullException.ThrowIfNull(job);
        return job.Trigger is JobRow.LabTrigger or JobRow.CanaryTrigger;
    }

    // never fatal: diagnostics must not turn an already failed job into a failing request
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
            job.Id, job.ProviderId, row.Status, LogSafe.Line(row.DomDigest ?? "-"), row.Screenshot?.Length ?? 0);
    }

    public Task<bool> IsPendingAsync(string jobId, CancellationToken ct) =>
        db.JobArtifacts.AsNoTracking().AnyAsync(a => a.JobId == jobId && a.Status == ArtifactStatus.Pending, ct);

    // saying yes twice is one yes; null when the job left nothing to share
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

    // no, or a changed mind about a yes: gone now, whatever its status
    public async Task<bool> DeclineAsync(string jobId, CancellationToken ct) =>
        await db.JobArtifacts.Where(a => a.JobId == jobId).ExecuteDeleteAsync(ct) > 0;

    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        return await db.JobArtifacts.Where(a => a.ExpiresAt < now).ExecuteDeleteAsync(ct);
    }

    /// <summary>A picture the operator may see; null while pending, once declined, or when none was ever taken.</summary>
    public Task<JobArtifactRow?> RetainedAsync(string jobId, CancellationToken ct) =>
        db.JobArtifacts.AsNoTracking()
            .FirstOrDefaultAsync(a => a.JobId == jobId && a.Status == ArtifactStatus.Retained, ct);

    // a picture past the cap is dropped and the digest kept, so a runaway capture cannot make this the biggest table
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
