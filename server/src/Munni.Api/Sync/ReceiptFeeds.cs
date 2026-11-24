using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Social;

namespace Munni.Api.Sync;

public sealed record ReceiptFeedsCounts(int Receipts, int Shares, int References, int Kept, int Dropped);

/// #648 repair: every receipt a person fetched or scanned sat in ONE feed only they could read, and a space kept a full
/// copy of each receipt it linked. Now a receipt lives once: a connection's in that connection's feed, a scan in the
/// person's scans feed, and a space that includes a feed READS it — its link names the receipt and holds only what
/// the space decided (which payment, which lines). Once per database:
/// (1) each receipt moves to its feed under a new id (a device keys a row by id alone: the same id in two feeds is one row);
/// (2) a space that included a connection reads that connection's feed, and a person's scans are read by the spaces
///     only they are in — a space shared with others is the person's own choice afterwards;
/// (3) a link becomes a reference when its space reads the receipt's feed; a receipt a space shows on a payment but
///     cannot read stays as the space's own (what the link held), so no payment loses its receipt.
/// A device writes the very same changes for rows it still holds in the old shape
/// (apps/web/src/application/receiptFeeds.ts): the same ids, each value stamped right behind the stamp it had
public static class ReceiptFeeds
{
    public const string SettingKey = "repair:receipt-feeds:2026-11-24";
    public const string ReceiptEntity = "receipt";
    public const string LinkEntity = "receiptLink";
    public const string StoreConnEntity = "storeConn";
    public const string StoreConnLinkEntity = "storeConnLink";
    public const string ScanSource = "photo";
    public const string FeedField = "feedSpaceId";
    private const string OldReceiptPrefix = "rcpt:";
    private const string SourceField = "source";
    private const string InstanceField = "instanceId";
    private const string ReceiptIdField = "receiptId";
    private const string ImageIdField = "imageId";
    private const string DocumentsField = "documents";
    private const string FileIdField = "fileId";
    private const string DataUrlField = "dataUrl";
    private const int EntityIdMaximumLength = 128;
    /// rows per save: a receipt's files hold megabytes, and the whole table does not fit the memory a NAS gives the api
    private const int Batch = 20;

    /// what a space decided about a receipt: the whole of a link from here on
    private static readonly string[] LinkState = ["txId", "alsoTxIds", "picks", "auto", "proposedTxId", "rejectedTxIds"];
    /// the fields that say a link is attached or asks to be
    private static readonly string[] Holds = ["txId", "proposedTxId"];
    /// what a link's copy said about the receipt itself; a newer value than the receipt's own (a read made on the copy) is kept
    private static readonly string[] Facts = ["date", "totalCents", "merchant", "items", "reconciled", "currency", "payment"];
    /// a copy that becomes the space's own receipt takes everything it held, its files (which stay where they are) included
    private static readonly string[] OwnFacts = [SourceField, InstanceField, .. Facts, ImageIdField, DocumentsField, "image"];

    public static async Task<ReceiptFeedsCounts?> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return null;
        var counts = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{counts} at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "receipt-feeds repair: {Receipts} receipt(s) moved to a feed of their own, {Shares} feed(s) shared with a space, {References} link(s) now a reference, {Kept} kept as the space's own, {Dropped} dropped",
                counts.Receipts, counts.Shares, counts.References, counts.Kept, counts.Dropped);
        }
        return counts;
    }

    /// safe to run again after a start that was cut short: a receipt that already moved is found by the row it became
    public static async Task<ReceiptFeedsCounts> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        var moved = new Dictionary<string, Moved>(StringComparer.Ordinal);
        var receipts = await MoveReceiptsAsync(db, moved, ct);
        var shares = await ShareFeedsAsync(db, moved, ct);
        var (references, kept, dropped) = await TurnLinksAsync(db, moved, ct);
        return new ReceiptFeedsCounts(receipts, shares, references, kept, dropped);
    }

    // ── the shapes both writers agree on ──────────────────────────────────────────────────────────────────────────────

    /// the stamp right behind another: it replaces exactly the value that stamp wrote and loses to every later write
    public static string Behind(string stamp) => stamp + "~";

    /// <summary>The id a fetched receipt has from here on (what the ingest computes for it), or a scan's.</summary>
    public static string NewReceiptId(string oldId, bool scan)
    {
        if (scan) return Fit(ImportIds.ScannedReceiptPrefix, oldId);
        return Fit(ImportIds.FetchedReceiptPrefix, oldId.StartsWith(OldReceiptPrefix, StringComparison.Ordinal) ? oldId[OldReceiptPrefix.Length..] : oldId);
    }

    public static string SpaceReceiptId(string linkId) => Fit(ImportIds.SpaceReceiptPrefix, linkId);

    private static string Fit(string prefix, string rest) =>
        prefix.Length + rest.Length <= EntityIdMaximumLength ? prefix + rest : prefix + ImportIds.OpId(rest);

    /// A row's values under another id (or in another space), each written right behind the stamp it had: values that
    /// were written together travel together, and the change is named by what it carries — the same row moved by the
    /// server and by a device is the same change, and a device that held a newer value writes that one beside it
    public static List<SyncOpDto> MoveOps(string spaceId, string entity, string entityId, IReadOnlyDictionary<string, JsonElement> fields, IReadOnlyDictionary<string, string> stamps)
    {
        var ops = new List<SyncOpDto>();
        var stamped = fields.Keys.Where(field => stamps.TryGetValue(field, out var stamp) && stamp.Length > 0);
        foreach (var group in stamped.GroupBy(field => stamps[field], StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var names = group.OrderBy(name => name, StringComparer.Ordinal).ToList();
            ops.Add(new SyncOpDto(
                ImportIds.OpId($"move:{spaceId}:{entity}:{entityId}:{group.Key}:{string.Join(',', names)}"),
                spaceId,
                entity,
                entityId,
                names.ToDictionary(name => name, name => fields[name]),
                Behind(group.Key)));
        }
        return ops;
    }

    /// the row a move left behind, removed right behind its newest value: an edit a device still holds brings it back,
    /// and that device moves it again
    public static SyncOpDto GoneOp(string spaceId, string entity, string entityId, IReadOnlyDictionary<string, string> stamps)
    {
        var last = stamps.Where(kv => kv.Key != LwwMerge.DeletedField).Select(kv => kv.Value).Max(StringComparer.Ordinal) ?? ServerHlc.Floor;
        return new SyncOpDto(ImportIds.OpId($"moved:{spaceId}:{entity}:{entityId}:{last}"), spaceId, entity, entityId, new(), Behind(last), true);
    }

    // ── (1) receipts ───────────────────────────────────────────────────────────────────────────────────────────────────

    private sealed record Moved(string FeedId, string ReceiptId, Guid OwnerId, bool Scan, Dictionary<string, JsonElement> Data, Dictionary<string, string> Stamps);

    private sealed record RowKey(string SpaceId, string EntityId, bool Deleted);

    private static async Task<int> MoveReceiptsAsync(AppDbContext db, Dictionary<string, Moved> moved, CancellationToken ct)
    {
        var count = 0;
        var feeds = await db.FeedSpaces.AsNoTracking().Where(f => f.AccountRef == ImportIds.ConnectionsFeedRef).ToListAsync(ct);
        foreach (var feed in feeds)
        {
            var owner = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == feed.OwnerUserId, ct);
            // a feed nobody owns any more has nobody to hold what would move
            if (owner is null) continue;
            var keys = await db.EntityRows.AsNoTracking()
                .Where(r => r.SpaceId == feed.Id && r.Entity == ReceiptEntity)
                .OrderBy(r => r.EntityId)
                .Select(r => new RowKey(r.SpaceId, r.EntityId, r.Deleted))
                .ToListAsync(ct);
            foreach (var batch in keys.Chunk(Batch))
            {
                foreach (var key in batch) count += await MoveReceiptAsync(db, owner, key, moved, ct);
                await db.SaveChangesAsync(ct);
                // the files just written hold megabytes each: nothing of them is needed again
                db.ChangeTracker.Clear();
            }
        }
        return count;
    }

    private static async Task<int> MoveReceiptAsync(AppDbContext db, User owner, RowKey key, Dictionary<string, Moved> moved, CancellationToken ct)
    {
        var row = await db.EntityRows.AsNoTracking().FirstAsync(r => r.SpaceId == key.SpaceId && r.Entity == ReceiptEntity && r.EntityId == key.EntityId, ct);
        var data = Parse(row.DataJson);
        var stamps = StampsOf(row.FieldVersionsJson);
        var instanceId = Text(data, InstanceField);
        var scan = string.IsNullOrEmpty(instanceId);
        var feedId = ImportIds.PersonalFeedSpaceId(scan ? ImportIds.ScansFeedRef : ImportIds.ReceiptFeedRef(instanceId!), owner.Sub);
        var newId = NewReceiptId(row.EntityId, scan);
        if (row.Deleted)
        {
            // removed by an earlier, cut-short run of this repair (the row it became is there) — or by its owner: then it stays gone
            var became = await db.EntityRows.AsNoTracking().FirstOrDefaultAsync(r => r.SpaceId == feedId && r.Entity == ReceiptEntity && r.EntityId == newId, ct);
            if (became is not null) moved[row.EntityId] = new Moved(feedId, newId, owner.Id, scan, Parse(became.DataJson), StampsOf(became.FieldVersionsJson));
            return 0;
        }

        var target = await EnsureFeedAsync(db, owner, feedId, scan ? ImportIds.ScansFeedRef : ImportIds.ReceiptFeedRef(instanceId!), ct);
        var source = await db.Spaces.FindAsync([key.SpaceId], ct);
        if (source is null) return 0;
        var files = await MoveFilesAsync(db, key.SpaceId, feedId, newId, data, ct);
        var writer = new SyncWriter(db);
        // the files before the receipt that names them, and the old row last: a pull cut anywhere never loses the receipt
        await writer.ApplyAsync(target, null, [.. files, .. MoveOps(feedId, ReceiptEntity, newId, data, stamps)]);
        await writer.ApplyAsync(source, null, [GoneOp(key.SpaceId, ReceiptEntity, row.EntityId, stamps)]);
        moved[row.EntityId] = new Moved(feedId, newId, owner.Id, scan, data, stamps);
        return 1;
    }

    /// the receipt's photo and invoices under its new id, in its new feed; `data` names them from here on.
    /// The old files stay as they are: nothing names them any more, and nothing is lost if a device still does
    private static async Task<List<SyncOpDto>> MoveFilesAsync(AppDbContext db, string fromSpace, string toSpace, string newId, Dictionary<string, JsonElement> data, CancellationToken ct)
    {
        var ops = new List<SyncOpDto>();
        if (Text(data, ImageIdField) is { Length: > 0 } imageId)
        {
            var to = ImportIds.ReceiptFileId(newId, ImportIds.ReceiptImageSlot);
            if (await FileOpAsync(db, fromSpace, imageId, toSpace, newId, to, ct) is { } op) ops.Add(op);
            data[ImageIdField] = JsonSerializer.SerializeToElement(to);
        }
        if (data.TryGetValue(DocumentsField, out var documents) && documents.ValueKind == JsonValueKind.Array)
        {
            var listed = new List<Dictionary<string, JsonElement>>();
            foreach (var (document, index) in documents.EnumerateArray().Select((document, index) => (document, index)))
            {
                var entry = document.ValueKind == JsonValueKind.Object ? Parse(document.GetRawText()) : new();
                if (Text(entry, FileIdField) is { Length: > 0 } fileId)
                {
                    var to = ImportIds.ReceiptFileId(newId, ImportIds.ReceiptDocumentSlot(index));
                    if (await FileOpAsync(db, fromSpace, fileId, toSpace, newId, to, ct) is { } op) ops.Add(op);
                    entry[FileIdField] = JsonSerializer.SerializeToElement(to);
                }
                listed.Add(entry);
            }
            data[DocumentsField] = JsonSerializer.SerializeToElement(listed);
        }
        return ops;
    }

    /// null for a file the server never got: the device that holds it writes it under the new id itself
    private static async Task<SyncOpDto?> FileOpAsync(AppDbContext db, string fromSpace, string fromId, string toSpace, string ownerId, string toId, CancellationToken ct)
    {
        var file = await db.EntityRows.AsNoTracking().FirstOrDefaultAsync(r => r.SpaceId == fromSpace && r.Entity == ReceiptFileSplit.FileEntity && r.EntityId == fromId, ct);
        if (file is null || file.Deleted) return null;
        var content = Text(Parse(file.DataJson), DataUrlField);
        if (string.IsNullOrEmpty(content) || !StampsOf(file.FieldVersionsJson).TryGetValue(DataUrlField, out var stamp) || stamp.Length == 0) return null;
        return ReceiptFileSplit.FileOp(toSpace, ownerId, toId, content, Behind(stamp));
    }

    private static async Task<Space> EnsureFeedAsync(AppDbContext db, User owner, string feedId, string accountRef, CancellationToken ct)
    {
        if (await db.FeedSpaces.FindAsync([feedId], ct) is null)
        {
            db.FeedSpaces.Add(new FeedSpace { Id = feedId, OwnerUserId = owner.Id, AccountRef = ImportIds.Normalize(accountRef) });
        }
        var space = await db.Spaces.FindAsync([feedId], ct);
        if (space is null)
        {
            space = new Space { Id = feedId };
            db.Spaces.Add(space);
        }
        var member = db.SpaceMembers.Local.Any(m => m.SpaceId == feedId && m.UserId == owner.Id)
            || await db.SpaceMembers.AnyAsync(m => m.SpaceId == feedId && m.UserId == owner.Id, ct);
        if (!member) db.SpaceMembers.Add(new SpaceMember { SpaceId = feedId, UserId = owner.Id, Role = SpaceRoles.Owner });
        return space;
    }

    // ── (2) who reads which feed ───────────────────────────────────────────────────────────────────────────────────────

    private static async Task<int> ShareFeedsAsync(AppDbContext db, Dictionary<string, Moved> moved, CancellationToken ct)
    {
        var shares = await ShareConnectionsAsync(db, ct);
        shares += await ShareScansAsync(db, moved, ct);
        await db.SaveChangesAsync(ct);
        db.ChangeTracker.Clear();
        return shares;
    }

    /// a space that included a connection (its storeConnLink row) reads that connection's feed, and its row says which
    private static async Task<int> ShareConnectionsAsync(AppDbContext db, CancellationToken ct)
    {
        var shares = 0;
        var links = await db.EntityRows.AsNoTracking().Where(r => r.Entity == StoreConnLinkEntity && !r.Deleted).ToListAsync(ct);
        foreach (var link in links)
        {
            var data = Parse(link.DataJson);
            var stamps = StampsOf(link.FieldVersionsJson);
            var instanceId = Text(data, InstanceField);
            if (string.IsNullOrEmpty(instanceId) || !string.IsNullOrEmpty(Text(data, FeedField)) || !stamps.TryGetValue(InstanceField, out var stamp)) continue;
            var owner = await ConnectionOwnerAsync(db, instanceId, ct);
            // the connection is gone, or the person who brought it left: nobody shares it with this space any more
            if (owner is null || !await MayWriteAsync(db, link.SpaceId, owner.Id, ct)) continue;
            var space = await db.Spaces.FindAsync([link.SpaceId], ct);
            if (space is null) continue;

            var feedRef = ImportIds.ReceiptFeedRef(instanceId);
            var feedId = ImportIds.PersonalFeedSpaceId(feedRef, owner.Sub);
            await EnsureFeedAsync(db, owner, feedId, feedRef, ct);
            if (await AttachAsync(db, link.SpaceId, feedId, owner.Id, ct)) shares++;
            var fields = new Dictionary<string, JsonElement> { [FeedField] = JsonSerializer.SerializeToElement(feedId) };
            await new SyncWriter(db).ApplyAsync(space, null, MoveOps(link.SpaceId, StoreConnLinkEntity, link.EntityId, fields, new Dictionary<string, string> { [FeedField] = stamp }));
            await db.SaveChangesAsync(ct);
        }
        return shares;
    }

    private static async Task<User?> ConnectionOwnerAsync(AppDbContext db, string instanceId, CancellationToken ct)
    {
        var connection = await db.EntityRows.AsNoTracking().FirstOrDefaultAsync(r => r.Entity == StoreConnEntity && r.EntityId == instanceId && !r.Deleted, ct);
        if (connection is null) return null;
        var feed = await db.FeedSpaces.AsNoTracking().FirstOrDefaultAsync(f => f.Id == connection.SpaceId, ct);
        return feed is null ? null : await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == feed.OwnerUserId, ct);
    }

    private static async Task<bool> MayWriteAsync(AppDbContext db, string spaceId, Guid userId, CancellationToken ct)
    {
        var member = await db.SpaceMembers.AsNoTracking().FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId, ct);
        return member is not null && SpaceRoles.CanWrite(member.Role);
    }

    /// false when the space read the feed already
    private static async Task<bool> AttachAsync(AppDbContext db, string spaceId, string feedId, Guid by, CancellationToken ct)
    {
        if (db.SpaceStoreLinks.Local.Any(l => l.SpaceId == spaceId && l.FeedSpaceId == feedId)
            || await db.SpaceStoreLinks.AnyAsync(l => l.SpaceId == spaceId && l.FeedSpaceId == feedId, ct)) return false;
        db.SpaceStoreLinks.Add(new SpaceStoreLink { Id = Guid.NewGuid(), SpaceId = spaceId, FeedSpaceId = feedId, AttachedBy = by });
        return true;
    }

    /// The row a space keeps for a scans feed it reads, as the app writes it; stamped lowest: whatever a device says wins
    public static SyncOpDto ScansLinkOp(string spaceId, string feedId) => new(
        ImportIds.OpId($"scans:{spaceId}:{feedId}"),
        spaceId,
        StoreConnLinkEntity,
        ImportIds.StoreConnLinkId(spaceId, feedId),
        new Dictionary<string, JsonElement>
        {
            [InstanceField] = JsonSerializer.SerializeToElement(feedId),
            ["store"] = JsonSerializer.SerializeToElement(ScanSource),
            ["displayName"] = JsonSerializer.SerializeToElement(string.Empty),
            [FeedField] = JsonSerializer.SerializeToElement(feedId),
        },
        ServerHlc.Floor);

    /// A person's scans were theirs in every space they opened; a space only they are in keeps reading them. A space with
    /// other members does not start to: those members never saw the scans that were not put on a payment there
    private static async Task<int> ShareScansAsync(AppDbContext db, Dictionary<string, Moved> moved, CancellationToken ct)
    {
        var shares = 0;
        foreach (var scans in moved.Values.Where(m => m.Scan).GroupBy(m => (m.OwnerId, m.FeedId)))
        {
            var (ownerId, feedId) = scans.Key;
            var mine = await db.SpaceMembers.AsNoTracking().Where(m => m.UserId == ownerId).Select(m => m.SpaceId).ToListAsync(ct);
            var feeds = await db.FeedSpaces.AsNoTracking().Where(f => mine.Contains(f.Id)).Select(f => f.Id).ToListAsync(ct);
            foreach (var spaceId in mine.Except(feeds, StringComparer.Ordinal))
            {
                if (await db.SpaceMembers.CountAsync(m => m.SpaceId == spaceId, ct) != 1) continue;
                var space = await db.Spaces.FindAsync([spaceId], ct);
                if (space is null) continue;
                if (await AttachAsync(db, spaceId, feedId, ownerId, ct)) shares++;
                await new SyncWriter(db).ApplyAsync(space, null, [ScansLinkOp(spaceId, feedId)]);
                await db.SaveChangesAsync(ct);
            }
        }
        return shares;
    }

    // ── (3) links ──────────────────────────────────────────────────────────────────────────────────────────────────────

    private static async Task<(int References, int Kept, int Dropped)> TurnLinksAsync(AppDbContext db, Dictionary<string, Moved> moved, CancellationToken ct)
    {
        var read = (await db.SpaceStoreLinks.AsNoTracking().Select(l => new { l.SpaceId, l.FeedSpaceId }).ToListAsync(ct))
            .Select(l => (l.SpaceId, l.FeedSpaceId))
            .ToHashSet();
        var keys = await db.EntityRows.AsNoTracking()
            .Where(r => r.Entity == LinkEntity && !r.Deleted)
            .OrderBy(r => r.SpaceId)
            .Select(r => new RowKey(r.SpaceId, r.EntityId, r.Deleted))
            .ToListAsync(ct);
        var (references, kept, dropped) = (0, 0, 0);
        foreach (var batch in keys.Chunk(Batch * 5))
        {
            foreach (var key in batch)
            {
                var turn = await TurnLinkAsync(db, key, moved, read, ct);
                if (turn == Turn.Reference) references++;
                else if (turn == Turn.Kept) kept++;
                else if (turn == Turn.Dropped) dropped++;
            }
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
        }
        return (references, kept, dropped);
    }

    private enum Turn
    {
        None,
        Reference,
        Kept,
        Dropped,
    }

    private static async Task<Turn> TurnLinkAsync(AppDbContext db, RowKey key, Dictionary<string, Moved> moved, HashSet<(string, string)> read, CancellationToken ct)
    {
        var row = await db.EntityRows.AsNoTracking().FirstAsync(r => r.SpaceId == key.SpaceId && r.Entity == LinkEntity && r.EntityId == key.EntityId, ct);
        var data = Parse(row.DataJson);
        var stamps = StampsOf(row.FieldVersionsJson);
        // a link that carries no copy is a reference already
        if (!stamps.TryGetValue(SourceField, out var born) || born.Length == 0) return Turn.None;
        var space = await db.Spaces.FindAsync([key.SpaceId], ct);
        if (space is null) return Turn.None;

        var writer = new SyncWriter(db);
        var gone = GoneOp(key.SpaceId, LinkEntity, row.EntityId, stamps);
        var global = Text(data, ReceiptIdField) is { Length: > 0 } receiptId && moved.TryGetValue(receiptId, out var found) ? found : null;
        if (global is not null && read.Contains((key.SpaceId, global.FeedId)))
        {
            if (FactsToKeep(global, data, stamps) is { Count: > 0 } newer && await db.Spaces.FindAsync([global.FeedId], ct) is { } feed)
            {
                await writer.ApplyAsync(feed, null, newer);
            }
            await writer.ApplyAsync(space, null, [.. LinkOps(key.SpaceId, global.ReceiptId, global.FeedId, data, stamps, born), gone]);
            return Turn.Reference;
        }
        // the receipt is its owner's and this space does not read it: only what the space shows on a payment is its to keep
        if (global is not null && !Holds.Any(field => !string.IsNullOrEmpty(Text(data, field))))
        {
            await writer.ApplyAsync(space, null, [gone]);
            return Turn.Dropped;
        }
        var own = SpaceReceiptId(row.EntityId);
        var facts = OwnFacts.Where(data.ContainsKey).ToDictionary(field => field, field => data[field]);
        await writer.ApplyAsync(space, null, [.. MoveOps(key.SpaceId, ReceiptEntity, own, facts, stamps), .. LinkOps(key.SpaceId, own, key.SpaceId, data, stamps, born), gone]);
        return Turn.Kept;
    }

    /// what the space decided, under the id a link to that receipt has; the receipt it names is stamped as the copy was born
    private static List<SyncOpDto> LinkOps(string spaceId, string receiptId, string feedId, Dictionary<string, JsonElement> data, Dictionary<string, string> stamps, string born)
    {
        var fields = LinkState.Where(data.ContainsKey).ToDictionary(field => field, field => data[field]);
        var fieldStamps = LinkState.Where(stamps.ContainsKey).ToDictionary(field => field, field => stamps[field]);
        fields[ReceiptIdField] = JsonSerializer.SerializeToElement(receiptId);
        fields[FeedField] = JsonSerializer.SerializeToElement(feedId);
        fieldStamps[ReceiptIdField] = born;
        fieldStamps[FeedField] = born;
        return MoveOps(spaceId, LinkEntity, ImportIds.ReceiptLinkId(spaceId, receiptId), fields, fieldStamps);
    }

    /// what the copy knew better than the receipt (a read made on the copy): written to the receipt, each value behind its stamp
    private static List<SyncOpDto> FactsToKeep(Moved receipt, Dictionary<string, JsonElement> copy, Dictionary<string, string> stamps)
    {
        var newer = Facts
            .Where(field => copy.ContainsKey(field) && stamps.TryGetValue(field, out var stamp) && stamp.Length > 0
                && (!receipt.Stamps.TryGetValue(field, out var own) || string.CompareOrdinal(stamp, own) > 0)
                && (!receipt.Data.TryGetValue(field, out var held) || held.GetRawText() != copy[field].GetRawText()))
            .ToDictionary(field => field, field => copy[field]);
        return MoveOps(receipt.FeedId, ReceiptEntity, receipt.ReceiptId, newer, stamps);
    }

    private static Dictionary<string, JsonElement> Parse(string json) => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? new();

    private static Dictionary<string, string> StampsOf(string json) => JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new();

    private static string? Text(Dictionary<string, JsonElement> data, string field) =>
        data.TryGetValue(field, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
