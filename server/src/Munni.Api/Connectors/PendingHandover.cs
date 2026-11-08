using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Connectors;

/// <summary>
/// A reserved row is only ever taken out by the settle of the connection
/// that tracks it (§15). When that tracking goes — a reconnect supersedes the
/// connection, a session or a feed is disconnected — the row must not be
/// left behind untracked: nothing would settle it, and once the bank books
/// it the reserved row stands beside its booked twin for good (#508). Another
/// live reference to the same feed account takes the tracking over, and its
/// next complete pass settles the row; with none left, the row is tombstoned.
/// </summary>
public static class PendingHandover
{
    private const string TransactionEntity = "transaction";

    /// <summary>One reserved row as it lies in its feed.</summary>
    public sealed record Reserved(string FeedSpaceId, string AccountEntityId, string EntityId);

    /// <summary>The tracking of references that are going away, handed over or settled; the caller removes the references and saves.</summary>
    public static async Task<int> HandOverAsync(AppDbContext db, IReadOnlyCollection<ConnectorAccountRef> leaving, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(leaving);
        if (leaving.Count == 0) return 0;
        var byId = leaving.DistinctBy(a => a.Id).ToDictionary(a => a.Id, StringComparer.Ordinal);
        var ids = byId.Keys.ToList();
        var tracked = await db.ConnectorPendingTxs.Where(p => ids.Contains(p.AccountRefId)).ToListAsync(ct);
        if (tracked.Count == 0) return 0;
        db.ConnectorPendingTxs.RemoveRange(tracked);
        var rows = tracked
            .Select(p => new Reserved(byId[p.AccountRefId].FeedSpaceId, byId[p.AccountRefId].AccountEntityId, p.EntityId))
            .Distinct()
            .ToList();
        return await AdoptOrSettleAsync(db, rows, ids, $"{DateTimeOffset.UtcNow.Ticks}", ct);
    }

    /// <summary>
    /// Reserved rows nobody tracks: each one goes to every live reference of
    /// its feed account (outside <paramref name="leavingIds"/>), or is
    /// tombstoned when there is none. Returns how many were tombstoned.
    /// <paramref name="seed"/> keys the tombstone ops.
    /// </summary>
    public static async Task<int> AdoptOrSettleAsync(
        AppDbContext db, IReadOnlyList<Reserved> rows, IReadOnlyCollection<string> leavingIds, string seed, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(rows);
        var tombstoned = 0;
        var counter = 0;
        foreach (var account in rows.GroupBy(r => (r.FeedSpaceId, r.AccountEntityId)))
        {
            var (feedId, accountId) = account.Key;
            var heirs = await db.ConnectorAccountRefs
                .Where(a => a.FeedSpaceId == feedId && a.AccountEntityId == accountId && !a.Excluded && !leavingIds.Contains(a.Id))
                .Select(a => a.Id)
                .ToListAsync(ct);
            var entityIds = account.Select(r => r.EntityId).Distinct().ToList();
            if (heirs.Count > 0)
            {
                var known = (await db.ConnectorPendingTxs
                        .Where(p => heirs.Contains(p.AccountRefId) && entityIds.Contains(p.EntityId))
                        .Select(p => new { p.AccountRefId, p.EntityId })
                        .ToListAsync(ct))
                    .Select(p => (p.AccountRefId, p.EntityId))
                    .ToHashSet();
                foreach (var heir in heirs)
                {
                    foreach (var entityId in entityIds.Where(e => known.Add((heir, e))))
                    {
                        db.ConnectorPendingTxs.Add(new ConnectorPendingTx { AccountRefId = heir, EntityId = entityId });
                    }
                }
                continue;
            }

            var feed = await db.Spaces.FindAsync([feedId], ct);
            if (feed is null) continue;
            var ops = entityIds
                .Select(id => new SyncOpDto(
                    ImportIds.OpId($"connpendgone:{feedId}:{id}:{seed}"), feedId, TransactionEntity, id,
                    new Dictionary<string, JsonElement>(), ServerHlc.Now(counter++), Deleted: true))
                .ToList();
            var (_, accepted) = await new SyncWriter(db).ApplyAsync(feed, null, ops);
            tombstoned += accepted;
        }
        await db.SaveChangesAsync(ct);
        return tombstoned;
    }
}
