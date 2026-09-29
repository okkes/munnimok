using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

/// <summary>One row of the order list: what the list page itself states.</summary>
/// <summary>
/// One row of the order list.
///
/// <paramref name="Total"/> is nullable because a card may state none. Most do
/// - it is the number the whole reconciliation rests on - but one order in a
/// real account's history had no "Totaal" in its header at all, and the parser
/// treating that as a shape change failed the ENTIRE fetch over a single card.
/// A total that is stated and unreadable is still a shape change; a total that
/// is simply absent is a fact about that order, and the invoice states one.
/// </summary>
internal sealed record AmazonOrderSummary(
    string Id,
    DateTimeOffset PurchasedAt,
    Money? Total,
    string? InvoiceUrl,
    string? DocumentsUrl = null);

/// <summary>
/// One document Amazon offers for an order: where it is, and what Amazon calls
/// it on the page.
/// </summary>
/// <remarks>
/// The href cannot be derived from anything. It is
/// <c>/documents/download/{guid}/invoice.pdf</c> with an opaque guid that
/// appears nowhere else - not in the order number, not on the order page - so
/// the only way to learn it is to read the invoice list, and the only way to
/// read that is to fetch it.
/// </remarks>
internal readonly record struct AmazonDocumentLink(string Href, string? Label);

/// <summary>
/// What the print invoice adds: the lines, the charges, and how it was paid.
/// </summary>
internal sealed record AmazonInvoice
{
    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    public ReceiptPayment Payment { get; init; } = ReceiptFactory.Payment();

    /// <summary>
    /// The invoice's own grand total, where it states one. Not used as the
    /// receipt's total - that comes from the list card - precisely so the two
    /// stay a real reconciliation pair rather than one number written twice.
    /// </summary>
    public Money? StatedTotal { get; init; }
}

/// <summary>Which line of the totals block a label names.</summary>
internal enum AmazonTotalKind
{
    Unknown,
    Subtotal,
    TotalBeforeTax,
    Shipping,
    Tax,
    Promotion,
    GiftCard,

    /// <summary>"Totaal" - what the order came to.</summary>
    GrandTotal,

    /// <summary>
    /// "Eindtotaal" - what was actually charged, which is a different number
    /// the moment a gift card or a balance pays part of the order. Preferred
    /// over <see cref="GrandTotal"/> because a receipt's total is matched
    /// against a bank transaction.
    /// </summary>
    FinalTotal,
}

/// <summary>
/// Amazon's order history, out of rendered HTML, in Dutch.
/// </summary>
internal static partial class AmazonOrderParser
{
    /// <summary>Amazon's order number, which has looked like this for twenty years.</summary>
    [GeneratedRegex(@"\b(\d{3}-\d{7}-\d{7})\b")]
    private static partial Regex OrderNumber { get; }

    /// <summary>
    /// "1 van: Titel", "2 of: Title", "3 x Titel". The separator words are
    /// both languages' because the page's language is a thing a live run still
    /// has to settle.
    /// </summary>
    [GeneratedRegex(@"^\s*(\d+(?:[.,]\d+)?)\s*(?:van:|van|of:|of|x|×)\s+(.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex QuantityPrefix { get; }

    /// <summary>The first four digits after "eindigend op" / "ending in".</summary>
    [GeneratedRegex(@"^\D*(\d{4})")]
    private static partial Regex LeadingFour { get; }

    /// <summary>The order id inside a link's query string.</summary>
    [GeneratedRegex(@"[?&]orderID=([^&#\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex OrderIdInUrl { get; }

    // ---- order list --------------------------------------------------------

    public static IReadOnlyList<AmazonOrderSummary> ParseList(
        HtmlNode dom, AmazonOptions options, TimeZoneInfo zone)
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
                           ?? HtmlQuery.TextOf(card, options.OrderDateSelectors)
                           ?? throw Missing($"order date on '{id}'", options.OrderDateSelectors);

            // Absent and unreadable are different answers.
            //
            // No total on the card is a fact about that order, and the invoice
            // has one - so it is carried as null and filled in later. A total
            // that IS there and cannot be read is a shape change and still
            // stops everything, because that is the case where a number we
            // would go on to use has changed meaning.
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

    /// <summary>
    /// Whether the list offers another page. Used only as a stop signal: the
    /// walk also stops on a page that repeats what it already has, because a
    /// pagination parameter that stops advancing is the likelier first symptom
    /// of a shape change and it presents as the same page fetched twenty times
    /// against a defended site.
    /// </summary>
    public static bool HasNextPage(HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        // No pagination block at all is not evidence that the history ended -
        // Amazon has more than one order-list layout. Say "maybe" and let the
        // freshness guard decide, because the alternative is silently
        // truncating somebody's history at ten orders.
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

    /// <summary>
    /// Four ways to read an order number, most durable first.
    ///
    /// An attribute and a query string survive the redesign that renames every
    /// class, and the classes are the shortest-lived part of this page. The
    /// last resort is the number's own shape, which Amazon has not changed in
    /// twenty years - a reading rather than a guess, and the thing that keeps
    /// this adapter alive when every selector above it has expired.
    /// </summary>
    private static string? OrderId(HtmlNode card, AmazonOptions options)
    {
        foreach (var attribute in options.OrderIdAttributes)
        {
            // The number out of the attribute, not the attribute.
            //
            // The sturdiest of these carries the id inside a longer token -
            // `data-csa-c-slot-id="amzn1.yourorders.order-card.402-1122334-5566778"`
            // - so taking the value whole gives every receipt an external id
            // with a widget name glued to the front of it. Which would look
            // stable, dedupe against itself perfectly, and match nothing the
            // rest of the platform holds.
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

    /// <summary>
    /// An order number held in one attribute, whether that attribute is the
    /// number or merely contains it. Null when the value carries no order
    /// number at all, so the next candidate is tried rather than a widget id
    /// being returned as an order.
    /// </summary>
    private static string? FromAttribute(HtmlNode node, string attribute)
    {
        if (node.Attribute(attribute) is not { Length: > 0 } value) return null;

        var trimmed = value.Trim();
        return OrderNumber.Match(trimmed) is { Success: true } number
            ? number.Groups[1].Value
            : null;
    }

    /// <summary>
    /// The value under a small-caps label in an order card's header.
    ///
    /// The four facts in that header - date, total, recipient, order number -
    /// are identical <c>li</c> elements distinguished by nothing but the label
    /// above each one. So the label IS the selector, exactly as it is in BKR's
    /// print block, and for the same reason: a page that reflows renames its
    /// grid columns and keeps its words.
    ///
    /// The label is then cut off the front of the value, because the two share
    /// an element and "Totaal € 25,98" would otherwise be handed to a money
    /// parser with a word in front of it.
    /// </summary>
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

    /// <summary>
    /// Built rather than harvested. A card's own links point at the
    /// order-details page, which is the heavier and more dynamically rendered
    /// of the two; the print invoice takes the same order id and is the most
    /// stable page Amazon serves, which is why the research recommends it for
    /// totals.
    /// </summary>
    private static string? InvoiceUrl(string orderId, AmazonOptions options) =>
        orderId.Length == 0
            ? null
            : UrlBuilder.WithQuery(
                options.BaseUrl.TrimEnd('/') + options.InvoicePath,
                new Dictionary<string, string>(StringComparer.Ordinal) { ["orderID"] = orderId });

    /// <summary>
    /// Harvested rather than built - the exact opposite of
    /// <see cref="InvoiceUrl"/>, and the difference is not a matter of taste.
    ///
    /// The invoice list is an AJAX fragment whose URL carries a
    /// <c>relatedRequestId</c> minted for THIS render of the order list. It is
    /// not derivable from the order number and it is not a constant, so the
    /// only correct source is the anchor the page drew. Building this URL by
    /// hand is what made an earlier attempt come back with nothing.
    /// </summary>
    private static string? DocumentsUrl(HtmlNode card, AmazonOptions options)
    {
        foreach (var link in HtmlQuery.All(card, options.InvoiceListLinkSelectors))
        {
            // Not decoded here. Amazon writes this href with &amp; between the
            // parameters and it has to reach the fetch as a real &, but the
            // tokenizer already decodes attribute values as it reads them - so
            // a decode at this point is not belt and braces, it is a SECOND
            // one, and a URL legitimately containing the text "&amp;" would
            // come out of it corrupted.
            if (link.Attribute("href") is { Length: > 0 } href) return href;
        }

        return null;
    }

    // ---- the invoice list --------------------------------------------------

    /// <summary>
    /// The documents Amazon actually has for an order, out of the fragment its
    /// own page fetches.
    ///
    /// Selected by the SHAPE OF THE HREF and never by the label. The fragment
    /// holds three kinds of link and two of them are decoys: a printable order
    /// summary (an HTML page, which this adapter already reads elsewhere) and
    /// "Factuur aanvragen" - REQUEST an invoice - which is a support form. That
    /// last one is why a label match would be actively wrong rather than merely
    /// fragile: it begins with the same word as the real thing, so
    /// <c>startsWith("Factuur")</c> would hand the user a contact page as their
    /// invoice. It is also Dutch, and a storefront in another language keeps
    /// its paths and changes its words.
    /// </summary>
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

            // The same document listed twice would become two identical
            // attachments on one receipt, each a hundred kilobytes.
            if (!seen.Add(href)) continue;

            var label = HtmlText.Normalize(link.Text());
            found.Add(new AmazonDocumentLink(href, label.Length == 0 ? null : label));
        }

        return found;
    }

    // ---- print invoice -----------------------------------------------------

    /// <summary>
    /// Whether this page is telling us the order was cancelled.
    ///
    /// Checked before the invoice is parsed, because a cancelled order's
    /// invoice is EMPTY by design - no lines, no charge summary, nothing to
    /// total - and that emptiness is indistinguishable from a page whose shape
    /// we no longer recognise. One of those is worth failing a fetch for; the
    /// other is an order behaving exactly as it should.
    /// </summary>
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

        // Nothing at all - no line, no charge, no total - is not an invoice
        // with nothing on it; it is a page whose shape we no longer recognise.
        // Naming both selector lists is the whole diagnosis for whoever fixes
        // it, and a fetch that silently returned an empty receipt would hide
        // the same fact behind a plausible-looking record.
        if (items.Count == 0 && totals.Count == 0)
        {
            throw ConnectorException.ProviderChanged(
                $"{AmazonAdapter.ProviderId}: the print invoice yielded neither a line nor a total; " +
                $"tried items [{string.Join(", ", options.InvoiceItemRowSelectors)}] " +
                $"and totals [{string.Join(", ", options.InvoiceTotalRowSelectors)}]");
        }

        // Shipping is a real charge and belongs in the sum. Tax is NOT added:
        // a Dutch consumer price is quoted including BTW, so the invoice's tax
        // row decomposes the total rather than adding to it, and emitting it
        // as a line would double-count the VAT on every receipt. Whether
        // Amazon's invoice ever renders a tax-exclusive breakdown is
        // UNCONFIRMED, which is why it is a switch and not an assumption -
        // and why reconciliation is what decides if the switch is wrong.
        foreach (var kind in new[] { AmazonTotalKind.Shipping, AmazonTotalKind.Tax })
        {
            if (kind == AmazonTotalKind.Tax && options.TaxIsIncludedInItemPrices) continue;

            foreach (var row in totals.Where(r => r.Kind == kind && r.Amount.Value != 0))
            {
                items.Add(new ReceiptItem { Name = row.Label, Total = row.Amount });
            }
        }

        // A promotion is modelled as a discount rather than as a negative
        // product, because that is the construct the normalized record has for
        // it and the one the consumer knows how to display. Its name is the
        // provider's own label - a connector never invents user-facing prose,
        // not even for a synthetic line.
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

            // What was charged, falling back to what the order came to. The
            // two are equal on an order paid entirely by card, which is why
            // preferring the wrong one is invisible until somebody uses a
            // voucher.
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

            // Stated first, then the prefix, then one.
            //
            // The live invoice states it in neither of the obvious places: not
            // as "2 van: Titel" in the name cell, and not in the element
            // literally called `quantity`, which is empty on every line. It is
            // a badge over the thumbnail, and it is absent when the quantity is
            // one - so "found nothing" genuinely means one here, and the
            // fallback below is not a guess covering a parse failure.
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
                // A stated line total always beats a computed one; Amazon's
                // print invoice normally states only the unit price, so the
                // multiplication is the usual path.
                Total = stated ?? new Money(
                    checked((long)decimal.Round(price.Value * quantity, 0, MidpointRounding.AwayFromZero)),
                    price.Currency),
            };
        }
    }

    /// <summary>
    /// The quantity badge, where the page draws one.
    ///
    /// Null rather than one when nothing is found, so the caller decides what
    /// absence means - and it means one here only because Amazon omits the
    /// badge on single items, which is a fact about this page rather than a
    /// convenient default.
    /// </summary>
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
            // Split where the page splits it. Every charge row on this invoice
            // has a label column and a value column, and reading them
            // separately keeps "Subtotaal item(s):" - which ends in a bracketed
            // token a money parser has to be talked out of - away from the
            // amount entirely.
            var labelNode = HtmlQuery.TextOf(node, options.InvoiceTotalLabelSelectors);
            var valueNode = HtmlQuery.TextOf(node, options.InvoiceTotalValueSelectors);

            string label;
            Money? amount;

            if (labelNode is not null && valueNode is not null)
            {
                // Trimmed of its colon, because a charge that becomes a receipt
                // line is shown to somebody: "Porto- en verpakkingskosten:"
                // reads as a mistake beside a product name.
                label = HtmlText.Normalize(labelNode).TrimEnd(':').Trim();
                amount = AmazonMoney.Find(
                    valueNode, options.InvoiceTotalUnit, options.Currency, "invoice total", options);
            }
            else
            {
                // A layout that puts both in one element, which is what the
                // table-shaped invoice did.
                (label, amount) = AmazonMoney.Row(
                    node.Text(), options.InvoiceTotalUnit, options.Currency, "invoice total", options);
            }

            if (amount is not { } value || label.Length == 0) continue;

            rows.Add(new TotalRow(Categorize(label, options), label, value));
        }

        return rows;
    }

    /// <summary>
    /// Which line a Dutch (or English) label names.
    ///
    /// The order is load-bearing and is the reason these are separate lists
    /// rather than one. "subtotaal" CONTAINS "totaal"; "totaal vóór btw"
    /// CONTAINS "btw". A single contains-match against one list therefore
    /// files the subtotal as the grand total and the pre-tax figure as the
    /// tax, and the receipt then reconciles against a number that is not its
    /// total - plausibly, and wrongly.
    /// </summary>
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

        // Before the general total, and the ordering is the whole point:
        // "eindtotaal" contains "totaal", so a single list would file the
        // amount actually charged as just another order total and leave which
        // of the two won to document order.
        if (Any(text, options.FinalTotalLabels)) return AmazonTotalKind.FinalTotal;
        if (Any(text, options.GrandTotalLabels)) return AmazonTotalKind.GrandTotal;

        return AmazonTotalKind.Unknown;
    }

    private static ReceiptPayment Payment(HtmlNode dom, AmazonOptions options)
    {
        var node = HtmlQuery.First(dom, options.InvoicePaymentSelectors);
        if (node is null) return ReceiptFactory.Payment();

        // The tail in its own element, which is how the live widget states it.
        // Preferred over reading it out of "MasterCard •••• 7201", because that
        // string's separator is four bullet characters chosen by a font and a
        // locale, and a regex over it is a regex over typography.
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

        if (text.Contains("ideal", StringComparison.OrdinalIgnoreCase))
        {
            return ReceiptFactory.Payment(method: "ideal");
        }

        // Stated as unknown rather than guessed. The consumer matches receipts
        // to transactions partly on the payment tail, and it needs to know the
        // match will be weaker rather than be handed an invention.
        return ReceiptFactory.Payment();
    }

    /// <summary>
    /// The payment method, from the instrument's own name.
    ///
    /// <c>card</c> covers every card scheme because that is what the normalised
    /// record's vocabulary has, and the scheme is not what a consumer matches
    /// on - the tail is. Anything unrecognised is null rather than guessed:
    /// inventing a method is how a receipt starts claiming it was paid a way it
    /// was not.
    /// </summary>
    private static string? Method(string? name)
    {
        if (name is null) return null;

        if (name.Contains("ideal", StringComparison.OrdinalIgnoreCase)) return "ideal";

        foreach (var scheme in new[] { "mastercard", "visa", "maestro", "american express", "amex", "card" })
        {
            if (name.Contains(scheme, StringComparison.OrdinalIgnoreCase)) return "card";
        }

        return null;
    }

    private static HtmlNode? FirstOtherThan(HtmlNode row, IReadOnlyList<string> selectors, HtmlNode exclude)
    {
        foreach (var selector in selectors)
        {
            foreach (var hit in HtmlQuery.All(row, selector))
            {
                if (!ReferenceEquals(hit, exclude)) return hit;
            }
        }

        return null;
    }

    /// <summary>
    /// Cuts an item cell where the product's name stops and Amazon's
    /// commentary begins. Falls back to the whole cell when no marker is
    /// found: a long name is a cosmetic problem, an empty one is a data one.
    /// </summary>
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
