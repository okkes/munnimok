using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Sync;

namespace Munni.Api.Tests;

// #648: every receipt sat in one feed only its owner read, and a space kept a full copy of each receipt it linked
public class ReceiptFeedsTests
{
    private const string Sub = "anna";
    private const string Connection = "conn-1";
    private const string Fetched = "rcpt:shop:conn-1:o-1";
    private const string Scan = "5b1f6c1e-0000-4000-8000-000000000001";
    private const string Home = "space-home";
    private const string Shared = "space-shared";
    private const string T1 = "000000100-0000-devA";
    private const string T2 = "000000200-0000-devA";
    private const string T3 = "000000300-0000-devA";
    private const string Pdf = "data:application/pdf;base64,JVBERi0=";
    private const string Photo = "data:image/jpeg;base64,ZmFrZQ==";

    private static readonly string Stores = ImportIds.PersonalFeedSpaceId(ImportIds.ConnectionsFeedRef, Sub);
    private static readonly string ShopFeed = ImportIds.PersonalFeedSpaceId(ImportIds.ReceiptFeedRef(Connection), Sub);
    private static readonly string ScansFeed = ImportIds.PersonalFeedSpaceId(ImportIds.ScansFeedRef, Sub);
    private static readonly string NewFetched = "rcp2:shop:conn-1:o-1";
    private static readonly string[] TurnedDown = ["pay-9"];
    private static readonly string[] Also = ["pay-2"];
    private static readonly string NewScan = $"scan:{Scan}";

    /// MUNNI_TEST_POSTGRES names a server (Host=…;Username=…;Password=…): the repair is then rehearsed on the engine
    /// production runs, each test in a database of its own — the in-memory one checks no query and no constraint
    private static AppDbContext Db()
    {
        var server = Environment.GetEnvironmentVariable("MUNNI_TEST_POSTGRES");
        if (string.IsNullOrEmpty(server))
        {
            return new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"receipt-feeds-{Guid.NewGuid():N}").Options);
        }
        var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql($"{server};Database=receipt_feeds_{Guid.NewGuid():N}").Options);
        db.Database.Migrate();
        return db;
    }

    private static Dictionary<string, JsonElement> Fields(object fields) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(fields))!;

    private static async Task RowAsync(AppDbContext db, string spaceId, string entity, string id, object fields, string hlc = T1, bool removed = false)
    {
        var space = await db.Spaces.FindAsync(spaceId) ?? db.Spaces.Add(new Space { Id = spaceId }).Entity;
        await new SyncWriter(db).ApplyAsync(space, null, [new(Guid.NewGuid().ToString("N"), spaceId, entity, id, Fields(fields), hlc, removed)]);
        await db.SaveChangesAsync();
    }

    private static EntityRow? Row(AppDbContext db, string spaceId, string entity, string id) =>
        db.EntityRows.AsNoTracking().SingleOrDefault(r => r.SpaceId == spaceId && r.Entity == entity && r.EntityId == id);

    private static JsonElement Data(AppDbContext db, string spaceId, string entity, string id) =>
        JsonDocument.Parse(Row(db, spaceId, entity, id)!.DataJson).RootElement;

    private static Dictionary<string, string> Stamps(AppDbContext db, string spaceId, string entity, string id) =>
        JsonSerializer.Deserialize<Dictionary<string, string>>(Row(db, spaceId, entity, id)!.FieldVersionsJson)!;

    /// anna with her connections feed, one shop, a space of her own and one she shares with ben
    private static async Task<(Guid Anna, Guid Ben)> PeopleAsync(AppDbContext db)
    {
        var anna = db.Users.Add(new User { Id = Guid.NewGuid(), Sub = Sub }).Entity;
        var ben = db.Users.Add(new User { Id = Guid.NewGuid(), Sub = "ben" }).Entity;
        db.FeedSpaces.Add(new FeedSpace { Id = Stores, OwnerUserId = anna.Id, AccountRef = ImportIds.ConnectionsFeedRef });
        db.Spaces.AddRange(new Space { Id = Stores }, new Space { Id = Home }, new Space { Id = Shared });
        db.SpaceMembers.AddRange(
            new SpaceMember { SpaceId = Stores, UserId = anna.Id, Role = SpaceRoles.Owner },
            new SpaceMember { SpaceId = Home, UserId = anna.Id, Role = SpaceRoles.Owner },
            new SpaceMember { SpaceId = Shared, UserId = anna.Id, Role = SpaceRoles.Owner },
            new SpaceMember { SpaceId = Shared, UserId = ben.Id, Role = SpaceRoles.Contributor });
        await db.SaveChangesAsync();
        await RowAsync(db, Stores, ReceiptFeeds.StoreConnEntity, Connection, new { store = "shop", displayName = "Shop" });
        return (anna.Id, ben.Id);
    }

    private static async Task FetchedAsync(AppDbContext db)
    {
        var invoice = ImportIds.ReceiptFileId(Fetched, "doc:0");
        await RowAsync(db, Stores, ReceiptFileSplit.FileEntity, invoice, new { ownerId = Fetched, dataUrl = Pdf });
        await RowAsync(db, Stores, ReceiptFeeds.ReceiptEntity, Fetched, new
        {
            source = "shop",
            instanceId = Connection,
            date = "2026-05-29",
            totalCents = 4999,
            storeRef = "shop:o-1",
            items = new[] { new { name = "Lamp", totalCents = 4999 } },
            documents = new[] { new { kind = "invoice", mime = "application/pdf", filename = "invoice.pdf", fileId = invoice } },
        });
    }

    private static async Task ScanAsync(AppDbContext db)
    {
        var picture = ImportIds.ReceiptFileId(Scan, "image");
        await RowAsync(db, Stores, ReceiptFileSplit.FileEntity, picture, new { ownerId = Scan, dataUrl = Photo });
        await RowAsync(db, Stores, ReceiptFeeds.ReceiptEntity, Scan, new { source = "photo", date = "2026-05-29", totalCents = 0, imageId = picture });
        await RowAsync(db, Stores, ReceiptFeeds.ReceiptEntity, Scan, new { totalCents = 1250 }, T2);
    }

    private static Task IncludeShopAsync(AppDbContext db, string spaceId) =>
        RowAsync(db, spaceId, ReceiptFeeds.StoreConnLinkEntity, ImportIds.StoreConnLinkId(spaceId, Connection), new { instanceId = Connection, store = "shop", displayName = "Shop" });

    /// a link as the app wrote it before: everything the receipt said, copied
    private static Task CopyAsync(AppDbContext db, string spaceId, string receiptId, object state, string source = "shop", string hlc = T2) =>
        RowAsync(db, spaceId, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(spaceId, receiptId), Merge(new { receiptId, source, date = "2026-05-29", totalCents = 4999 }, state), hlc);

    private static Dictionary<string, JsonElement> Merge(object a, object b)
    {
        var merged = Fields(a);
        foreach (var (key, value) in Fields(b)) merged[key] = value;
        return merged;
    }

    [Fact]
    public async Task A_fetched_receipt_moves_to_its_connections_feed_and_a_scan_to_the_scans_feed()
    {
        using var db = Db();
        var (anna, _) = await PeopleAsync(db);
        await FetchedAsync(db);
        await ScanAsync(db);

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(2, counts.Receipts);
        // under the id the ingest gives it from here on, with everything it said
        var fetched = Data(db, ShopFeed, ReceiptFeeds.ReceiptEntity, NewFetched);
        Assert.Equal(4999, fetched.GetProperty("totalCents").GetInt32());
        Assert.Equal("shop:o-1", fetched.GetProperty("storeRef").GetString());
        Assert.Equal("Lamp", fetched.GetProperty("items")[0].GetProperty("name").GetString());
        // its invoice came along under the new owner, and the receipt names that one
        var invoice = ImportIds.ReceiptFileId(NewFetched, "doc:0");
        Assert.Equal(invoice, fetched.GetProperty("documents")[0].GetProperty("fileId").GetString());
        Assert.Equal("invoice.pdf", fetched.GetProperty("documents")[0].GetProperty("filename").GetString());
        Assert.Equal(Pdf, Data(db, ShopFeed, ReceiptFileSplit.FileEntity, invoice).GetProperty("dataUrl").GetString());
        Assert.Equal(NewFetched, Data(db, ShopFeed, ReceiptFileSplit.FileEntity, invoice).GetProperty("ownerId").GetString());
        // each value right behind the stamp it had: a later write of a device keeps its say
        Assert.All(Stamps(db, ShopFeed, ReceiptFeeds.ReceiptEntity, NewFetched).Values, stamp => Assert.Equal(T1 + "~", stamp));

        var scan = Data(db, ScansFeed, ReceiptFeeds.ReceiptEntity, NewScan);
        Assert.Equal(1250, scan.GetProperty("totalCents").GetInt32());
        Assert.Equal(ImportIds.ReceiptFileId(NewScan, "image"), scan.GetProperty("imageId").GetString());
        Assert.Equal(Photo, Data(db, ScansFeed, ReceiptFileSplit.FileEntity, ImportIds.ReceiptFileId(NewScan, "image")).GetProperty("dataUrl").GetString());
        var stamps = Stamps(db, ScansFeed, ReceiptFeeds.ReceiptEntity, NewScan);
        Assert.Equal(T2 + "~", stamps["totalCents"]);
        Assert.Equal(T1 + "~", stamps["date"]);

        // the rows they left are removed, and the feeds are the person's own
        Assert.True(Row(db, Stores, ReceiptFeeds.ReceiptEntity, Fetched)!.Deleted);
        Assert.True(Row(db, Stores, ReceiptFeeds.ReceiptEntity, Scan)!.Deleted);
        Assert.False(Row(db, Stores, ReceiptFeeds.StoreConnEntity, Connection)!.Deleted);
        foreach (var feedId in new[] { ShopFeed, ScansFeed })
        {
            Assert.Equal(anna, db.FeedSpaces.Single(f => f.Id == feedId).OwnerUserId);
            Assert.True(db.SpaceMembers.Any(m => m.SpaceId == feedId && m.UserId == anna && m.Role == SpaceRoles.Owner));
        }
        // a device pulls a file before the receipt that names it
        Assert.Equal([ReceiptFileSplit.FileEntity, ReceiptFeeds.ReceiptEntity], db.SyncOps.Where(o => o.SpaceId == ShopFeed).OrderBy(o => o.Seq).Select(o => o.Entity).ToList());
    }

    [Fact]
    public async Task A_space_that_included_the_shop_reads_its_feed_and_its_links_become_references()
    {
        using var db = Db();
        var (anna, _) = await PeopleAsync(db);
        await FetchedAsync(db);
        await IncludeShopAsync(db, Shared);
        await CopyAsync(db, Shared, Fetched, new { txId = "pay-1", auto = 0, picks = new { }, rejectedTxIds = TurnedDown });
        var old = ImportIds.ReceiptLinkId(Shared, Fetched);
        // a line the space picked later than the copy was made
        await RowAsync(db, Shared, ReceiptFeeds.LinkEntity, old, new { alsoTxIds = Also }, T3);

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(1, 1, 1, 0, 0), counts);
        var share = db.SpaceStoreLinks.Single();
        Assert.Equal((Shared, ShopFeed, anna), (share.SpaceId, share.FeedSpaceId, share.AttachedBy));
        Assert.Equal(ShopFeed, Data(db, Shared, ReceiptFeeds.StoreConnLinkEntity, ImportIds.StoreConnLinkId(Shared, Connection)).GetProperty("feedSpaceId").GetString());

        var link = Data(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, NewFetched));
        Assert.Equal(NewFetched, link.GetProperty("receiptId").GetString());
        Assert.Equal(ShopFeed, link.GetProperty("feedSpaceId").GetString());
        Assert.Equal("pay-1", link.GetProperty("txId").GetString());
        Assert.Equal("pay-2", link.GetProperty("alsoTxIds")[0].GetString());
        Assert.Equal("pay-9", link.GetProperty("rejectedTxIds")[0].GetString());
        // nothing of the receipt is in the space any more
        foreach (var copied in new[] { "source", "date", "totalCents", "items" }) Assert.False(link.TryGetProperty(copied, out _));
        var stamps = Stamps(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, NewFetched));
        Assert.Equal(T2 + "~", stamps["txId"]);
        Assert.Equal(T3 + "~", stamps["alsoTxIds"]);
        Assert.True(Row(db, Shared, ReceiptFeeds.LinkEntity, old)!.Deleted);
        Assert.Null(Row(db, Shared, ReceiptFeeds.ReceiptEntity, ReceiptFeeds.SpaceReceiptId(old)));
    }

    [Fact]
    public async Task What_a_copy_knew_better_than_its_receipt_is_kept_on_the_receipt()
    {
        using var db = Db();
        await PeopleAsync(db);
        await ScanAsync(db);
        await CopyAsync(db, Home, Scan, new { txId = "pay-1" }, "photo");
        // a read made on the copy: its lines and its total were never on the scan itself
        await RowAsync(db, Home, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Home, Scan), new { items = new[] { new { name = "Bread", totalCents = 1310 } }, totalCents = 1310 }, T3);

        await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        var scan = Data(db, ScansFeed, ReceiptFeeds.ReceiptEntity, NewScan);
        Assert.Equal("Bread", scan.GetProperty("items")[0].GetProperty("name").GetString());
        Assert.Equal(1310, scan.GetProperty("totalCents").GetInt32());
        // the day the copy repeated is not written again
        Assert.Equal(T1 + "~", Stamps(db, ScansFeed, ReceiptFeeds.ReceiptEntity, NewScan)["date"]);
    }

    [Fact]
    public async Task Scans_are_read_by_the_spaces_only_their_owner_is_in()
    {
        using var db = Db();
        var (anna, _) = await PeopleAsync(db);
        await ScanAsync(db);
        await CopyAsync(db, Home, Scan, new { proposedTxId = "pay-1" }, "photo");
        await CopyAsync(db, Shared, Scan, new { txId = "pay-7" }, "photo");
        var copy = ImportIds.ReceiptFileId(ImportIds.ReceiptLinkId(Shared, Scan), "image");
        await RowAsync(db, Shared, ReceiptFileSplit.FileEntity, copy, new { ownerId = ImportIds.ReceiptLinkId(Shared, Scan), dataUrl = Photo });
        await RowAsync(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, Scan), new { imageId = copy }, T2);

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(1, 1, 1, 1, 0), counts);
        var share = db.SpaceStoreLinks.Single();
        Assert.Equal((Home, ScansFeed, anna), (share.SpaceId, share.FeedSpaceId, share.AttachedBy));
        var mirror = Data(db, Home, ReceiptFeeds.StoreConnLinkEntity, ImportIds.StoreConnLinkId(Home, ScansFeed));
        Assert.Equal("photo", mirror.GetProperty("store").GetString());
        Assert.Equal(ScansFeed, mirror.GetProperty("feedSpaceId").GetString());
        Assert.Equal("pay-1", Data(db, Home, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Home, NewScan)).GetProperty("proposedTxId").GetString());

        // the shared space never read anna's scans: what it shows on a payment stays its own, picture and all
        var own = ReceiptFeeds.SpaceReceiptId(ImportIds.ReceiptLinkId(Shared, Scan));
        var kept = Data(db, Shared, ReceiptFeeds.ReceiptEntity, own);
        Assert.Equal("photo", kept.GetProperty("source").GetString());
        Assert.Equal(4999, kept.GetProperty("totalCents").GetInt32());
        Assert.Equal(copy, kept.GetProperty("imageId").GetString());
        Assert.False(Row(db, Shared, ReceiptFileSplit.FileEntity, copy)!.Deleted);
        var link = Data(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, own));
        Assert.Equal((own, Shared, "pay-7"), (link.GetProperty("receiptId").GetString(), link.GetProperty("feedSpaceId").GetString(), link.GetProperty("txId").GetString()));
        Assert.Null(Row(db, Shared, ReceiptFeeds.StoreConnLinkEntity, ImportIds.StoreConnLinkId(Shared, ScansFeed)));
    }

    [Fact]
    public async Task A_photo_taken_on_a_payment_becomes_the_spaces_own_receipt()
    {
        using var db = Db();
        await PeopleAsync(db);
        await RowAsync(db, Shared, ReceiptFeeds.LinkEntity, "link-photo", new { txId = "pay-3", source = "photo", date = "2026-06-01", totalCents = 830, merchant = "Bakery", imageId = "file-1", auto = 0 });

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(0, 0, 0, 1, 0), counts);
        var own = ReceiptFeeds.SpaceReceiptId("link-photo");
        var receipt = Data(db, Shared, ReceiptFeeds.ReceiptEntity, own);
        Assert.Equal(("photo", "Bakery", 830, "file-1"), (receipt.GetProperty("source").GetString(), receipt.GetProperty("merchant").GetString(), receipt.GetProperty("totalCents").GetInt32(), receipt.GetProperty("imageId").GetString()));
        Assert.False(receipt.TryGetProperty("txId", out _));
        var link = Data(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, own));
        Assert.Equal("pay-3", link.GetProperty("txId").GetString());
        Assert.False(link.TryGetProperty("merchant", out _));
        Assert.True(Row(db, Shared, ReceiptFeeds.LinkEntity, "link-photo")!.Deleted);
    }

    [Fact]
    public async Task A_link_to_a_receipt_the_space_cannot_read_is_kept_only_when_it_is_on_a_payment()
    {
        using var db = Db();
        await PeopleAsync(db);
        await FetchedAsync(db);
        // the shop is not included in the shared space: a copy nobody put on a payment is its owner's receipt, nothing more
        await CopyAsync(db, Shared, Fetched, new { rejectedTxIds = TurnedDown });
        // a copy whose receipt is gone is the only one there is
        await CopyAsync(db, Shared, "rcpt:shop:gone:o-7", new { rejectedTxIds = TurnedDown });

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(1, 0, 0, 1, 1), counts);
        Assert.True(Row(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, Fetched))!.Deleted);
        Assert.Null(Row(db, Shared, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Shared, NewFetched)));
        Assert.NotNull(Row(db, Shared, ReceiptFeeds.ReceiptEntity, ReceiptFeeds.SpaceReceiptId(ImportIds.ReceiptLinkId(Shared, "rcpt:shop:gone:o-7"))));
        Assert.Empty(db.SpaceStoreLinks);
    }

    [Fact]
    public async Task A_second_run_changes_nothing_and_a_run_cut_short_is_finished()
    {
        using var db = Db();
        await PeopleAsync(db);
        await FetchedAsync(db);
        await IncludeShopAsync(db, Home);
        await ReceiptFeeds.RepairAsync(db, CancellationToken.None);
        // a link the first run never reached: its receipt has moved already
        await CopyAsync(db, Home, Fetched, new { txId = "pay-1" });
        var before = db.SyncOps.Count();

        var again = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(0, 0, 1, 0, 0), again);
        Assert.Equal(NewFetched, Data(db, Home, ReceiptFeeds.LinkEntity, ImportIds.ReceiptLinkId(Home, NewFetched)).GetProperty("receiptId").GetString());
        // the reference and the removal of the copy: nothing else was written again
        Assert.Equal(before + 2, db.SyncOps.Count());
        Assert.Equal(new ReceiptFeedsCounts(0, 0, 0, 0, 0), await ReceiptFeeds.RepairAsync(db, CancellationToken.None));
        Assert.Equal(before + 2, db.SyncOps.Count());
    }

    [Fact]
    public async Task The_repair_runs_once_per_database()
    {
        using var db = Db();
        await PeopleAsync(db);
        await FetchedAsync(db);
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;

        Assert.Equal(1, (await ReceiptFeeds.RunOnceAsync(db, logger, CancellationToken.None))!.Receipts);
        Assert.Null(await ReceiptFeeds.RunOnceAsync(db, logger, CancellationToken.None));
    }

    [Fact]
    public async Task A_removed_receipt_stays_removed_and_a_left_connection_shares_nothing()
    {
        using var db = Db();
        var (_, ben) = await PeopleAsync(db);
        await FetchedAsync(db);
        await RowAsync(db, Stores, ReceiptFeeds.ReceiptEntity, Fetched, new { }, T3, removed: true);
        // ben included a shop of his own and left; the space's row for it stayed behind
        var bens = ImportIds.PersonalFeedSpaceId(ImportIds.ConnectionsFeedRef, "ben");
        db.FeedSpaces.Add(new FeedSpace { Id = bens, OwnerUserId = ben, AccountRef = ImportIds.ConnectionsFeedRef });
        db.SpaceMembers.Remove(db.SpaceMembers.Single(m => m.SpaceId == Shared && m.UserId == ben));
        await db.SaveChangesAsync();
        await RowAsync(db, bens, ReceiptFeeds.StoreConnEntity, "conn-ben", new { store = "shop", displayName = "Shop" });
        await RowAsync(db, Shared, ReceiptFeeds.StoreConnLinkEntity, ImportIds.StoreConnLinkId(Shared, "conn-ben"), new { instanceId = "conn-ben", store = "shop", displayName = "Shop" });

        var counts = await ReceiptFeeds.RepairAsync(db, CancellationToken.None);

        Assert.Equal(new ReceiptFeedsCounts(0, 0, 0, 0, 0), counts);
        Assert.Null(Row(db, ShopFeed, ReceiptFeeds.ReceiptEntity, NewFetched));
        Assert.Empty(db.SpaceStoreLinks);
    }

    [Fact]
    public void The_changes_are_spelled_the_way_a_device_spells_them()
    {
        // pinned on both sides (apps/web/src/application/receiptFeeds.test.ts): the server and a device write one change
        var stamps = new Dictionary<string, string> { ["txId"] = T2, ["auto"] = T2, ["picks"] = T3 };
        var ops = ReceiptFeeds.MoveOps("space-1", ReceiptFeeds.LinkEntity, "link-1", Fields(new { txId = "pay-1", auto = 0, picks = new { } }), stamps);

        Assert.Equal(2, ops.Count);
        Assert.Equal(["auto", "txId"], ops[0].Fields.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList());
        Assert.Equal(T2 + "~", ops[0].Hlc);
        Assert.Equal("b12ea12a-6c26-5851-a280-28f8ad7ea01c", ops[0].OpId);
        Assert.Equal(T3 + "~", ops[1].Hlc);
        Assert.Equal("e9d6b91a-c842-54c8-a592-fe4ec7c8decc", ops[1].OpId);

        var gone = ReceiptFeeds.GoneOp("space-1", ReceiptFeeds.LinkEntity, "link-1", stamps);
        Assert.True(gone.Deleted);
        Assert.Equal(T3 + "~", gone.Hlc);
        Assert.Equal("b736aef2-0652-5cd2-8316-f5d6c08190f0", gone.OpId);

        Assert.Equal("rcp2:shop:conn-1:o-1", ReceiptFeeds.NewReceiptId("rcpt:shop:conn-1:o-1", scan: false));
        Assert.Equal("scan:abc", ReceiptFeeds.NewReceiptId("abc", scan: true));
        Assert.Equal("srcp:link-1", ReceiptFeeds.SpaceReceiptId("link-1"));
        Assert.Equal("64a8a17f-8050-5789-8124-f7c6daa0d8b3", ImportIds.ReceiptLinkId("space-1", "rcp2:shop:conn-1:o-1"));
        Assert.Equal("d2ecd890-3cdb-5335-b9ae-8a92e025be10", ShopFeed);
        Assert.Equal("5a7af673-f5b9-5f94-aba7-83baaa47a944", ScansFeed);
    }
}
