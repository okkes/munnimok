using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Logging;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Providers;

// the operator's own connections, run on a schedule: finds a provider break before a real user does
// the only thing on the platform that holds a credential at rest (see CanaryRow)
public sealed class CanaryService(
    ConnectorDbContext db,
    IProviderRegistry registry,
    TimeProvider time,
    ILogger<CanaryService> logger)
{
    // a real user's bundle cannot be enrolled: a consumer's subject is an HMAC that never begins with this prefix
    public const string SubjectPrefix = "canary:";

    // a canary is a real provider session; running it too often from a datacentre address gets its account blocked
    public const int MinimumIntervalMinutes = 15;

    public Task<List<CanaryRow>> AllAsync(CancellationToken ct) =>
        db.Canaries.AsNoTracking().OrderBy(c => c.ProviderId).ToListAsync(ct);

    // the bundle is not opened here: the scheduler does it at run time and the first run reports one that will not open
    public async Task<CanaryRow> EnrolAsync(
        string providerId, string subject, string bundle, string resourceId, int intervalMinutes, CancellationToken ct)
    {
        var manifest = registry.RequireManifest(providerId);

        if (string.IsNullOrWhiteSpace(subject) || !subject.StartsWith(SubjectPrefix, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest(
                $"canary: the subject must begin with '{SubjectPrefix}', so that a connection belonging to a "
                + "person cannot be enrolled here. Connect the operator's own account with such a subject and "
                + "offer that bundle instead");
        }

        if (string.IsNullOrWhiteSpace(bundle))
        {
            throw ConnectorException.InvalidRequest("canary: no bundle was offered, so there is nothing to run with");
        }

        if (!manifest.Resources.Any(r => string.Equals(r.Id, resourceId, StringComparison.Ordinal)))
        {
            throw ConnectorException.InvalidRequest(
                $"canary: {manifest.Id} offers no resource '{resourceId}'; it has "
                + $"[{string.Join(", ", manifest.Resources.Select(r => r.Id))}]");
        }

        if (intervalMinutes < MinimumIntervalMinutes)
        {
            throw ConnectorException.InvalidRequest(
                $"canary: {intervalMinutes} minute(s) is below the {MinimumIntervalMinutes}-minute floor. A canary "
                + "is a real session against a real provider, and one that runs too often gets its own account "
                + "blocked");
        }

        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == manifest.Id, ct);

        if (row is null)
        {
            row = new CanaryRow { ProviderId = manifest.Id, CreatedAt = time.GetUtcNow() };
            db.Canaries.Add(row);
        }

        row.Subject = subject;
        row.Bundle = bundle;
        row.ResourceId = resourceId;
        row.IntervalMinutes = intervalMinutes;

        // a re-enrolment is a new connection: the last verdict is about something that no longer exists
        row.LastRunAt = null;
        row.LastJobId = null;
        row.LastVerdict = null;
        row.LastIntact = null;

        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "canary for {Provider} enrolled against {Resource}, every {Minutes} minute(s)",
            manifest.Id, LogSafe.Line(resourceId), intervalMinutes);

        return row;
    }

    // deleted, not disabled: a disabled canary would leave a live provider session stored with nothing running
    public async Task<bool> RemoveAsync(string providerId, CancellationToken ct)
    {
        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == providerId, ct);
        if (row is null) return false;

        db.Canaries.Remove(row);
        await db.SaveChangesAsync(ct);

        logger.LogInformation("canary for {Provider} removed", LogSafe.Line(providerId));
        return true;
    }

    public Task RecordStartedAsync(CanaryRow canary, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(canary);

        db.Canaries.Update(canary);
        return db.SaveChangesAsync(ct);
    }

    public async Task<List<CanaryRow>> DueAsync(CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var rows = await db.Canaries.ToListAsync(ct);

        return
        [
            .. rows
                .Where(c => c.LastRunAt is null || c.LastRunAt.Value.AddMinutes(c.IntervalMinutes) <= now)
                .OrderBy(c => c.LastRunAt ?? DateTimeOffset.MinValue),
        ];
    }

    // rotation matters: most providers invalidate the bundle used, so keeping the original reports a self-inflicted
    // provider_changed, which degrades the provider for every real user
    public async Task RecordAsync(
        string providerId, string? jobId, bool intact, string verdict, string? rotatedBundle, CancellationToken ct)
    {
        var row = await db.Canaries.FirstOrDefaultAsync(c => c.ProviderId == providerId, ct);
        if (row is null) return;

        row.LastRunAt = time.GetUtcNow();
        row.LastJobId = jobId;
        row.LastIntact = intact;

        // truncated to the column: a provider's refusal can be long
        row.LastVerdict = verdict.Length > 512 ? verdict[..512] : verdict;

        if (!string.IsNullOrWhiteSpace(rotatedBundle)) row.Bundle = rotatedBundle;

        await db.SaveChangesAsync(ct);
    }
}
