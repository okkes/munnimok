using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Sync;

/// #648: a photo its owner deleted (after a reading they trust) is gone from the server as well. Removing the row is
/// not enough: the change that once brought the picture still holds it in the log, megabytes of it. What the file
/// held is emptied in the row and in every earlier change of it; the changes themselves stay, so a device that
/// replays the log still ends at a removed file
public static class ReceiptFilePurge
{
    private const string DataUrlField = "dataUrl";

    /// after the push was merged, before it is saved
    public static async Task DropContentAsync(AppDbContext db, string spaceId, IReadOnlyList<SyncOpDto> ops)
    {
        var removed = ops.Where(op => op.Deleted && op.Entity == ReceiptFileSplit.FileEntity).Select(op => op.EntityId).Distinct(StringComparer.Ordinal).ToList();
        foreach (var fileId in removed)
        {
            var row = await db.EntityRows.FindAsync(spaceId, ReceiptFileSplit.FileEntity, fileId);
            // a write made after the removal keeps the file: what it holds is still somebody's
            if (row is null || !row.Deleted) continue;
            row.DataJson = Emptied(row.DataJson);
            var earlier = await db.SyncOps
                .Where(op => op.SpaceId == spaceId && op.Entity == ReceiptFileSplit.FileEntity && op.EntityId == fileId && !op.Deleted)
                .ToListAsync();
            foreach (var op in earlier) op.PayloadJson = Emptied(op.PayloadJson);
        }
    }

    private static string Emptied(string json)
    {
        var fields = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? new();
        if (!fields.TryGetValue(DataUrlField, out var content) || content.ValueKind != JsonValueKind.String || content.GetString() is not { Length: > 0 }) return json;
        fields[DataUrlField] = JsonSerializer.SerializeToElement(string.Empty);
        return JsonSerializer.Serialize(fields);
    }
}
