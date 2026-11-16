using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;
using Munni.Api.Social;

namespace Munni.Api.Sync;

/// <summary>
/// A space its owner deleted is erased at once (#615, the person's ruling of 2026-11-16: "permanently delete
/// right away"). Until then a deleted space was a tombstone on its own row and nothing else: its members, its
/// account attachments and its place among the spaces every device syncs all stayed, so the nightly fetch kept
/// writing into it. What is left afterwards is the id (<see cref="ErasedSpace"/>): a device that still holds
/// the space is told it is gone, and its next push cannot bring an empty space of that id back to life.
/// </summary>
public static class SpaceErasure
{
    /// <summary>The 403 body that tells an erased space from one the caller was taken out of.</summary>
    public const string GoneError = "space-deleted";

    private const string SpaceEntity = "space";

    /// <summary>
    /// 403, so a device from before this still lets go of the space the way it does when it is removed from
    /// one; the body says which of the two happened.
    /// </summary>
    public static IResult Gone() => Results.Json(new { error = GoneError }, statusCode: StatusCodes.Status403Forbidden);

    public static Task<bool> IsErasedAsync(AppDbContext db, string spaceId, CancellationToken ct = default) =>
        db.ErasedSpaces.AnyAsync(e => e.SpaceId == spaceId, ct);

    /// <summary>The op that deletes a space: a delete of the space's own row.</summary>
    public static bool Deletes(SyncOpDto op, string spaceId) =>
        op.Deleted && op.Entity == SpaceEntity && op.EntityId == spaceId;

    /// <summary>
    /// What a push may apply: deleting the space is its owner's to do — it erases the space for everyone — so
    /// anybody else's delete of the space's row is left out.
    /// </summary>
    public static List<SyncOpDto> Admitted(List<SyncOpDto> ops, string spaceId, bool owner) =>
        owner ? ops : ops.Where(o => !Deletes(o, spaceId)).ToList();

    /// <summary>
    /// Whether the ops just applied deleted the space: one of them is the delete, and the space's own row
    /// stands as deleted — by the merge's rule, so an edit made after the delete keeps the space. Reads the
    /// row the caller's unit of work holds, saved or not.
    /// </summary>
    public static async Task<bool> DeletedByAsync(AppDbContext db, string spaceId, List<SyncOpDto> applied, CancellationToken ct = default) =>
        applied.Exists(o => Deletes(o, spaceId)) && (await db.EntityRows.FindAsync([spaceId, SpaceEntity, spaceId], ct))?.Deleted == true;

    /// <summary>
    /// Takes the space out of reach, in the caller's unit of work: nobody is a member, no account is attached
    /// (an account only this space showed is unattached again, and still its owner's), no invitation waits,
    /// and what pointed at the space from outside it lets go. The id is recorded. The caller saves.
    /// </summary>
    public static async Task SealAsync(AppDbContext db, string spaceId, CancellationToken ct = default)
    {
        db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == spaceId).ToListAsync(ct));
        db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.SpaceId == spaceId).ToListAsync(ct));
        db.SpaceInvites.RemoveRange(await db.SpaceInvites.Where(i => i.SpaceId == spaceId).ToListAsync(ct));
        // a friend request that carried an invitation to the space stays a friend request
        foreach (var request in await db.Friendships.Where(f => f.SpaceId == spaceId).ToListAsync(ct))
        {
            request.SpaceId = null;
            request.SpaceRole = null;
            request.SpaceName = null;
        }
        // a split a member had wired to the space, and the entries added from one of its transactions
        foreach (var member in await db.SplitMembers.Where(m => m.AttachedSpaceId == spaceId).ToListAsync(ct))
        {
            member.AttachedSpaceId = null;
            member.AttachedEventId = null;
        }
        foreach (var entry in await db.SplitEntries.Where(e => e.SourceSpaceId == spaceId).ToListAsync(ct))
        {
            entry.SourceSpaceId = null;
            entry.SourceTxId = null;
        }
        if (await db.ErasedSpaces.FindAsync([spaceId], ct) is null) db.ErasedSpaces.Add(new ErasedSpace { SpaceId = spaceId });
    }

    /// <summary>
    /// Removes what the space held: every row, every op, the space itself. Safe to run again — an erase cut
    /// short is finished by <see cref="SweepAsync"/>.
    /// </summary>
    public static async Task EraseRowsAsync(AppDbContext db, string spaceId, CancellationToken ct = default)
    {
        if (db.Database.IsRelational())
        {
            // one statement per table: a space holds a hundred thousand ops, far too many to load and remove one by one
            await db.EntityRows.Where(r => r.SpaceId == spaceId).ExecuteDeleteAsync(ct);
            await db.SyncOps.Where(o => o.SpaceId == spaceId).ExecuteDeleteAsync(ct);
            await db.Spaces.Where(s => s.Id == spaceId).ExecuteDeleteAsync(ct);
            return;
        }
        db.EntityRows.RemoveRange(await db.EntityRows.Where(r => r.SpaceId == spaceId).ToListAsync(ct));
        db.SyncOps.RemoveRange(await db.SyncOps.Where(o => o.SpaceId == spaceId).ToListAsync(ct));
        db.Spaces.RemoveRange(await db.Spaces.Where(s => s.Id == spaceId).ToListAsync(ct));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Every start: finishes an erase that was cut short, and erases the spaces that were deleted before the
    /// server erased anything. Only a delete an owner wrote counts — the app offers Delete to owners alone, and
    /// since this change the push refuses anybody else's. Returns how many spaces went.
    /// </summary>
    public static async Task<int> SweepAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        var erased = 0;
        var marked = await db.ErasedSpaces.Select(e => e.SpaceId).ToListAsync(ct);
        foreach (var spaceId in await db.Spaces.Where(s => marked.Contains(s.Id)).Select(s => s.Id).ToListAsync(ct))
        {
            await EraseRowsAsync(db, spaceId, ct);
            erased++;
        }

        var deleted = await db.EntityRows
            .Where(r => r.Entity == SpaceEntity && r.EntityId == r.SpaceId && r.Deleted)
            .Select(r => r.SpaceId)
            .ToListAsync(ct);
        var kept = 0;
        foreach (var spaceId in deleted)
        {
            if (!await DeletedByOwnerAsync(db, spaceId, ct))
            {
                kept++;
                continue;
            }
            await SealAsync(db, spaceId, ct);
            await db.SaveChangesAsync(ct);
            await EraseRowsAsync(db, spaceId, ct);
            erased++;
        }
        if ((erased > 0 || kept > 0) && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("space erasure: {Erased} deleted space(s) erased, {Kept} left alone (their delete was not an owner's)", erased, kept);
        }
        return erased;
    }

    /// <summary>The newest delete of the space's row came from someone who owns the space; a feed is nobody's to delete this way.</summary>
    private static async Task<bool> DeletedByOwnerAsync(AppDbContext db, string spaceId, CancellationToken ct)
    {
        if (await db.FeedSpaces.AnyAsync(f => f.Id == spaceId, ct)) return false;
        var author = await db.SyncOps
            .Where(o => o.SpaceId == spaceId && o.Entity == SpaceEntity && o.EntityId == spaceId && o.Deleted)
            .OrderByDescending(o => o.Seq)
            .Select(o => o.UserId)
            .FirstOrDefaultAsync(ct);
        return author is Guid user && await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == user && m.Role == SpaceRoles.Owner, ct);
    }
}
