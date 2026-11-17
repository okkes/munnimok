using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.LidlPlus;

/// A v3 detail has "ticketType": "HTML", no line items: htmlPrintedReceipt is the paper receipt (confirmed 2026-08-04).
/// Article spans carry id, description, unit price, quantity as data attributes; only the line TOTAL comes from text.
/// The total is READ, never recomputed: what the till printed is what was charged; a multiplied one would miss the bank.
internal static partial class LidlPrintedReceipt
{
    private sealed record Line
    {
        public required string Id { get; init; }

        public required string Text { get; init; }

        public string? ArticleId { get; init; }

        public string? Description { get; init; }

        public string? UnitPrice { get; init; }

        public string? Quantity { get; init; }

        /// <summary>CONFIRMED: the tender line carries data-tender-description="Bankpas".</summary>
        public string? TenderDescription { get; init; }
    }

    /// an id is required: Lidl wraps each block in an id-less purchase_list span, which would pair with the first inner
    /// closing tag and swallow the first real line of every block (the card tail is on one)
    [GeneratedRegex(
        @"<span\b(?<attrs>[^>]*\bid\s*=\s*""[^""]*""[^>]*)>(?<text>.*?)</span>",
        RegexOptions.Singleline)]
    private static partial Regex Span { get; }

    [GeneratedRegex(@"(?<name>[a-zA-Z-]+)\s*=\s*""(?<value>[^""]*)""")]
    private static partial Regex Attribute { get; }

    /// <summary>A money token: 1,59 or -0,10 or 1.234,56.</summary>
    [GeneratedRegex(@"-?\d{1,3}(?:\.\d{3})*,\d{2}")]
    private static partial Regex Amount { get; }

    /// <summary>
    /// CONFIRMED. The masked card, as the payment terminal block prints it:
    /// "Kaart                 xxxxxxxxxxxx9785".
    /// </summary>
    [GeneratedRegex(@"[xX*]{4,}\s*(?<tail>\d{4})\b")]
    private static partial Regex CardTail { get; }

    public static IReadOnlyList<ReceiptItem> Items(string? printed, LidlPlusOptions options, string currency)
    {
        ArgumentNullException.ThrowIfNull(options);

        var lines = Lines(printed);
        if (lines.Count == 0) return [];

        var items = new List<ReceiptItem>();

        foreach (var line in lines)
        {
            // A line with no article id is either a discount belonging to the
            // article above it, or a subtotal, or a header.
            if (line.ArticleId is null)
            {
                Apply(items, line, options, currency);
                continue;
            }

            // a weighed article's continuation line ("0,084 kg x 5,99") repeats the attributes and has no total,
            // told by its text not starting with the description
            if (!StartsWithDescription(line)) continue;

            if (Total(line.Text) is not { } total) continue;

            items.Add(new ReceiptItem
            {
                Name = line.Description ?? "?",
                Quantity = Decimal(line.Quantity) ?? 1m,
                UnitPrice = Money(line.UnitPrice, options, currency),
                Total = new Money(Minor(total, options), currency),
            });
        }

        return items;
    }

    public static ReceiptPayment Payment(string? printed, LidlPlusOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var lines = Lines(printed);
        if (lines.Count == 0) return ReceiptFactory.Payment();

        string? method = null;
        foreach (var line in lines)
        {
            if (line.Id.StartsWith("purchase_summary", StringComparison.Ordinal) &&
                line.TenderDescription is { Length: > 0 } tender)
            {
                method = tender;
                break;
            }
        }

        string? tail = null;
        foreach (var line in lines)
        {
            if (CardTail.Match(line.Text) is { Success: true } match)
            {
                tail = match.Groups["tail"].Value;
                break;
            }
        }

        return ReceiptFactory.Payment(Method(method), tail);
    }

    /// "In prijs verlaagd  -0,10" has no attributes and attaches to the last item; else items would not sum to the total
    private static void Apply(List<ReceiptItem> items, Line line, LidlPlusOptions options, string currency)
    {
        if (items.Count == 0) return;
        if (!line.Id.StartsWith("purchase_list", StringComparison.Ordinal)) return;

        var amount = Total(line.Text);
        if (amount is not { } value || value >= 0) return;

        var label = Amount.Replace(line.Text, string.Empty).Trim();
        var last = items[^1];

        items[^1] = last with
        {
            Discount = new ReceiptDiscount
            {
                Amount = new Money(Minor(value, options), currency),
                Label = string.IsNullOrWhiteSpace(label) ? null : label,
            },

            // the printed line total is BEFORE this markdown and items plus discounts must equal the total, so the discount carries it
            Total = last.Total,
        };
    }

    /// null stays null: a guess weakens the receipt-to-transaction match;
    /// "Bankpas" (Dutch debit) would be "other" in the shared mapping
    private static string? Method(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        if (raw.Contains("ideal", StringComparison.OrdinalIgnoreCase)) return "ideal";

        if (raw.Contains("contant", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("cash", StringComparison.OrdinalIgnoreCase))
        {
            return "cash";
        }

        return raw.Contains("bankpas", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("pin", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("card", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("kaart", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("maestro", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("visa", StringComparison.OrdinalIgnoreCase)
               || raw.Contains("mastercard", StringComparison.OrdinalIgnoreCase)
            ? "card"
            : "other";
    }

    private static bool StartsWithDescription(Line line) =>
        line.Description is { Length: > 0 } description &&
        line.Text.TrimStart().StartsWith(description.AsSpan(0, Math.Min(description.Length, 8)), StringComparison.Ordinal);

    /// the last money token is the amount; earlier ones are a quantity or unit price
    private static decimal? Total(string text)
    {
        decimal? last = null;

        foreach (Match match in Amount.Matches(text))
        {
            if (decimal.TryParse(match.Value, NumberStyles.Number, Dutch, out var value)) last = value;
        }

        return last;
    }

    private static readonly CultureInfo Dutch = CultureInfo.GetCultureInfo("nl-NL");

    private static decimal? Decimal(string? raw) =>
        decimal.TryParse(raw, NumberStyles.Number, Dutch, out var value) ? value : null;

    private static Money? Money(string? raw, LidlPlusOptions options, string currency) =>
        Decimal(raw) is { } value ? new Money(Minor(value, options), currency) : null;

    /// the till prints major units with a comma; half-cent rounding is the platform converter's
    private static long Minor(decimal major, LidlPlusOptions options) =>
        MoneyParser.ToMinor(major, options.PrintedAmountUnit);

    /// Lidl repeats the id and data attributes on every styled span: a line is the spans sharing an id, in receipt order
    private static IReadOnlyList<Line> Lines(string? printed)
    {
        if (string.IsNullOrWhiteSpace(printed)) return [];

        var order = new List<string>();
        var byId = new Dictionary<string, Line>(StringComparer.Ordinal);

        foreach (var groups in Span.Matches(printed).Select(span => span.Groups))
        {
            var attrs = Attributes(groups["attrs"].Value);
            if (!attrs.TryGetValue("id", out var id) || id.Length == 0) continue;

            // nested spans also match and would double-count text; stripping residual tags is enough
            var text = WebUtility.HtmlDecode(Tags.Replace(groups["text"].Value, string.Empty));

            if (byId.TryGetValue(id, out var existing))
            {
                byId[id] = existing with
                {
                    Text = existing.Text + text,
                    ArticleId = existing.ArticleId ?? attrs.GetValueOrDefault("data-art-id"),
                    Description = existing.Description ?? Decode(attrs.GetValueOrDefault("data-art-description")),
                    UnitPrice = existing.UnitPrice ?? attrs.GetValueOrDefault("data-unit-price"),
                    Quantity = existing.Quantity ?? attrs.GetValueOrDefault("data-art-quantity"),
                    TenderDescription = existing.TenderDescription ?? Decode(attrs.GetValueOrDefault("data-tender-description")),
                };

                continue;
            }

            order.Add(id);
            byId[id] = new Line
            {
                Id = id,
                Text = text,
                ArticleId = attrs.GetValueOrDefault("data-art-id"),
                Description = Decode(attrs.GetValueOrDefault("data-art-description")),
                UnitPrice = attrs.GetValueOrDefault("data-unit-price"),
                Quantity = attrs.GetValueOrDefault("data-art-quantity"),
                TenderDescription = Decode(attrs.GetValueOrDefault("data-tender-description")),
            };
        }

        return [.. order.Select(id => byId[id])];
    }

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex Tags { get; }

    private static string? Decode(string? raw) => raw is null ? null : WebUtility.HtmlDecode(raw);

    private static Dictionary<string, string> Attributes(string raw)
    {
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var groups in Attribute.Matches(raw).Select(match => match.Groups))
        {
            found[groups["name"].Value] = groups["value"].Value;
        }

        return found;
    }
}
