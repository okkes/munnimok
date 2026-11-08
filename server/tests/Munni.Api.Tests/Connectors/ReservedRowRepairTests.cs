using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// #508: reserved rows nobody tracks any more stood beside their booked twins
/// for good. Once, every such row goes to a live connection of its account -
/// whose next complete pass settles it against the bank - or is tombstoned
/// when no connection reaches the account any more.
/// </summary>
public class ReservedRowRepairTests
{
    private static AppDbContext Db() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"reserved-{Guid.NewGuid():N}").Options);

    private static async Task RowAsync(AppDbContext db, string feedId, string account, string id, bool pending)
    {
        var feed = await db.Spaces.FindAsync(feedId) ?? db.Spaces.Add(new Space { Id = feedId }).Entity;
        var fields = new Dictionary<string, JsonElement>
        {
            ["accountId"] = JsonSerializer.SerializeToElement(account),
            ["date"] = JsonSerializer.SerializeToElement("2026-10-06"),
            ["amountCents"] = JsonSerializer.SerializeToElement(-1300),
        };
        if (pending) fields["pending"] = JsonSerializer.SerializeToElement(1);
        await new SyncWriter(db).ApplyAsync(feed, null, [new SyncOpDto(Guid.NewGuid().ToString("N"), feedId, "transaction", id, fields, ServerHlc.Now())]);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Untracked_reserved_rows_go_to_a_live_connection_of_their_account_or_are_tombstoned_once()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        db.ConnectorAccountRefs.Add(new ConnectorAccountRef
        {
            Id = "acc_live",
            UserId = Guid.NewGuid(),
            Provider = "enablebanking",
            ExternalId = "NL91MOCK0000000791",
            AccountRef = "NL91MOCK0000000791",
            FeedSpaceId = "feed-reached",
            AccountEntityId = "acct-reached",
            Currency = "EUR",
            ConnectionId = "conn-live",
        });
        db.ConnectorPendingTxs.Add(new ConnectorPendingTx { AccountRefId = "acc_live", EntityId = "tracked" });
        await db.SaveChangesAsync(ct);
        await RowAsync(db, "feed-reached", "acct-reached", "tracked", pending: true);
        await RowAsync(db, "feed-reached", "acct-reached", "orphan", pending: true);
        await RowAsync(db, "feed-reached", "acct-reached", "booked", pending: false);
        await RowAsync(db, "feed-gone", "acct-gone", "stranded", pending: true);

        Assert.Equal(1, await ReservedRowRepair.RunOnceAsync(db, NullLogger.Instance, ct));

        // the live connection now tracks both reserved rows of its account; the booked row is nobody's business
        var tracked = await db.ConnectorPendingTxs.Where(p => p.AccountRefId == "acc_live").Select(p => p.EntityId).OrderBy(id => id).ToListAsync(ct);
        Assert.Equal(["orphan", "tracked"], tracked);
        Assert.False((await db.EntityRows.SingleAsync(r => r.EntityId == "orphan", ct)).Deleted);
        Assert.False((await db.EntityRows.SingleAsync(r => r.EntityId == "booked", ct)).Deleted);
        // nothing reaches the other account: its reserved row goes, as a tombstone every device pulls
        Assert.True((await db.EntityRows.SingleAsync(r => r.EntityId == "stranded", ct)).Deleted);
        Assert.True(await db.SyncOps.AnyAsync(o => o.SpaceId == "feed-gone" && o.EntityId == "stranded" && o.Deleted, ct));

        // once per database
        await RowAsync(db, "feed-gone", "acct-gone", "later", pending: true);
        Assert.Equal(0, await ReservedRowRepair.RunOnceAsync(db, NullLogger.Instance, ct));
        Assert.False((await db.EntityRows.SingleAsync(r => r.EntityId == "later", ct)).Deleted);
    }
}
