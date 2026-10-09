using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Admin;

/// <summary>A space the user is in: its name where the space's own row is readable, the user's role, and whether it is really a bank feed.</summary>
public sealed record AdminSpaceDto(string Id, string? Name, string Role, bool Feed);

/// <summary>A space by id and name — where a feed's accounts are shown.</summary>
public sealed record AdminSpaceRefDto(string Id, string? Name);

/// <summary>An owned feed: the op high-water mark, when data last landed, and the spaces its accounts are attached to.</summary>
public sealed record AdminFeedDto(string FeedSpaceId, long MaxSeq, DateTimeOffset? LastOpAt = null, List<AdminSpaceRefDto>? AttachedTo = null);

/// <summary>An attachment, read for a human: the account's name and the tail of its IBAN (never the whole), the space's name, who attached it.</summary>
public sealed record AdminAttachmentDto(
    string SpaceId,
    string FeedSpaceId,
    string AccountId,
    string? SpaceName = null,
    string? AccountName = null,
    string? IbanTail = null,
    string? AttachedByName = null,
    bool Archived = false);

/// <summary>The whole account→app chain of one user (user 2026-10-09: "hard to understand" as bare ids — named and grouped now).</summary>
public sealed record AdminUserDiagnosisDto(
    Guid UserId,
    List<string> MemberSpaces,
    List<AdminFeedDto> OwnedFeeds,
    List<AdminAttachmentDto> Attachments,
    /// <summary>#367: the user's connector sessions as the relay binds them — ids and state, never a bundle;
    /// a bank's consent is one of them (§15)</summary>
    List<AdminConnectorSessionDetailDto>? ConnectorSessions = null,
    /// <summary>the member spaces, named and with the user's role — the ids above stay for anything that reads them</summary>
    List<AdminSpaceDto>? Spaces = null);

/// <summary>
/// The per-user sync-chain diagnosis: memberships, owned feeds (+ op
/// high-water mark and the spaces they reach), attachments, connector
/// sessions — diagnosing "the consent linked but the app shows nothing".
/// The server never interprets the app's entities, but it may READ a name
/// off a materialized row to label a line for the operator (user
/// 2026-10-09); a row it cannot read leaves the label null.
/// </summary>
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

    /// <summary>The names off the spaces' own materialized rows; null for a space whose row is not readable (a feed, an empty one).</summary>
    private static async Task<Dictionary<string, string?>> SpaceNamesAsync(AppDbContext db, List<string> spaceIds)
    {
        if (spaceIds.Count == 0) return [];
        var rows = await db.EntityRows
            .Where(r => r.Entity == SpaceEntity && spaceIds.Contains(r.SpaceId) && r.EntityId == r.SpaceId)
            .Select(r => new { r.SpaceId, r.DataJson })
            .ToListAsync();
        return rows.ToDictionary(r => r.SpaceId, r => Text(r.DataJson, "name"));
    }

    /// <summary>A string field off a materialized row's JSON, or null — a row that does not parse labels nothing and breaks nothing.</summary>
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
