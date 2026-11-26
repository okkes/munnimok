using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Accounts;

/// #536: an account whose party states what it is — a savings account, a card, a loan — is attached to a space as that
/// type and no other. The fetch stamps the party's word on the row (<c>partyType</c>); rows fetched before that carry
/// only the type they were seeded with, which was the party's word then. This writes it over once, so an account whose
/// connection never fetches again is covered too
public static class PartyTypeRepair
{
    public const string SettingKey = "repair:party-type:2026-11-26";
    private const string Entity = "account";
    private const string ConnectorMark = "\"source\":\"connector\"";
    private const string StampedMark = "\"partyType\"";

    /// the types a party states: a current account is left to the space (see <see cref="ConnectorIngest.StatedTypeOf"/>)
    private static readonly HashSet<string> Stated = new(StringComparer.Ordinal) { "savings", "credit", "loan", "mortgage" };

    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var stamped = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{stamped} accounts at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("party-type repair: {Accounts} fetched account(s) now say what their party calls them", stamped);
        }
        return stamped;
    }

    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var spaceIds = await db.EntityRows
            .Where(r => r.Entity == Entity && !r.Deleted && r.DataJson.Contains(ConnectorMark) && !r.DataJson.Contains(StampedMark))
            .Select(r => r.SpaceId)
            .Distinct()
            .ToListAsync(ct);
        var stamped = 0;
        foreach (var spaceId in spaceIds) stamped += await RepairSpaceAsync(db, spaceId, ct);
        return stamped;
    }

    public static async Task<int> RepairSpaceAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([spaceId], ct);
        if (space is null) return 0;
        var rows = await db.EntityRows
            .Where(r => r.SpaceId == spaceId && r.Entity == Entity && !r.Deleted && r.DataJson.Contains(ConnectorMark) && !r.DataJson.Contains(StampedMark))
            .ToListAsync(ct);
        var ops = new List<SyncOpDto>();
        foreach (var row in rows)
        {
            if (SeededType(row.DataJson) is not { } type) continue;
            ops.Add(new SyncOpDto(
                ImportIds.OpId($"repair:party-type:{spaceId}:{row.EntityId}"),
                spaceId,
                Entity,
                row.EntityId,
                new Dictionary<string, JsonElement> { [ConnectorIngest.PartyTypeField] = JsonSerializer.SerializeToElement(type) },
                ServerHlc.Now(ops.Count)));
        }
        if (ops.Count == 0) return 0;
        var (_, accepted) = await new SyncWriter(db).ApplyAsync(space, null, ops);
        await db.SaveChangesAsync(ct);
        return accepted;
    }

    /// <summary>The type a party states for an account, or null where the space decides.</summary>
    public static async Task<string?> StatedTypeAsync(AppDbContext db, string feedSpaceId, string accountId)
    {
        var json = await db.EntityRows
            .Where(r => r.SpaceId == feedSpaceId && r.Entity == Entity && r.EntityId == accountId && !r.Deleted)
            .Select(r => r.DataJson)
            .FirstOrDefaultAsync();
        if (json is null) return null;
        using var data = JsonDocument.Parse(json);
        return Text(data.RootElement, ConnectorIngest.PartyTypeField) is { } stated && AccountTypes.All.Contains(stated) ? stated : null;
    }

    // a row an open-banking connection feeds was typed by a guess; one of munni's own connectors typed it from the party's product
    private static string? SeededType(string dataJson)
    {
        using var data = JsonDocument.Parse(dataJson);
        var root = data.RootElement;
        if (Text(root, "source") != "connector") return null;
        if (Text(root, "provider") is not { } provider || ConnectorIngest.OpenBankingProviders.Contains(provider)) return null;
        return Text(root, "type") is { } type && Stated.Contains(type) ? type : null;
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
