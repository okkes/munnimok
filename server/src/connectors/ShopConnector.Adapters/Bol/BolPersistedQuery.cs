using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

/// bol's persisted-query hash moves with every front-end release; an unknown one answers PersistedQueryNotFound. It is
/// LEARNED at login from bol's own page and sealed in the session material; the option is the fallback. A rebuilt
/// request was refused even with that hash (prod, 2026-10-07), so the page's own body and headers ride beside it.
internal static class BolPersistedQuery
{
    public const string ExtraKey = "ordersHash";

    public const string BodyKey = "ordersBody";

    /// <summary>Where the page's request headers ride: a JSON object of name to value.</summary>
    public const string HeadersKey = "ordersHeaders";

    /// <summary>Enough of a hash to tell two apart in a note or refusal, never the whole value.</summary>
    public const int PrefixLength = 19;

    public const string None = "-";

    private static readonly IReadOnlyDictionary<string, string> NoHeaders =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// What a replay must never carry: cookie (the jar is the fetch's own), authorization, content-length and host (the
    /// transport's), accept-encoding (a client that cannot decode gets an unreadable body).
    private static readonly HashSet<string> NeverCarried = new(StringComparer.OrdinalIgnoreCase)
    {
        "cookie",
        "authorization",
        "content-length",
        "host",
        "accept-encoding",
    };

    /// <summary>How many other operations a sign-in's note names: enough to spot a rename, never a page's whole chatter.</summary>
    public const int MaxOthers = 12;

    /// <summary>A GraphQL name and nothing else: it goes into a header, a note and a refusal's detail.</summary>
    private const int MaxNameLength = 64;

    /// The orders operation by what its name contains (BolOptions.OrdersOperationMarker), never by its whole name.
    public static bool TryReadHash(string? postData, BolOptions options, out string hash)
    {
        ArgumentNullException.ThrowIfNull(options);

        hash = string.Empty;
        if (string.IsNullOrWhiteSpace(postData)) return false;
        if (!postData.Contains(options.OrdersOperationMarker, StringComparison.Ordinal)) return false;

        try
        {
            using var document = JsonDocument.Parse(postData);
            var root = document.RootElement;

            // via JsonAccess, never throwing accessors: a null where an object was expected answers "no hash" (the JSON read rule)
            var name = JsonAccess.StrOf(root, "operationName");
            if (name is not null && !name.Contains(options.OrdersOperationMarker, StringComparison.Ordinal)) return false;

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

    /// The name a request body gives its operation; null unless it is a plain GraphQL name, because the page wrote it.
    public static string? OperationName(string? postData)
    {
        if (string.IsNullOrWhiteSpace(postData)) return null;

        try
        {
            using var document = JsonDocument.Parse(postData);
            var name = JsonAccess.StrOf(document.RootElement, "operationName");

            return IsName(name) ? name : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsName(string? name) =>
        name is { Length: > 0 and <= MaxNameLength }
        && !char.IsAsciiDigit(name[0])
        && name.All(c => char.IsAsciiLetterOrDigit(c) || c == '_');

    /// Pseudo headers (:authority) are HTTP/2 framing the browser reports; no client can set them.
    public static bool MayCarry(string? name) =>
        !string.IsNullOrWhiteSpace(name) && !name.StartsWith(':') && !NeverCarried.Contains(name);

    /// Names compare case-insensitively: Playwright reports lower case, the fetch sets title case.
    public static IReadOnlyDictionary<string, string> CarryHeaders(IEnumerable<KeyValuePair<string, string>>? headers)
    {
        var carried = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (headers is null) return carried;

        foreach (var (name, value) in headers)
        {
            if (!MayCarry(name) || value is null) continue;
            carried[name] = value;
        }

        return carried;
    }

    public static Connector.Kit.Security.SessionMaterial WithHash(Connector.Kit.Security.SessionMaterial material, string? hash)
    {
        ArgumentNullException.ThrowIfNull(material);
        if (string.IsNullOrEmpty(hash)) return material;
        var extra = new Dictionary<string, string>(material.Extra, StringComparer.Ordinal) { [ExtraKey] = hash };
        return material with { Extra = extra };
    }

    public static string? Learned(Connector.Kit.Security.SessionMaterial? material) =>
        material?.Extra.TryGetValue(ExtraKey, out var hash) == true && !string.IsNullOrEmpty(hash) ? hash : null;

    public static SessionMaterial WithRequest(SessionMaterial material, BolPageRequest? request)
    {
        ArgumentNullException.ThrowIfNull(material);
        if (request is null || string.IsNullOrEmpty(request.Body)) return material;

        var extra = new Dictionary<string, string>(material.Extra, StringComparer.Ordinal) { [BodyKey] = request.Body };

        // filtered on the way in too, so a cookie the listener saw never reaches the bundle
        var headers = new JsonObject();
        foreach (var (name, value) in CarryHeaders(request.Headers))
        {
            headers[name] = value;
        }

        if (headers.Count > 0) extra[HeadersKey] = headers.ToJsonString();

        return material with { Extra = extra };
    }

    public static BolPageRequest? LearnedRequest(SessionMaterial? material)
    {
        if (material?.Extra.TryGetValue(BodyKey, out var body) != true || string.IsNullOrEmpty(body)) return null;

        var headers = material.Extra.TryGetValue(HeadersKey, out var json) ? ReadHeaders(json) : NoHeaders;
        return new BolPageRequest(body, headers);
    }

    public static string Prefix(string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return None;
        return hash.Length <= PrefixLength ? hash : hash[..PrefixLength];
    }

    /// A value that is not the object WithRequest wrote costs the headers, never the fetch (the JSON read rule);
    /// the filter applies again.
    private static IReadOnlyDictionary<string, string> ReadHeaders(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return NoHeaders;

        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return NoHeaders;

            var read = new List<KeyValuePair<string, string>>();
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (JsonAccess.Str(property.Value) is { } value) read.Add(new KeyValuePair<string, string>(property.Name, value));
            }

            return CarryHeaders(read);
        }
        catch (JsonException)
        {
            return NoHeaders;
        }
    }
}

internal sealed record BolPageRequest(string Body, IReadOnlyDictionary<string, string> Headers);
