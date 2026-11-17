using System.Globalization;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// a record, not a Receipt: keeps this file about MediaMarkt's payload and ReceiptFactory the one place a receipt is built
internal sealed record MediaMarktOrder
{
    public required string Id { get; init; }

    public required DateTimeOffset PurchasedAt { get; init; }

    public required Money Total { get; init; }

    public required ReceiptPayment Payment { get; init; }

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    /// MediaMarkt's order state (COMPLETED, IN_PROGRESS, CREATED); not emitted, keeps unpaid orders out of a purchase history
    public required string State { get; init; }

    /// per order, not per page: Raw is keyed by external id, and a page under one key hands each record nine other purchases
    public string? Raw { get; init; }
}

/// GetCombinedOrderV3 per order is identical to the list entry (checked 2026-08-11): no detail request, no N+1
/// four identities held over 13 orders, 15 lines: price == unitOriginal*quantity - sum(valued adjustments);
/// price == unit*quantity; sum(item prices.total) == billing.total; subtotal + shipping == total == sum(payments)
internal static class MediaMarktOrders
{
    /// money is a JSON number in euros ("amount": 4.02): as a double x100 gives 401.99999999999994, a cent short when truncated
    /// GetDecimal plus ToMinor never touches binary floating point; nothing here may call GetDouble
    public const MoneyUnit Unit = MoneyUnit.MajorDecimal;

    /// an unreadable order is skipped so one malformed order does not cost nine good ones; no order list is a changed provider
    public static IReadOnlyList<MediaMarktOrder> Read(
        JsonDocument payload, MediaMarktOptions options, bool raw = false)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(options);

        var orders = payload.RootElement.Child("data").Child(options.OrdersField);

        if (orders.ValueKind != JsonValueKind.Array)
        {
            // a GraphQL error payload lands here; naming the operation separates "MediaMarkt changed" from "our persisted hash is stale"
            throw ConnectorException.ProviderChanged(
                $"{MediaMarktAdapter.ProviderId}: {options.OrdersOperation} answered without a " +
                $"'data.{options.OrdersField}' array");
        }

        var read = new List<MediaMarktOrder>();

        foreach (var order in orders.EnumerateArray())
        {
            if (One(order, options, raw) is { } parsed) read.Add(parsed);
        }

        return read;
    }

    /// counts what MediaMarkt STATED, readable or not: Read drops unreadable orders, so one odd order made a full page look
    /// short and ended the walk reported complete
    public static int Stated(JsonDocument payload, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(options);

        var orders = payload.RootElement.Child("data").Child(options.OrdersField);

        return orders.ValueKind == JsonValueKind.Array ? orders.GetArrayLength() : 0;
    }

    private static MediaMarktOrder? One(JsonElement order, MediaMarktOptions options, bool raw)
    {
        if (order.ValueKind != JsonValueKind.Object) return null;

        var id = order.Text("id");
        if (string.IsNullOrWhiteSpace(id)) return null;

        var billing = order.Child("billing");

        if (Stamp(order.Child("meta").Text(options.PurchasedAtField)) is not { } purchasedAt) return null;
        if (Amount(billing, "total") is not { } total) return null;

        return new MediaMarktOrder
        {
            Id = id,
            PurchasedAt = purchasedAt,
            Total = total,
            Payment = Payment(billing, options),
            Items = [.. Lines(order, options)],
            State = order.Text("state") ?? string.Empty,
            Raw = raw ? Kept(order, options) : null,
        };
    }

    /// the payload minus the person's branches (RawRemovals), cut at the source: raw travels with the record
    private static string Kept(JsonElement order, MediaMarktOptions options)
    {
        using var buffer = new MemoryStream();

        using (var writer = new Utf8JsonWriter(buffer))
        {
            Copy(order, writer, path: string.Empty, options.RawRemovals);
        }

        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// array indices are transparent: items.deliveryAddress goes from every item; the home address sits there as well as at
    /// billing.address, and a scrub missing one of them looks done
    private static void Copy(
        JsonElement element, Utf8JsonWriter writer, string path, IReadOnlyList<string> removals)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();

                foreach (var property in element.EnumerateObject())
                {
                    var child = path.Length == 0 ? property.Name : $"{path}.{property.Name}";

                    if (removals.Contains(child, StringComparer.OrdinalIgnoreCase)) continue;

                    writer.WritePropertyName(property.Name);
                    Copy(property.Value, writer, child, removals);
                }

                writer.WriteEndObject();
                break;

            case JsonValueKind.Array:
                writer.WriteStartArray();

                foreach (var item in element.EnumerateArray()) Copy(item, writer, path, removals);

                writer.WriteEndArray();
                break;

            default:
                element.WriteTo(writer);
                break;
        }
    }

    /// three levels: an order splits into fulfilments (parcels), the same product once per parcel; the first alone loses half
    private static IEnumerable<ReceiptItem> Lines(JsonElement order, MediaMarktOptions options)
    {
        // a hole at any level costs that entry only: GraphQL nulls a list element when a non-nullable child
        // errors (`items: [null]`); a throw there is no ConnectorException, so it left as a retriable internal error
        // fatal to the page
        foreach (var item in order.Items("items"))
        {
            foreach (var fulfillment in item.Items("fulfillments"))
            {
                foreach (var product in fulfillment.Items("products"))
                {
                    if (Line(product, options) is { } line) yield return line;
                }
            }
        }
    }

    /// Total is the price at unitOriginal, the coupon a negative Discount: the shape ItemsReconcile sums; the discounted price
    /// plus a discount would double-count. Only adjustments carrying a value are money:
    /// COUPON states one, PROMOTION null (a banner)
    private static ReceiptItem? Line(JsonElement product, MediaMarktOptions options)
    {
        if (product.ValueKind != JsonValueKind.Object) return null;

        var name = product.Text(options.ProductTitleField);
        if (string.IsNullOrWhiteSpace(name)) return null;

        var prices = product.Child("prices");
        var quantity = product.Int32("quantity") ?? 1;

        if (Amount(prices, "price") is not { } paid) return null;

        var listed = Amount(prices, "unitOriginal");
        var discount = Discount(prices, options);

        // derived from the list price, not paid + discount: a provider that stops stating coupons then fails reconciliation
        // instead of balancing by construction
        var gross = listed is { } list ? new Money(list.Value * quantity, list.Currency) : paid;

        return new ReceiptItem
        {
            Name = name,
            Kind = ReceiptLineKind.Product,
            Quantity = quantity,
            UnitPrice = listed ?? Amount(prices, "unit"),
            Total = gross,
            Discount = discount,
        };
    }

    private static ReceiptDiscount? Discount(JsonElement prices, MediaMarktOptions options)
    {
        var adjustments = prices.Child("adjustments");

        if (adjustments.ValueKind != JsonValueKind.Array) return null;

        var total = 0L;
        string? label = null;
        var currency = options.Currency;

        foreach (var adjustment in adjustments.EnumerateArray())
        {
            if (Amount(adjustment, "value") is not { } value) continue;

            total += value.Value;
            currency = value.Currency;

            // the label is the first adjustment's: two coupons sum correctly but a single-label record carries one name
            label ??= adjustment.Text("description");
        }

        return total == 0 ? null : new ReceiptDiscount { Amount = new Money(-total, currency), Label = label };
    }

    /// the LARGEST payment wins: only a card reaches a bank statement, and the first one depends on MediaMarkt's order
    /// no card tail is in the payload, so CardLast4 is explicitly null: matching will be weaker
    private static ReceiptPayment Payment(JsonElement billing, MediaMarktOptions options)
    {
        string? method = null;
        var largest = long.MinValue;

        foreach (var payment in billing.Items("payments"))
        {
            var amount = Amount(payment, "amount")?.Value ?? 0;
            if (amount <= largest) continue;

            largest = amount;
            method = payment.Text("method");
        }

        return ReceiptFactory.Payment(options.PaymentMethod(method));
    }

    private static Money? Amount(JsonElement parent, string property)
    {
        var money = parent.Child(property);

        if (money.Decimal("amount") is not { } value) return null;

        var currency = money.Text("currency") is { Length: 3 } code ? code.ToUpperInvariant() : "EUR";

        return new Money(MoneyParser.ToMinor(value, Unit), currency);
    }

    /// meta.created is ISO-8601 with a real offset, so a near-midnight order lands on its own day
    private static DateTimeOffset? Stamp(string? value) =>
        DateTimeOffset.TryParse(
            value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var stamp)
            ? stamp
            : null;
}
