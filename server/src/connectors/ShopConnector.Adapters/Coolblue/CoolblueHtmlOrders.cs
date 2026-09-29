using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Coolblue;

/// <summary>One order as the OVERVIEW page states it, which is not much.</summary>
internal sealed record CoolblueListing
{
    public required string Id { get; init; }

    public required DateTimeOffset PlacedAt { get; init; }

    /// <summary>The product headline the card shows. Null when it shows none.</summary>
    public string? Title { get; init; }

    /// <summary>Invoice hrefs found on this card, first-seen order, deduped.</summary>
    public IReadOnlyList<CoolblueInvoiceLink> Invoices { get; init; } = [];
}

/// <summary>An invoice download, straight off the list markup.</summary>
internal readonly record struct CoolblueInvoiceLink(string Href, string InvoiceId);

/// <summary>
/// One product on an order: what it was called, what the page charged for it,
/// and how many.
///
/// No unit price, because the page states none and dividing one out of a total
/// would invent a figure that is wrong the moment a line carries a discount.
/// </summary>
internal readonly record struct CoolblueLine(string Name, Money Total, decimal Quantity);

/// <summary>What one order's own page is worth reading for: its total and its lines.</summary>
internal readonly record struct CoolblueOrder(Money Total, IReadOnlyList<ReceiptItem> Items);

/// <summary>
/// Copy keys this adapter emits. Keys, never prose: the connector cannot know
/// the reader's language, and an English literal that reaches a screen becomes
/// an untranslatable de-facto API the moment a consumer matches on it.
/// </summary>
internal static class CoolblueMessageKeys
{
    /// <summary>
    /// The derived line that closes the gap between a stated total and the
    /// products a Coolblue order page itemises.
    ///
    /// Shared vocabulary rather than a Coolblue word, because the situation is
    /// not Coolblue's alone - any merchant may charge something it does not
    /// break out - and a consumer should render it the same way whoever it came
    /// from.
    /// </summary>
    public const string Unattributed = "receipt.line.unattributed";
}

/// <summary>
/// What came back from a document URL, before anyone decides whether to
/// believe it.
///
/// The status and the media type travel WITH the bytes rather than being
/// checked at the call site, because a document that is really an error page
/// is the failure worth catching, and it arrives looking exactly like a
/// success.
/// </summary>
internal readonly record struct CoolblueDownload(int Status, string MediaType, byte[] Bytes);

/// <summary>
/// Reading Coolblue's account pages, where nothing that looks like a hook is one.
///
/// The constraint that shapes every line here: the real overview page carries
/// 110 distinct <c>css-&lt;hash&gt;</c> class names emitted by CSS-in-JS and
/// ZERO <c>data-testid</c> attributes. Those classes change on Coolblue's next
/// deploy, so a selector built on one is a selector with a shelf life measured
/// in sprints. What is durable is the shape of an href and the words a human
/// reads, so that is what this reads.
///
/// The other constraint is arithmetic rather than structural: the overview
/// states NO MONEY AT ALL - a real 610KB page contains exactly one euro sign
/// and it is inside a translations blob. So a listing is an index and nothing
/// more, and a receipt's total can only come from the per-order details page.
/// That is why <see cref="CoolblueAdapter"/> fetches one page per order and
/// says so in its notes rather than quietly summing something.
/// </summary>
internal static partial class CoolblueHtmlOrders
{
    /// <summary>
    /// Where Next.js starts repeating the page to itself.
    ///
    /// Everything a Coolblue account page renders appears TWICE in one
    /// response: once as HTML a browser paints, and again inside
    /// <c>self.__next_f.push([...])</c> script chunks - the React Server
    /// Component flight payload the client uses to hydrate. On the captured
    /// overview the ten orders render at 163-190KB and the flight copy of the
    /// same ten begins at 559KB, with the app's entire Dutch translation
    /// dictionary in between - a dictionary that DEFINES
    /// <c>"totalAmount":"Totaalbedrag"</c> on a page carrying no total at all.
    ///
    /// It is cut off before anything is read, and the honest description of
    /// that is a bound rather than a fix. Removing the cut and re-running the
    /// live capture through this reader changes NOTHING: the same ten orders,
    /// the same eleven invoices, the same refusal to find a total on the
    /// overview. What actually rejects the second copy is that flight data is
    /// JSON - it has no angle brackets, and every value this reader takes must
    /// be a text node between a <c>&gt;</c> and a <c>&lt;</c>.
    /// <para>
    /// So this earns its place on two smaller grounds instead. It halves the
    /// bytes every parse walks, which on a fetch that reads one 600KB page per
    /// order is most of the work; and it keeps a card's slice from ever running
    /// into the translation dictionary, which is a thing no assertion currently
    /// depends on and which a future change to any pattern here could start
    /// depending on silently.
    /// </para>
    /// </summary>
    public const string FlightMarker = "self.__next_f.push";

    /// <summary>
    /// How far past a label a value is allowed to be.
    ///
    /// MEASURED, not chosen: on the captured pages the gap from "Besteld op"
    /// to its date, and from "Totaalbedrag" to its amount, is 44 characters of
    /// tags - with one exception, the FIRST card on each page, where emotion
    /// emits its 406-character <c>&lt;style&gt;</c> block between the two the
    /// first time a class is used. That block is stripped by
    /// <see cref="Rendered"/>, so 44 is the real distance and this leaves an
    /// order of magnitude of headroom.
    /// <para>
    /// It is a bound rather than a generosity. An unbounded search forward from
    /// a label is the failure this reader shipped with: a card whose own value
    /// had moved would silently take the NEXT card's, and every receipt after
    /// it would be off by one order.
    /// </para>
    /// </summary>
    private const int LabelWindow = 512;

    /// <summary>An order's own page, and the id inside it.</summary>
    [GeneratedRegex(@"/orderoverzicht/(?<id>\d{4,})", RegexOptions.IgnoreCase)]
    private static partial Regex OrderHref { get; }

    /// <summary>
    /// An invoice download. Anchored on the path segment rather than on the
    /// word "factuur": the account navigation links to <c>/mijn-facturen</c>,
    /// which is a page and not a document.
    /// </summary>
    [GeneratedRegex(@"/mijn-coolblue-account/mijn-factuur/(?<order>\d+)/(?<invoice>\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex InvoiceHref { get; }

    /// <summary>
    /// The date, once the markup between it and its label is gone.
    ///
    /// Anchored at the start on purpose. The real card is
    /// <c>Besteld op&lt;!-- --&gt;:&lt;/p&gt;&lt;p class="css-i623zk"&gt;22 september 2025&lt;/p&gt;</c>,
    /// which reads as "Besteld op : 22 september 2025" - so the only thing
    /// allowed between the words and the date is the separator. A pattern that
    /// searched instead of anchoring would happily accept a date from further
    /// down the card, and the whole value of a label is that it names the thing
    /// immediately after it.
    /// </summary>
    [GeneratedRegex(@"^[\s:]*(?<date>\d{1,2}\s+\p{L}+\s+\d{4})")]
    private static partial Regex DateAfterLabel { get; }

    /// <summary>
    /// Emotion's generated CSS, which is not content and is full of digits.
    ///
    /// Stripped whole rather than tag by tag: the text INSIDE a style element
    /// survives an ordinary tag strip, and <c>font-size:var(--cb-font-size-md)</c>
    /// sitting between a label and its value is exactly the kind of thing a
    /// money pattern finds.
    /// </summary>
    [GeneratedRegex(@"<style\b[^>]*>.*?</style>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex StyleBlock { get; }

    /// <summary>Script bodies, for the same reason and with the same danger.</summary>
    [GeneratedRegex(@"<script\b[^>]*>.*?</script>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ScriptBlock { get; }

    /// <summary>
    /// Comments, which a browser does not paint and this reader must not read.
    ///
    /// Two kinds appear on these pages and stripping serves both. React emits
    /// an empty comment as a text-node separator - it sits between "Besteld op"
    /// and the colon after it - and Coolblue writes real prose in comments too:
    /// the sign-in page explains its own decoy password field in one.
    /// <para>
    /// Removed FIRST, before the style and script blocks, so that a comment
    /// mentioning a tag cannot open a block that then swallows real markup up
    /// to the next genuine closing tag. That is not hypothetical - it is what
    /// this project's own fixture did to its own reader, eating a card's date
    /// label and handing the receipt the NEXT order's date.
    /// </para>
    /// </summary>
    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex Comment { get; }

    /// <summary>
    /// The half of the response a browser actually paints, with the CSS and the
    /// scripts taken out of it.
    ///
    /// The three removals are not equally load-bearing, and it is worth knowing
    /// which is which. <see cref="Comment"/> and <see cref="StyleBlock"/> are
    /// CORRECTIONS - without them the first card's date is unreadable, because
    /// 406 characters of generated CSS sit between the label and the value, and
    /// a comment that names a label can be read as the value beside it.
    /// <see cref="FlightMarker"/> is a BOUND: removing it changes no answer on
    /// the live capture, and its own note says so.
    /// <para>
    /// The cut is an optimisation that happens to be a correction, and it is
    /// written so that losing it is survivable: a response with no flight
    /// marker at all - a future Next.js, or a plain server-rendered page - is
    /// read whole, exactly as before.
    /// </para>
    /// </summary>
    internal static string Rendered(string body)
    {
        if (string.IsNullOrEmpty(body)) return string.Empty;

        // Deliberately > 0 rather than >= 0. A marker at position zero would
        // mean the response is nothing but flight data, and reading an empty
        // string would report "no orders" - which is a lie a walk would stop
        // on. Falling back to the whole body fails loudly instead.
        var at = body.IndexOf(FlightMarker, StringComparison.Ordinal);
        var rendered = at > 0 ? body[..at] : body;

        rendered = Comment.Replace(rendered, " ");
        return ScriptBlock.Replace(StyleBlock.Replace(rendered, " "), " ");
    }

    /// <summary>
    /// Every order on one overview page.
    ///
    /// Cards are cut out of the RAW BODY on the order href rather than found by
    /// walking the DOM, and that is a deliberate departure from how Amazon and
    /// bol read their lists. Nothing encloses a Coolblue order except a div
    /// whose only attribute is a generated class - so a container selector
    /// cannot be written, and a walk UP from the href to "the nearest ancestor
    /// that looks like a card" has to define looks-like with the same
    /// unavailable vocabulary. Slicing between one order link and the next
    /// needs neither.
    /// </summary>
    public static IReadOnlyList<CoolblueListing> ParseList(
        string body, CoolblueOptions options, TimeZoneInfo zone)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(zone);
        if (string.IsNullOrEmpty(body)) return [];

        // The painted half only. Without this the flight payload at the bottom
        // repeats every order, and the last real card's slice runs through the
        // whole translation dictionary on its way there.
        var rendered = Rendered(body);
        if (rendered.Length == 0) return [];

        // Where each order's markup starts. Several anchors point at the same
        // order - Coolblue renders an invisible overlay link beside the visible
        // one - so the first mention of an id opens its card and the first
        // mention of the NEXT id closes it.
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
            var (id, at) = starts[i];
            if (!seen.Add(id)) continue;

            // The card runs back to the previous order's start and forward to
            // the next one's. Backwards as well as forwards because the date
            // and the title are rendered ABOVE the link that names the order.
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

    /// <summary>
    /// When the order was placed, from the words in front of it.
    ///
    /// The label and its date are separated by MARKUP rather than by
    /// whitespace - <c>&lt;!-- --&gt;:&lt;/p&gt;&lt;p class="css-i623zk"&gt;</c>,
    /// and on the first card of every page a 406-character emotion
    /// <c>&lt;style&gt;</c> block as well - so the window after the label is
    /// read as TEXT. A pattern that allowed only whitespace between the two
    /// matched nothing on any real page, which is what this reader shipped
    /// with and what the fixture was too tidy to catch.
    /// </summary>
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

        // No date is a shape change rather than a fact about the order: every
        // card on the captured pages states one, and a receipt without a
        // purchase date cannot be matched to anything.
        throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: order '{orderId}' states no order date; " +
            $"expected the words '{options.OrderedOnLabel}' followed by a Dutch date");
    }

    /// <summary>
    /// The total, read by its LABEL.
    ///
    /// "Totaalbedrag" is the one hook on this page a redeploy cannot rename
    /// without changing what the page says to a human, which is the same
    /// argument Amazon's header reader rests on. The value follows the label
    /// through however many wrapper elements Coolblue's component library
    /// happens to emit, so the reader steps over tags rather than assuming a
    /// shape.
    /// <para>
    /// EVERY occurrence of every label is tried, and each is read only within
    /// <see cref="LabelWindow"/> characters of itself. Both halves earn their
    /// place: the captured details page says "Totaalbedrag" six times and only
    /// the first is a rendered total, and a search that ran past its own window
    /// would answer with some other element's number rather than admit the
    /// label had moved.
    /// </para>
    /// </summary>
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

                // The same pattern the line reader uses, and deliberately one
                // copy of it: a total and a line price are the same kind of
                // thing on the same page, and two spellings of "an amount"
                // would drift the first time one of them was corrected.
                var amount = RenderedAmount.Match(window);

                if (amount.Success)
                {
                    // MoneyUnit is DECLARED, never inferred from the value's
                    // shape - and this provider writes whole euros as "463,-",
                    // which is the exact string that used to come back negative.
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

    /// <summary>
    /// A product heading on an order's own page: an <c>h3</c> wrapping a link
    /// to the product.
    ///
    /// The tag is semantic and the href is real, which is what makes this a
    /// hook at all - everything else in this markup is a generated class. The
    /// <c>/product/</c> link is also what tells an ordered product apart from
    /// any other heading that might appear inside the section.
    /// </summary>
    [GeneratedRegex(@"<h3\b[^>]*>(?<inner>.*?)</h3>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ProductHeading { get; }

    /// <summary>The link inside a product heading, which is the product's NAME.</summary>
    [GeneratedRegex(
        @"<a\b[^>]*href=""(?<href>[^""]*)""[^>]*>(?<text>.*?)</a>",
        RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex ProductAnchor { get; }

    /// <summary>
    /// How many of them, written in front of the name: <c>3x</c>.
    ///
    /// Read from the text BEFORE the product link rather than from the start of
    /// the name, and that distinction is the whole point. Coolblue renders the
    /// count outside the anchor and the product inside it, so a product genuinely
    /// CALLED "3x AA batterij" - and such products exist - cannot be read as
    /// three of something called "AA batterij".
    /// </summary>
    [GeneratedRegex(@"^(?<qty>\d{1,4})\s*x$", RegexOptions.IgnoreCase)]
    private static partial Regex QuantityPrefix { get; }

    /// <summary>
    /// A rendered amount: a text node bounded by a tag on each side.
    ///
    /// Spelled with unicode escapes rather than literal characters on purpose.
    /// The euro sign and the NON-BREAKING SPACE Coolblue writes after it are
    /// both invisible-or-ambiguous in a diff, and an editor that "helpfully"
    /// normalises the nbsp to a plain space would break every amount on the
    /// site while looking like a whitespace change.
    /// </summary>
    [GeneratedRegex(@"[>\s]\s*(?<money>\u20AC?[\s\u00A0]*\d[\d.,\s\u00A0]*(?:,-|\.-|,\d{2}|\.\d{2})?)\s*<")]
    private static partial Regex RenderedAmount { get; }

    /// <summary>
    /// The products on an order's own page, with what each was charged.
    ///
    /// Bounded by the two headings a human reads - "Je bestelling" above and
    /// "Adres- en betaalinformatie" below - because past that boundary the page
    /// carries a long tail of ACCESSORY RECOMMENDATIONS, each with its own
    /// heading and its own price. A reader that ran on would put things the
    /// customer never bought onto their receipt, at prices they never paid.
    /// </summary>
    /// <remarks>
    /// QUANTITY IS ON THIS PAGE and this reader once said it was not, on the
    /// strength of an order that happened to contain one of everything. A real
    /// order reads "3x Seagate IronWolf ST4000VN008 4TB", with the count
    /// outside the product link and the name inside it.
    /// <para>
    /// THE AMOUNT IS THE LINE TOTAL, and that is now CONFIRMED rather than
    /// assumed. It was the one thing left unverified here - whether a
    /// multi-quantity line shows the price of one or of all - because every
    /// order captured had a quantity of one. The account owner settled it with
    /// the invoice for a three-item order: <c>Aantal 3</c>,
    /// <c>Prijs per stuk EUR 134,99</c>, <c>Prijs incl. BTW EUR 404,97</c>, and
    /// the order page shows 404,97. So the amount is taken exactly as printed
    /// and never multiplied by the count.
    /// </para>
    /// <para>
    /// A UNIT PRICE is still not taken. The order page states none, and the
    /// obvious arithmetic - 404,97 over 3 - is exactly the division this
    /// project refuses everywhere else: it produces a number that looks
    /// authoritative and is wrong the moment a line carries a bundle discount.
    /// The provider's own figure exists on the INVOICE, which is a document
    /// this adapter hands over whole rather than parses.
    /// <para>
    /// That uncertainty is survivable precisely because the adapter closes any
    /// gap with an <c>Unattributed</c> line: if a multi-item line does state a
    /// unit price, the receipt still adds up to what was paid, and the
    /// difference is labelled as money whose reason is unknown rather than
    /// quietly attributed to a product.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<CoolblueLine> ParseItems(string body, CoolblueOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var rendered = Rendered(body);
        var section = Section(rendered, options);

        var unit = options.ItemUnitOrThrow();
        var lines = new List<CoolblueLine>();

        foreach (Match heading in ProductHeading.Matches(section))
        {
            // Not every heading is a product, and a link to one says which are.
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
                // A product with no price is a shape change rather than a free
                // gift. Refusing is what stops a receipt reporting fewer lines
                // than the customer was charged for.
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

    /// <summary>
    /// The count in front of a product name, or one.
    ///
    /// ONE rather than null when nothing is written, and that is an inference
    /// worth stating plainly. Coolblue writes "3x" before a product it sold
    /// three of and writes nothing at all before a single one - CONFIRMED both
    /// ways from real orders - so silence means one, on this page, by this
    /// page's own convention.
    /// <para>
    /// It is a safe inference to make where the money one would not be, because
    /// nothing financial rides on it: the amount beside the line is taken
    /// exactly as printed whatever the count says, so a quantity read wrongly
    /// is a cosmetic error rather than a wrong number on a receipt.
    /// </para>
    /// </summary>
    private static decimal Quantity(string beforeTheName)
    {
        var prefix = QuantityPrefix.Match(HtmlText(beforeTheName));

        return prefix.Success
               && decimal.TryParse(prefix.Groups["qty"].Value, CultureInfo.InvariantCulture, out var many)
            ? many
            : 1m;
    }

    /// <summary>Any heading, whatever level. The section boundaries are headings.</summary>
    [GeneratedRegex(@"<h[1-6]\b[^>]*>(?<text>.*?)</h[1-6]>", RegexOptions.Singleline | RegexOptions.IgnoreCase)]
    private static partial Regex SectionHeading { get; }

    /// <summary>
    /// The markup between the "Je bestelling" heading and the one that ends it.
    ///
    /// Bounded by HEADINGS rather than by the first place those words appear,
    /// and that distinction is not fussiness - it is a bug this reader shipped
    /// with for about an hour. Coolblue titles the page
    /// <c>&lt;title&gt;Details van je bestelling | Coolblue&lt;/title&gt;</c>,
    /// so a case-insensitive search for the label finds the TITLE, and the
    /// section starts at the top of the document. It happened to still find the
    /// right product on the captured page, which is the worst way for a bug
    /// like this to behave.
    /// <para>
    /// This is the third time today that a label has been found somewhere it
    /// was not meant to be read - after a comment and a translation
    /// dictionary - and the answer each time is the same: say WHERE the words
    /// have to appear, not just that they appear.
    /// </para>
    /// </summary>
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

            // The first heading after the section that closes it. Past this
            // point the page recommends accessories, in the same shape.
            if (Says(text, options.ItemsSectionEndLabels)) return rendered[start..heading.Index];
        }

        if (start >= 0) return rendered[start..];

        throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: the order page has no product section; looked for a heading saying " +
            $"any of [{string.Join(", ", options.ItemsSectionLabels)}]");
    }

    private static bool Says(string text, IReadOnlyList<string> labels) =>
        labels.Any(label => text.Contains(label, StringComparison.OrdinalIgnoreCase));

    /// <summary>The product headline, which is the only item text the list offers.</summary>
    private static string? Title(string card)
    {
        var heading = Regex.Match(card, @"<h2\b[^>]*>(?<text>.*?)</h2>",
            RegexOptions.Singleline, TimeSpan.FromSeconds(2));

        if (!heading.Success) return null;

        var text = HtmlText(heading.Groups["text"].Value);
        return text.Length == 0 ? null : text;
    }

    private static IReadOnlyList<CoolblueInvoiceLink> Invoices(
        string card, string orderId, CoolblueOptions options)
    {
        var found = new List<CoolblueInvoiceLink>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (Match match in InvoiceHref.Matches(card))
        {
            // The href names its own order, so an invoice is paired by what it
            // SAYS rather than by where it sits. Slicing a card is a heuristic;
            // this check means a slice that ran long cannot hand one order's
            // invoice to another.
            if (!string.Equals(match.Groups["order"].Value, orderId, StringComparison.Ordinal)) continue;

            var invoiceId = match.Groups["invoice"].Value;
            if (!seen.Add(invoiceId)) continue;

            found.Add(new CoolblueInvoiceLink(
                options.BaseUrl.TrimEnd('/') + match.Value, invoiceId));
        }

        return found;
    }

    /// <summary>
    /// "15 december 2025" - a month NAME, in Dutch, with no machine-readable
    /// form anywhere on the page.
    /// </summary>
    private static DateTimeOffset ParseDutchDate(string raw, TimeZoneInfo zone, string orderId)
    {
        var dutch = CultureInfo.GetCultureInfo("nl-NL");

        if (!DateTime.TryParseExact(
                HtmlText(raw), "d MMMM yyyy", dutch, DateTimeStyles.None, out var parsed))
        {
            throw ConnectorException.ProviderChanged(
                $"{CoolblueAdapter.ProviderId}: order '{orderId}' states an unreadable date '{raw}'");
        }

        // Midnight in the shop's own zone, not the agent's: an order placed on
        // the 1st must not become the 31st for a connector running in London.
        return new DateTimeOffset(parsed, zone.GetUtcOffset(parsed));
    }

    private static string HtmlText(string raw) =>
        Regex.Replace(
            System.Net.WebUtility.HtmlDecode(Regex.Replace(raw, "<[^>]+>", " ")),
            @"\s+", " ").Trim();
}
