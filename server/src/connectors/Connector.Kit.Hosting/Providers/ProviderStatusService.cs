using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Logging;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Providers;

/// the kill switch: paused stops new work for every user within one lease poll,
/// so a consumer can say so instead of showing a spinner
public sealed class ProviderStatusService(
    ConnectorDbContext db,
    IProviderRegistry registry,
    TimeProvider time,
    ILogger<ProviderStatusService> logger)
{
    public static ProviderStatus ToStatus(ProviderStatusRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        return new ProviderStatus
        {
            ProviderId = row.ProviderId,
            State = row.State,
            Since = row.Since,
            ReasonKey = row.ReasonKey,
        };
    }

    public async Task<IReadOnlyDictionary<string, ProviderStatus>> AllAsync(CancellationToken ct)
    {
        var rows = await db.ProviderStatuses.AsNoTracking().ToListAsync(ct);
        var byId = rows.ToDictionary(r => r.ProviderId, ToStatus, StringComparer.Ordinal);

        // no row means never an incident: reported healthy; the registry decides existence, this table only health
        var now = time.GetUtcNow();
        foreach (var providerId in registry.Manifests.Select(m => m.Id).Where(id => !byId.ContainsKey(id)))
        {
            byId[providerId] = ProviderStatus.Healthy(providerId, now);
        }

        return byId;
    }

    public async Task<ProviderStatus> GetAsync(string providerId, CancellationToken ct)
    {
        var row = await db.ProviderStatuses.AsNoTracking().FirstOrDefaultAsync(r => r.ProviderId == providerId, ct);
        return row is null ? ProviderStatus.Healthy(providerId, time.GetUtcNow()) : ToStatus(row);
    }

    public async Task<ProviderStatus> SetAsync(string providerId, ProviderState state, string? reasonKey, CancellationToken ct)
    {
        var manifest = registry.RequireManifest(providerId);
        var now = time.GetUtcNow();

        var row = await db.ProviderStatuses.FirstOrDefaultAsync(r => r.ProviderId == manifest.Id, ct);
        if (row is null)
        {
            row = new ProviderStatusRow { ProviderId = manifest.Id };
            db.ProviderStatuses.Add(row);
        }

        // Since moves only when the state does, or re-confirming a pause would reset the clock everyone reads
        if (row.State != state) row.Since = now;
        row.State = state;
        row.ReasonKey = reasonKey;

        await db.SaveChangesAsync(ct);
        logger.LogWarning("provider {Provider} is now {State} ({Reason})", manifest.Id, state, LogSafe.Line(reasonKey ?? "-"));
        return ToStatus(row);
    }

    /// never escalates past degraded: pausing is an operator's decision
    public async Task DegradeAsync(string providerId, string? reasonKey, CancellationToken ct)
    {
        var current = await GetAsync(providerId, ct);
        if (current.State != ProviderState.Healthy) return;

        await SetAsync(providerId, ProviderState.Degraded, reasonKey ?? "connect.provider.changed", ct);
    }

    /// only degraded recovers: paused and retired are operator decisions, and a drained job must not un-pause the kill switch
    public async Task RecoverAsync(string providerId, CancellationToken ct)
    {
        var current = await GetAsync(providerId, ct);
        if (current.State != ProviderState.Degraded) return;

        await SetAsync(providerId, ProviderState.Healthy, reasonKey: null, ct);
    }

    public async Task SeedAsync(CancellationToken ct)
    {
        var known = await db.ProviderStatuses.Select(r => r.ProviderId).ToListAsync(ct);
        var missing = registry.Manifests.Select(m => m.Id).Except(known, StringComparer.Ordinal).ToList();
        if (missing.Count == 0) return;

        var now = time.GetUtcNow();
        foreach (var providerId in missing)
        {
            db.ProviderStatuses.Add(new ProviderStatusRow
            {
                ProviderId = providerId,
                State = ProviderState.Healthy,
                Since = now,
            });
        }

        await db.SaveChangesAsync(ct);
    }
}
