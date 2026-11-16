using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Jumbo;

// a receipt summary has no total and no items: an in-store receipt costs a second round trip
internal sealed record JumboStoreReceiptSummary
{
    public required string TransactionId { get; init; }

    public required DateTimeOffset PurchasedAt { get; init; }

    public string? Source { get; init; }

    public string? StoreName { get; init; }

    // an ONLINE receipt's transaction id is <orderId>-…: the only thing that stops the purchase being emitted twice
    public string? OrderId { get; init; }
}

// any part may be absent; which one is the diagnosis
internal sealed record JumboReceiptContents
{
    public Money? Total { get; init; }

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    public string? PaymentMethod { get; init; }

    // why this is less than a whole receipt, in operator-facing words; null when the layout parsed completely
    public string? Shortfall { get; init; }
}

// text parsing is guesswork: behind an interface with recorded fixtures
// a till template change moves only this implementation, visibly in a diff
internal interface IJumboReceiptLayoutParser
{
    JumboReceiptContents Parse(string layout, JumboOptions options, string currency);
}

internal static class JumboStoreReceipts
{
    private const string ProviderId = JumboAdapter.ProviderId;

    private static readonly Regex OrderIdPrefix =
        new(@"^(\d+)-", RegexOptions.None, TimeSpan.FromMilliseconds(100));

    public static IReadOnlyList<JsonElement> Rows(JsonElement root, JumboOptions options)
    {
        if (!JsonAccess.TryPath(root, options.StoreReceiptsPath, out var node))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: no receipt collection at '{options.StoreReceiptsPath}'");
        }

        return node.ValueKind == JsonValueKind.Array ? JsonAccess.AsArray(node) : [];
    }

    public static int? TotalResults(JsonElement root, JumboOptions options) =>
        JsonAccess.TryPath(root, options.StoreReceiptsTotalPath, out var node) ? node.Int32() : null;

    public static JumboStoreReceiptSummary? ParseSummary(JsonElement row, JumboOptions options, TimeZoneInfo zone)
    {
        var id = JsonAccess.StrOf(row, "transactionId");
        if (string.IsNullOrWhiteSpace(id)) return null;

        var match = OrderIdPrefix.Match(id);

        return new JumboStoreReceiptSummary
        {
            TransactionId = id,
            PurchasedAt = ReceiptTime.Parse(
                JsonAccess.StrOf(row, "purchaseEndOn"), zone, ProviderId, $"receipt[{id}].purchaseEndOn"),
            Source = JsonAccess.StrOf(row, "receiptSource"),
            StoreName = JsonAccess.TryProp(row, out var store, "store") ? JsonAccess.StrOf(store, "name") : null,
            OrderId = match.Success ? match.Groups[1].Value : null,
        };
    }

    // null when the image is not the JSON layout: an older picture receipt is a real answer, not a shape change
    // the caller decides
    public static string? Layout(JsonElement root, JumboOptions options, string transactionId)
    {
        if (!JsonAccess.TryPath(root, options.DigitalReceiptPath, out var receipt))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: receipt '{transactionId}' detail has nothing at '{options.DigitalReceiptPath}'");
        }

        if (!JsonAccess.TryProp(receipt, out var image, "receiptImage"))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: receipt '{transactionId}' detail states no receiptImage");
        }

        var type = JsonAccess.StrOf(image, "type");
        if (!string.Equals(type, options.DigitalReceiptJsonType, StringComparison.OrdinalIgnoreCase)) return null;

        var payload = JsonAccess.StrOf(image, "image");
        return string.IsNullOrWhiteSpace(payload) ? null : payload;
    }

    public static string? StoreName(JsonElement root, JumboOptions options)
    {
        if (!JsonAccess.TryPath(root, options.DigitalReceiptPath, out var receipt)) return null;

        return JsonAccess.TryProp(receipt, out var store, "store") ? JsonAccess.StrOf(store, "name") : null;
    }
}

// nothing invented: no item without an amount, no discount from a promotion flag (the price is printed already net)
// nothing dropped: a total without items still becomes a receipt, flagged as not reconciling
internal sealed partial class JumboPrintLayoutParser : IJumboReceiptLayoutParser
{
    [GeneratedRegex(@"^\s*(\d+)\s*[Xx]\s*(\d+[,.]\d+)\s*$")]
    private static partial Regex QuantityLine { get; }

    // anchored: a loose match reads the 1,5 of "COCA COLA 1,5L" as money; the trailing minus is how a till prints a credit
    [GeneratedRegex(@"^-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2}-?$")]
    private static partial Regex PrintedAmount { get; }

    public JumboReceiptContents Parse(string layout, JumboOptions options, string currency)
    {
        ArgumentNullException.ThrowIfNull(options);

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(layout);
        }
        catch (JsonException ex)
        {
            // the field is documented as a layout document: anything else is the provider moving
            throw new ConnectorException(
                ErrorCode.ProviderChanged, $"{JumboAdapter.ProviderId}: the receipt layout is not JSON", ex);
        }

        using (document)
        {
            var lines = Flatten(document.RootElement, options);
            if (lines.Count == 0)
            {
                return new JumboReceiptContents
                {
                    Shortfall = $"no text lines under '{options.PrintSectionsPath}'",
                };
            }

            var totalIndex = IndexOfPrefix(lines, options.TotalPrefix, from: 0, requireAmount: true);
            var total = totalIndex >= 0 ? Amount(lines[totalIndex].Fields, options, currency) : null;

            var headerIndex = HeaderIndex(lines, options);
            var payment = PaymentMethod(lines, options);

            // no terminator means no total, and Jumbo's API has no other source for one: items without a total to check are not offered
            if (totalIndex < 0)
            {
                return new JumboReceiptContents
                {
                    PaymentMethod = payment,
                    Shortfall = $"no '{options.TotalPrefix}' line",
                };
            }

            if (headerIndex < 0 || totalIndex <= headerIndex)
            {
                // a total with no readable item block is still a receipt; the caller flags it
                return new JumboReceiptContents
                {
                    Total = total,
                    PaymentMethod = payment,
                    Shortfall = headerIndex < 0
                        ? $"no items header ({string.Join("/", options.ItemsHeaderTokens)})"
                        : $"the '{options.TotalPrefix}' line is above the items header",
                };
            }

            return new JumboReceiptContents
            {
                Total = total,
                Items = Items(lines, headerIndex + 1, totalIndex, options, currency),
                PaymentMethod = payment,
            };
        }
    }

    // fields stay separate: the columns (description, promotion flag, amount) are the only structure
    internal static IReadOnlyList<PrintLine> Flatten(JsonElement root, JumboOptions options)
    {
        if (!WalkPath(root, options.PrintSectionsPath, out var sections) ||
            sections.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var lines = new List<PrintLine>();

        foreach (var section in sections.EnumerateArray())
        {
            foreach (var textObject in JsonAccess.Array(section, "textObjects"))
            {
                foreach (var textLine in JsonAccess.Array(textObject, "textLines"))
                {
                    var fields = Fields(textLine);
                    if (fields.Count > 0) lines.Add(new PrintLine(fields));
                }
            }
        }

        return lines;
    }

    private static List<string> Fields(JsonElement textLine)
    {
        var fields = new List<string>();

        foreach (var text in JsonAccess.Array(textLine, "texts"))
        {
            var value = JsonAccess.StrOf(text, "text");
            if (value is not null) fields.Add(value.Trim());
        }

        return fields;
    }

    internal static bool WalkPath(JsonElement root, string path, out JsonElement value)
    {
        value = root;

        foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
            {
                if (value.ValueKind != JsonValueKind.Array || index < 0 || index >= value.GetArrayLength())
                {
                    value = default;
                    return false;
                }

                value = value[index];
                continue;
            }

            if (!JsonAccess.TryProp(value, out var next, segment))
            {
                value = default;
                return false;
            }

            value = next;
        }

        return true;
    }

    private static List<ReceiptItem> Items(
        IReadOnlyList<PrintLine> lines, int from, int to, JumboOptions options, string currency)
    {
        var items = new List<ReceiptItem>();

        for (var i = from; i < to; i++)
        {
            var fields = lines[i].Fields;

            // "2 X 0,94" amends the item above it; with none above, it is a stray and ignored
            var quantity = QuantityLine.Match(fields[0]);
            if (quantity.Success)
            {
                if (items.Count == 0) continue;

                items[^1] = items[^1] with
                {
                    Quantity = decimal.Parse(quantity.Groups[1].Value, CultureInfo.InvariantCulture),
                    UnitPrice = new Money(
                        MoneyParser.ToMinor(quantity.Groups[2].Value, options.StoreReceiptUnit, "receipt.unitPrice"),
                        currency),
                };

                continue;
            }

            if (Amount(fields, options, currency) is not { } amount) continue;

            var name = fields[0];
            if (string.IsNullOrWhiteSpace(name)) continue;

            // a line of only the promotion flag continues the item above: as an item it would add a "P" line and double-count
            if (string.Equals(name, options.PromotionFlag, StringComparison.OrdinalIgnoreCase)) continue;

            // a single-column line that is only a number is not an item
            if (PrintedAmount.IsMatch(name)) continue;

            items.Add(new ReceiptItem { Name = name, Total = amount });
        }

        return items;
    }

    private static int HeaderIndex(IReadOnlyList<PrintLine> lines, JumboOptions options)
    {
        for (var i = 0; i < lines.Count; i++)
        {
            var text = lines[i].Text;
            if (options.ItemsHeaderTokens.All(t => text.Contains(t, StringComparison.OrdinalIgnoreCase))) return i;
        }

        return -1;
    }

    private static int IndexOfPrefix(
        IReadOnlyList<PrintLine> lines, string prefix, int from, bool requireAmount)
    {
        for (var i = from; i < lines.Count; i++)
        {
            var fields = lines[i].Fields;
            if (!fields[0].StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            if (requireAmount && !fields.Any(f => PrintedAmount.IsMatch(f))) continue;

            return i;
        }

        return -1;
    }

    private static string? PaymentMethod(IReadOnlyList<PrintLine> lines, JumboOptions options)
    {
        var index = IndexOfPrefix(lines, options.PaidPrefix, from: 0, requireAmount: false);
        if (index < 0) return null;

        foreach (var field in lines[index].Fields.Skip(1))
        {
            if (field.Length > 0 && !PrintedAmount.IsMatch(field)) return JumboReceipts.Method(field);
        }

        return index + 1 < lines.Count ? JumboReceipts.Method(lines[index + 1].Fields[0]) : null;
    }

    // rightmost: money is in the last column, and a description containing a number must not read as one
    private static Money? Amount(IReadOnlyList<string> fields, JumboOptions options, string currency)
    {
        for (var i = fields.Count - 1; i >= 0; i--)
        {
            var field = fields[i];
            if (!PrintedAmount.IsMatch(field)) continue;

            // A till writes a credit with the sign on the right.
            var negative = field.EndsWith('-');
            var text = negative ? field[..^1] : field;

            var minor = MoneyParser.ToMinor(text, options.StoreReceiptUnit, "receipt.amount");
            return new Money(negative ? -minor : minor, currency);
        }

        return null;
    }
}

internal sealed record PrintLine(IReadOnlyList<string> Fields)
{
    public string Text => string.Join(' ', Fields);
}
