using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

/// <summary>
/// bol's order overview, as bol's own front end reads it.
///
/// CONFIRMED live on 2026-08-02 against a real account, which is what makes
/// this shape different from the two beside it: the page is a shell, the first
/// orders arrive rendered into it, and every "Toon meer" posts
/// <c>OrdersOverviewClient</c> to <c>/api/graphql</c> as an automatic persisted
/// query - a hash, no document.
///
/// Two things about the payload matter more than the rest.
///
/// The price is <c>listPrice.priceInclVat.amount</c>, a JSON number in MAJOR
/// units, and it is the price of ONE. The page that produced this capture
/// showed "2 x EUR 21,24" against an amount of 21.24, so a line total is
/// quantity times amount. bol's money hazard - both units wrong the same way,
/// reconciling perfectly, undetectable downstream - is settled by that
/// observation rather than by inference.
///
/// And there is no order total anywhere. Summing the lines is the only total
/// available, so every receipt from here is marked
/// <see cref="Receipt.TotalIsDerived"/> and therefore not reconciled: checking
/// our own sum against the lines it came from could never fail, and a check
/// that cannot fail must not be reported as one that passed.
/// </summary>
internal sealed class BolGraphQlShape : IBolOrdersShape
{
    /// <summary>
    /// What a refusal's detail starts with, after the provider id. The
    /// adapter tells a refused operation from any other shape change by it.
    /// </summary>
    public const string RefusedMarker = "graphql refused";

    private const string VariablesKey = "variables";

    public string Name => "graphql";

    public string ConfigHint =>
        "if bol has shipped a new front end, the persisted-query hash it pins is the first thing to move: " +
        "see BolOptions.OrdersPersistedQueryHash";

    public string Accept => "application/json";

    /// <summary>Always: <c>ShopOrder</c> has no total field at all.</summary>
    public bool TotalIsDerived => true;

    public string Url(BolOptions options, int page)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.GraphQlUrl;
    }

    /// <summary>
    /// The operation, named again in a header. bol's edge rejects the request
    /// with a 400 before GraphQL sees it when this is missing, which is exactly
    /// how this adapter's first live run failed.
    /// </summary>
    public IReadOnlyList<KeyValuePair<string, string>> Headers(BolOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return [new KeyValuePair<string, string>(options.OperationNameHeader, options.OrdersOperationName)];
    }

    /// <summary>
    /// The cursor is an offset counted in orders, as a string, exactly as bol
    /// sends it: page one asks for <c>"0"</c>, page two for <c>"5"</c>.
    /// </summary>
    public string? Body(BolOptions options, int page)
    {
        ArgumentNullException.ThrowIfNull(options);

        var after = (Math.Max(0, page - 1) * Math.Max(1, options.OrdersPageSize)).ToString(CultureInfo.InvariantCulture);

        return Replayed(options, after) ?? Rebuilt(options, after);
    }

    /// <summary>
    /// The page's own body with only the cursor rewritten - 2026-10-07
    /// (prod), see <see cref="BolOptions.OrdersRequestTemplate"/> - or null
    /// for a session that learned none. A template that is not a body with
    /// variables in it falls back to the rebuilt shape too, rather than
    /// sending bol something no page ever sent.
    /// </summary>
    private static string? Replayed(BolOptions options, string after)
    {
        if (string.IsNullOrWhiteSpace(options.OrdersRequestTemplate)) return null;

        try
        {
            if (JsonNode.Parse(options.OrdersRequestTemplate) is not JsonObject body) return null;
            if (body[VariablesKey] is not JsonObject variables) return null;

            variables[options.AfterVariable] = after;
            return body.ToJsonString();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The operation from the settings alone: the shape every fetch sent before a sign-in learned the page's own.</summary>
    private static string Rebuilt(BolOptions options, string after) =>
        new JsonObject
        {
            ["operationName"] = options.OrdersOperationName,
            [VariablesKey] = new JsonObject
            {
                [options.AfterVariable] = after,
            },
            ["extensions"] = new JsonObject
            {
                ["persistedQuery"] = new JsonObject
                {
                    ["version"] = 1,
                    ["sha256Hash"] = options.OrdersPersistedQueryHash,
                },
            },
        }.ToJsonString();

    public IReadOnlyList<BolOrder> Parse(string body, BolOptions options, TimeZoneInfo zone, bool keepRaw = false, Action<string>? warn = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        using var document = Parse(body);
        var root = document.RootElement;

        // GraphQL reports failure in the body with a 200. But an errors array
        // BESIDE data is a partial result - one field failed, the rest is
        // there - not a refusal: 2026-10-07 (prod) "Error(s) redacted." came
        // with data.me.orders of a signed-in customer, and refusing the page
        // kept every sync on "the party changed its site". So the orders are
        // looked for first; only a page WITHOUT them is refused, and the
        // errors beside a read page are noted for the operator.
        var errors = root.Items("errors").ToList();
        var me = root.Child("data").Child("me");

        if (me.ValueKind == JsonValueKind.Undefined)
        {
            Refuse(root, errors, options);
            throw ConnectorException.ProviderChanged(
                $"{BolAdapter.ProviderId}: the response carries no data.me.orders; {ConfigHint}");
        }

        // A signed-out request is a 200 with a valid payload that simply has no
        // orders on it. Checked BEFORE the missing-field branch below, because
        // the two are indistinguishable by shape alone and only one of them is
        // a provider change - reporting an expired session as "bol rebuilt its
        // site" sends the user nowhere and an operator hunting for nothing.
        if (string.Equals(
                JsonAccess.StrOf(me, "__typename"), options.AnonymousTypeName, StringComparison.Ordinal))
        {
            Refuse(root, errors, options); // beside errors: the detail names what bol left
            throw ConnectorException.SessionExpired(
                $"{BolAdapter.ProviderId}: bol answered as {options.AnonymousTypeName}, so the stored session " +
                "is no longer signed in. bol issues no refresh token, so this needs a new login.");
        }

        var orders = me.Child("orders");

        // a null orders field is an empty history - unless errors stand beside it, which is the field having failed
        if (orders.ValueKind == JsonValueKind.Undefined || (orders.ValueKind == JsonValueKind.Null && errors.Count > 0))
        {
            Refuse(root, errors, options);
            throw ConnectorException.ProviderChanged(
                $"{BolAdapter.ProviderId}: the response carries no data.me.orders; {ConfigHint}");
        }

        // Null is an answer - an account that has never ordered - and not a
        // shape change.
        if (orders.ValueKind == JsonValueKind.Null) return [];

        if (orders.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{BolAdapter.ProviderId}: data.me.orders is a {orders.ValueKind}, not a list");
        }

        if (errors.Count > 0)
        {
            warn?.Invoke(
                $"{BolAdapter.ProviderId}: bol answered the orders with {errors.Count} error(s) beside them - a field that " +
                $"failed, read as a partial page ({BolRefusal.Describe(root, errors, options)})");
        }

        var parsed = new List<BolOrder>();

        foreach (var order in orders.EnumerateArray())
        {
            if (Read(order, options, zone, keepRaw) is { } one) parsed.Add(one);
        }

        return parsed;
    }

    private static BolOrder? Read(JsonElement order, BolOptions options, TimeZoneInfo zone, bool keepRaw)
    {
        var reference = JsonAccess.StrOf(order, "reference");

        // A row with no reference cannot be keyed, so it cannot be deduped
        // against a later pass either. Skipped rather than invented.
        if (string.IsNullOrWhiteSpace(reference)) return null;

        var items = new List<ReceiptItem>();
        var total = 0L;
        string? seller = null;

        foreach (var line in order.Items("items"))
        {
            if (!Read(line, options, out var item, out var lineSeller)) continue;

            items.Add(item);
            total += item.Total.Value;

            // bol is a marketplace and the seller is per LINE, so one order can
            // carry several. Naming the first is honest for the common case and
            // never claims to be the only one.
            seller ??= lineSeller;
        }

        return new BolOrder
        {
            Id = reference,
            PlacedAt = BolDate.Parse(JsonAccess.StrOf(order, "creationDateTime"), zone, "creationDateTime"),
            Total = new Money(total, options.Currency),
            SellerName = seller,
            Items = items,

            // The order as bol sent it, whole - which is what makes it worth
            // having when a field moves and our reading of it stops matching.
            Raw = keepRaw ? order.GetRawText() : null,
        };
    }

    private static bool Read(JsonElement line, BolOptions options, out ReceiptItem item, out string? seller)
    {
        item = null!;
        seller = null;

        var offer = line.Child("offerInformation");

        var name = JsonAccess.StrOf(offer, "productTitle");
        if (string.IsNullOrWhiteSpace(name)) return false;

        // A GraphQL field that is nullable arrives as JSON null when it is
        // absent, so a line whose price bol declined to state used to take the
        // whole fetch out as `internal` instead of being skipped like every
        // other unreadable line here. JsonRead answers "not there" for a null
        // as readily as for a missing field, which is what this needs.
        var incl = offer.Child("listPrice").Child("priceInclVat");

        if (incl.ValueKind != JsonValueKind.Object) return false;

        // Major units, stated as a number. Declared rather than sniffed: the
        // whole point of BolOptions.ItemUnit is that a unit is never inferred
        // from a value.
        var unit = MoneyReader.Require(incl, options.GraphQlAmountUnit, options.Currency, "listPrice.priceInclVat", "amount");

        var quantity = line.Int32("quantity") ?? 1;
        if (quantity < 1) quantity = 1;

        var named = JsonAccess.StrOf(offer.Child("retailer"), "name");
        if (!string.IsNullOrWhiteSpace(named)) seller = named;

        item = new ReceiptItem
        {
            Name = name,
            Quantity = quantity,
            UnitPrice = unit,
            Total = new Money(unit.Value * quantity, unit.Currency),
        };

        return true;
    }

    /// <summary>
    /// The errors array, read before the data is trusted - GraphQL reports
    /// failure in the body with a 200, and a hash bol has forgotten arrives
    /// here rather than as a status code.
    ///
    /// 2026-10-07 (prod): the old reading kept the message and threw the
    /// rest away, and "Error(s) redacted." told nobody whether bol had
    /// refused the hash, the variables or the session. The detail now
    /// carries what tells those apart, as tokens and never as free text -
    /// see <see cref="BolRefusal"/>. And an anonymous <c>data.me</c> beside
    /// the errors is the session being over, not a change: the verdict the
    /// signed-out answer without errors gets below.
    /// </summary>
    private static void Refuse(JsonElement root, List<JsonElement> errors, BolOptions options)
    {
        if (errors.Count == 0) return;

        var detail = BolRefusal.Describe(root, errors, options);

        if (string.Equals(BolRefusal.Typename(root), options.AnonymousTypeName, StringComparison.Ordinal))
        {
            throw ConnectorException.SessionExpired(
                $"{BolAdapter.ProviderId}: bol answered as {options.AnonymousTypeName} beside the refusal, so the " +
                $"stored session is no longer signed in. bol issues no refresh token, so this needs a new login ({detail})");
        }

        throw ConnectorException.ProviderChanged(detail);
    }

    private static JsonDocument Parse(string body)
    {
        try
        {
            return JsonDocument.Parse(body);
        }
        catch (JsonException ex)
        {
            throw ConnectorException.ProviderChanged(
                $"{BolAdapter.ProviderId}: the orders response is not JSON ({ex.Message})");
        }
    }
}

/// <summary>
/// A refusal's detail, self-explaining and safe to log.
///
/// One <c>name=value</c> token per fact, every value identifier-like -
/// letters, digits and <c>_.:-</c>, at most <see cref="MaxTokenLength"/>
/// characters - so the detail can be read, grouped and logged without ever
/// carrying a party's free text. The facts are the ones that tell the cases
/// apart (2026-10-07, prod): how many errors, their code, the extension
/// keys, the path, whether <c>data</c> was there at all, what <c>data.me</c>
/// says it is, which hash was in use and whether the body was the page's own
/// replay or the rebuilt shape. Per the GraphQL spec a request refused
/// before running has no <c>data</c> entry - an unknown hash, variables it
/// no longer takes - while one that ran carries it, null or not; that one
/// distinction is what "Error(s) redacted." withheld.
/// </summary>
internal static class BolRefusal
{
    public const int MaxTokenLength = 64;

    private const string Absent = "absent";

    /// <summary>The detail, with the reading of the <c>data</c> entry spelled out after the tokens.</summary>
    public static string Describe(JsonElement root, IReadOnlyList<JsonElement> errors, BolOptions options)
    {
        ArgumentNullException.ThrowIfNull(errors);
        ArgumentNullException.ThrowIfNull(options);

        var first = errors.Count > 0 ? errors[0] : default;
        var extensions = first.Child("extensions");
        var data = Data(root);

        var tokens = string.Join(' ',
            $"message={Token(JsonAccess.StrOf(first, "message"))}",
            $"errors={errors.Count}",
            $"code={Token(JsonAccess.StrOf(extensions, "code", "classification", "errorType"))}",
            $"extensions={Keys(extensions)}",
            $"path={Path(first)}",
            $"data={data}",
            $"me={Token(Typename(root))}",
            $"hash={Token(BolPersistedQuery.Prefix(options.OrdersPersistedQueryHash))}",
            $"body={(options.OrdersRequestTemplate is null ? "rebuilt" : "replay")}");

        var reading = data == Absent
            ? "absent data means bol refused the request before running it - a hash it does not know, or variables it no longer takes"
            : "data means the operation ran, so bol knew the hash and the refusal is about the request itself or the session";

        return $"{BolAdapter.ProviderId}: {BolGraphQlShape.RefusedMarker} {options.OrdersOperationName}: {tokens}; " +
               $"{reading}; see BolOptions.OrdersPersistedQueryHash";
    }

    /// <summary>What <c>data.me</c> says it is, or null.</summary>
    public static string? Typename(JsonElement root) => JsonAccess.StrOf(root.Child("data").Child("me"), "__typename");

    /// <summary>
    /// A party's value as a token: letters, digits and <c>_.:-</c> survive,
    /// anything else becomes <c>-</c>, and it is cut at <see cref="MaxTokenLength"/>.
    /// </summary>
    public static string Token(string? value)
    {
        if (string.IsNullOrEmpty(value)) return BolPersistedQuery.None;

        var kept = new StringBuilder(Math.Min(value.Length, MaxTokenLength));
        foreach (var c in value)
        {
            if (kept.Length == MaxTokenLength) break;
            kept.Append(char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or ':' or '-' ? c : '-');
        }

        return kept.ToString();
    }

    /// <summary>absent, null or present - the one fact "Error(s) redacted." withheld.</summary>
    private static string Data(JsonElement root)
    {
        var data = root.Child("data");
        if (data.ValueKind == JsonValueKind.Undefined) return Absent;

        return data.ValueKind == JsonValueKind.Null ? "null" : "present";
    }

    /// <summary>The extension KEYS, never their values: the keys say what bol states about an error, the values could say anything.</summary>
    private static string Keys(JsonElement extensions)
    {
        if (extensions.ValueKind != JsonValueKind.Object) return BolPersistedQuery.None;

        var names = extensions.EnumerateObject().Select(property => Token(property.Name)).ToList();
        return names.Count == 0 ? BolPersistedQuery.None : string.Join(',', names);
    }

    private static string Path(JsonElement error)
    {
        var segments = error.Items("path").Select(segment => Token(JsonAccess.Str(segment))).ToList();
        return segments.Count == 0 ? BolPersistedQuery.None : string.Join('.', segments);
    }
}
