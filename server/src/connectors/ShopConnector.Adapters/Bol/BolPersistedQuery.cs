using System.Text.Json;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

/// <summary>
/// The persisted-query hash bol's own front end sends, read off the request
/// it makes.
///
/// bol pins its GraphQL operations to a sha256 hash that moves with every
/// front-end release, and a hash it no longer knows is refused with
/// <c>PersistedQueryNotFound</c>. Until 2026-10-01 the only copy lived in
/// <see cref="BolOptions.OrdersPersistedQueryHash"/> - an operator edit each
/// time, and until then every fetch failed as <c>provider_changed</c> (user
/// ss). The login runs in a real browser on bol's own orders page, and that
/// page fires the very operation this adapter needs: so the hash is LEARNED
/// there, sealed into the session's material, and the fetch sends the one
/// bol itself sent that day. The option stays as the fallback for a login
/// whose page never fired it.
/// </summary>
internal static class BolPersistedQuery
{
    /// <summary>Where the learned hash rides in <see cref="Connector.Kit.Security.SessionMaterial.Extra"/>.</summary>
    public const string ExtraKey = "ordersHash";

    /// <summary>
    /// True when <paramref name="postData"/> is the persisted operation named
    /// <paramref name="operationName"/>, with its hash in <paramref name="hash"/>
    /// exactly as bol spelled it.
    /// </summary>
    public static bool TryReadHash(string? postData, string operationName, out string hash)
    {
        hash = string.Empty;
        if (string.IsNullOrWhiteSpace(postData)) return false;
        if (!postData.Contains(operationName, StringComparison.Ordinal)) return false;

        try
        {
            using var document = JsonDocument.Parse(postData);
            var root = document.RootElement;

            // Through JsonAccess, never the runtime's throwing accessors: a
            // request body is the party's own payload, and a null where an
            // object was expected must answer "no hash", not escape as an
            // InvalidOperationException (the JSON read rule).
            var name = JsonAccess.StrOf(root, "operationName");
            if (name is not null && !string.Equals(name, operationName, StringComparison.Ordinal)) return false;

            if (!JsonAccess.TryPath(root, "extensions.persistedQuery.sha256Hash", out var value)) return false;
            if (value.ValueKind != JsonValueKind.String) return false;

            var read = JsonAccess.Str(value);
            if (string.IsNullOrWhiteSpace(read) || read.Length > 128) return false;
            hash = read;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>The material with the hash sealed in; the material as it was when there is nothing to seal.</summary>
    public static Connector.Kit.Security.SessionMaterial WithHash(Connector.Kit.Security.SessionMaterial material, string? hash)
    {
        ArgumentNullException.ThrowIfNull(material);
        if (string.IsNullOrEmpty(hash)) return material;
        var extra = new Dictionary<string, string>(material.Extra, StringComparer.Ordinal) { [ExtraKey] = hash };
        return material with { Extra = extra };
    }

    /// <summary>The hash a session learned, or null for a session that learned none.</summary>
    public static string? Learned(Connector.Kit.Security.SessionMaterial? material) =>
        material?.Extra.TryGetValue(ExtraKey, out var hash) == true && !string.IsNullOrEmpty(hash) ? hash : null;
}
