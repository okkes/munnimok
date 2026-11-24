using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Accounts;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Tests;

// #630: receipts held their photo and their invoices inside the row, and every pass over receipts read all of them
public class ReceiptFileSplitTests
{
    private const string Photo = "data:image/jpeg;base64,ZmFrZQ==";
    private const string Pdf = "data:application/pdf;base64,JVBERi0=";
    private const string Feed = "feed-stores";
    private const string Space = "space-1";
    private const string Receipt = "rcpt:bol:c1:o-1";
    private const string Old = "000000100-0000-devA";

    private static AppDbContext Db() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"receipt-files-{Guid.NewGuid():N}").Options);

    private static Dictionary<string, JsonElement> Fields(object fields) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(fields))!;

    /// a row as a device wrote it before #630, long before the repair runs
    private static async Task RowAsync(AppDbContext db, string spaceId, string entity, string id, object fields, string hlc = Old, bool removed = false)
    {
        var space = await db.Spaces.FindAsync(spaceId) ?? db.Spaces.Add(new Space { Id = spaceId }).Entity;
        var ops = new List<SyncOpDto> { new(Guid.NewGuid().ToString("N"), spaceId, entity, id, Fields(fields), hlc) };
        if (removed) ops.Add(new(Guid.NewGuid().ToString("N"), spaceId, entity, id, new(), "000000200-0000-devA", true));
        await new SyncWriter(db).ApplyAsync(space, null, ops);
        await db.SaveChangesAsync();
    }

    private static JsonElement Data(AppDbContext db, string entity, string id) =>
        JsonDocument.Parse(db.EntityRows.AsNoTracking().Single(r => r.Entity == entity && r.EntityId == id).DataJson).RootElement;

    private static async Task SeedAsync(AppDbContext db)
    {
        await RowAsync(db, Feed, "receipt", Receipt, new
        {
            source = "bol",
            date = "2026-05-29",
            totalCents = 4999,
            documents = new object[]
            {
                new { kind = "invoice", mime = "application/pdf", filename = "factuur.pdf", sizeBytes = 5, dataUrl = Pdf },
                new { kind = "invoice", mime = "application/pdf", filename = "creditnota.pdf", dataUrl = Pdf + "Mg==" },
            },
        });
        await RowAsync(db, Space, "receiptLink", "link-photo", new { txId = "pay-1", source = "photo", date = "2026-05-29", totalCents = 1500, image = Photo });
        await RowAsync(db, Space, "receiptLink", "link-plain", new { txId = "pay-2", source = "ah", date = "2026-05-30", totalCents = 700 });
    }

    [Fact]
    public async Task Photos_and_invoices_leave_the_rows_that_held_them_and_the_rows_name_the_files()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        await SeedAsync(db);

        Assert.Equal(2, await ReceiptFileSplit.RepairAsync(db, ct));

        var receipt = Data(db, "receipt", Receipt);
        Assert.DoesNotContain("base64", receipt.GetRawText());
        var documents = receipt.GetProperty("documents").EnumerateArray().ToList();
        Assert.Equal(ImportIds.ReceiptFileId(Receipt, "doc:0"), documents[0].GetProperty("fileId").GetString());
        Assert.Equal(ImportIds.ReceiptFileId(Receipt, "doc:1"), documents[1].GetProperty("fileId").GetString());
        // what the row knew about a document stays with the row
        Assert.Equal("factuur.pdf", documents[0].GetProperty("filename").GetString());
        Assert.Equal(5, documents[0].GetProperty("sizeBytes").GetInt32());
        Assert.False(documents[0].TryGetProperty("dataUrl", out _));

        var invoice = db.EntityRows.AsNoTracking().Single(r => r.Entity == ReceiptFileSplit.FileEntity && r.EntityId == ImportIds.ReceiptFileId(Receipt, "doc:1"));
        Assert.Equal(Feed, invoice.SpaceId);
        Assert.Equal(Pdf + "Mg==", JsonDocument.Parse(invoice.DataJson).RootElement.GetProperty("dataUrl").GetString());
        Assert.Equal(Receipt, JsonDocument.Parse(invoice.DataJson).RootElement.GetProperty("ownerId").GetString());

        var link = Data(db, "receiptLink", "link-photo");
        Assert.Equal(JsonValueKind.Null, link.GetProperty("image").ValueKind);
        Assert.Equal(ImportIds.ReceiptFileId("link-photo", "image"), link.GetProperty("imageId").GetString());
        var picture = db.EntityRows.AsNoTracking().Single(r => r.Entity == ReceiptFileSplit.FileEntity && r.SpaceId == Space);
        Assert.Equal(Photo, JsonDocument.Parse(picture.DataJson).RootElement.GetProperty("dataUrl").GetString());

        // a device learns of it by pulling: the files before the row that names them, and nothing for a row that held nothing
        var feedOps = await db.SyncOps.AsNoTracking().Where(o => o.SpaceId == Feed).OrderBy(o => o.Seq).Select(o => o.Entity).ToListAsync(ct);
        Assert.Equal(["receipt", "receiptFile", "receiptFile", "receipt"], feedOps);
        Assert.Equal(1, await db.SyncOps.CountAsync(o => o.EntityId == "link-plain", ct));
        Assert.Equal(4, (await db.Spaces.AsNoTracking().SingleAsync(s => s.Id == Feed, ct)).LastSeq);
    }

    /// <summary>The app's receiptFiles.test.ts pins the same ids and the same stamp for the same rows: a device that
    /// still holds a row unsplit writes these very ops, and the one that comes second changes nothing.</summary>
    [Fact]
    public async Task The_ops_are_the_ones_a_device_writes_the_same_ids_stamped_right_behind_the_value_they_replace()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        await SeedAsync(db);

        await ReceiptFileSplit.RepairAsync(db, ct);

        var ops = await db.SyncOps.AsNoTracking().Where(o => o.Hlc == Old + "~").ToDictionaryAsync(o => o.OpId, ct);
        Assert.Equal(5, ops.Count);
        var photoFile = ops["a6209f0f-03d6-5b0c-bf1a-ca6ca5ff1709"];
        Assert.Equal((Space, ReceiptFileSplit.FileEntity, "8c2aa1f8-bcfd-51b6-9912-9ccb6a8eb3e7"), (photoFile.SpaceId, photoFile.Entity, photoFile.EntityId));
        var photoRow = ops["5e2cb7d8-15b7-52b5-9bb2-276f3ba6291c"];
        Assert.Equal(("receiptLink", "link-photo"), (photoRow.Entity, photoRow.EntityId));
        var invoiceFile = ops["9568cdfd-cd6d-533d-8204-93a5b4204dd5"];
        Assert.Equal((Feed, ReceiptFileSplit.FileEntity, "4999ca75-da96-587d-b1a7-44753c9ca707"), (invoiceFile.SpaceId, invoiceFile.Entity, invoiceFile.EntityId));
        var invoiceRow = ops["9a5d84f4-7274-5490-9462-6d31bd5aef30"];
        Assert.Equal(("receipt", Receipt), (invoiceRow.Entity, invoiceRow.EntityId));
    }

    [Fact]
    public async Task What_a_device_wrote_after_the_old_value_still_wins_whenever_it_arrives()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        await SeedAsync(db);
        await ReceiptFileSplit.RepairAsync(db, ct);

        // written on a phone before the repair ran, pushed after it: later than the old list, so it replaces the split one
        var feed = await db.Spaces.SingleAsync(s => s.Id == Feed, ct);
        var newer = Fields(new { documents = new object[] { new { kind = "invoice", mime = "application/pdf", filename = "nieuw.pdf", fileId = "rfile-nieuw" } } });
        await new SyncWriter(db).ApplyAsync(feed, null, [new SyncOpDto("op-newer", Feed, "receipt", Receipt, newer, "000000200-0000-devB")]);
        await db.SaveChangesAsync(ct);

        Assert.Equal("nieuw.pdf", Assert.Single(Data(db, "receipt", Receipt).GetProperty("documents").EnumerateArray()).GetProperty("filename").GetString());
    }

    [Fact]
    public async Task A_row_a_fast_clock_stamped_in_the_future_is_split_like_any_other()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        var ahead = ServerHlc.Encode(DateTimeOffset.UtcNow.AddYears(1).ToUnixTimeMilliseconds(), 0).Replace(ServerHlc.DeviceId, "devA", StringComparison.Ordinal);
        await RowAsync(db, Space, "receiptLink", "link-ahead", new { source = "photo", date = "2026-05-29", totalCents = 1500, image = Photo }, ahead);

        Assert.Equal(1, await ReceiptFileSplit.RepairAsync(db, ct));

        Assert.Equal(JsonValueKind.Null, Data(db, "receiptLink", "link-ahead").GetProperty("image").ValueKind);
    }

    [Fact]
    public async Task A_removed_row_is_slimmed_too_and_stays_removed()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        await RowAsync(db, Space, "receiptLink", "link-gone", new { txId = "pay-1", source = "photo", date = "2026-05-29", totalCents = 1500, image = Photo }, removed: true);

        Assert.Equal(1, await ReceiptFileSplit.RepairAsync(db, ct));

        var gone = db.EntityRows.AsNoTracking().Single(r => r.EntityId == "link-gone");
        Assert.True(gone.Deleted);
        Assert.DoesNotContain("base64", gone.DataJson);
        // an edit made on a device while it was removed brings the row back, and its picture is there
        var picture = db.EntityRows.AsNoTracking().Single(r => r.Entity == ReceiptFileSplit.FileEntity);
        Assert.False(picture.Deleted);
        Assert.Equal(ImportIds.ReceiptFileId("link-gone", "image"), picture.EntityId);
    }

    [Fact]
    public async Task It_runs_once_per_database_and_a_second_start_writes_nothing()
    {
        using var db = Db();
        var ct = CancellationToken.None;
        await SeedAsync(db);

        Assert.Equal(2, await ReceiptFileSplit.RunOnceAsync(db, NullLogger.Instance, ct));
        var ops = await db.SyncOps.CountAsync(ct);
        Assert.Equal(0, await ReceiptFileSplit.RunOnceAsync(db, NullLogger.Instance, ct));

        Assert.Equal(ops, await db.SyncOps.CountAsync(ct));
        Assert.NotNull(await db.AppSettings.FindAsync([ReceiptFileSplit.SettingKey], ct));
        // run again by hand (the remembered key aside), nothing is left to move
        Assert.Equal(0, await ReceiptFileSplit.RepairAsync(db, ct));
    }

    [Fact]
    public void A_file_is_named_and_spelled_the_same_by_every_writer()
    {
        // the app's feedIds.ts receiptFileId answers these for the same owner and slot
        Assert.Equal("4999ca75-da96-587d-b1a7-44753c9ca707", ImportIds.ReceiptFileId(Receipt, ImportIds.ReceiptDocumentSlot(0)));
        Assert.Equal("8c2aa1f8-bcfd-51b6-9912-9ccb6a8eb3e7", ImportIds.ReceiptFileId("link-photo", ImportIds.ReceiptImageSlot));

        var first = ReceiptFileSplit.FileOp(Feed, Receipt, "file-1", Pdf, ServerHlc.Now());
        var again = ReceiptFileSplit.FileOp(Feed, Receipt, "file-1", Pdf, ServerHlc.Now(7));
        var changed = ReceiptFileSplit.FileOp(Feed, Receipt, "file-1", Pdf + "Mg==", ServerHlc.Now());
        // the same content under the same id is one op: an invoice the repair moved is not sent again by the next fetch
        Assert.Equal(first.OpId, again.OpId);
        Assert.NotEqual(first.OpId, changed.OpId);
        Assert.Equal(Receipt, first.Fields["ownerId"].GetString());
        Assert.Equal(Pdf, first.Fields["dataUrl"].GetString());
    }
}

// the ingest writes the same shape from the start: a class of its own, with the relay behind it
public class ReceiptFileIngestTests(Connectors.ConnectorApiFactory factory) : IClassFixture<Connectors.ConnectorApiFactory>
{
    /// <summary>#630: a receipt is read with every pass over receipts, what it holds only when it is opened.</summary>
    [Fact]
    public async Task An_invoice_lands_as_a_file_of_its_own_and_the_receipt_names_it()
    {
        const string sub = "invoice-keeper";
        using var client = factory.ClientFor(sub);
        Assert.True((await client.GetAsync("/connectors")).IsSuccessStatusCode);
        var userId = factory.Read(db => db.Users.Single(u => u.Sub == sub).Id);
        using var scope = factory.Services.CreateScope();
        var ingest = ActivatorUtilities.CreateInstance<ConnectorIngest>(scope.ServiceProvider);
        var ct = CancellationToken.None;
        // parsed, as the relay hands records over; one document without content keeps no place: the next is the first
        JsonObject Receipt(string content) => JsonNode.Parse($$"""
            {"id":"rcp_1","external_id":"o-1","purchased_at":"2026-05-29T10:00:00+02:00","total":{"value":4999,"currency":"EUR"},
             "documents":[{"kind":"invoice","filename":"leeg.pdf"},
                          {"kind":"invoice","media_type":"application/pdf","filename":"factuur.pdf","size_bytes":5,"content_base64":"{{content}}"}]}
            """)!.AsObject();

        var first = await ingest.IngestAsync(userId, "bol", "bol.com", "conn-1", "receipt", [Receipt("JVBERi0=")], ct);

        // counted by receipt: the invoice is part of it
        Assert.Equal(1, first.Counts.Receipts);
        var feedId = ImportIds.PersonalFeedSpaceId(ImportIds.ReceiptFeedRef("conn-1"), sub);
        const string receiptId = "rcp2:bol:conn-1:o-1";
        var fileId = ImportIds.ReceiptFileId(receiptId, ImportIds.ReceiptDocumentSlot(0));
        var receipt = JsonDocument.Parse(factory.Read(db => db.EntityRows.Single(r => r.SpaceId == feedId && r.Entity == "receipt").DataJson)).RootElement;
        var document = Assert.Single(receipt.GetProperty("documents").EnumerateArray());
        Assert.Equal(fileId, document.GetProperty("fileId").GetString());
        Assert.Equal("factuur.pdf", document.GetProperty("filename").GetString());
        Assert.Equal(5, document.GetProperty("sizeBytes").GetInt32());
        Assert.DoesNotContain("base64", receipt.GetRawText());
        var file = JsonDocument.Parse(factory.Read(db => db.EntityRows.Single(r => r.SpaceId == feedId && r.Entity == ReceiptFileSplit.FileEntity && r.EntityId == fileId).DataJson)).RootElement;
        Assert.Equal("data:application/pdf;base64,JVBERi0=", file.GetProperty("dataUrl").GetString());
        Assert.Equal(receiptId, file.GetProperty("ownerId").GetString());
        // a device pulls the file before the receipt that names it
        Assert.Equal([ReceiptFileSplit.FileEntity, "receipt"], factory.Read(db => db.SyncOps.Where(o => o.SpaceId == feedId).OrderBy(o => o.Seq).Select(o => o.Entity).ToList()));

        // the same receipt fetched again sends nothing; a corrected invoice sends the file alone
        Assert.Equal(0, (await ingest.IngestAsync(userId, "bol", "bol.com", "conn-1", "receipt", [Receipt("JVBERi0=")], ct)).Counts.Receipts);
        Assert.Equal(2, factory.Read(db => db.SyncOps.Count(o => o.SpaceId == feedId)));
        await ingest.IngestAsync(userId, "bol", "bol.com", "conn-1", "receipt", [Receipt("JVBERi0y")], ct);
        Assert.Equal([ReceiptFileSplit.FileEntity, "receipt", ReceiptFileSplit.FileEntity], factory.Read(db => db.SyncOps.Where(o => o.SpaceId == feedId).OrderBy(o => o.Seq).Select(o => o.Entity).ToList()));
    }
}
