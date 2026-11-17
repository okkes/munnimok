using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

// Total is null when the card states none (a fact about that order, the invoice states one).
// a stated but unreadable total is a shape change
internal sealed record AmazonOrderSummary(
    string Id,
    DateTimeOffset PurchasedAt,
    Money? Total,
    string? InvoiceUrl,
    string? DocumentsUrl = null);

// the href has an opaque guid found nowhere else, so it is learned only by fetching the invoice list
internal readonly record struct AmazonDocumentLink(string Href, string? Label);

internal sealed record AmazonInvoice
{
    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    public ReceiptPayment Payment { get; init; } = ReceiptFactory.Payment();

    // not the receipt's total (that comes from the list card): keeps the two a real reconciliation pair
    public Money? StatedTotal { get; init; }
}

internal enum AmazonTotalKind
{
    Unknown,
    Subtotal,
    TotalBeforeTax,
    Shipping,
    Tax,
    Promotion,
    GiftCard,

    GrandTotal,

    // what was actually charged, differing from GrandTotal once a gift card or balance pays part.
    // preferred as a bank transaction is matched against it
    FinalTotal,
}

internal static partial class AmazonOrderParser
{
    [GeneratedRegex(@"\b(\d{3}-\d{7}-\d{7})\b")]
    private static partial Regex OrderNumber { get; }

    /// <summary>
    /// "1 van: Titel", "2 of: Title", "3 x Titel". The separator words are
    /// both languages' because the page's language is a thing a live run still
    /// has to settle.
    /// </summary>
    [GeneratedRegex(@"^\s*(\d+(?:[.,]\d+)?)\s*(?:van:|van|of:|of|x|×)\s+(.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex QuantityPrefix { get; }

    [GeneratedRegex(@"^\D*(\d{4})")]
    private static partial Regex LeadingFour { get; }

    [GeneratedRegex(@"[?&]orderID=([^&#\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex OrderIdInUrl { get; }

    // the page's word and the normalised record's method name coincide
    private const string Ideal = "ideal";

    /// <summary>The card schemes an instrument's name may carry; every one of them is <c>card</c>.</summary>
    private static readonly string[] CardSchemes =
        ["mastercard", "visa", "maestro", "american express", "amex", "card"];

    /// <param name="skipped">ids of cards with no readable date (prod 2026-10-05): left out, not a shape change</param>
    public static IReadOnlyList<AmazonOrderSummary> ParseList(
        HtmlNode dom, AmazonOptions options, TimeZoneInfo zone, ICollection<string>? skipped = null)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        var cards = HtmlQuery.All(dom, options.OrderCardSelectors);
        var rows = new List<AmazonOrderSummary>(cards.Count);

        foreach (var card in cards)
        {
            var id = OrderId(card, options)
                     ?? throw Missing("order id", options.OrderIdSelectors);

            var dateText = Labelled(card, options.OrderDateLabels, options)
                           ?? HtmlQuery.TextOf(card, options.OrderDateSelectors);
            if (dateText is null)
            {
                // a card this walk cannot place is not a shape change: stopping ended a fetch of two dozen good orders
                // as provider_changed (prod 2026-10-05)
                skipped?.Add(id);
                continue;
            }

            // absent and unreadable differ: no total on the card is null (the invoice has one).
            // a total that is there but unreadable is a shape change
            var totalText = Labelled(card, options.OrderTotalLabels, options)
                            ?? HtmlQuery.TextOf(card, options.OrderTotalSelectors);

            Money? total = totalText is null
                ? null
                : AmazonMoney.Find(totalText, options.OrderTotalUnit, options.Currency, "order total", options)
                  ?? throw ConnectorException.ProviderChanged(
                      $"{AmazonAdapter.ProviderId}: order '{id}' states no readable total (read '{totalText}')");

            rows.Add(new AmazonOrderSummary(
                id,
                AmazonDate.Parse(dateText, zone, $"order date on '{id}'"),
                total,
                InvoiceUrl(id, options),
                DocumentsUrl(card, options)));
        }

        return rows;
    }

    // a stop signal only: the walk also stops on a page repeating itself, the likelier first symptom of a shape change
    public static bool HasNextPage(HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        // no pagination block is not evidence the history ended (more than one layout):
        // say "maybe" and let the freshness guard decide
        var pagination = HtmlQuery.First(dom, options.PaginationSelectors);
        if (pagination is null) return true;

        var next = HtmlQuery.First(pagination, options.NextPageSelectors);
        if (next is null) return false;

        // Amazon renders the "next" control disabled rather than removing it.
        var classes = next.Attribute("class") ?? string.Empty;
        if (classes.Contains("a-disabled", StringComparison.OrdinalIgnoreCase)) return false;

        var parentClasses = next.Parent?.Attribute("class") ?? string.Empty;
        return !parentClasses.Contains("a-disabled", StringComparison.OrdinalIgnoreCase);
    }

    // most durable first: attributes and query strings survive class renames; the order number's own shape is the last resort
    private static string? OrderId(HtmlNode card, AmazonOptions options)
    {
        foreach (var attribute in options.OrderIdAttributes)
        {
            // the number out of the attribute: data-csa-c-slot-id holds it inside a longer token,
            // and the whole value would glue a widget name onto every id
            if (FromAttribute(card, attribute) is { } own) return own;

            foreach (var descendant in card.Elements())
            {
                if (FromAttribute(descendant, attribute) is { } nested) return nested;
            }
        }

        foreach (var link in HtmlQuery.All(card, options.OrderLinkSelectors))
        {
            if (link.Attribute("href") is { } href && OrderIdInUrl.Match(href) is { Success: true } fromHref)
            {
                return Uri.UnescapeDataString(fromHref.Groups[1].Value);
            }
        }

        if (HtmlQuery.TextOf(card, options.OrderIdSelectors) is { } text
            && OrderNumber.Match(text) is { Success: true } fromSelector)
        {
            return fromSelector.Groups[1].Value;
        }

        return OrderNumber.Match(card.Text()) is { Success: true } fromText ? fromText.Groups[1].Value : null;
    }

    // null when the value holds no order number, so the next candidate is tried
    private static string? FromAttribute(HtmlNode node, string attribute)
    {
        if (node.Attribute(attribute) is not { Length: > 0 } value) return null;

        var trimmed = value.Trim();
        return OrderNumber.Match(trimmed) is { Success: true } number
            ? number.Groups[1].Value
            : null;
    }

    // the label is the selector (header items differ only by label; a reflow renames columns, keeps words),
    // then cut off so a money parser gets no word
    private static string? Labelled(HtmlNode card, IReadOnlyList<string> labels, AmazonOptions options)
    {
        foreach (var item in HtmlQuery.All(card, options.OrderHeaderItemSelectors))
        {
            var text = HtmlText.Normalize(item.Text());

            foreach (var label in labels)
            {
                if (!text.StartsWith(label, StringComparison.OrdinalIgnoreCase)) continue;

                var value = text[label.Length..].Trim();
                if (value.Length > 0) return value;
            }
        }

        return null;
    }

    // built, not harvested: the print invoice is more stable than the order-details page the card links to
    private static string? InvoiceUrl(string orderId, AmazonOptions options) =>
        orderId.Length == 0
            ? null
            : UrlBuilder.WithQuery(
                options.BaseUrl.TrimEnd('/') + options.InvoicePath,
                new Dictionary<string, string>(StringComparer.Ordinal) { ["orderID"] = orderId });

    // harvested, not built: the URL carries a relatedRequestId minted for this render, so only the page's own anchor is correct
    private static string? DocumentsUrl(HtmlNode card, AmazonOptions options)
    {
        foreach (var link in HtmlQuery.All(card, options.InvoiceListLinkSelectors))
        {
            // not decoded here: the tokenizer already decodes attribute values, and a second decode would corrupt a literal "&amp;"
            if (link.Attribute("href") is { Length: > 0 } href) return href;
        }

        return null;
    }

    // by the shape of the href, never the label: the fragment holds decoys, among them "Factuur aanvragen"
    // (a support form that startsWith "Factuur"); paths survive a language change
    public static IReadOnlyList<AmazonDocumentLink> ParseDocuments(HtmlNode fragment, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(fragment);
        ArgumentNullException.ThrowIfNull(options);

        var found = new List<AmazonDocumentLink>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var link in HtmlQuery.All(fragment, options.DocumentLinkSelectors))
        {
            // Already entity-decoded by the tokenizer; see DocumentsUrl.
            if (link.Attribute("href") is not { Length: > 0 } href) continue;

            if (!options.DocumentPathMarkers.Any(
                    marker => href.Contains(marker, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            // a duplicate would attach the same ~100KB document twice
            if (!seen.Add(href)) continue;

            var label = HtmlText.Normalize(link.Text());
            found.Add(new AmazonDocumentLink(href, label.Length == 0 ? null : label));
        }

        return found;
    }

    // checked before parsing: a cancelled order's invoice is empty by design, indistinguishable from an unrecognised shape
    public static bool IsCancelled(HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        var text = HtmlText.Normalize(dom.Text());

        return options.CancelledOrderMarkers.Any(
            marker => text.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    public static AmazonInvoice ParseInvoice(HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        var items = new List<ReceiptItem>();
        items.AddRange(Products(dom, options));

        var totals = Totals(dom, options);

        // nothing at all is a page whose shape we no longer recognise, not an empty invoice.
        // naming both selector lists is the diagnosis
        if (items.Count == 0 && totals.Count == 0)
        {
            throw ConnectorException.ProviderChanged(
                $"{AmazonAdapter.ProviderId}: the print invoice yielded neither a line nor a total; " +
                $"tried items [{string.Join(", ", options.InvoiceItemRowSelectors)}] " +
                $"and totals [{string.Join(", ", options.InvoiceTotalRowSelectors)}]");
        }

        // shipping is a real charge; tax is not added when prices include BTW (the row decomposes the total, adding double-counts).
        // a tax-exclusive invoice is UNCONFIRMED, hence the switch
        foreach (var kind in new[] { AmazonTotalKind.Shipping, AmazonTotalKind.Tax })
        {
            if (kind == AmazonTotalKind.Tax && options.TaxIsIncludedInItemPrices) continue;

            foreach (var row in totals.Where(r => r.Kind == kind && r.Amount.Value != 0))
            {
                items.Add(new ReceiptItem { Name = row.Label, Total = row.Amount });
            }
        }

        // a promotion is a discount, not a negative product (the normalised record's construct).
        // its name is the provider's own label, a connector invents no user-facing prose
        foreach (var row in totals.Where(r =>
                     r.Kind is AmazonTotalKind.Promotion or AmazonTotalKind.GiftCard && r.Amount.Value != 0))
        {
            items.Add(new ReceiptItem
            {
                Name = row.Label,
                Total = Money.Zero(row.Amount.Currency),
                Discount = new ReceiptDiscount { Amount = row.Amount.Abs().Negated(), Label = row.Label },
            });
        }

        return new AmazonInvoice
        {
            Items = items,
            Payment = Payment(dom, options),

            // charged, falling back to what the order came to; equal on card-only orders,
            // so the wrong preference hides until a voucher is used
            StatedTotal = (totals.FirstOrDefault(r => r.Kind == AmazonTotalKind.FinalTotal)
                           ?? totals.FirstOrDefault(r => r.Kind == AmazonTotalKind.GrandTotal))?.Amount,
        };
    }

    private static IEnumerable<ReceiptItem> Products(HtmlNode dom, AmazonOptions options)
    {
        foreach (var row in HtmlQuery.All(dom, options.InvoiceItemRowSelectors))
        {
            var priceNode = HtmlQuery.First(row, options.InvoiceItemPriceSelectors);
            if (priceNode is null) continue;

            var unitPrice = AmazonMoney.Find(
                priceNode.Text(), options.ItemAmountUnit, options.Currency, "item price", options);

            // A row with no amount is a header or a spacer, not a purchase.
            if (unitPrice is not { } price) continue;

            var nameNode = FirstOtherThan(row, options.InvoiceItemNameSelectors, priceNode);
            var cell = HtmlText.Normalize(nameNode?.Text());
            if (cell.Length == 0) continue;

            // quantity: stated, then the name prefix, then one; the live badge is absent for quantity one,
            // so "found nothing" genuinely means one
            var quantity = Quantity(row, options) ?? 1m;
            var name = cell;

            if (QuantityPrefix.Match(cell) is { Success: true } prefix
                && decimal.TryParse(prefix.Groups[1].Value.Replace(',', '.'), NumberStyles.Number,
                    CultureInfo.InvariantCulture, out var parsed) && parsed > 0)
            {
                quantity = parsed;
                name = prefix.Groups[2].Value.Trim();
            }

            var stated = FirstOtherThan(row, options.InvoiceItemTotalSelectors, priceNode) is { } totalNode
                ? AmazonMoney.Find(totalNode.Text(), options.ItemAmountUnit, options.Currency, "item total", options)
                : null;

            yield return new ReceiptItem
            {
                Name = Truncate(name, options),
                Quantity = quantity,
                UnitPrice = price,
                // a stated line total beats a computed one; Amazon normally states only the unit price
                Total = stated ?? new Money(
                    checked((long)decimal.Round(price.Value * quantity, 0, MidpointRounding.AwayFromZero)),
                    price.Currency),
            };
        }
    }

    // null, not one, when nothing is found; absence means one only because Amazon omits the badge on single items
    private static decimal? Quantity(HtmlNode row, AmazonOptions options)
    {
        var text = HtmlQuery.TextOf(row, options.InvoiceItemQuantitySelectors);
        if (text is null) return null;

        return decimal.TryParse(HtmlText.Normalize(text), NumberStyles.Number,
                   CultureInfo.InvariantCulture, out var quantity) && quantity > 0
            ? quantity
            : null;
    }

    private sealed record TotalRow(AmazonTotalKind Kind, string Label, Money Amount);

    private static List<TotalRow> Totals(HtmlNode dom, AmazonOptions options)
    {
        var rows = new List<TotalRow>();

        foreach (var node in HtmlQuery.All(dom, options.InvoiceTotalRowSelectors))
        {
            // split as the page splits: reading the label apart keeps "Subtotaal item(s):" and its bracketed token away from the amount
            var labelNode = HtmlQuery.TextOf(node, options.InvoiceTotalLabelSelectors);
            var valueNode = HtmlQuery.TextOf(node, options.InvoiceTotalValueSelectors);

            string label;
            Money? amount;

            if (labelNode is not null && valueNode is not null)
            {
                // trimmed of its colon: a charge that becomes a receipt line is shown to somebody
                label = HtmlText.Normalize(labelNode).TrimEnd(':').Trim();
                amount = AmazonMoney.Find(
                    valueNode, options.InvoiceTotalUnit, options.Currency, "invoice total", options);
            }
            else
            {
                // a layout with both in one element (the old table-shaped invoice)
                (label, amount) = AmazonMoney.Row(
                    node.Text(), options.InvoiceTotalUnit, options.Currency, "invoice total", options);
            }

            if (amount is not { } value || label.Length == 0) continue;

            rows.Add(new TotalRow(Categorize(label, options), label, value));
        }

        return rows;
    }

    // order is load-bearing: "subtotaal" contains "totaal" and "totaal vóór btw" contains "btw",
    // so a single contains-list misfiles them
    internal static AmazonTotalKind Categorize(string label, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var text = label.Trim().TrimEnd(':').Trim();

        if (Any(text, options.SubtotalLabels)) return AmazonTotalKind.Subtotal;
        if (Any(text, options.TotalBeforeTaxLabels)) return AmazonTotalKind.TotalBeforeTax;
        if (Any(text, options.ShippingLabels)) return AmazonTotalKind.Shipping;
        if (Any(text, options.PromotionLabels)) return AmazonTotalKind.Promotion;
        if (Any(text, options.GiftCardLabels)) return AmazonTotalKind.GiftCard;
        if (Any(text, options.TaxLabels)) return AmazonTotalKind.Tax;

        // before the general total: "eindtotaal" contains "totaal",
        // and the amount actually charged must not be filed as just another total
        if (Any(text, options.FinalTotalLabels)) return AmazonTotalKind.FinalTotal;
        if (Any(text, options.GrandTotalLabels)) return AmazonTotalKind.GrandTotal;

        return AmazonTotalKind.Unknown;
    }

    private static ReceiptPayment Payment(HtmlNode dom, AmazonOptions options)
    {
        var node = HtmlQuery.First(dom, options.InvoicePaymentSelectors);
        if (node is null) return ReceiptFactory.Payment();

        // the tail in its own element is preferred over parsing "MasterCard •••• 7201", whose bullets are typography
        if (HtmlQuery.TextOf(node, options.PaymentTailSelectors) is { } stated
            && LeadingFour.Match(HtmlText.Normalize(stated)) is { Success: true } four)
        {
            return ReceiptFactory.Payment(
                method: Method(HtmlQuery.TextOf(node, options.PaymentNameSelectors)),
                cardLast4: JsonAccess.Tail(four.Groups[1].Value));
        }

        var text = node.Text();
        if (text.Length == 0) return ReceiptFactory.Payment();

        foreach (var marker in options.CardTailMarkers)
        {
            var at = text.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (at < 0) continue;

            var tail = JsonAccess.Tail(LeadingFour.Match(text[(at + marker.Length)..]) is { Success: true } digits
                ? digits.Groups[1].Value
                : null);

            return ReceiptFactory.Payment(method: "card", cardLast4: tail);
        }

        if (text.Contains(Ideal, StringComparison.OrdinalIgnoreCase))
        {
            return ReceiptFactory.Payment(method: Ideal);
        }

        // unknown rather than guessed: receipts are matched to transactions partly on the tail,
        // and the consumer must know the match is weaker
        return ReceiptFactory.Payment();
    }

    // card covers every scheme (the record's vocabulary; the tail is what is matched on).
    // unrecognised is null, never an invented method
    private static string? Method(string? name)
    {
        if (name is null) return null;

        if (name.Contains(Ideal, StringComparison.OrdinalIgnoreCase)) return Ideal;

        return Any(name, CardSchemes) ? "card" : null;
    }

    private static HtmlNode? FirstOtherThan(HtmlNode row, IReadOnlyList<string> selectors, HtmlNode exclude) =>
        selectors
            .SelectMany(selector => HtmlQuery.All(row, selector))
            .FirstOrDefault(hit => !ReferenceEquals(hit, exclude));

    // falls back to the whole cell when no marker is found: a long name is cosmetic, an empty one is a data problem
    private static string Truncate(string name, AmazonOptions options)
    {
        var cut = name.Length;

        foreach (var marker in options.ItemNameStopMarkers)
        {
            var at = name.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (at > 0 && at < cut) cut = at;
        }

        var trimmed = name[..cut].Trim().TrimEnd(',', ';', '-').Trim();
        return trimmed.Length == 0 ? name : trimmed;
    }

    private static bool Any(string text, IReadOnlyList<string> candidates) =>
        candidates.Any(candidate => text.Contains(candidate, StringComparison.OrdinalIgnoreCase));

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{AmazonAdapter.ProviderId}: no {what} on the order list; tried [{string.Join(", ", selectors)}]");
}
