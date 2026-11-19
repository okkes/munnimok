using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;

namespace Munni.Api.Sync;

/// #653 repair: the catalog gave groceries a main of their own ("grocery") and renamed "consumption" to eating out.
/// Ids that only moved keep the rows filed under them. Once per database, for what is left:
/// (1) a sub the catalog merged into another is replaced wherever a row names it — the app does the same for what a
/// device still holds (apps/web/src/application/categoryMoves.ts);
/// (2) a budget, a plan subject and a trend graph that listed the old main as a whole keep counting the two subs that
/// left it, and a space that hid the old main hides the new one too — nothing changes what it counts.
/// Each field is stamped right behind the value it replaces, so a later write of a device keeps its say
public static class CategoryMoves
{
    public const string SettingKey = "repair:category-moves:2026-11-19";
    private const string OldMain = "consumption";
    private const string NewMain = "grocery";
    private const string CatIds = "catIds";
    private const string ExcludeCatIds = "excludeCatIds";
    private const string HiddenMains = "hiddenMains";
    private const string TrendGraphs = "trendGraphs";
    private const string Budget = "budget";
    private const string PlanSubject = "planSubject";
    private const string SpaceEntity = "space";

    private static readonly Dictionary<string, string> Merged = new(StringComparer.Ordinal) { ["softDrinks"] = "coffee" };
    /// the subs that were under the old main and are under the new one
    private static readonly string[] LeftOldMain = ["groceries", "tobacco"];
    private static readonly string[] Entities = ["transaction", "txMeta", "recurring", Budget, PlanSubject, SpaceEntity, "receipt", "receiptLink"];
    private static readonly string[] Listing = [Budget, PlanSubject, SpaceEntity];
    /// the fields that name categories: nothing else of a row is read or rewritten
    private static readonly string[] Fields = ["catId", "cats", "splits", CatIds, ExcludeCatIds, TrendGraphs, HiddenMains, "items", "picks"];
    private static readonly string[] IdLists = [CatIds, ExcludeCatIds, HiddenMains];
    private static readonly string MergedMark = "\"softDrinks\"";
    private static readonly string OldMainMark = $"\"{OldMain}\"";

    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var rows = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{rows} rows at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("category-moves repair: {Rows} row(s) follow the catalog's new groceries main", rows);
        }
        return rows;
    }

    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var spaceIds = await db.EntityRows.AsNoTracking()
            .Where(r => !r.Deleted && Entities.Contains(r.Entity)
                && (r.DataJson.Contains(MergedMark) || (Listing.Contains(r.Entity) && r.DataJson.Contains(OldMainMark))))
            .Select(r => r.SpaceId)
            .Distinct()
            .ToListAsync(ct);
        var rows = 0;
        foreach (var spaceId in spaceIds) rows += await RepairSpaceAsync(db, spaceId, ct);
        return rows;
    }

    public static async Task<int> RepairSpaceAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([spaceId], ct);
        if (space is null) return 0;
        var rows = await db.EntityRows
            .Where(r => r.SpaceId == spaceId && !r.Deleted && Entities.Contains(r.Entity)
                && (r.DataJson.Contains(MergedMark) || (Listing.Contains(r.Entity) && r.DataJson.Contains(OldMainMark))))
            .ToListAsync(ct);
        // who lists what, read before anything moves: a sub another budget (or another subject of the plan) names is that one's
        var listed = await ListedAsync(db, spaceId, ct);
        var ops = new List<SyncOpDto>();
        var changed = 0;
        foreach (var row in rows)
        {
            var rowOps = OpsFor(row, listed);
            if (rowOps.Count == 0) continue;
            ops.AddRange(rowOps);
            changed++;
        }
        if (ops.Count == 0) return 0;
        var (_, accepted) = await new SyncWriter(db).ApplyAsync(space, null, ops);
        await db.SaveChangesAsync(ct);
        // an op the space already holds moved nothing: a field a device rewrote since is asked about again, and left
        return accepted == 0 ? 0 : changed;
    }

    /// per budget and per plan subject: the category ids it lists, keyed by the row's id; a subject also by its plan
    private sealed record Listed(Dictionary<string, HashSet<string>> Budgets, Dictionary<string, (string PlanId, HashSet<string> Ids)> Subjects);

    private static async Task<Listed> ListedAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        var rows = await db.EntityRows.AsNoTracking()
            .Where(r => r.SpaceId == spaceId && !r.Deleted && (r.Entity == Budget || r.Entity == PlanSubject))
            .Select(r => new { r.Entity, r.EntityId, r.DataJson })
            .ToListAsync(ct);
        var budgets = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var subjects = new Dictionary<string, (string, HashSet<string>)>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            var data = JsonNode.Parse(row.DataJson) as JsonObject ?? new JsonObject();
            var ids = Ids(data[CatIds]).ToHashSet(StringComparer.Ordinal);
            if (row.Entity == Budget) budgets[row.EntityId] = ids;
            else subjects[row.EntityId] = (data["planId"]?.GetValue<string>() ?? "", ids);
        }
        return new Listed(budgets, subjects);
    }

    private static IEnumerable<string> Ids(JsonNode? node) =>
        node is JsonArray list ? list.Select(id => id is JsonValue value && value.TryGetValue<string>(out var text) ? text : null).OfType<string>() : [];

    private static List<SyncOpDto> OpsFor(EntityRow row, Listed listed)
    {
        var data = JsonNode.Parse(row.DataJson) as JsonObject ?? new JsonObject();
        var stamps = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
        var ops = new List<SyncOpDto>();
        foreach (var field in Fields)
        {
            if (data[field] is not { } before || !stamps.TryGetValue(field, out var stamp) || stamp.Length == 0) continue;
            var after = before.DeepClone();
            Merge(field, ref after);
            Cover(row, field, data, ref after, listed);
            if (JsonNode.DeepEquals(before, after)) continue;
            ops.Add(new SyncOpDto(
                ImportIds.OpId($"repair:category-moves:{row.SpaceId}:{row.Entity}:{row.EntityId}:{field}"),
                row.SpaceId,
                row.Entity,
                row.EntityId,
                new Dictionary<string, JsonElement> { [field] = JsonSerializer.SerializeToElement(after) },
                Behind(stamp)));
        }
        return ops;
    }

    /// the stamp right behind another: it replaces exactly the value that stamp wrote and loses to every later write
    private static string Behind(string stamp) => stamp + "~";

    /// (1) a merged id is replaced: as a "catId" value anywhere in the field, and as an entry of a list of ids
    private static void Merge(string field, ref JsonNode node)
    {
        if (IdLists.Contains(field)) node = MovedList(node);
        else if (field == "catId") node = Moved(node);
        else Walk(node);
    }

    private static JsonNode Moved(JsonNode node) =>
        node is JsonValue value && value.TryGetValue<string>(out var id) && Merged.TryGetValue(id, out var to) ? JsonValue.Create(to) : node;

    private static JsonNode MovedList(JsonNode node)
    {
        if (node is not JsonArray) return node;
        var ids = Ids(node).ToList();
        if (!ids.Exists(Merged.ContainsKey)) return node;
        return ToArray(ids.Select(id => Merged.GetValueOrDefault(id, id)).Distinct(StringComparer.Ordinal));
    }

    private static JsonArray ToArray(IEnumerable<string> ids) => new([.. ids.Select(id => (JsonNode?)JsonValue.Create(id))]);

    private static void Walk(JsonNode node)
    {
        if (node is JsonArray list)
        {
            foreach (var item in list.OfType<JsonNode>()) Walk(item);
            return;
        }
        if (node is not JsonObject bag) return;
        foreach (var (key, value) in bag.Where(pair => pair.Value is not null).Select(pair => (pair.Key, pair.Value!)).ToList())
        {
            if (key != "catId" && key != CatIds)
            {
                Walk(value);
                continue;
            }
            var moved = key == CatIds ? MovedList(value) : Moved(value);
            // a node that stays where it is cannot be assigned again: only a new one goes in
            if (!ReferenceEquals(moved, value)) bag[key] = moved;
        }
    }

    /// (2) what listed the old main as a whole keeps the subs that left it
    private static void Cover(EntityRow row, string field, JsonObject data, ref JsonNode node, Listed listed)
    {
        node = (row.Entity, field) switch
        {
            (Budget, CatIds) => Covered(node, id => listed.Budgets.Any(b => b.Key != row.EntityId && b.Value.Contains(id))),
            (PlanSubject, CatIds) => CoveredSubject(row, data, node, listed),
            (SpaceEntity, HiddenMains) => WithAll(node, [NewMain]),
            (SpaceEntity, TrendGraphs) => CoveredGraphs(node),
            _ => node,
        };
    }

    /// a subject keeps what it counted: not what it left out, and not what another subject of its plan names
    private static JsonNode CoveredSubject(EntityRow row, JsonObject data, JsonNode node, Listed listed)
    {
        var planId = listed.Subjects.GetValueOrDefault(row.EntityId).PlanId;
        var excluded = Ids(data[ExcludeCatIds]).ToHashSet(StringComparer.Ordinal);
        return Covered(node, id => excluded.Contains(id)
            || listed.Subjects.Any(s => s.Key != row.EntityId && s.Value.PlanId == planId && s.Value.Ids.Contains(id)));
    }

    private static JsonNode CoveredGraphs(JsonNode node)
    {
        foreach (var graph in (node as JsonArray ?? []).OfType<JsonObject>())
        {
            if (graph[CatIds] is not { } ids) continue;
            var covered = Covered(ids, _ => false);
            if (!ReferenceEquals(covered, ids)) graph[CatIds] = covered;
        }
        return node;
    }

    private static JsonNode Covered(JsonNode node, Func<string, bool> taken)
    {
        var ids = Ids(node).ToList();
        if (!ids.Contains(OldMain) || ids.Contains(NewMain)) return node;
        return WithAll(node, LeftOldMain.Where(id => !taken(id)));
    }

    private static JsonNode WithAll(JsonNode node, IEnumerable<string> more)
    {
        var ids = Ids(node).ToList();
        if (!ids.Contains(OldMain)) return node;
        var missing = more.Where(id => !ids.Contains(id)).ToList();
        return missing.Count == 0 ? node : ToArray(ids.Concat(missing));
    }
}
