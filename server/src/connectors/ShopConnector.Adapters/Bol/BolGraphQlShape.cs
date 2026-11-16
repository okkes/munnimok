using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

// confirmed live 2026-08-02: "Toon meer" posts OrdersOverviewClient to /api/graphql as a persisted query (hash, no document)
// price = listPrice.priceInclVat.amount, MAJOR units, per ONE ("2 x EUR 21,24" = 21.24): line total = quantity * amount
// no order total anywhere: lines are summed and receipts marked TotalIsDerived (a check of our own sum cannot fail)
internal sealed class BolGraphQlShape : IBolOrdersShape
{
    // what a refusal's detail starts with after the provider id; the adapter tells a refused operation by it
    public const string RefusedMarker = "graphql refused";

    private const string VariablesKey = "variables";

    public string Name => "graphql";

    public string ConfigHint =>
        "if bol has shipped a new front end, the persisted-query hash it pins is the first thing to move: " +
        "see BolOptions.OrdersPersistedQueryHash";

    public string Accept => "application/json";

    public bool TotalIsDerived => true;

    public string Url(BolOptions options, int page)
    {
        ArgumentNullException.ThrowIfNull(options);
        return options.GraphQlUrl;
    }

    /// <summary>The operation named again in a header: bol's edge answers 400 before GraphQL without it.</summary>
    public IReadOnlyList<KeyValuePair<string, string>> Headers(BolOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return [new KeyValuePair<string, string>(options.OperationNameHeader, options.OrdersOperationName)];
    }

    /// <summary>The cursor is an offset counted in orders, as a string: page one "0", page two "5".</summary>
    public string? Body(BolOptions options, int page)
    {
        ArgumentNullException.ThrowIfNull(options);

        var after = (Math.Max(0, page - 1) * Math.Max(1, options.OrdersPageSize)).ToString(CultureInfo.InvariantCulture);

        return Replayed(options, after) ?? Rebuilt(options, after);
    }

    // the page's own body with only the cursor rewritten (2026-10-07 prod, see OrdersRequestTemplate);
    // null if none learned or the template is not a body with variables
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

        // an errors array BESIDE data is a partial result, not a refusal: "Error(s) redacted." came with a signed-in customer's
        // orders (2026-10-07 prod) and refusing the page kept every sync on "the party changed its site"; only a page WITHOUT
        // the orders is refused
        var errors = root.Items("errors").ToList();
        var me = root.Child("data").Child("me");

        if (me.ValueKind == JsonValueKind.Undefined)
        {
            Refuse(root, errors, options);
            throw ConnectorException.ProviderChanged(
                $"{BolAdapter.ProviderId}: the response carries no data.me.orders; {ConfigHint}");
        }

        // a signed-out request is a 200 without orders, indistinguishable by shape from a provider change: checked first, since
        // reporting an expired session as "bol rebuilt its site" sends the user nowhere
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

        // null is an account that never ordered, not a shape change
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

        // no reference means it cannot be keyed or deduped: skipped, not invented
        if (string.IsNullOrWhiteSpace(reference)) return null;

        var items = new List<ReceiptItem>();
        var total = 0L;
        string? seller = null;

        foreach (var line in order.Items("items"))
        {
            if (!Read(line, options, out var item, out var lineSeller)) continue;

            items.Add(item);
            total += item.Total.Value;

            // bol is a marketplace and the seller is per LINE: naming the first never claims to be the only one
            seller ??= lineSeller;
        }

        return new BolOrder
        {
            Id = reference,
            PlacedAt = BolDate.Parse(JsonAccess.StrOf(order, "creationDateTime"), zone, "creationDateTime"),
            Total = new Money(total, options.Currency),
            SellerName = seller,
            Items = items,

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

        // a nullable GraphQL field arrives as JSON null: a line without a stated price is skipped, not an internal failure
        var incl = offer.Child("listPrice").Child("priceInclVat");

        if (incl.ValueKind != JsonValueKind.Object) return false;

        // major units, declared not sniffed: BolOptions.ItemUnit exists so a unit is never inferred from a value
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

    // errors are read before the data is trusted: a hash bol forgot arrives here, not as a status code
    // "Error(s) redacted." did not say what was refused (2026-10-07 prod): the detail carries tokens (see BolRefusal);
    // an anonymous data.me beside errors is the session being over
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

// name=value tokens, identifier-like values only (letters, digits, _.:-, max MaxTokenLength): no party free text
// per the GraphQL spec a request refused before running has no data entry (unknown hash, changed variables)
internal static class BolRefusal
{
    public const int MaxTokenLength = 64;

    private const string Absent = "absent";

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

    public static string? Typename(JsonElement root) => JsonAccess.StrOf(root.Child("data").Child("me"), "__typename");

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
