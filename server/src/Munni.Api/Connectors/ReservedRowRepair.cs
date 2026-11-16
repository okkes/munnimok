using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

// #508: reserved rows nobody tracks stood beside their booked twins for good (a pass that became a job never settled;
// a superseded or disconnected connection); once per database they go to live references of the feed account,
// else tombstoned
public static class ReservedRowRepair
{
    public const string SettingKey = "repair:reserved-rows:2026-11-08";
    private const string Entity = "transaction";

    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(logger);
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var (adopted, tombstoned) = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{adopted} adopted, {tombstoned} tombstoned at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("reserved row repair: {Adopted} untracked reserved row(s) handed to a connection, {Tombstoned} tombstoned", adopted, tombstoned);
        }
        return tombstoned;
    }

    public static async Task<(int Adopted, int Tombstoned)> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(db);
        var rows = await db.EntityRows
            .Where(r => r.Entity == Entity && !r.Deleted && r.DataJson.Contains("\"pending\":1"))
            .Select(r => new { r.SpaceId, r.EntityId, r.DataJson })
            .ToListAsync(ct);
        if (rows.Count == 0) return (0, 0);
        var tracked = (await db.ConnectorPendingTxs.Select(p => p.EntityId).Distinct().ToListAsync(ct)).ToHashSet(StringComparer.Ordinal);
        var orphans = new List<PendingHandover.Reserved>();
        foreach (var row in rows.Where(r => !tracked.Contains(r.EntityId)))
        {
            var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.DataJson);
            if (data is null || !data.TryGetValue("accountId", out var account) || account.ValueKind != JsonValueKind.String) continue;
            orphans.Add(new PendingHandover.Reserved(row.SpaceId, account.GetString()!, row.EntityId));
        }
        if (orphans.Count == 0) return (0, 0);
        var tombstoned = await PendingHandover.AdoptOrSettleAsync(db, orphans, [], SettingKey, ct);
        return (orphans.Count - tombstoned, tombstoned);
    }
}
