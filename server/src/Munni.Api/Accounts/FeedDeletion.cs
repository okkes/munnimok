using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Accounts;

public sealed record FeedDeletionResult(bool Erased);

/// ruling: revoke MINE only. My bank consent always goes; the raw feed and every space's overlays are erased
/// only when no one else covers the account (family accounts share one feed).
/// Consent first, so a scheduled fetch cannot resurrect rows mid-delete.
public static class FeedDeletion
{
    public static async Task<IResult> DeleteFeedAccount(string feedSpaceId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var feed = await db.FeedSpaces.FindAsync(feedSpaceId);
        if (feed is null) return Results.NotFound();

        // #240: attachments whose mirror the space tombstoned are dead: dropped BEFORE judging who else uses it,
        // or a mis-stamped AttachedBy keeps an orphan undeletable
        await FeedJanitor.RemoveDeadAttachmentsAsync(db, feedSpaceId);
        var coOwner = await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedSpaceId && o.UserId == me);

        // deleting is for accounts you brought in: your feed or your co-ownership (#240)
        if (feed.OwnerUserId != me && !coOwner) return Results.Forbid();

        // 1: my consent first, so fetches stop and nothing resurrects; the session ends at the party with its last account (§15)
        if (http.RequestServices.GetService<Connectors.ConnectorDisconnector>() is { } connectors)
        {
            await connectors.DisconnectFeedAsync(me, feedSpaceId, http.RequestAborted);
        }

        var otherCoOwner = await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedSpaceId && o.UserId != me);
        var otherAttachment = await db.SpaceAccountLinks.AnyAsync(l => l.FeedSpaceId == feedSpaceId && l.AttachedBy != me);
        var otherOwner = feed.OwnerUserId != me && await db.SpaceMembers.AnyAsync(m => m.UserId == feed.OwnerUserId);
        if (otherCoOwner || otherAttachment || otherOwner)
        {
            await RemoveMyViewAsync(db, feed, me);
            await db.SaveChangesAsync();
            return Results.Ok(new FeedDeletionResult(false));
        }

        // 3: full erasure; a recorded owner with no living presence (a deleted test identity) no longer blocks it (#240)
        await EraseFeedAsync(db, feed);
        await db.SaveChangesAsync();
        return Results.Ok(new FeedDeletionResult(true));
    }

    /// ownership follows a remaining coverer so they can attach
    private static async Task RemoveMyViewAsync(AppDbContext db, FeedSpace feed, Guid me)
    {
        var myLinks = await db.SpaceAccountLinks
            .Where(l => l.FeedSpaceId == feed.Id && l.AttachedBy == me)
            .ToListAsync();
        db.SpaceAccountLinks.RemoveRange(myLinks);
        db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == me).ToListAsync());
        await WriteDeletionOpsAsync(db, myLinks.Select(l => l.SpaceId).Distinct().ToList(), feed.Id, txIds: null);
        if (feed.OwnerUserId == me)
        {
            // a co-owner is the natural successor; attachers keep their old place in line
            var successor = (await db.FeedOwners.FirstOrDefaultAsync(o => o.FeedSpaceId == feed.Id && o.UserId != me))?.UserId
                ?? (await db.SpaceAccountLinks.FirstOrDefaultAsync(l => l.FeedSpaceId == feed.Id && l.AttachedBy != me))?.AttachedBy;
            if (successor is Guid next)
            {
                feed.OwnerUserId = next;
                db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == next).ToListAsync());
            }
        }
    }

    /// the per-space overlays are NOT in the feed space and no other path cleans them: erased first
    private static async Task EraseFeedAsync(AppDbContext db, FeedSpace feed)
    {
        var feedSpaceId = feed.Id;
        var txIds = await db.EntityRows
            .Where(r => r.SpaceId == feedSpaceId && r.Entity == "transaction")
            .Select(r => r.EntityId)
            .ToListAsync();
        var viewingSpaceIds = await db.SpaceAccountLinks
            .Where(l => l.FeedSpaceId == feedSpaceId)
            .Select(l => l.SpaceId)
            .Distinct()
            .ToListAsync();
        await WriteDeletionOpsAsync(db, viewingSpaceIds, feedSpaceId, txIds);
        db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.FeedSpaceId == feedSpaceId).ToListAsync());
        await StoreLinkEndpoints.RemoveForFeedAsync(db, feedSpaceId);
        db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feedSpaceId).ToListAsync());

        db.EntityRows.RemoveRange(await db.EntityRows.Where(r => r.SpaceId == feedSpaceId).ToListAsync());
        db.SyncOps.RemoveRange(await db.SyncOps.Where(o => o.SpaceId == feedSpaceId).ToListAsync());
        db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == feedSpaceId).ToListAsync());
        var space = await db.Spaces.FindAsync(feedSpaceId);
        if (space is not null) db.Spaces.Remove(space);
        db.FeedSpaces.Remove(feed);
    }

    /// deletes must travel the oplog, or other devices revive the rows
    private static async Task WriteDeletionOpsAsync(AppDbContext db, List<string> spaceIds, string feedSpaceId, List<string>? txIds)
    {
        var writer = new SyncWriter(db);
        foreach (var spaceId in spaceIds)
        {
            var space = await db.Spaces.FindAsync(spaceId);
            if (space is null) continue;
            var counter = 0;
            var ops = new List<SyncOpDto>
            {
                DeleteOp(spaceId, "accountLink", ImportIds.AccountLinkId(spaceId, feedSpaceId), counter++),
            };
            foreach (var txId in txIds ?? [])
                ops.Add(DeleteOp(spaceId, "txMeta", ImportIds.TxMetaId(spaceId, txId), counter++));
            await writer.ApplyAsync(space, null, ops);
        }
    }

    private static SyncOpDto DeleteOp(string spaceId, string entity, string entityId, int counter) => new(
        ImportIds.OpId($"feeddel:{spaceId}:{entityId}"),
        spaceId,
        entity,
        entityId,
        new Dictionary<string, JsonElement>(),
        ServerHlc.Now(counter),
        Deleted: true);
}
