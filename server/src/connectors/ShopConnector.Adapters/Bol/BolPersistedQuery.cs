using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

/// <summary>
/// The persisted-query hash bol's own front end sends, read off the request
/// it makes - and, since 2026-10-07 (prod), that request itself.
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
///
/// 2026-10-07 (prod): the sign-in learned the hash, the fetch sent it thirty
/// seconds later, and bol still answered "Error(s) redacted.". The hash was
/// bol's own, sent by its page moments earlier, so what bol refuses is the
/// REQUEST the fetch rebuilds around it - a first-page cursor the page never
/// sends, headers the page sends and the rebuild does not. So the page's own
/// request rides beside the hash: its body (<see cref="BodyKey"/>) verbatim
/// and its headers (<see cref="HeadersKey"/>, one JSON object) minus what a
/// replay must never carry (<see cref="MayCarry"/>). The fetch replays the
/// body with only the cursor rewritten and lays the headers over its own.
/// Every value stays a string, as everything in <c>Extra</c> is.
/// </summary>
internal static class BolPersistedQuery
{
    /// <summary>Where the learned hash rides in <see cref="SessionMaterial.Extra"/>.</summary>
    public const string ExtraKey = "ordersHash";

    /// <summary>Where the page's own request body rides, verbatim.</summary>
    public const string BodyKey = "ordersBody";

    /// <summary>Where the page's request headers ride: a JSON object of name to value.</summary>
    public const string HeadersKey = "ordersHeaders";

    /// <summary>
    /// How much of a hash a note or a refusal quotes: enough to tell two
    /// apart at a glance, never the whole value.
    /// </summary>
    public const int PrefixLength = 19;

    /// <summary>What a note or a refusal says for a value there is none of.</summary>
    public const string None = "-";

    private static readonly IReadOnlyDictionary<string, string> NoHeaders =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// What a replay must never carry. The jar is the fetch's own (a stored
    /// cookie header would be the sign-in's jar frozen beside the live one),
    /// an authorization never belongs in a bundle twice, the length and the
    /// host are the transport's to state, and an accept-encoding the client
    /// cannot decode buys an unreadable body.
    /// </summary>
    private static readonly HashSet<string> NeverCarried = new(StringComparer.OrdinalIgnoreCase)
    {
        "cookie",
        "authorization",
        "content-length",
        "host",
        "accept-encoding",
    };

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

    /// <summary>
    /// Whether a header the page sent may ride in the material and go out
    /// with a replay. A pseudo header (<c>:authority</c>) is HTTP/2 framing
    /// the browser reports as if it were one, and no client can set it.
    /// </summary>
    public static bool MayCarry(string? name) =>
        !string.IsNullOrWhiteSpace(name) && !name.StartsWith(':') && !NeverCarried.Contains(name);

    /// <summary>
    /// The headers a replay may carry, out of what the page sent. Names
    /// compare case-insensitively, as HTTP's do: Playwright reports them in
    /// lower case and the fetch sets its own in title case.
    /// </summary>
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

    /// <summary>
    /// The material with the page's own request sealed in beside the hash;
    /// the material as it was when there is none to seal.
    /// </summary>
    public static SessionMaterial WithRequest(SessionMaterial material, BolPageRequest? request)
    {
        ArgumentNullException.ThrowIfNull(material);
        if (request is null || string.IsNullOrEmpty(request.Body)) return material;

        var extra = new Dictionary<string, string>(material.Extra, StringComparer.Ordinal) { [BodyKey] = request.Body };

        // Filtered on the way in as well as on the way out, so a cookie the
        // listener saw never reaches the bundle at all.
        var headers = new JsonObject();
        foreach (var (name, value) in CarryHeaders(request.Headers))
        {
            headers[name] = value;
        }

        if (headers.Count > 0) extra[HeadersKey] = headers.ToJsonString();

        return material with { Extra = extra };
    }

    /// <summary>
    /// The page's own request a session learned, or null for a session
    /// holding only a hash - or nothing - whose fetch rebuilds the shape.
    /// </summary>
    public static BolPageRequest? LearnedRequest(SessionMaterial? material)
    {
        if (material?.Extra.TryGetValue(BodyKey, out var body) != true || string.IsNullOrEmpty(body)) return null;

        var headers = material.Extra.TryGetValue(HeadersKey, out var json) ? ReadHeaders(json) : NoHeaders;
        return new BolPageRequest(body, headers);
    }

    /// <summary>
    /// The first <see cref="PrefixLength"/> characters of a hash - what a
    /// note or a refusal quotes - or <see cref="None"/> for no hash at all.
    /// </summary>
    public static string Prefix(string? hash)
    {
        if (string.IsNullOrEmpty(hash)) return None;
        return hash.Length <= PrefixLength ? hash : hash[..PrefixLength];
    }

    /// <summary>
    /// The headers back out of the bundle. A value that is not the object
    /// <see cref="WithRequest"/> wrote - a hand-edited bundle, an older
    /// build's - costs the headers and never the fetch (the JSON read rule),
    /// and the filter applies again so nothing smuggles a cookie in.
    /// </summary>
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

/// <summary>
/// The orders request as bol's own page sent it: the body verbatim, and the
/// headers a replay may carry (<see cref="BolPersistedQuery.CarryHeaders"/>).
/// </summary>
internal sealed record BolPageRequest(string Body, IReadOnlyDictionary<string, string> Headers);
