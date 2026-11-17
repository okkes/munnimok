using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Coolblue;

internal sealed record CoolblueListing
{
    public required string Id { get; init; }

    public required DateTimeOffset PlacedAt { get; init; }

    public string? Title { get; init; }

    /// <summary>Invoice hrefs found on this card, first-seen order, deduped.</summary>
    public IReadOnlyList<CoolblueInvoiceLink> Invoices { get; init; } = [];
}

internal readonly record struct CoolblueInvoiceLink(string Href, string InvoiceId);

/// No unit price: the page states none, and dividing one out of a total is wrong as soon as a line carries a discount.
internal readonly record struct CoolblueLine(string Name, Money Total, decimal Quantity);

internal readonly record struct CoolblueOrder(Money Total, IReadOnlyList<ReceiptItem> Items);

/// Copy keys, never prose: the connector cannot know the reader's language, and an English literal reaching a screen
/// becomes an untranslatable API.
internal static class CoolblueMessageKeys
{
    /// Shared vocabulary, not a Coolblue word: any merchant may charge something it does not break out, and consumers
    /// render it alike.
    public const string Unattributed = "receipt.line.unattributed";
}

/// Status and media type travel with the bytes: a document that is really an error page arrives looking like a success.
internal readonly record struct CoolblueDownload(int Status, string MediaType, byte[] Bytes);

/// The overview has 110 css-hash classes (CSS-in-JS) and ZERO data-testid, so selectors die on the next deploy; this
/// reads href shapes and human-read words. It states NO MONEY (one euro sign in 610KB, inside a translations blob):
/// a total only comes from the per-order page.
internal static partial class CoolblueHtmlOrders
{
    /// Next.js repeats the page as RSC flight data (self.__next_f.push chunks, from 559KB, with the Dutch dictionary
    /// before it). Cutting there is a bound, not a fix: it changes no answer (flight JSON has no angle brackets), but
    /// halves the bytes parsed and keeps a card's slice out of the dictionary.
    public const string FlightMarker = "self.__next_f.push";

    /// How far past a label a value may be: MEASURED, 44 chars of tags on captured pages (the first card also has emotion's
    /// 406-char style block, stripped by Rendered). A bound: an unbounded search once took the NEXT card's value when a
    /// card's own had moved, putting every receipt after it off by one.
    private const int LabelWindow = 512;

    [GeneratedRegex(@"/orderoverzicht/(?<id>\d{4,})", RegexOptions.IgnoreCase)]
    private static partial Regex OrderHref { get; }

    /// Anchored on the path segment, not the word "factuur": account navigation links to /mijn-facturen, a page not a document.
    [GeneratedRegex(@"/mijn-coolblue-account/mijn-factuur/(?<order>\d+)/(?<invoice>\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex InvoiceHref { get; }

    /// Anchored at the start: the card reads "Besteld op : 22 september 2025", so only the separator may sit between label
    /// and date; a search would accept a date from further down the card.
    [GeneratedRegex(@"^[\s:]*(?<date>\d{1,2}\s+\p{L}+\s+\d{4})")]
    private static partial Regex DateAfterLabel { get; }

    /// Emotion's generated CSS, stripped whole: text inside a style element survives a tag strip, and a money pattern
    /// finds values like font-size there.
    [GeneratedRegex(@"<style\b[^>]*>.*?</style>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex StyleBlock { get; }

    [GeneratedRegex(@"<script\b[^>]*>.*?</script>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ScriptBlock { get; }

    /// React emits an empty comment between "Besteld op" and the colon, and Coolblue writes prose in comments. Removed
    /// FIRST: a comment mentioning a tag would open a block swallowing markup up to the next real closing tag (it once gave
    /// a receipt the NEXT order's date).
    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment { get; }

    /// The painted half, CSS and scripts removed. Comment and StyleBlock are CORRECTIONS (406 chars of CSS sit between the
    /// first card's label and value); the flight cut is a bound, and a response without the marker is read whole.
    internal static string Rendered(string body)
    {
        if (string.IsNullOrEmpty(body)) return string.Empty;

        // > 0, not >= 0: a marker at position zero means all flight data, and an empty read would report "no orders" and stop a
        // walk; the whole body fails loudly instead
        var at = body.IndexOf(FlightMarker, StringComparison.Ordinal);
        var rendered = at > 0 ? body[..at] : body;

        rendered = Comment.Replace(rendered, " ");
        return ScriptBlock.Replace(StyleBlock.Replace(rendered, " "), " ");
    }

    /// Cards are cut from the RAW BODY on the order href, not the DOM: nothing encloses an order but a div with a generated
    /// class, so no container selector or ancestor walk can be written.
    public static IReadOnlyList<CoolblueListing> ParseList(
        string body, CoolblueOptions options, TimeZoneInfo zone)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(zone);
        if (string.IsNullOrEmpty(body)) return [];

        // painted half only: the flight payload repeats every order and the last card's slice would run through the dictionary
        var rendered = Rendered(body);
        if (rendered.Length == 0) return [];

        // several anchors point at one order (an invisible overlay link): the first mention of an id opens its card, the first
        // of the NEXT id closes it
        var starts = new List<(string Id, int At)>();
        foreach (Match match in OrderHref.Matches(rendered))
        {
            var id = match.Groups["id"].Value;
            if (starts.Count == 0 || !string.Equals(starts[^1].Id, id, StringComparison.Ordinal))
            {
                starts.Add((id, match.Index));
            }
        }

        var listings = new List<CoolblueListing>(starts.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < starts.Count; i++)
        {
            var id = starts[i].Id;
            if (!seen.Add(id)) continue;

            // back to the previous order's start as well: the date and title are rendered ABOVE the link that names the order
            var from = i == 0 ? 0 : starts[i - 1].At;
            var to = i + 1 < starts.Count ? starts[i + 1].At : rendered.Length;
            var card = rendered[from..to];

            listings.Add(new CoolblueListing
            {
                Id = id,
                PlacedAt = ParseDutchDate(PlacedOn(card, options, id), zone, id),
                Title = Title(card),
                Invoices = Invoices(card, id, options),
            });
        }

        return listings;
    }

    /// Label and date are separated by MARKUP (a comment, ":</p><p>", on the first card a 406-char style block), so the
    /// window is read as TEXT; a whitespace-only pattern matched nothing on any real page.
    private static string PlacedOn(string card, CoolblueOptions options, string orderId)
    {
        var at = card.IndexOf(options.OrderedOnLabel, StringComparison.OrdinalIgnoreCase);

        if (at >= 0)
        {
            var from = at + options.OrderedOnLabel.Length;
            var window = card[from..Math.Min(card.Length, from + LabelWindow)];

            var date = DateAfterLabel.Match(HtmlText(window));
            if (date.Success) return date.Groups["date"].Value;
        }

        // no date is a shape change: every captured card states one, and a receipt without a purchase date cannot be matched
        throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: order '{orderId}' states no order date; " +
            $"expected the words '{options.OrderedOnLabel}' followed by a Dutch date");
    }

    /// Read by LABEL: "Totaalbedrag" cannot be renamed without changing what the page says to a human. EVERY occurrence is
    /// tried, each only within LabelWindow: the details page says it six times and only the first is a rendered total.
    public static Money ParseTotal(string body, CoolblueOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var rendered = Rendered(body);

        foreach (var label in options.TotalLabels)
        {
            var at = 0;

            while (at < rendered.Length &&
                   (at = rendered.IndexOf(label, at, StringComparison.OrdinalIgnoreCase)) >= 0)
            {
                var from = at + label.Length;
                var window = rendered[from..Math.Min(rendered.Length, from + LabelWindow)];

                // one copy of the amount pattern shared with the line reader, so two spellings of "an amount" cannot drift
                var amount = RenderedAmount.Match(window);

                if (amount.Success)
                {
                    // unit DECLARED, never inferred from the value's shape: this provider writes whole euros as "463,-", which once came
                    // back negative
                    return new Money
                    {
                        Value = MoneyParser.ToMinor(
                            amount.Groups["money"].Value, options.TotalUnitOrThrow(), "order total"),
                        Currency = options.Currency,
                    };
                }

                at = from;
            }
        }

        throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: the order details page states no total; " +
            $"looked for [{string.Join(", ", options.TotalLabels)}] with a value within " +
            $"{LabelWindow} characters of one");
    }

    /// An h3 wrapping a link: the tag is semantic and the href real; the /product/ link tells an ordered product from other
    /// headings.
    [GeneratedRegex(@"<h3\b[^>]*>(?<inner>.*?)</h3>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ProductHeading { get; }

    [GeneratedRegex(
        @"<a\b[^>]*href=""(?<href>[^""]*)""[^>]*>(?<text>.*?)</a>",
        RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ProductAnchor { get; }

    /// Read from the text BEFORE the product link: Coolblue puts the count outside the anchor, so a product CALLED
    /// "3x AA batterij" is not read as three of "AA batterij".
    [GeneratedRegex(@"^(?<qty>\d{1,4})\s*x$", RegexOptions.IgnoreCase)]
    private static partial Regex QuantityPrefix { get; }

    /// Unicode escapes on purpose: the euro sign and the nbsp after it are invisible in a diff, and an editor normalising
    /// the nbsp would break every amount.
    [GeneratedRegex(@"[>\s]\s*(?<money>\u20AC?[\s\u00A0]*\d[\d.,\s\u00A0]*(?:,-|\.-|,\d{2}|\.\d{2})?)\s*<")]
    private static partial Regex RenderedAmount { get; }

    /// Bounded by "Je bestelling" above and "Adres- en betaalinformatie" below: past it the page lists ACCESSORY
    /// RECOMMENDATIONS with prices the customer never paid. The amount is the LINE TOTAL (confirmed from an invoice: 3 x
    /// 134,99 shown as 404,97), taken as printed, never multiplied; no unit price is derived (wrong with a bundle discount).
    public static IReadOnlyList<CoolblueLine> ParseItems(string body, CoolblueOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var rendered = Rendered(body);
        var section = Section(rendered, options);

        var unit = options.ItemUnitOrThrow();
        var lines = new List<CoolblueLine>();

        foreach (Match heading in ProductHeading.Matches(section))
        {
            var inner = heading.Groups["inner"].Value;

            var anchor = ProductAnchor.Matches(inner).FirstOrDefault(
                a => a.Groups["href"].Value.Contains(options.ProductHrefMarker, StringComparison.OrdinalIgnoreCase));

            if (anchor is null) continue;

            var name = HtmlText(anchor.Groups["text"].Value);
            if (name.Length == 0) continue;

            var quantity = Quantity(inner[..anchor.Index]);
            var after = heading.Index + heading.Length;
            var window = section[after..Math.Min(section.Length, after + LabelWindow)];

            var amount = RenderedAmount.Match(window);
            if (!amount.Success)
            {
                // a product with no price is a shape change, not a free gift: refusing stops a receipt reporting fewer lines than charged
                throw ConnectorException.ProviderChanged(
                    $"{CoolblueAdapter.ProviderId}: the product '{name}' states no price within " +
                    $"{LabelWindow} characters of its heading");
            }

            lines.Add(new CoolblueLine(
                name,
                new Money
                {
                    Value = MoneyParser.ToMinor(amount.Groups["money"].Value, unit, "line total"),
                    Currency = options.Currency,
                },
                quantity));
        }

        return lines;
    }

    /// One when nothing is written: Coolblue writes "3x" before three and nothing before one (confirmed both ways). Safe to
    /// infer: the amount is taken as printed whatever the count says, so a misread quantity is cosmetic.
    private static decimal Quantity(string beforeTheName)
    {
        var prefix = QuantityPrefix.Match(HtmlText(beforeTheName));

        return prefix.Success
               && decimal.TryParse(prefix.Groups["qty"].Value, CultureInfo.InvariantCulture, out var many)
            ? many
            : 1m;
    }

    [GeneratedRegex(@"<h[1-6]\b[^>]*>(?<text>.*?)</h[1-6]>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex SectionHeading { get; }

    /// Bounded by HEADINGS, not the first occurrence of the words: the page <title> says "Details van je bestelling", so a
    /// text search started at the document's top. Say WHERE the words must appear, not just that they appear.
    private static string Section(string rendered, CoolblueOptions options)
    {
        var start = -1;

        foreach (Match heading in SectionHeading.Matches(rendered))
        {
            var text = HtmlText(heading.Groups["text"].Value);

            if (start < 0)
            {
                if (Says(text, options.ItemsSectionLabels)) start = heading.Index + heading.Length;
                continue;
            }

            // the first heading after the section closes it: past it the page recommends accessories in the same shape
            if (Says(text, options.ItemsSectionEndLabels)) return rendered[start..heading.Index];
        }

        if (start >= 0) return rendered[start..];

        throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: the order page has no product section; looked for a heading saying " +
            $"any of [{string.Join(", ", options.ItemsSectionLabels)}]");
    }

    private static bool Says(string text, IReadOnlyList<string> labels) =>
        labels.Any(label => text.Contains(label, StringComparison.OrdinalIgnoreCase));

    private static string? Title(string card)
    {
        var heading = Regex.Match(card, @"<h2\b[^>]*>(?<text>.*?)</h2>",
            RegexOptions.Singleline, TimeSpan.FromSeconds(2));

        if (!heading.Success) return null;

        var text = HtmlText(heading.Groups["text"].Value);
        return text.Length == 0 ? null : text;
    }

    private static List<CoolblueInvoiceLink> Invoices(
        string card, string orderId, CoolblueOptions options)
    {
        var found = new List<CoolblueInvoiceLink>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (Match match in InvoiceHref.Matches(card))
        {
            // the href names its own order: pairing by what it SAYS means a slice that ran long cannot hand one order's invoice
            // to another
            if (!string.Equals(match.Groups["order"].Value, orderId, StringComparison.Ordinal)) continue;

            var invoiceId = match.Groups["invoice"].Value;
            if (!seen.Add(invoiceId)) continue;

            found.Add(new CoolblueInvoiceLink(
                options.BaseUrl.TrimEnd('/') + match.Value, invoiceId));
        }

        return found;
    }

    /// A month NAME in Dutch, with no machine-readable form anywhere on the page.
    private static DateTimeOffset ParseDutchDate(string raw, TimeZoneInfo zone, string orderId)
    {
        var dutch = CultureInfo.GetCultureInfo("nl-NL");

        if (!DateTime.TryParseExact(
                HtmlText(raw), "d MMMM yyyy", dutch, DateTimeStyles.None, out var parsed))
        {
            throw ConnectorException.ProviderChanged(
                $"{CoolblueAdapter.ProviderId}: order '{orderId}' states an unreadable date '{raw}'");
        }

        // midnight in the shop's zone, not the agent's: the 1st must not become the 31st on a connector running in London
        return new DateTimeOffset(parsed, zone.GetUtcOffset(parsed));
    }

    [GeneratedRegex("<[^>]+>", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex AnyTag { get; }

    [GeneratedRegex(@"\s+", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex WhitespaceRun { get; }

    private static string HtmlText(string raw) =>
        WhitespaceRun.Replace(System.Net.WebUtility.HtmlDecode(AnyTag.Replace(raw, " ")), " ").Trim();
}
