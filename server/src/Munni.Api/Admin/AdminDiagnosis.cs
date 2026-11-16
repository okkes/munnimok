using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Admin;

public sealed record AdminSpaceDto(string Id, string? Name, string Role, bool Feed);

public sealed record AdminSpaceRefDto(string Id, string? Name);

public sealed record AdminFeedDto(string FeedSpaceId, long MaxSeq, DateTimeOffset? LastOpAt = null, List<AdminSpaceRefDto>? AttachedTo = null);

/// <summary>The IBAN as its tail only, never the whole.</summary>
public sealed record AdminAttachmentDto(
    string SpaceId,
    string FeedSpaceId,
    string AccountId,
    string? SpaceName = null,
    string? AccountName = null,
    string? IbanTail = null,
    string? AttachedByName = null,
    bool Archived = false);

public sealed record AdminUserDiagnosisDto(
    Guid UserId,
    List<string> MemberSpaces,
    List<AdminFeedDto> OwnedFeeds,
    List<AdminAttachmentDto> Attachments,
    /// <summary>#367: ids and state, never a bundle.</summary>
    List<AdminConnectorSessionDetailDto>? ConnectorSessions = null,
    List<AdminSpaceDto>? Spaces = null);

// the server never interprets the app's entities, but may READ a name off a materialized row to label a line;
// an unreadable row leaves the label null
public static class AdminDiagnosis
{
    private const string SpaceEntity = "space";
    private const string AccountEntity = "account";

    public static async Task<AdminUserDiagnosisDto> BuildAsync(AppDbContext db, User user)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(user);
        var memberships = await db.SpaceMembers.Where(m => m.UserId == user.Id).Select(m => new { m.SpaceId, m.Role }).ToListAsync();
        var memberSpaces = memberships.Select(m => m.SpaceId).ToList();
        var feedIds = (await db.FeedSpaces.Where(f => memberSpaces.Contains(f.Id)).Select(f => f.Id).ToListAsync()).ToHashSet();
        var spaceNames = await SpaceNamesAsync(db, memberSpaces);
        var spaces = memberships
            .Select(m => new AdminSpaceDto(m.SpaceId, spaceNames.GetValueOrDefault(m.SpaceId), m.Role, feedIds.Contains(m.SpaceId)))
            .ToList();

        var ownedFeedIds = await db.FeedSpaces.Where(f => f.OwnerUserId == user.Id).Select(f => f.Id).ToListAsync();
        var links = await db.SpaceAccountLinks
            .Where(l => memberSpaces.Contains(l.SpaceId) || ownedFeedIds.Contains(l.FeedSpaceId))
            .ToListAsync();
        // the spaces a feed reaches may be ones the owner is not in (shared by a co-owner): name those too
        var linkedSpaceIds = links.Select(l => l.SpaceId).Where(id => !spaceNames.ContainsKey(id)).Distinct().ToList();
        foreach (var (id, name) in await SpaceNamesAsync(db, linkedSpaceIds)) spaceNames[id] = name;

        return new AdminUserDiagnosisDto(
            user.Id,
            memberSpaces,
            await FeedsAsync(db, ownedFeedIds, links, spaceNames),
            await AttachmentsAsync(db, links.Where(l => memberSpaces.Contains(l.SpaceId)).ToList(), spaceNames),
            await AdminBankConnectionEndpoints.SessionsOfAsync(db, user.Id),
            spaces);
    }

    private static async Task<List<AdminFeedDto>> FeedsAsync(AppDbContext db, List<string> ownedFeedIds, List<Accounts.SpaceAccountLink> links, Dictionary<string, string?> spaceNames)
    {
        var ops = await db.SyncOps
            .Where(o => ownedFeedIds.Contains(o.SpaceId))
            .GroupBy(o => o.SpaceId)
            .Select(g => new { g.Key, Max = g.Max(o => o.Seq), Last = g.Max(o => o.ReceivedAt) })
            .ToDictionaryAsync(g => g.Key, g => (g.Max, g.Last));
        return ownedFeedIds
            .Select(id =>
            {
                var attached = links
                    .Where(l => l.FeedSpaceId == id)
                    .Select(l => l.SpaceId)
                    .Distinct()
                    .Select(spaceId => new AdminSpaceRefDto(spaceId, spaceNames.GetValueOrDefault(spaceId)))
                    .ToList();
                var (max, last) = ops.GetValueOrDefault(id);
                return new AdminFeedDto(id, max, last == default ? null : last, attached);
            })
            .ToList();
    }

    private static async Task<List<AdminAttachmentDto>> AttachmentsAsync(AppDbContext db, List<Accounts.SpaceAccountLink> links, Dictionary<string, string?> spaceNames)
    {
        var feedIds = links.Select(l => l.FeedSpaceId).Distinct().ToList();
        var accountIds = links.Select(l => l.AccountId).Distinct().ToList();
        var accounts = (await db.EntityRows
                .Where(r => r.Entity == AccountEntity && feedIds.Contains(r.SpaceId) && accountIds.Contains(r.EntityId))
                .Select(r => new { r.SpaceId, r.EntityId, r.DataJson })
                .ToListAsync())
            .ToDictionary(r => (r.SpaceId, r.EntityId), r => r.DataJson);
        var attacherIds = links.Select(l => l.AttachedBy).Distinct().ToList();
        var attachers = await db.Users.Where(u => attacherIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName ?? u.Email ?? u.Sub);
        return links
            .Select(l =>
            {
                var account = accounts.GetValueOrDefault((l.FeedSpaceId, l.AccountId));
                return new AdminAttachmentDto(
                    l.SpaceId, l.FeedSpaceId, l.AccountId,
                    spaceNames.GetValueOrDefault(l.SpaceId),
                    Text(account, "name"),
                    IbanTail(Text(account, "iban")),
                    attachers.GetValueOrDefault(l.AttachedBy),
                    l.Archived);
            })
            .ToList();
    }

    private static async Task<Dictionary<string, string?>> SpaceNamesAsync(AppDbContext db, List<string> spaceIds)
    {
        if (spaceIds.Count == 0) return [];
        var rows = await db.EntityRows
            .Where(r => r.Entity == SpaceEntity && spaceIds.Contains(r.SpaceId) && r.EntityId == r.SpaceId)
            .Select(r => new { r.SpaceId, r.DataJson })
            .ToListAsync();
        return rows.ToDictionary(r => r.SpaceId, r => Text(r.DataJson, "name"));
    }

    private static string? Text(string? dataJson, string field)
    {
        if (string.IsNullOrEmpty(dataJson)) return null;
        try
        {
            using var document = JsonDocument.Parse(dataJson);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(field, out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The last four characters — enough to tell accounts apart, never the account number.</summary>
    private static string? IbanTail(string? iban) =>
        string.IsNullOrWhiteSpace(iban) ? null : $"…{iban.Trim()[^Math.Min(4, iban.Trim().Length)..]}";
}
