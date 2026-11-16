using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Accounts;

/// feeds are never members' spaces: everyone but the owner derives READ through an attachment; writes stay
/// owner-only (raw bank truth has one author, every space's opinion lives in its own overlay rows)
public static class FeedAccess
{
    /// <summary>uuid version 5 = deterministic feed-shaped id (normal spaces are v7 or free-form).</summary>
    public static bool IsFeedShaped(string spaceId)
    {
        if (!Guid.TryParseExact(spaceId, "D", out _)) return false;
        return spaceId.Length == 36 && spaceId[14] == '5';
    }

    /// #240: the first owner or any co-owner (their own consent covered the account) edits, attaches and deletes as owner
    public static async Task<bool> IsFeedOwner(AppDbContext db, Guid userId, string feedSpaceId) =>
        await db.FeedSpaces.AnyAsync(f => f.Id == feedSpaceId && f.OwnerUserId == userId)
        || await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedSpaceId && o.UserId == userId);

    /// null: may not read; long.MaxValue: unlimited; else the archived-at cap (history stays, new data stops)
    public static async Task<long?> ReadCapAsync(AppDbContext db, Guid userId, string feedSpaceId)
    {
        if (await IsFeedOwner(db, userId, feedSpaceId)) return long.MaxValue;

        var mySpaceIds = db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId);
        var links = await db.SpaceAccountLinks
            .Where(l => l.FeedSpaceId == feedSpaceId && mySpaceIds.Contains(l.SpaceId))
            .ToListAsync();
        if (links.Count == 0) return null;
        if (links.Any(l => !l.Archived)) return long.MaxValue;
        return links.Max(l => l.ArchivedAtSeq ?? 0);
    }

    /// #569: every reachable feed in three queries, not three per feed (the sync round reads them all)
    public static async Task<Dictionary<string, long>> ReadCapsAsync(AppDbContext db, Guid userId)
    {
        var caps = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var owned in await db.FeedSpaces.Where(f => f.OwnerUserId == userId).Select(f => f.Id).ToListAsync())
            caps[owned] = long.MaxValue;
        foreach (var coOwned in await db.FeedOwners.Where(o => o.UserId == userId).Select(o => o.FeedSpaceId).ToListAsync())
            caps[coOwned] = long.MaxValue;

        var mySpaceIds = db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId);
        var links = await db.SpaceAccountLinks
            .Where(l => mySpaceIds.Contains(l.SpaceId))
            .Select(l => new { l.FeedSpaceId, l.Archived, l.ArchivedAtSeq })
            .ToListAsync();
        foreach (var feed in links.GroupBy(l => l.FeedSpaceId))
        {
            if (caps.ContainsKey(feed.Key)) continue;
            caps[feed.Key] = feed.Any(l => !l.Archived) ? long.MaxValue : feed.Max(l => l.ArchivedAtSeq ?? 0);
        }
        return caps;
    }

    public static async Task<List<string>> ReachableFeedsAsync(AppDbContext db, Guid userId)
    {
        var owned = await db.FeedSpaces.Where(f => f.OwnerUserId == userId).Select(f => f.Id).ToListAsync();
        var coOwned = await db.FeedOwners.Where(o => o.UserId == userId).Select(o => o.FeedSpaceId).ToListAsync();
        var mySpaceIds = db.SpaceMembers.Where(m => m.UserId == userId).Select(m => m.SpaceId);
        var attached = await db.SpaceAccountLinks
            .Where(l => mySpaceIds.Contains(l.SpaceId))
            .Select(l => l.FeedSpaceId)
            .Distinct()
            .ToListAsync();
        return owned.Union(coOwned).Union(attached).ToList();
    }
}
