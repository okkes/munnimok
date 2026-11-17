using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Accounts;

/// #240: attachments whose accountLink mirror the space tombstoned are dead; surviving (GC ingest stamped AttachedBy
/// with the feed owner) they kept the feed reachable as an unremovable orphan in no space. Dropping them lets
/// /me/spaces stop listing the feed, so clients purge their copy on the next sync.
public static class FeedJanitor
{
    public static async Task<int> RemoveDeadAttachmentsAsync(AppDbContext db, string? feedSpaceId = null, CancellationToken ct = default)
    {
        var links = await db.SpaceAccountLinks
            .Where(l => feedSpaceId == null || l.FeedSpaceId == feedSpaceId)
            .ToListAsync(ct);
        if (links.Count == 0) return 0;
        var mirrorIds = links.Select(l => ImportIds.AccountLinkId(l.SpaceId, l.FeedSpaceId)).Distinct().ToList();
        var dead = await db.EntityRows
            .Where(r => r.Entity == "accountLink" && r.Deleted && mirrorIds.Contains(r.EntityId))
            .Select(r => new { r.SpaceId, r.EntityId })
            .ToListAsync(ct);
        if (dead.Count == 0) return 0;
        var deadKeys = dead.Select(d => (d.SpaceId, d.EntityId)).ToHashSet();
        var doomed = links.Where(l => deadKeys.Contains((l.SpaceId, ImportIds.AccountLinkId(l.SpaceId, l.FeedSpaceId)))).ToList();
        if (doomed.Count == 0) return 0;
        db.SpaceAccountLinks.RemoveRange(doomed);
        await db.SaveChangesAsync(ct);
        return doomed.Count;
    }
}
