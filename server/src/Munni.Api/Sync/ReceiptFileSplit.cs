using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Accounts;
using Munni.Api.Data;

namespace Munni.Api.Sync;

/// #630 repair: a receipt held its photo and its invoices inside its own row, and so did the copy a space keeps of a
/// linked receipt — every pass over receipts read all of them (one read of 75 million characters ended the Android app).
/// What a row held becomes receiptFile rows of the same space; the row names them. Once per database.
/// A device writes the very same ops for a row it still holds unsplit (apps/web/src/application/receiptFiles.ts): the
/// same ids, stamped right behind the value they replace — so whoever comes second changes nothing
public static class ReceiptFileSplit
{
    public const string SettingKey = "repair:receipt-files:2026-11-17";
    public const string FileEntity = "receiptFile";
    private const string ImageField = "image";
    private const string DocumentsField = "documents";
    private const string DataUrlField = "dataUrl";
    /// rows per save: each holds megabytes, and the whole table does not fit the memory a NAS gives the api
    private const int Batch = 20;
    private static readonly string[] Holders = ["receipt", "receiptLink"];

    public static async Task<int> RunOnceAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (await db.AppSettings.FindAsync([SettingKey], ct) is not null) return 0;
        var rows = await RepairAsync(db, ct);
        db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = $"{rows} rows at {DateTimeOffset.UtcNow:O}" });
        await db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("receipt-file repair: {Rows} receipt row(s) handed their photos and invoices to files of their own", rows);
        }
        return rows;
    }

    public static async Task<int> RepairAsync(AppDbContext db, CancellationToken ct)
    {
        // every receipt and link by its key alone — asking the database which of them hold something would have it read
        // every invoice in one statement; removed rows too: a pass reads them with the rest before it leaves them out
        var keys = await db.EntityRows.AsNoTracking()
            .Where(r => Holders.Contains(r.Entity))
            .OrderBy(r => r.SpaceId)
            .Select(r => new RowKey(r.SpaceId, r.Entity, r.EntityId))
            .ToListAsync(ct);
        var rows = 0;
        foreach (var batch in keys.Chunk(Batch))
        {
            foreach (var space in batch.GroupBy(k => k.SpaceId, StringComparer.Ordinal))
            {
                rows += await SplitAsync(db, space.Key, space, ct);
            }
            await db.SaveChangesAsync(ct);
            // the rows just written hold megabytes each: nothing of them is needed again
            db.ChangeTracker.Clear();
        }
        return rows;
    }

    /// <summary>A file as every writer spells it: the same content under the same id is the same op, whoever wrote it —
    /// an invoice the repair moved is not sent again when the shop is fetched next.</summary>
    public static SyncOpDto FileOp(string spaceId, string ownerId, string fileId, string dataUrl, string hlc) => new(
        ImportIds.OpId($"rfile:{fileId}:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(dataUrl)), 0, 16).ToLowerInvariant()}"),
        spaceId,
        FileEntity,
        fileId,
        new Dictionary<string, JsonElement>
        {
            ["ownerId"] = JsonSerializer.SerializeToElement(ownerId),
            [DataUrlField] = JsonSerializer.SerializeToElement(dataUrl),
        },
        hlc);

    /// the stamp right behind another: it replaces exactly the value that stamp wrote and loses to every later write —
    /// a removed row stays removed, and a field a device has changed since keeps the device's value
    private static string Behind(string stamp) => stamp + "~";

    private static async Task<int> SplitAsync(AppDbContext db, string spaceId, IEnumerable<RowKey> keys, CancellationToken ct)
    {
        var space = await db.Spaces.FindAsync([spaceId], ct);
        if (space is null) return 0;
        var ops = new List<SyncOpDto>();
        var rows = 0;
        foreach (var key in keys)
        {
            var row = await db.EntityRows.FindAsync([key.SpaceId, key.Entity, key.EntityId], ct);
            var split = row is null ? new List<SyncOpDto>() : OpsFor(row);
            if (split.Count == 0) continue;
            ops.AddRange(split);
            rows++;
        }
        if (ops.Count > 0) await new SyncWriter(db).ApplyAsync(space, null, ops);
        return rows;
    }

    /// each file before the change of the row that names it; nothing for a row that holds nothing
    private static List<SyncOpDto> OpsFor(EntityRow row)
    {
        var data = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(row.DataJson) ?? new();
        var stamps = JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson) ?? new();
        var ops = new List<SyncOpDto>();
        MoveImage(row, data, stamps, ops);
        MoveDocuments(row, data, stamps, ops);
        return ops;
    }

    private static SyncOpDto RowOp(EntityRow row, string part, Dictionary<string, JsonElement> fields, string hlc) => new(
        ImportIds.OpId($"repair:receipt-files:{row.SpaceId}:{row.Entity}:{row.EntityId}:{part}"), row.SpaceId, row.Entity, row.EntityId, fields, hlc);

    private static void MoveImage(EntityRow row, Dictionary<string, JsonElement> data, Dictionary<string, string> stamps, List<SyncOpDto> ops)
    {
        if (!data.TryGetValue(ImageField, out var image) || image.ValueKind != JsonValueKind.String) return;
        var picture = image.GetString();
        if (string.IsNullOrEmpty(picture) || !stamps.TryGetValue(ImageField, out var stamp) || stamp.Length == 0) return;
        var imageId = ImportIds.ReceiptFileId(row.EntityId, ImportIds.ReceiptImageSlot);
        var hlc = Behind(stamp);
        ops.Add(FileOp(row.SpaceId, row.EntityId, imageId, picture, hlc));
        ops.Add(RowOp(row, ImageField, new Dictionary<string, JsonElement>
        {
            [ImageField] = JsonSerializer.SerializeToElement<string?>(null),
            ["imageId"] = JsonSerializer.SerializeToElement(imageId),
        }, hlc));
    }

    private static void MoveDocuments(EntityRow row, Dictionary<string, JsonElement> data, Dictionary<string, string> stamps, List<SyncOpDto> ops)
    {
        if (!data.TryGetValue(DocumentsField, out var documents) || documents.ValueKind != JsonValueKind.Array) return;
        if (!stamps.TryGetValue(DocumentsField, out var stamp) || stamp.Length == 0) return;
        var hlc = Behind(stamp);
        var listed = new JsonArray();
        var files = new List<SyncOpDto>();
        foreach (var (document, index) in documents.EnumerateArray().Select((document, index) => (document, index)))
        {
            var node = JsonNode.Parse(document.GetRawText());
            var content = node is JsonObject holder && holder[DataUrlField] is JsonValue held && held.TryGetValue<string>(out var text) ? text : null;
            if (node is JsonObject entry && !string.IsNullOrEmpty(content))
            {
                // named by its place among the row's documents, as the ingest and a device name it
                var fileId = ImportIds.ReceiptFileId(row.EntityId, ImportIds.ReceiptDocumentSlot(index));
                files.Add(FileOp(row.SpaceId, row.EntityId, fileId, content, hlc));
                entry.Remove(DataUrlField);
                entry["fileId"] = fileId;
            }
            listed.Add(node);
        }
        if (files.Count == 0) return;
        ops.AddRange(files);
        ops.Add(RowOp(row, DocumentsField, new Dictionary<string, JsonElement> { [DocumentsField] = JsonSerializer.SerializeToElement(listed) }, hlc));
    }

    private sealed record RowKey(string SpaceId, string Entity, string EntityId);
}
