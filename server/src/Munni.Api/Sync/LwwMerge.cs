using System.Text.Json;

namespace Munni.Api.Sync;

/// mirrors apps/web/src/sync/merge.ts; the server itself also produces ops (bank imports)
public sealed record SyncOpDto(
    string OpId,
    string SpaceId,
    string Entity,
    string EntityId,
    Dictionary<string, JsonElement> Fields,
    string Hlc,
    bool Deleted = false);

public sealed class EntityState
{
    public Dictionary<string, JsonElement> Data { get; init; } = new();
    public Dictionary<string, string> FieldVersions { get; init; } = new();
    public bool Deleted { get; set; }
}

/// the exact same rule as the client (apps/web/src/sync/merge.ts): any order of applying the same ops converges;
/// ordinal comparison of the fixed-width HLC strings is HLC comparison
/// "$deleted" is a pseudo-field: deleted only while its tombstone is newer than every field edit (derived, so commutative)
public static class LwwMerge
{
    public const string DeletedField = "$deleted";

    public static (EntityState State, bool Changed) Apply(EntityState? local, SyncOpDto op)
    {
        var data = new Dictionary<string, JsonElement>(local?.Data ?? new());
        var versions = new Dictionary<string, string>(local?.FieldVersions ?? new());
        var applied = 0;

        foreach (var (field, value) in op.Fields)
        {
            if (!versions.TryGetValue(field, out var current) || string.CompareOrdinal(op.Hlc, current) > 0)
            {
                versions[field] = op.Hlc;
                data[field] = value;
                applied++;
            }
        }

        if (op.Deleted && (!versions.TryGetValue(DeletedField, out var tombstone) || string.CompareOrdinal(op.Hlc, tombstone) > 0))
        {
            versions[DeletedField] = op.Hlc;
            applied++;
        }

        if (local is not null && applied == 0) return (local, false);

        var state = new EntityState { Data = data, FieldVersions = versions, Deleted = DeriveDeleted(versions) };
        return (state, true);
    }

    private static bool DeriveDeleted(Dictionary<string, string> versions)
    {
        if (!versions.TryGetValue(DeletedField, out var tombstone)) return false;
        foreach (var (field, version) in versions)
        {
            if (field != DeletedField && string.CompareOrdinal(version, tombstone) > 0) return false;
        }
        return true;
    }
}
