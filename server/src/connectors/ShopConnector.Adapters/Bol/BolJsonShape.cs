using System.Globalization;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

// unconfirmed: no JSON order endpoint has been found for bol's consumer site; built anyway with alias lists and a URL
// template in BolOptions, so finding the real one takes two configuration edits and no release
// the tier could drop toward http only after a login is watched: the login is still a JS page with a reCAPTCHA key
internal sealed class BolJsonShape : IBolOrdersShape
{
    private const string ProviderId = BolAdapter.ProviderId;

    public string Name => "json";

    public string Accept => "application/json, text/plain, */*";

    public string ConfigHint =>
        "if bol serves this account page as plain HTML, set BolOptions.OrdersShape to Html; " +
        "if it is JSON at a different address, correct BolOptions.JsonOrdersUrlTemplate and " +
        "BolOptions.JsonOrderPaths";

    public string Url(BolOptions options, int page)
    {
        ArgumentNullException.ThrowIfNull(options);

        return options.JsonOrdersUrlTemplate
            .Replace("{page}", page.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
    }

    public IReadOnlyList<BolOrder> Parse(string body, BolOptions options, TimeZoneInfo zone, bool keepRaw = false, Action<string>? warn = null)
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentNullException.ThrowIfNull(options);

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(body);
        }
        catch (JsonException ex)
        {
            // non-JSON where JSON was promised is almost always an interstitial the guard did not recognise: a shape change
            throw new ConnectorException(
                ErrorCode.ProviderChanged,
                $"{ProviderId}: the orders endpoint was read as the '{Name}' shape and did not return JSON. " +
                ConfigHint,
                ex);
        }

        using (document)
        {
            var rows = Rows(document.RootElement, options);
            var orders = new List<BolOrder>(rows.Count);

            foreach (var row in rows)
            {
                if (row.ValueKind != JsonValueKind.Object) continue;
                orders.Add(ParseOrder(row, options, zone));
            }

            return orders;
        }
    }

    // an empty resolved array is an account with no orders; no path resolving is a moved shape, naming every path tried
    // (guessing which array holds orders reports wrong data silently)
    private IReadOnlyList<JsonElement> Rows(JsonElement root, BolOptions options)
    {
        if (root.ValueKind == JsonValueKind.Array) return JsonAccess.AsArray(root);

        foreach (var path in options.JsonOrderPaths)
        {
            if (!JsonAccess.TryPath(root, path, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Array) return JsonAccess.AsArray(value);

            // a wrapper around the array ({ "orders": { "items": [...] } }) is common enough for one hop, no more
            if (value.ValueKind == JsonValueKind.Object &&
                JsonAccess.TryProp(value, out var nested, "items", "results", "content", "orders") &&
                nested.ValueKind == JsonValueKind.Array)
            {
                return JsonAccess.AsArray(nested);
            }
        }

        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: the orders endpoint was read as the '{Name}' shape and carried no order array; " +
            $"tried [{string.Join(", ", options.JsonOrderPaths)}]. {ConfigHint}");
    }

    private static BolOrder ParseOrder(JsonElement row, BolOptions options, TimeZoneInfo zone)
    {
        var id = JsonAccess.StrOf(row, [.. options.JsonOrderIdNames]);
        if (string.IsNullOrWhiteSpace(id))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: an order carries no id under any of " +
                $"[{string.Join(", ", options.JsonOrderIdNames)}]. The external id is what makes a re-run " +
                "idempotent, so an order without one cannot be emitted");
        }

        var currency = MoneyReader.Currency(row, options.Currency);

        return new BolOrder
        {
            Id = id,
            PlacedAt = BolDate.Parse(
                JsonAccess.StrOf(row, [.. options.JsonOrderDateNames]), zone, $"order[{id}].date"),
            // unit declared, never sniffed: BolOptions.JsonAmountUnit is the one value here that can be wrong without anything noticing
            Total = MoneyReader.Require(
                row, options.JsonAmountUnit, currency, $"order[{id}].total", [.. options.JsonOrderTotalNames]),
            SellerName = Seller(row, options),
            Payment = Payment(row, options),
            Items = ParseItems(row, options, id, currency),
        };
    }

    private static string? Seller(JsonElement row, BolOptions options)
    {
        if (!JsonAccess.TryProp(row, out var seller, [.. options.JsonSellerNames])) return null;

        return seller.ValueKind == JsonValueKind.Object
            ? JsonAccess.StrOf(seller, "displayName", "name", "title")
            : JsonAccess.Str(seller);
    }

    private static string? PaymentMethod(JsonElement row, BolOptions options)
    {
        if (!JsonAccess.TryProp(row, out var payment, [.. options.JsonPaymentMethodNames])) return null;

        return payment.ValueKind == JsonValueKind.Object
            ? JsonAccess.StrOf(payment, "type", "method", "name", "description")
            : JsonAccess.Str(payment);
    }

    private static ReceiptPayment Payment(JsonElement row, BolOptions options)
    {
        var method = PaymentMethod(row, options);

        var masked = JsonAccess.StrOf(row, [.. options.JsonPaymentMaskNames]);
        if (masked is null && JsonAccess.TryProp(row, out var block, [.. options.JsonPaymentMethodNames]) &&
            block.ValueKind == JsonValueKind.Object)
        {
            masked = JsonAccess.StrOf(block, [.. options.JsonPaymentMaskNames]);
        }

        // explicit nulls, not an omitted block: the consumer must tell "no tail from bol" from "not considered"
        // (it disambiguates two identical purchases on one day)
        return ReceiptFactory.Payment(BolNormalize.Method(method), JsonAccess.Tail(masked));
    }

    private static List<ReceiptItem> ParseItems(
        JsonElement row, BolOptions options, string orderId, string currency)
    {
        var lines = JsonAccess.Array(row, [.. options.JsonItemArrayNames]);
        var items = new List<ReceiptItem>(lines.Count);

        foreach (var line in lines)
        {
            var name = JsonAccess.StrOf(line, [.. options.JsonItemNameNames]);
            if (string.IsNullOrWhiteSpace(name)) continue;

            var field = $"order[{orderId}].item[{name}]";
            var lineCurrency = MoneyReader.Currency(line, currency);
            var quantity = JsonAccess.Quantity(line, [.. options.JsonItemQuantityNames]);

            var unit = MoneyReader.Optional(
                line, options.JsonAmountUnit, lineCurrency, field + ".unitPrice", [.. options.JsonItemUnitPriceNames]);

            var total = MoneyReader.Optional(
                line, options.JsonAmountUnit, lineCurrency, field + ".total", [.. options.JsonItemTotalNames]);

            Money lineTotal;
            if (total is { } stated) lineTotal = stated;
            else if (unit is { } each) lineTotal = BolNormalize.Extended(each, quantity);
            else continue;

            items.Add(new ReceiptItem
            {
                Name = name,
                Quantity = quantity,
                UnitPrice = unit,
                Total = lineTotal,
                Discount = Discount(line, options, lineCurrency, field),
            });
        }

        return items;
    }
    private static ReceiptDiscount? Discount(
        JsonElement line, BolOptions options, string currency, string field)
    {
        var amount = MoneyReader.Optional(
            line, options.JsonAmountUnit, currency, field + ".discount", [.. options.JsonItemDiscountNames]);

        if (amount is not { } value || value.Value == 0) return null;

        var label = JsonAccess.TryProp(line, out var block, [.. options.JsonItemDiscountNames]) &&
                    block.ValueKind == JsonValueKind.Object
            ? JsonAccess.StrOf(block, "description", "label", "name")
            : null;

        // providers state a discount with either sign; the schema requires negative so summing for reconciliation is unconditional
        return new ReceiptDiscount
        {
            Amount = value.Value > 0 ? value.Negated() : value,
            Label = label,
        };
    }
}
