using System.IO.Compression;
using System.Text.Json;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Tracing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Jobs;

/// <summary>
/// The recordings (#441 L3): one per job, kept gzipped with the digest an
/// adapter author reads first rendered once at arrival, readable by the
/// operator for the retention a failure report gets, then swept.
///
/// Only a lab run's is kept. The record flag cannot be set without the lab
/// trigger, so this is defence in depth rather than the gate itself - but a
/// trace that arrived for a person's job, however it got there, is dropped
/// here and logged, never stored.
/// </summary>
public sealed class JobTraceService(
    ConnectorDbContext db,
    IOptions<ConnectorOptions> options,
    TimeProvider time,
    ILogger<JobTraceService> logger)
{
    private readonly ConnectorOptions _options = options.Value;

    /// <summary>Keeps a recording for the job, replacing whatever it held. Null when it was refused.</summary>
    public async Task<JobTraceRow?> KeepAsync(string jobId, JobTrace trace, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(jobId);
        ArgumentNullException.ThrowIfNull(trace);

        var job = await db.Jobs.AsNoTracking().FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job is null)
        {
            logger.LogWarning("a recording arrived for unknown job {JobId}; dropped", jobId);
            return null;
        }

        if (!JobArtifactService.IsOperatorRun(job))
        {
            logger.LogWarning(
                "a recording arrived for job {JobId} ({Provider}), which is not the operator's run; dropped unread",
                job.Id, job.ProviderId);
            return null;
        }

        var bytes = Gzip(JsonSerializer.SerializeToUtf8Bytes(trace, ConnectorWireJson.Options));
        if (bytes.Length > _options.MaxTraceBytes)
        {
            logger.LogWarning(
                "job {JobId}: the recording weighs {Bytes} bytes packed, past the {Max} byte cap; dropped",
                job.Id, bytes.Length, _options.MaxTraceBytes);
            return null;
        }

        var now = time.GetUtcNow();
        var row = new JobTraceRow
        {
            JobId = job.Id,
            SessionId = job.SessionId,
            ProviderId = job.ProviderId,
            Entries = trace.Entries.Count,
            Dropped = trace.Dropped,
            Truncated = trace.Truncated,
            ByteCount = bytes.Length,
            Bytes = bytes,
            Digest = TraceDigest.Render(trace),
            StartedAt = trace.StartedAt,
            EndedAt = trace.EndedAt,
            CapturedAt = now,
            ExpiresAt = now.AddDays(_options.Timeouts.ArtifactRetentionDays),
        };

        try
        {
            await db.JobTraces.Where(t => t.JobId == job.Id).ExecuteDeleteAsync(ct);
            db.JobTraces.Add(row);
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex)
        {
            db.Entry(row).State = EntityState.Detached;
            logger.LogWarning(ex, "job {JobId}: the recording could not be kept", job.Id);
            return null;
        }

        logger.LogInformation(
            "job {JobId} ({Provider}) recording kept: {Entries} entries ({Dropped} dropped), {Bytes} bytes packed",
            job.Id, job.ProviderId, row.Entries, row.Dropped, row.ByteCount);
        return row;
    }

    public Task<JobTraceRow?> FindAsync(string jobId, CancellationToken ct) =>
        db.JobTraces.AsNoTracking().FirstOrDefaultAsync(t => t.JobId == jobId, ct);

    public async Task<bool> DeleteAsync(string jobId, CancellationToken ct) =>
        await db.JobTraces.Where(t => t.JobId == jobId).ExecuteDeleteAsync(ct) > 0;

    public async Task<int> SweepAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var swept = await db.JobTraces.Where(t => t.ExpiresAt <= now).ExecuteDeleteAsync(ct);
        if (swept > 0) logger.LogInformation("swept {Count} recording(s) past their retention", swept);
        return swept;
    }

    /// <summary>The trace as JSON bytes, unpacked.</summary>
    public static byte[] Unpack(JobTraceRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        return Gunzip(row.Bytes, int.MaxValue);
    }

    public static byte[] Gzip(byte[] plain)
    {
        ArgumentNullException.ThrowIfNull(plain);

        using var packed = new MemoryStream();
        using (var zip = new GZipStream(packed, CompressionLevel.Optimal, leaveOpen: true))
        {
            zip.Write(plain);
        }

        return packed.ToArray();
    }

    /// <summary>Unpacks up to <paramref name="max"/> bytes; past that the stream is a bomb and the result null.</summary>
    public static byte[] Gunzip(byte[] packed, int max)
    {
        ArgumentNullException.ThrowIfNull(packed);

        using var source = new MemoryStream(packed);
        using var unzip = new GZipStream(source, CompressionMode.Decompress);
        using var plain = new MemoryStream();

        var chunk = new byte[64 * 1024];
        while (true)
        {
            var read = unzip.Read(chunk, 0, chunk.Length);
            if (read == 0) break;

            if (plain.Length + read > max) throw new InvalidDataException("the packed trace unpacks past the cap");
            plain.Write(chunk, 0, read);
        }

        return plain.ToArray();
    }
}
