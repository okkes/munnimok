using System.Globalization;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>
/// One order, as <c>GetCombinedOrdersV3</c> states it.
/// </summary>
/// <remarks>
/// A record rather than a <see cref="Receipt"/> straight away, so this file can
/// be about MediaMarkt's payload and <see cref="ReceiptFactory"/> can stay the
/// single place a receipt is built.
/// </remarks>
internal sealed record MediaMarktOrder
{
    public required string Id { get; init; }

    public required DateTimeOffset PurchasedAt { get; init; }

    public required Money Total { get; init; }

    public required ReceiptPayment Payment { get; init; }

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    /// <summary>
    /// MediaMarkt's own word for where the order has got to - <c>COMPLETED</c>,
    /// <c>IN_PROGRESS</c>, <c>CREATED</c>. Not emitted; used to keep orders
    /// that have not been paid for out of a purchase history.
    /// </summary>
    public required string State { get; init; }

    /// <summary>
    /// This order's own slice of MediaMarkt's payload, kept only when the
    /// caller asked for <c>raw</c>. Per order rather than per page, because
    /// <see cref="Connector.Kit.Adapters.FetchResult.Raw"/> is keyed by
    /// external id - handing back the whole page under one order's key would
    /// give every record a copy of nine other people's purchases.
    /// </summary>
    public string? Raw { get; init; }
}

/// <summary>
/// MediaMarkt's order payload, read as JSON.
///
/// The whole contract fits in one operation. <c>GetCombinedOrdersV3</c> takes
/// <c>{limit, offset}</c> and answers with the order, its billing, its
/// fulfilments, its products and their prices - and the per-order call
/// <c>GetCombinedOrderV3</c> returns a payload byte-for-byte identical to the
/// list entry, which was checked against a live capture on 2026-08-11 rather
/// than assumed. So there is no detail request here and no N+1: a page of ten
/// orders costs one call, and every figure a receipt needs is already in it.
/// </summary>
/// <remarks>
/// FOUR IDENTITIES were established across every order in that capture - 13
/// orders, 15 product lines, 2015 to 2026 - and this reader is built on them
/// rather than on a reading of one order:
/// <list type="number">
/// <item><c>price == unitOriginal * quantity - sum(adjustments carrying a
/// value)</c>. Zero mismatches.</item>
/// <item><c>price == unit * quantity</c>. Zero mismatches - so <c>unit</c> is
/// the price actually paid per item and <c>price</c> is the line total.</item>
/// <item><c>sum(item.prices.total) == billing.total</c>. Zero.</item>
/// <item><c>subtotal + shipping == total == sum(payments)</c>. Zero.</item>
/// </list>
/// The first is what makes a discount reportable rather than guessed at: a
/// coupon of five euros spread over two lines as 3.34 and 1.66 is stated, by
/// name, with its amount, and the arithmetic closes to the cent.
/// </remarks>
internal static class MediaMarktOrders
{
    /// <summary>
    /// MONEY IS A JSON NUMBER IN EUROS, and that is the sharp edge of this
    /// provider.
    /// </summary>
    /// <remarks>
    /// <c>"amount": 4.02</c> - not a string, not minor units. As a
    /// <c>double</c>, multiplying it by 100 gives 401.99999999999994, and
    /// truncating that gives 401: a line one cent light, on a value that looks
    /// right in every log it passes through. Roughly one two-decimal value in
    /// eighteen behaves that way, which is frequent enough to corrupt real
    /// receipts and rare enough that a hand-picked test case would miss it - so
    /// the fixture is built from values that do.
    /// <para>
    /// <see cref="JsonElement.GetDecimal"/> parses the original text into a
    /// decimal exactly, and
    /// <see cref="MoneyParser.ToMinor(decimal, MoneyUnit)"/> rounds away from
    /// zero, so the path from wire to minor units never touches binary floating
    /// point. Nothing in this file may call <c>GetDouble</c>.
    /// </para>
    /// </remarks>
    public const MoneyUnit Unit = MoneyUnit.MajorDecimal;

    /// <summary>
    /// Reads a page of orders. Orders that cannot be read are skipped rather
    /// than failing the page - one malformed order should not cost somebody
    /// nine good ones - but a payload with no order list at all is a changed
    /// provider and says so.
    /// </summary>
    public static IReadOnlyList<MediaMarktOrder> Read(
        JsonDocument payload, MediaMarktOptions options, bool raw = false)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(options);

        var orders = payload.RootElement.Child("data").Child(options.OrdersField);

        if (orders.ValueKind != JsonValueKind.Array)
        {
            // A GraphQL error payload lands here too, and naming the operation
            // is what makes the difference between "MediaMarkt changed" and
            // "our persisted hash is stale" one log line away.
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

    /// <summary>
    /// How many orders MediaMarkt STATED on this page, readable or not.
    /// </summary>
    /// <remarks>
    /// The walk stops on a page that came back smaller than it asked for,
    /// because a short page is the only end-of-history MediaMarkt states - the
    /// payload carries no total count anywhere.
    /// <para>
    /// It used to measure that against the orders it managed to READ, and this
    /// reader deliberately drops orders it cannot make a receipt of. So one
    /// unreadable order on a full page made the page look short, stopped the
    /// walk, and reported the pass COMPLETE - quietly cutting a purchase
    /// history off at whatever page held the odd order, with nothing to say it
    /// had happened.
    /// </para>
    /// </remarks>
    public static int Stated(JsonDocument payload, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(options);

        var orders = payload.RootElement.Child("data").Child(options.OrdersField);

        return orders.ValueKind == JsonValueKind.Array ? orders.GetArrayLength() : 0;
    }

    /// <summary>Null when the order is missing something a receipt cannot do without.</summary>
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

    /// <summary>
    /// The order's own payload, MINUS the branches that are about the person
    /// rather than the purchase. See <see cref="MediaMarktOptions.RawRemovals"/>.
    /// </summary>
    /// <remarks>
    /// Rewritten rather than filtered downstream, because raw is staged onto the
    /// same row as the record and goes wherever that goes. A field never
    /// captured cannot leak from somewhere nobody thought to look.
    /// </remarks>
    private static string Kept(JsonElement order, MediaMarktOptions options)
    {
        using var buffer = new MemoryStream();

        using (var writer = new Utf8JsonWriter(buffer))
        {
            Copy(order, writer, path: string.Empty, options.RawRemovals);
        }

        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>
    /// Copies the payload, dropping every property whose path is named for
    /// removal.
    /// </summary>
    /// <remarks>
    /// ARRAY INDICES ARE TRANSPARENT in a path, so <c>items.deliveryAddress</c>
    /// removes that branch from every item rather than from one. That rule
    /// exists because the first version of this walked objects only, on the
    /// reasoning that no removal needed to reach through an array - and the
    /// account holder's address turned out to sit at
    /// <c>items[].deliveryAddress</c> as well as at <c>billing.address</c>. A
    /// scrub that silently misses one of the two places a home address is
    /// written is worse than none, because it looks done.
    /// </remarks>
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

    /// <summary>
    /// The product lines, flattened out of items -> fulfillments -> products.
    /// </summary>
    /// <remarks>
    /// THREE LEVELS, and the middle one is not decoration: a single order splits
    /// across fulfilments when it ships in two parcels, and the same product at
    /// the same price appears once per parcel with its own quantity. Reading
    /// only the first fulfilment loses half of a split order silently, which
    /// reconciliation would then report as a receipt that does not add up.
    /// </remarks>
    private static IEnumerable<ReceiptItem> Lines(JsonElement order, MediaMarktOptions options)
    {
        // A HOLE AT ANY LEVEL COSTS THAT ENTRY AND NOTHING ELSE.
        //
        // GraphQL nulls a list element whenever a non-nullable child of it
        // errors, so `items: [null]` is an ordinary answer rather than a
        // contrived one - and the raw reads this used to make THREW on a null
        // rather than returning false. That InvalidOperationException is not a
        // ConnectorException, so it left as `internal`: retriable, blamed on
        // us, and fatal to the whole page. Read's own contract two hundred
        // lines up says one malformed order must not cost somebody nine good
        // ones, and these three loops were the exception to it.
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

    /// <summary>
    /// One product line, with its coupon told apart from its free-delivery
    /// banner.
    /// </summary>
    /// <remarks>
    /// The line's <c>Total</c> is what it would have cost at
    /// <c>unitOriginal</c>, and the coupon is carried beside it as a negative
    /// <see cref="ReceiptDiscount"/> - which is the shape
    /// <see cref="Reconciliation.ItemsReconcile"/> is defined against: it sums
    /// <c>total + discount</c> per line and compares that to the receipt total.
    /// Reporting the already-discounted <c>price</c> as the total AND a discount
    /// beside it would double-count the coupon and fail every discounted
    /// receipt.
    /// <para>
    /// ONLY ADJUSTMENTS THAT CARRY A VALUE ARE MONEY. Of the four kinds seen
    /// live, <c>COUPON</c> states an amount and <c>PROMOTION</c> states
    /// <c>null</c> - "Gratis verzending" is a banner explaining why delivery was
    /// free, not a sum anybody was credited. Treating those as zero-valued
    /// discounts would litter every receipt with empty lines; treating them as
    /// money would be inventing it.
    /// </para>
    /// </remarks>
    private static ReceiptItem? Line(JsonElement product, MediaMarktOptions options)
    {
        if (product.ValueKind != JsonValueKind.Object) return null;

        var name = product.Text(options.ProductTitleField);
        if (string.IsNullOrWhiteSpace(name)) return null;

        var prices = product.Child("prices");
        var quantity = product.Int32("quantity") ?? 1;

        // What was actually charged for the line. Required: a line with no
        // price cannot be reconciled against anything.
        if (Amount(prices, "price") is not { } paid) return null;

        var listed = Amount(prices, "unitOriginal");
        var discount = Discount(prices, options);

        // The pre-discount total, and it is DERIVED from the list price rather
        // than from paid + discount. The two agree in the capture - that is
        // identity (1) - and deriving it this way means a provider that stops
        // stating its coupons produces a line that fails reconciliation rather
        // than one that silently balances by construction.
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

    /// <summary>
    /// The money taken off this line, negated, or null when nothing was.
    /// </summary>
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

            // The first one that names itself. A line carrying two different
            // coupons would be summed correctly and labelled after the first,
            // which is the honest limit of a single-label record - and no line
            // in the capture carries two.
            label ??= adjustment.Text("description");
        }

        return total == 0 ? null : new ReceiptDiscount { Amount = new Money(-total, currency), Label = label };
    }

    /// <summary>
    /// How the order was paid for.
    /// </summary>
    /// <remarks>
    /// THE LARGEST PART, when an order was settled with more than one
    /// instrument. A gift card plus a credit card is a real shape here - the
    /// capture holds one - and the two are not equal for the consumer's
    /// purpose: only the card reaches a bank statement, so the card is what a
    /// transaction match has to work from. Reporting the first payment would
    /// depend on MediaMarkt's ordering, and reporting nothing would throw away
    /// the useful half.
    /// <para>
    /// No card tail is stated anywhere in the payload, so
    /// <see cref="ReceiptPayment.CardLast4"/> is explicitly null - which the
    /// record documents as the way to tell a consumer that matching will be
    /// weaker, rather than leaving it looking like an oversight.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// A money block, as a <see cref="Money"/>. Null when absent or unreadable
    /// - callers decide whether that is fatal.
    /// </summary>
    private static Money? Amount(JsonElement parent, string property)
    {
        var money = parent.Child(property);

        // Decimal, never a double. See the note on Unit.
        if (money.Decimal("amount") is not { } value) return null;

        var currency = money.Text("currency") is { Length: 3 } code ? code.ToUpperInvariant() : "EUR";

        return new Money(MoneyParser.ToMinor(value, Unit), currency);
    }

    /// <summary>
    /// <c>meta.created</c>, which is ISO-8601 with a real offset - so a
    /// near-midnight order lands on the day it was placed rather than the day
    /// the reader happens to be running in.
    /// </summary>
    private static DateTimeOffset? Stamp(string? value) =>
        DateTimeOffset.TryParse(
            value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var stamp)
            ? stamp
            : null;
}
