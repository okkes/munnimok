using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;

namespace Munni.Api.Sync;

/// 2026-10-09 repair: the prediction overlay marked a row reviewed (needsReview 0) when keyword rules knew the merchant
/// rule now: every fetched row waits in the review with its prediction prefilled; only the person takes it out
/// puts back, once, rows whose 0 carries only the server's stamp, with no device op ever carrying the field
public static class NeedsReviewRepair
{
    public const string SettingKey = "repair:needs-review:2026-10-09";
    private const string Entity = "txMeta";
    private const string Field = "needsReview";
    private const string ReviewedMark = "\"needsReview\":0";
    private const string FieldMark = "\"needsReview\"";
    private static readonly string ServerSuffix = $"-{ServerHlc.DeviceId}";

    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var repaired = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{repaired} rows at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("needs-review repair: {Rows} predicted row(s) put back to the review", repaired);
        }
        return repaired;
    }

    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var spaceIds = await db.EntityRows
            .Where(r => r.Entity == Entity && !r.Deleted && r.DataJson.Contains(ReviewedMark) && r.FieldVersionsJson.Contains(ServerSuffix))
            .Select(r => r.SpaceId)
            .Distinct()
            .ToListAsync(ct);
        var repaired = 0;
        foreach (var spaceId in spaceIds) repaired += await RepairSpaceAsync(db, spaceId, ct);
        return repaired;
    }

    public static async Task<int> RepairSpaceAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([spaceId], ct);
        if (space is null) return 0;
        var repairs = await RepairsForAsync(db, spaceId, ct);
        if (repairs.Count == 0) return 0;
        var (_, accepted) = await new SyncWriter(db).ApplyAsync(space, null, repairs);
        await db.SaveChangesAsync(ct);
        return accepted;
    }

    private static async Task<List<SyncOpDto>> RepairsForAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        var rows = await db.EntityRows
            .Where(r => r.SpaceId == spaceId && r.Entity == Entity && !r.Deleted && r.DataJson.Contains(ReviewedMark))
            .ToListAsync(ct);
        // a device that ever carried the flag has spoken: its opinion, whatever it was, stands
        var carried = await db.SyncOps
            .Where(o => o.SpaceId == spaceId && o.Entity == Entity && o.PayloadJson.Contains(FieldMark))
            .Select(o => new { o.EntityId, o.Hlc })
            .ToListAsync(ct);
        var spoken = carried
            .Where(o => !o.Hlc.EndsWith(ServerSuffix, StringComparison.Ordinal))
            .Select(o => o.EntityId)
            .ToHashSet(StringComparer.Ordinal);
        var repairs = new List<SyncOpDto>();
        foreach (var row in rows)
        {
            if (spoken.Contains(row.EntityId) || !ReviewedByPrediction(row)) continue;
            repairs.Add(new SyncOpDto(
                ImportIds.OpId($"repair:needs-review:{spaceId}:{row.EntityId}"),
                spaceId,
                Entity,
                row.EntityId,
                new Dictionary<string, JsonElement> { [Field] = JsonSerializer.SerializeToElement(1) },
                ServerHlc.Now(repairs.Count)));
        }
        return repairs;
    }

    private static bool ReviewedByPrediction(EntityRow row)
    {
        var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.DataJson) ?? new();
        if (!data.TryGetValue(Field, out var value) || value.ValueKind != JsonValueKind.Number || value.GetInt32() != 0) return false;
        var versions = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
        return versions.TryGetValue(Field, out var version) && version.EndsWith(ServerSuffix, StringComparison.Ordinal);
    }
}
