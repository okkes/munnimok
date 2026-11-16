using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Jumbo;

// the list states the total, the line items come from a separate OrderPagesOrder call
// kept apart they are a real reconciliation pair
internal sealed record JumboOrderSummary
{
    public required string OrderId { get; init; }

    public required DateTimeOffset PurchasedAt { get; init; }

    public required Money Total { get; init; }

    public string? StoreName { get; init; }

    // a verbatim copy of somebody's shopping: held only on request
    public string? Raw { get; init; }
}

internal sealed record JumboOrderDetail
{
    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    public ReceiptPayment Payment { get; init; } = ReceiptFactory.Payment();
}

// the money unit is declared per field, never guessed: order amounts are decimal-string euros
// catalogue prices are cents, one field apart
internal static class JumboOrders
{
    private const string ProviderId = JumboAdapter.ProviderId;

    // an unresolved path is provider_changed, not an empty list: "never shopped at Jumbo" is a worse lie than an outage
    public static IReadOnlyList<JsonElement> Rows(JsonElement root, JumboOptions options)
    {
        if (!JsonAccess.TryPath(root, options.OnlineOrdersPath, out var node))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: no order collection at '{options.OnlineOrdersPath}'");
        }

        return node.ValueKind == JsonValueKind.Array ? JsonAccess.AsArray(node) : [];
    }

    // absent when unreadable: it only bounds the walk as a courtesy
    public static int? TotalCount(JsonElement root, JumboOptions options) =>
        JsonAccess.TryPath(root, options.OnlineOrdersTotalPath, out var node) ? node.Int32() : null;

    public static JumboOrderSummary? ParseSummary(
        JsonElement row, JumboOptions options, TimeZoneInfo zone, bool keepRaw = false)
    {
        var id = JsonAccess.StrOf(row, "orderId");
        if (string.IsNullOrWhiteSpace(id)) return null;

        // currency is stated on the money object; the option is only a fallback
        var currency = JsonAccess.TryProp(row, out var money, "totalToPayMoneyType")
            ? MoneyReader.Currency(money, options.Currency)
            : options.Currency;

        // decimal-string euros, declared (see JumboOptions.OrderTotalUnit)
        var total = MoneyReader.Optional(row, options.OrderTotalUnit, currency,
                        $"order[{id}].totalToPayMoneyType", "totalToPayMoneyType")
                    ?? throw ConnectorException.ProviderChanged(
                        $"{ProviderId}: order '{id}' states no totalToPayMoneyType");

        return new JumboOrderSummary
        {
            OrderId = id,
            // deliveryDate has no offset: read in Europe/Amsterdam, else a near-midnight order lands on the wrong day
            PurchasedAt = ReceiptTime.Parse(
                JsonAccess.StrOf(row, "deliveryDate"), zone, ProviderId, $"order[{id}].deliveryDate"),
            Total = total,
            StoreName = JsonAccess.StrOf(row, "branchName"),
            Raw = keepRaw ? row.GetRawText() : null,
        };
    }

    // Total is the price before discount and Discount the gap to the price after: they sum to what Jumbo says the line cost
    public static JumboOrderDetail ParseDetail(
        JsonElement root, JumboOptions options, string currency, string orderId)
    {
        if (!JsonAccess.TryPath(root, options.OrderDetailPath, out var order))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: order '{orderId}' detail has nothing at '{options.OrderDetailPath}'");
        }

        var items = new List<ReceiptItem>();

        foreach (var line in JsonAccess.Array(order, "items"))
        {
            var name = LineName(line);
            var field = $"order[{orderId}].item[{name}]";

            var gross = MoneyReader.Optional(line, options.OrderLineUnit, currency,
                $"{field}.linePriceExDiscount", "linePriceExDiscount");
            var net = MoneyReader.Optional(line, options.OrderLineUnit, currency,
                $"{field}.linePriceIncDiscount", "linePriceIncDiscount");

            if (gross is null && net is null)
            {
                // both price fields gone is the schema moving, not a free product
                throw ConnectorException.ProviderChanged(
                    $"{ProviderId}: order '{orderId}' line '{name}' states neither " +
                    "linePriceExDiscount nor linePriceIncDiscount");
            }

            var total = gross ?? net!.Value;

            items.Add(new ReceiptItem
            {
                Name = name,
                Quantity = JsonAccess.Quantity(line, "quantity", "orderedQuantity", "pickedQuantity"),
                UnitPrice = UnitPrice(line, options, currency, field),
                Total = total,
                Discount = Discount(line, total, net),
            });
        }

        AddDeposits(items, order, options, currency, orderId);
        AddSurcharges(items, order, options, currency, orderId);

        return new JumboOrderDetail
        {
            Items = items,
            // paymentMethod is a bare string, no card or IBAN tail: an explicit null tells the consumer its transaction match is weaker
            Payment = ReceiptFactory.Payment(JumboReceipts.Method(JsonAccess.StrOf(order, "paymentMethod"))),
        };
    }

    private static string LineName(JsonElement line)
    {
        if (JsonAccess.TryProp(line, out var details, "details"))
        {
            var title = JsonAccess.StrOf(details, "title");
            if (!string.IsNullOrWhiteSpace(title)) return title;
        }

        // the SKU beats dropping the line and its money
        return JsonAccess.StrOf(line, "sku") ?? "?";
    }

    private static Money? UnitPrice(JsonElement line, JumboOptions options, string currency, string field)
    {
        if (!JsonAccess.TryProp(line, out var perUnit, "pricePerUnit")) return null;

        // pricePerUnit wraps its money one level deeper than everything else
        // in this document: { price: { amount, currency }, unit }.
        return MoneyReader.Optional(perUnit, options.OrderLineUnit, currency, $"{field}.pricePerUnit", "price");
    }

    // from the price gap, not promotions[].discount: a third number that must agree and silently breaks the receipt
    // promotions still give the label
    private static ReceiptDiscount? Discount(JsonElement line, Money gross, Money? net)
    {
        if (net is not { } paid) return null;

        var delta = paid.Value - gross.Value;
        if (delta == 0) return null;

        return new ReceiptDiscount
        {
            // Negative by contract, whichever sign the provider chose.
            Amount = new Money(delta > 0 ? -delta : delta, gross.Currency),
            Label = PromotionLabel(line),
        };
    }

    private static string? PromotionLabel(JsonElement line)
    {
        foreach (var promotion in JsonAccess.Array(line, "promotions"))
        {
            var label = JsonAccess.StrOf(promotion, "description", "type");
            if (!string.IsNullOrWhiteSpace(label)) return label;
        }

        return null;
    }

    // deposits are money paid: leaving them out leaves an order short by the crate
    private static void AddDeposits(
        List<ReceiptItem> items, JsonElement order, JumboOptions options, string currency, string orderId)
    {
        foreach (var line in JsonAccess.Array(order, "items"))
        {
            foreach (var deposit in JsonAccess.Array(line, "deposits"))
            {
                var name = JsonAccess.StrOf(deposit, "description") ?? options.DepositLabel;
                var unit = MoneyReader.Optional(deposit, options.OrderLineUnit, currency,
                    $"order[{orderId}].deposit[{name}].unitPrice", "unitPrice");
                if (unit is not { } price) continue;

                var quantity = JsonAccess.Quantity(deposit, "quantity") ?? 1m;

                items.Add(new ReceiptItem
                {
                    Name = name,
                    Quantity = quantity,
                    UnitPrice = price,
                    // multiplied: the document states a unit price and a count but no line total; rounded away from zero like MoneyParser
                    Total = new Money(
                        (long)decimal.Round(price.Value * quantity, 0, MidpointRounding.AwayFromZero),
                        price.Currency),
                });
            }
        }
    }

    private static void AddSurcharges(
        List<ReceiptItem> items, JsonElement order, JumboOptions options, string currency, string orderId)
    {
        foreach (var line in JsonAccess.Array(order, "items"))
        {
            foreach (var surcharge in JsonAccess.Array(line, "surcharges"))
            {
                var name = JsonAccess.StrOf(surcharge, "type") ?? "surcharge";
                var value = MoneyReader.Optional(surcharge, options.OrderLineUnit, currency,
                    $"order[{orderId}].surcharge[{name}].value", "value");
                if (value is not { } amount) continue;

                items.Add(new ReceiptItem { Name = name, Total = amount });
            }
        }
    }
}

internal static class JumboReceipts
{
    public static Merchant Merchant(string? storeName) => new()
    {
        Id = JumboAdapter.ProviderId,
        Name = "Jumbo",
        StoreName = storeName,
    };

    // mapped onto the four normalized names; null stays null, a guess weakens the consumer's receipt-to-transaction match
    public static string? Method(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        if (raw.Contains("ideal", StringComparison.OrdinalIgnoreCase)) return "ideal";
        if (raw.Contains("cash", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("contant", StringComparison.OrdinalIgnoreCase))
        {
            return "cash";
        }

        return raw.Contains("card", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("pin", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("maestro", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("visa", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("mastercard", StringComparison.OrdinalIgnoreCase)
            ? "card"
            : "other";
    }
}
