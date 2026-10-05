using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;

namespace Munni.Api.Sync;

/// <summary>
/// The 2026-10-05 repair: the connector ingest's prediction overlay used to
/// carry the server's current clock, so the first overlay the NEW scheme
/// wrote for a (space, transaction) pair outranked every opinion a device
/// had already filed there — the open-banking retirement (#414) renamed
/// the overlay's op id, and the next full fetch re-overlaid a whole
/// account's history over a person's categorisations. The overlay is a
/// floor now (<see cref="ServerHlc.Floor"/>); this puts back what the
/// floor would have left alone: for every overlay field the server's
/// clock still holds, the latest value any device ever filed for it.
/// </summary>
public static class TxMetaOverlayRepair
{
    public const string SettingKey = "repair:txmeta-overlay:2026-10-05";
    private const string Entity = "txMeta";
    private static readonly string[] OverlayFields = ["catId", "txType", "needsReview"];
    private static readonly string ServerSuffix = $"-{ServerHlc.DeviceId}";

    /// <summary>Runs the repair once per database (an app setting remembers it); returns how many rows it put back.</summary>
    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var repaired = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{repaired} rows at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("txMeta overlay repair: {Rows} row(s) put back to the device's value", repaired);
        }
        return repaired;
    }

    /// <summary>The repair itself, idempotent by op id: every row whose overlay field buried a device's value gets that value back.</summary>
    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var spaceIds = await db.EntityRows
            .Where(r => r.Entity == Entity && !r.Deleted && r.FieldVersionsJson.Contains(ServerSuffix))
            .Select(r => r.SpaceId)
            .Distinct()
            .ToListAsync(ct);
        var repaired = 0;
        var counter = 0;
        foreach (var spaceId in spaceIds)
        {
            var space = await db.Spaces.FindAsync([spaceId], ct);
            if (space is null) continue;
            var repairs = await RepairsForAsync(db, spaceId, counter, ct);
            counter += repairs.Count;
            if (repairs.Count == 0) continue;
            var (_, accepted) = await new SyncWriter(db).ApplyAsync(space, null, repairs);
            await db.SaveChangesAsync(ct);
            repaired += accepted;
        }
        return repaired;
    }

    /// <summary>One space's repair ops: every txMeta row whose overlay field buried a device value, stamped from <paramref name="counter"/> on.</summary>
    private static async Task<List<SyncOpDto>> RepairsForAsync(AppDbContext db, string spaceId, int counter, CancellationToken ct)
    {
        var rows = await db.EntityRows.Where(r => r.SpaceId == spaceId && r.Entity == Entity && !r.Deleted).ToListAsync(ct);
        var ops = await db.SyncOps.Where(o => o.SpaceId == spaceId && o.Entity == Entity).OrderBy(o => o.Seq).ToListAsync(ct);
        var history = ops
            .Where(o => !o.Hlc.EndsWith(ServerSuffix, StringComparison.Ordinal))
            .Select(o => new Recorded(o.EntityId, JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(o.PayloadJson) ?? new()))
            .GroupBy(r => r.EntityId)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var repairs = new List<SyncOpDto>();
        foreach (var row in rows)
        {
            if (!history.TryGetValue(row.EntityId, out var devices)) continue;
            var restore = Restore(row, devices);
            if (restore.Count == 0) continue;
            repairs.Add(new SyncOpDto(
                ImportIds.OpId($"repair:txmeta-overlay:{spaceId}:{row.EntityId}"), spaceId, Entity, row.EntityId, restore, ServerHlc.Now(counter + repairs.Count)));
        }
        return repairs;
    }

    /// <summary>One device op's payload, in arrival order.</summary>
    private sealed record Recorded(string EntityId, Dictionary<string, JsonElement> Fields);

    /// <summary>
    /// What to put back on one row: for each overlay field the server's
    /// clock still holds, the value of the LAST device op that ever carried
    /// it — an opinion, whenever it was formed, outranks a prediction; a
    /// device op the overlay beat on the clock alone is still the person's
    /// latest word.
    /// </summary>
    private static Dictionary<string, JsonElement> Restore(EntityRow row, List<Recorded> devices)
    {
        var versions = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
        var restore = new Dictionary<string, JsonElement>();
        foreach (var field in OverlayFields)
        {
            if (!versions.TryGetValue(field, out var version) || !version.EndsWith(ServerSuffix, StringComparison.Ordinal)) continue;
            var device = devices.LastOrDefault(r => r.Fields.ContainsKey(field));
            if (device is null) continue;
            restore[field] = device.Fields[field];
        }
        return restore;
    }
}
