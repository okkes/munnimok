using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Accounts;

public sealed record FeedDeletionResult(bool Erased);

/// <summary>
/// User-initiated deletion of one financial account (= its feed).
/// Ruling (2026-07-20): revoke MINE only — the caller's bank consent
/// always goes, but the raw feed and every space's overlay data are
/// erased ONLY when no other user still covers the account (family
/// accounts share one feed; a surviving co-owner's own consent keeps
/// fetching it). Order mirrors Social.AccountDeletion: the party's
/// consent first, so a scheduled fetch can never resurrect the rows
/// mid-delete.
/// </summary>
public static class FeedDeletion
{
    public static async Task<IResult> DeleteFeedAccount(string feedSpaceId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var feed = await db.FeedSpaces.FindAsync(feedSpaceId);
        if (feed is null) return Results.NotFound();

        // #240 r3: attachments whose mirror the space already tombstoned
        // are dead weight — drop them BEFORE judging "who else uses it",
        // or a mis-stamped AttachedBy keeps an orphan undeletable forever
        await FeedJanitor.RemoveDeadAttachmentsAsync(db, feedSpaceId);
        var coOwner = await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedSpaceId && o.UserId == me);

        // deleting is for accounts you brought in: your feed or your
        // co-ownership (#240: your own consent proved the account)
        if (feed.OwnerUserId != me && !coOwner) return Results.Forbid();

        // 1 · my consent goes first (fetches stop; nothing resurrects): the
        //     account leaves the party's session — the session ends at the
        //     party when that was its last account (§15)
        if (http.RequestServices.GetService<Connectors.ConnectorDisconnector>() is { } connectors)
        {
            await connectors.DisconnectFeedAsync(me, feedSpaceId, http.RequestAborted);
        }

        // 2 · anyone ELSE still covering this account keeps the feed alive
        var otherCoOwner = await db.FeedOwners.AnyAsync(o => o.FeedSpaceId == feedSpaceId && o.UserId != me);
        var otherAttachment = await db.SpaceAccountLinks.AnyAsync(l => l.FeedSpaceId == feedSpaceId && l.AttachedBy != me);
        var otherOwner = feed.OwnerUserId != me && await db.SpaceMembers.AnyAsync(m => m.UserId == feed.OwnerUserId);
        if (otherCoOwner || otherAttachment || otherOwner)
        {
            await RemoveMyViewAsync(db, feed, me);
            await db.SaveChangesAsync();
            return Results.Ok(new FeedDeletionResult(false));
        }

        // 3 · full erasure — nobody living is left behind this feed
        // (#240 r3: a recorded owner with no living presence, e.g. a
        // deleted test identity, no longer blocks the erase)
        await EraseFeedAsync(db, feed);
        await db.SaveChangesAsync();
        return Results.Ok(new FeedDeletionResult(true));
    }

    /// <summary>Partial path: my attachments disappear, the others keep
    /// theirs; ownership follows a remaining coverer so they can attach.</summary>
    private static async Task RemoveMyViewAsync(AppDbContext db, FeedSpace feed, Guid me)
    {
        var myLinks = await db.SpaceAccountLinks
            .Where(l => l.FeedSpaceId == feed.Id && l.AttachedBy == me)
            .ToListAsync();
        db.SpaceAccountLinks.RemoveRange(myLinks);
        // #240: my co-ownership goes with my view
        db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == me).ToListAsync());
        await WriteDeletionOpsAsync(db, myLinks.Select(l => l.SpaceId).Distinct().ToList(), feed.Id, txIds: null);
        if (feed.OwnerUserId == me)
        {
            // a co-owner is the natural successor; attachers keep their
            // old place in line
            var successor = (await db.FeedOwners.FirstOrDefaultAsync(o => o.FeedSpaceId == feed.Id && o.UserId != me))?.UserId
                ?? (await db.SpaceAccountLinks.FirstOrDefaultAsync(l => l.FeedSpaceId == feed.Id && l.AttachedBy != me))?.AttachedBy;
            if (successor is Guid next)
            {
                feed.OwnerUserId = next;
                // the promoted co-owner's row collapses into the primary slot
                db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == next).ToListAsync());
            }
        }
    }

    /// <summary>Full path: per-space overlays first (they are NOT in the
    /// feed space and no other path ever cleans them), then the feed.</summary>
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
        db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feedSpaceId).ToListAsync());

        db.EntityRows.RemoveRange(await db.EntityRows.Where(r => r.SpaceId == feedSpaceId).ToListAsync());
        db.SyncOps.RemoveRange(await db.SyncOps.Where(o => o.SpaceId == feedSpaceId).ToListAsync());
        db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == feedSpaceId).ToListAsync());
        var space = await db.Spaces.FindAsync(feedSpaceId);
        if (space is not null) db.Spaces.Remove(space);
        db.FeedSpaces.Remove(feed);
    }

    /// <summary>
    /// Tombstone ops into each viewing space: the accountLink mirror always,
    /// plus every txMeta overlay when the raw transactions are going away.
    /// Deletes must travel the oplog or other devices revive the rows.
    /// </summary>
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
