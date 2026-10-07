using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

/// <summary>
/// The 2026-10-07 repair: rows whose id the connector derived once carried
/// the login session in that id, so every new ING sign-in re-keyed the
/// fetched window - the card's repayments, the loan and savings movements
/// landed a second time, identical in every fact. The adapter's seed is
/// stable now and <see cref="DerivedRowReconciler"/> catches the next
/// re-key; this takes the copies that are already there back out, once.
/// <para>
/// Per account, rows with a derived reference are grouped by their facts
/// (booked date, amount, currency, counterparty). A group is one real
/// transaction fetched several times, except that two identical payments
/// on one day are two rows: so the rows are clustered by the fetch that
/// wrote them (their birth stamps, two minutes apart or more), the oldest
/// cluster says how many are real, and only a later cluster LARGER than
/// that adds to the count. The surplus goes - the untouched copies first
/// (no pairing, no reimbursement, no category a device filed), the newest
/// first among equals - as ordinary tombstones every device pulls.
/// </para>
/// </summary>
public static class DerivedDuplicateRepair
{
    public const string SettingKey = "repair:derived-duplicates:2026-10-07";
    private const string Entity = "transaction";
    private static readonly string[] DerivedPrefixes = ["ing-d-"];
    private static readonly TimeSpan SameFetch = TimeSpan.FromMinutes(2);

    /// <summary>Runs once per database (an app setting remembers it); returns how many copies were tombstoned.</summary>
    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var removed = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{removed} rows at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("derived duplicate repair: {Rows} copied row(s) tombstoned", removed);
        }
        return removed;
    }

    /// <summary>The repair itself, idempotent by op id: every surplus copy of a derived row is tombstoned in its feed.</summary>
    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var feedIds = await db.EntityRows
            .Where(r => r.Entity == Entity && !r.Deleted && r.DataJson.Contains("\"importRef\":\"ing-d-"))
            .Select(r => r.SpaceId)
            .Distinct()
            .ToListAsync(ct);
        var removed = 0;
        var counter = 0;
        foreach (var feedId in feedIds)
        {
            var feed = await db.Spaces.FindAsync([feedId], ct);
            if (feed is null) continue;
            var surplus = await SurplusAsync(db, feedId, ct);
            if (surplus.Count == 0) continue;
            var ops = surplus
                .Select(id => new SyncOpDto(ImportIds.OpId($"repair:derived-dup:{feedId}:{id}"), feedId, Entity, id, new(), ServerHlc.Now(counter++), Deleted: true))
                .ToList();
            var (_, accepted) = await new SyncWriter(db).ApplyAsync(feed, null, ops);
            await db.SaveChangesAsync(ct);
            removed += accepted;
        }
        return removed;
    }

    /// <summary>One row as the repair weighs it. A tombstoned row still counts for the size of the fetch that wrote it, so a second pass changes nothing.</summary>
    private sealed record Copy(string Id, string AccountId, string Key, long BornMs, bool Deleted, int Touched);

    /// <summary>The ids in one feed that are copies of an older row.</summary>
    private static async Task<List<string>> SurplusAsync(AppDbContext db, string feedId, CancellationToken ct)
    {
        var rows = await db.EntityRows
            .Where(r => r.SpaceId == feedId && r.Entity == Entity)
            .Select(r => new { r.EntityId, r.DataJson, r.FieldVersionsJson, r.Deleted })
            .ToListAsync(ct);
        var copies = new List<Copy>();
        foreach (var row in rows)
        {
            var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.DataJson);
            if (data is null) continue;
            var reference = Text(data, "importRef");
            if (reference is null || !DerivedPrefixes.Any(p => reference.StartsWith(p, StringComparison.Ordinal))) continue;
            var accountId = Text(data, "accountId");
            var date = Text(data, "date");
            if (accountId is null || date is null || !data.TryGetValue("amountCents", out var cents) || cents.ValueKind != JsonValueKind.Number) continue;
            var versions = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
            var key = DerivedRowReconciler.Key(date, cents.GetInt64(), Text(data, "currency") ?? "EUR", Text(data, "merchant"));
            copies.Add(new Copy(row.EntityId, accountId, key, WallMs(versions.GetValueOrDefault("date")), row.Deleted, 0));
        }

        var surplus = new List<string>();
        var groups = copies.GroupBy(c => (c.AccountId, c.Key)).Where(g => g.Count(c => !c.Deleted) > 1).ToList();
        if (groups.Count == 0) return surplus;

        // what the attached spaces say about each row: a pairing, a reimbursement, a category a person filed
        var touchedById = await TouchedAsync(db, feedId, groups.SelectMany(g => g).Where(c => !c.Deleted).Select(c => c.Id).ToList(), ct);
        foreach (var group in groups)
        {
            var ordered = group.Select(c => c with { Touched = touchedById.GetValueOrDefault(c.Id) }).OrderBy(c => c.BornMs).ToList();
            var keep = RealCount(ordered);
            var alive = ordered.Where(c => !c.Deleted).ToList();
            if (keep >= alive.Count) continue;
            // the copies to let go: the least touched first, the newest first among equals
            var drop = alive
                .OrderBy(c => c.Touched)
                .ThenByDescending(c => c.BornMs)
                .Take(alive.Count - keep)
                .Select(c => c.Id);
            surplus.AddRange(drop);
        }
        return surplus;
    }

    /// <summary>How many rows of a group are real: the oldest fetch's count, grown only by a later fetch that brought more than that.</summary>
    private static int RealCount(IReadOnlyList<Copy> ordered)
    {
        var keep = 0;
        var cluster = 0;
        long clusterStart = long.MinValue;
        foreach (var copy in ordered)
        {
            if (cluster > 0 && copy.BornMs - clusterStart > SameFetch.TotalMilliseconds)
            {
                keep = Math.Max(keep, cluster);
                cluster = 0;
            }
            if (cluster == 0) clusterStart = copy.BornMs;
            cluster++;
        }
        return Math.Max(keep, cluster);
    }

    /// <summary>A row's weight in the person's hands, summed over every space its account is attached to.</summary>
    private static async Task<Dictionary<string, int>> TouchedAsync(AppDbContext db, string feedId, List<string> ids, CancellationToken ct)
    {
        var spaceIds = await db.SpaceAccountLinks.Where(l => l.FeedSpaceId == feedId).Select(l => l.SpaceId).Distinct().ToListAsync(ct);
        var touched = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var spaceId in spaceIds)
        {
            var metaIds = ids.ToDictionary(id => ImportIds.TxMetaId(spaceId, id), id => id, StringComparer.Ordinal);
            var keys = metaIds.Keys.ToList();
            var metas = await db.EntityRows
                .Where(r => r.SpaceId == spaceId && r.Entity == "txMeta" && !r.Deleted && keys.Contains(r.EntityId))
                .Select(r => new { r.EntityId, r.DataJson, r.FieldVersionsJson })
                .ToListAsync(ct);
            foreach (var meta in metas)
            {
                var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(meta.DataJson) ?? new();
                var versions = JsonSerializer.Deserialize<Dictionary<string, string>>(meta.FieldVersionsJson) ?? new();
                var weight = 0;
                if (Text(data, "transferPeerId") is { Length: > 0 }) weight += 4;
                if (data.TryGetValue("reimbursements", out var reimb) && reimb.ValueKind == JsonValueKind.Array && reimb.GetArrayLength() > 0) weight += 4;
                if (data.ContainsKey("catId") && versions.TryGetValue("catId", out var catClock) && catClock != ServerHlc.Floor) weight += 2;
                if (Text(data, "linkedAccountId") is { Length: > 0 }) weight += 1;
                var id = metaIds[meta.EntityId];
                touched[id] = touched.GetValueOrDefault(id) + weight;
            }
        }
        return touched;
    }

    /// <summary>The wall-clock milliseconds inside a stamp (its first, base36 part), or 0 when there is none.</summary>
    internal static long WallMs(string? hlc)
    {
        if (string.IsNullOrEmpty(hlc)) return 0;
        var dash = hlc.IndexOf('-', StringComparison.Ordinal);
        var part = dash < 0 ? hlc : hlc[..dash];
        long value = 0;
        foreach (var c in part)
        {
            var digit = c switch
            {
                >= '0' and <= '9' => c - '0',
                >= 'a' and <= 'z' => c - 'a' + 10,
                >= 'A' and <= 'Z' => c - 'A' + 10,
                _ => -1,
            };
            if (digit < 0) return 0;
            value = value * 36 + digit;
        }
        return value;
    }

    private static string? Text(Dictionary<string, JsonElement> data, string field) =>
        data.TryGetValue(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
