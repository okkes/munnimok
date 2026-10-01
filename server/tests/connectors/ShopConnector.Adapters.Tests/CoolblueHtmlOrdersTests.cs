using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// Reading Coolblue's account pages, where nothing that looks like a hook is
/// one.
///
/// The real overview page carries 110 distinct <c>css-&lt;hash&gt;</c> class
/// names and ZERO <c>data-testid</c> attributes. Those classes are CSS-in-JS
/// output and change on Coolblue's next deploy, so the whole point of this
/// reader is that it survives losing every one of them - which is what
/// <see cref="A_redeploy_that_renames_every_class_changes_nothing"/> asserts.
///
/// The fixtures are built from a live capture of 2026-08-07 with this account's
/// products, ids and dates replaced.
/// </summary>
public sealed partial class CoolblueHtmlOrdersTests
{
    private static string Overview => FixtureCatalog.Read("coolblue/orders-overview.html");

    private static string Details => FixtureCatalog.Read("coolblue/order-details.html");

    private static CoolblueOptions Options => new() { TotalUnit = MoneyUnit.MajorString };

    /// <summary>A CSS-in-JS class name, as emotion writes them.</summary>
    [GeneratedRegex(@"css-([a-z0-9]+)")]
    private static partial Regex EmotionClass();

    private static IReadOnlyList<CoolblueListing> Listings(string? body = null) =>
        CoolblueHtmlOrders.ParseList(body ?? Overview, Options, RetailZones.Dutch);

    [Fact]
    public void Every_order_on_the_page_is_found_once()
    {
        Assert.Equal(["80000001", "80000002", "80000003"], Listings().Select(l => l.Id));
    }

    /// <summary>
    /// THE test this design exists for.
    ///
    /// Every class on the page is replaced with a different generated name -
    /// which is exactly what Coolblue's next deploy does - and the reader must
    /// not notice. A selector that had crept in anywhere fails here, loudly,
    /// against a page whose meaning has not changed at all.
    /// </summary>
    [Fact]
    public void A_redeploy_that_renames_every_class_changes_nothing()
    {
        var before = Listings();

        // css-807ot0 -> css-zz807ot0, and so on for all 34 references.
        var redeployed = EmotionClass().Replace(Overview, "css-zz$1");
        Assert.NotEqual(Overview, redeployed);

        var after = Listings(redeployed);

        Assert.Equal(before.Select(l => l.Id), after.Select(l => l.Id));
        Assert.Equal(before.Select(l => l.PlacedAt), after.Select(l => l.PlacedAt));
        Assert.Equal(before.Select(l => l.Title), after.Select(l => l.Title));
        Assert.Equal(
            before.SelectMany(l => l.Invoices.Select(i => i.InvoiceId)),
            after.SelectMany(l => l.Invoices.Select(i => i.InvoiceId)));
    }

    /// <summary>
    /// The regression this reader was shipped with, pinned.
    ///
    /// The date is never beside its label. The card writes the words, closes
    /// the paragraph, and opens another for the date - and on the FIRST card of
    /// every page emotion emits its 406-character style block in between,
    /// because that is the first use of the class. The original pattern allowed
    /// only whitespace between the two, so it matched on the hand-written
    /// fixture and on NOTHING on any real page: every live fetch would have
    /// failed with "states no order date" on its very first order.
    /// </summary>
    [Fact]
    public void The_first_cards_date_is_behind_a_style_block_and_is_read_anyway()
    {
        // The premise, asserted rather than described: label, then a style
        // element, then the date - in that order, in the fixture's own markup.
        var label = Overview.IndexOf("Besteld op", StringComparison.Ordinal);
        var style = Overview.IndexOf("<style", label, StringComparison.Ordinal);
        var date = Overview.IndexOf("15 december 2025", label, StringComparison.Ordinal);

        Assert.InRange(style, label, date);
        Assert.True(date - label > 400, $"the gap is {date - label} characters; the real one is 450");

        Assert.Equal(new DateOnly(2025, 12, 15), DateOnly.FromDateTime(Listings()[0].PlacedAt.Date));
    }

    /// <summary>
    /// Commentary is not content, and this reader learned that the hard way
    /// from its own fixture.
    ///
    /// Coolblue writes real prose in comments - the sign-in page explains its
    /// decoy password field in one - and React emits empty comments as text-node
    /// separators throughout. A comment that happens to mention a label must not
    /// become the value beside it.
    /// </summary>
    [Fact]
    public void A_comment_that_mentions_a_label_is_not_content()
    {
        const string body =
            "<html><body>" +
            "<!-- the total sits beside Totaalbedrag, which renders as <div>111,-</div> -->" +
            "<div class=\"css-dt07t8\"><div>Totaalbedrag</div><div>463,-</div></div>" +
            "</body></html>";

        Assert.Equal(46_300L, CoolblueHtmlOrders.ParseTotal(body, Options).Value);
    }

    [Fact]
    public void The_dutch_date_on_a_card_becomes_a_real_moment_in_the_shops_own_zone()
    {
        var first = Listings()[0];

        Assert.Equal(new DateOnly(2025, 12, 15), DateOnly.FromDateTime(first.PlacedAt.Date));

        // Midnight in Amsterdam, not wherever the agent runs. An order placed
        // on the 1st must not become the 31st for a connector in London.
        Assert.Equal(RetailZones.Dutch.GetUtcOffset(first.PlacedAt.DateTime), first.PlacedAt.Offset);
    }

    /// <summary>
    /// An order with two invoices, one with none, and neither is an error.
    /// </summary>
    [Fact]
    public void Invoices_are_paired_to_their_own_order()
    {
        var byId = Listings().ToDictionary(l => l.Id, StringComparer.Ordinal);

        Assert.Equal(["1300000001"], byId["80000001"].Invoices.Select(i => i.InvoiceId));
        Assert.Empty(byId["80000002"].Invoices);
        Assert.Equal(["1300000003", "1300000004"], byId["80000003"].Invoices.Select(i => i.InvoiceId));

        Assert.All(
            byId["80000003"].Invoices,
            invoice => Assert.StartsWith(
                "https://www.coolblue.nl/mijn-coolblue-account/mijn-factuur/80000003/",
                invoice.Href,
                StringComparison.Ordinal));
    }

    /// <summary>
    /// The account navigation links to /mijn-facturen, which is a page and not
    /// a document. Anchoring on the word "factuur" rather than the path segment
    /// would attach it to somebody's receipt.
    /// </summary>
    [Fact]
    public void The_account_navigations_facturen_link_is_not_an_invoice()
    {
        Assert.Contains("/mijn-coolblue-account/mijn-facturen", Overview, StringComparison.Ordinal);

        Assert.All(
            Listings().SelectMany(l => l.Invoices),
            invoice => Assert.Contains("/mijn-factuur/", invoice.Href, StringComparison.Ordinal));
    }

    // ---- the total ---------------------------------------------------------

    /// <summary>
    /// The total, and the format that used to come back NEGATIVE.
    ///
    /// Coolblue writes a whole-euro amount as "463,-" with a non-breaking space
    /// after the euro sign. Until 2026-08-07 <c>MoneyParser</c> read the
    /// trailing hyphen as a minus and returned -46300, silently, and
    /// reconciliation agreed with it. This is that exact string.
    /// </summary>
    [Fact]
    public void The_total_is_read_by_its_label_and_is_positive()
    {
        var total = CoolblueHtmlOrders.ParseTotal(Details, Options);

        Assert.Equal(46_300L, total.Value);
        Assert.Equal("EUR", total.Currency);
    }

    /// <summary>
    /// And it takes the TOTAL, not the first amount on the page.
    ///
    /// The details page states a line price of 399 above a total of 463. A
    /// reader that grabbed the first euro sign it saw would be wrong by
    /// sixty-four euros and would still look like it worked.
    /// </summary>
    [Fact]
    public void The_first_amount_on_the_page_is_not_the_total()
    {
        Assert.Contains("399,-", Details, StringComparison.Ordinal);
        Assert.NotEqual(39_900L, CoolblueHtmlOrders.ParseTotal(Details, Options).Value);
    }

    /// <summary>
    /// The overview states no money at all, so a reader must never try to total
    /// from it - and the page does its best to offer one anyway.
    ///
    /// The real 610KB overview carries the word "Totaalbedrag" FOUR times and
    /// exactly one euro sign, and every one of them is in the flight payload:
    /// the app's translation dictionary, which defines the label, and a line
    /// reading "Het minimale bestedingsbedrag is EUR50". A reader that took the
    /// response at face value would find a label on a page that states no
    /// total, which is the most convincing way to be wrong.
    /// </summary>
    [Fact]
    public void The_overview_states_no_total_and_says_so_rather_than_inventing_one()
    {
        // The premise: the bait really is in the body being handed over.
        Assert.Contains("minimale bestedingsbedrag", Overview, StringComparison.Ordinal);
        Assert.Contains("Totaalbedrag", Overview, StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseTotal(Overview, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    /// <summary>
    /// A label names the thing beside it, and nothing further away than that.
    ///
    /// Synthetic on purpose - a real page offers no convenient decoy, which is
    /// the whole reason this bound has to be tested rather than observed. The
    /// reader searched forward without limit until 2026-08-07: a details page
    /// whose own total had moved would have answered with whatever number came
    /// next, and a receipt carrying some other element's figure reconciles
    /// against nothing and looks entirely normal.
    /// </summary>
    [Theory]
    [InlineData(100, 99_900L)]
    [InlineData(600, null)]
    public void A_value_too_far_from_its_label_is_not_that_labels_value(int distance, long? expected)
    {
        var body =
            "<div>Totaalbedrag</div>" +
            string.Concat(Enumerable.Repeat("<div class=\"css-filler\"></div>", distance / 30)) +
            "<div>999,-</div>";

        if (expected is { } value)
        {
            Assert.Equal(value, CoolblueHtmlOrders.ParseTotal(body, Options).Value);
            return;
        }

        var error = Assert.Throws<ConnectorException>(() => CoolblueHtmlOrders.ParseTotal(body, Options));
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    /// <summary>
    /// A money unit is DECLARED, never inferred. "463" and "463,-" are
    /// indistinguishable to a parser and mean different things to a bank, so an
    /// undeclared unit refuses rather than assuming euros.
    ///
    /// The default is no longer null - the capture settled that Coolblue writes
    /// MajorString - but the refusal has to survive that, because the discipline
    /// is what stops the next provider being guessed at.
    /// </summary>
    [Fact]
    public void An_undeclared_money_unit_refuses_instead_of_guessing()
    {
        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseTotal(Details, new CoolblueOptions { TotalUnit = null }));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("MajorString", error.Detail!, StringComparison.Ordinal);
    }

    // ---- line items --------------------------------------------------------

    [Fact]
    public void The_products_on_an_order_page_are_read_with_what_each_cost()
    {
        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(Details, Options));

        Assert.Equal("Testmerk Koelkast RB100", line.Name);
        Assert.Equal(39_900L, line.Total.Value);
        Assert.Equal("EUR", line.Total.Currency);

        // Nothing in front of the name, which on this page means one.
        Assert.Equal(1m, line.Quantity);
    }

    /// <summary>
    /// "3x Seagate IronWolf ST4000VN008 4TB" - a real line from a real order,
    /// and the one this reader used to say could not exist.
    ///
    /// It claimed quantity was not on the page at all, having only ever seen an
    /// order containing one of everything. The account owner found the
    /// counter-example and pointed at it.
    /// </summary>
    [Fact]
    public void A_count_in_front_of_a_product_is_that_lines_quantity()
    {
        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(Multiple(3, "Seagate IronWolf ST4000VN008 4TB"), Options));

        Assert.Equal(3m, line.Quantity);

        // And the count is NOT part of the name.
        Assert.Equal("Seagate IronWolf ST4000VN008 4TB", line.Name);
    }

    /// <summary>
    /// The amount beside a line is the LINE TOTAL, and is never multiplied by
    /// the count.
    ///
    /// CONFIRMED from that order's own invoice, which is the only place the
    /// unit price appears: <c>Aantal 3</c>, <c>Prijs per stuk EUR 134,99</c>,
    /// <c>Prijs incl. BTW EUR 404,97</c> - and the order page prints 404,97.
    ///
    /// Worth a test of its own because the mistake is so easy to make later. A
    /// reader that saw "3x" beside "404,97" and helpfully multiplied would
    /// report 1214,91 for three disks that cost 404,97, and the receipt would
    /// still look entirely ordinary: the derived Unattributed line would simply
    /// absorb the error as a NEGATIVE remainder, and reconciliation would agree
    /// with the whole thing.
    /// </summary>
    [Fact]
    public void The_amount_beside_a_line_is_the_total_for_all_of_them()
    {
        const string page =
            "<html><body><h2>Je bestelling</h2>" +
            "<h3>3x <a href=\"/product/1/seagate.html\"><span>Seagate IronWolf ST4000VN008 4TB</span></a></h3>" +
            "<div>404,97</div>" +
            "<h2>Adres- en betaalinformatie</h2></body></html>";

        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(page, Options));

        Assert.Equal(3m, line.Quantity);
        Assert.Equal(40_497L, line.Total.Value);

        // Not 3 x 404,97, and not 404,97 / 3 either.
        Assert.NotEqual(121_491L, line.Total.Value);
        Assert.NotEqual(13_499L, line.Total.Value);
    }

    /// <summary>
    /// A product whose own NAME begins "3x" is one thing, not three.
    ///
    /// Coolblue really sells such products - multipacks are named that way -
    /// and the difference is structural rather than a matter of guessing: the
    /// count sits outside the product link and the name inside it. A reader
    /// that stripped a leading count off the name would turn a single
    /// three-pack into three of a product that does not exist.
    /// </summary>
    [Theory]
    // One three-pack: the count is part of the NAME and there is none outside.
    [InlineData("", "3x AA batterij Alkaline", 1)]
    // TWO three-packs, which is the case that tells the two apart. A reader
    // taking the count off the name reports one; taking it off the whole
    // heading reports nothing; only reading what sits before the LINK gives
    // two of a product called "3x AA batterij Alkaline".
    [InlineData("2x ", "3x AA batterij Alkaline", 2)]
    // Text before the link that merely STARTS like a count is not one. A guard
    // against a shape not yet seen - Coolblue could put a badge there - and the
    // reason the pattern insists a count is the whole of what precedes the
    // name rather than merely its beginning.
    [InlineData("3x sneller bezorgd ", "Testmerk Waterkoker", 1)]
    public void A_product_named_like_a_multipack_is_still_one_product(
        string prefix, string product, int quantity)
    {
        var page =
            "<html><body><h2>Je bestelling</h2>" +
            $"<h3>{prefix}<a href=\"/product/1/3x-aa-batterij.html\"><span>{product}</span></a></h3>" +
            "<div>12,50</div>" +
            "<h2>Adres- en betaalinformatie</h2></body></html>";

        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(page, Options));

        Assert.Equal(product, line.Name);
        Assert.Equal(quantity, line.Quantity);
    }

    /// <summary>One order line, with a count in front of the product link.</summary>
    private static string Multiple(int quantity, string product) =>
        "<html><body><h2>Je bestelling</h2>" +
        $"<h3 class=\"css-i623zk\">{quantity}x <a href=\"/product/940557/seagate.html\" class=\"css-1prk0xx\">" +
        $"<span class=\"css-y6pps\">{product}</span></a></h3>" +
        "<div class=\"css-1u8qly9\">199,-</div>" +
        "<h2>Adres- en betaalinformatie</h2></body></html>";

    /// <summary>
    /// The trap this reader exists inside: after the payment block, an order
    /// page carries ACCESSORY RECOMMENDATIONS in the same heading-and-price
    /// shape as the order's own lines.
    ///
    /// They are real products at real prices that the customer never bought. A
    /// reader that walked the whole page would put them on the receipt, and the
    /// receipt would still look entirely plausible - the total is stated
    /// separately, so nothing would visibly disagree except the reconciliation
    /// flag, on a page where that flag is already expected to fire.
    /// </summary>
    [Fact]
    public void The_accessories_the_page_recommends_are_not_on_the_order()
    {
        // The bait is really in the fixture, below the payment block.
        Assert.Contains("Testmerk Koelkastfilter", Details, StringComparison.Ordinal);
        Assert.Contains("24,95", Details, StringComparison.Ordinal);

        Assert.DoesNotContain(
            CoolblueHtmlOrders.ParseItems(Details, Options),
            line => line.Name.Contains("Koelkastfilter", StringComparison.Ordinal));
    }

    /// <summary>
    /// A page with no product section is a shape change, not an empty order -
    /// and the page TITLE must not be mistaken for one.
    ///
    /// This is the test that caught a real bug an hour after it was written.
    /// Coolblue titles the page "Details van je bestelling | Coolblue", so a
    /// case-insensitive search for the section label finds the title and starts
    /// the section at the top of the document. On the captured page it still
    /// found the right product, which is the worst way for that to behave: it
    /// only misreads once the page changes shape, and by then nobody is
    /// looking.
    /// <para>
    /// Returning nothing would be worse still than failing: an empty item list
    /// reconciles trivially, so every receipt would come back looking checked
    /// and agreed when nothing had been read at all.
    /// </para>
    /// </summary>
    [Fact]
    public void The_page_title_is_not_the_product_section()
    {
        // The bait, in the fixture, exactly as Coolblue writes it.
        Assert.Contains("<title>Details van je bestelling", Details, StringComparison.Ordinal);

        // Strip the HEADING and leave the title alone.
        var without = Details.Replace(
            ">Je bestelling</h2>", ">Je spullen</h2>", StringComparison.Ordinal);

        Assert.Contains("je bestelling", without, StringComparison.OrdinalIgnoreCase);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(without, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Je bestelling", error.Detail!, StringComparison.Ordinal);
    }

    /// <summary>
    /// A heading inside the section is only a product if it LINKS to one.
    ///
    /// Synthetic, and labelled as such: the captured page puts nothing but
    /// product headings between the two boundaries, so this guard is against a
    /// shape not yet observed. It is a plausible one - Coolblue splits an order
    /// across shipments, and a heading grouping them ("Bezorgd op 20 november")
    /// would sit exactly here. Without the check that heading becomes a line
    /// item priced at whatever amount came next, which is a product the
    /// customer never bought at a price they did pay.
    /// </summary>
    [Fact]
    public void A_heading_that_links_to_no_product_is_not_a_line()
    {
        const string page =
            "<html><body>" +
            "<h2>Je bestelling</h2>" +
            "<h3>Bezorgd op 20 november</h3><div>2 artikelen</div>" +
            "<h3><a href=\"/product/940557/testmerk.html\"><span>Testmerk Koelkast RB100</span></a></h3>" +
            "<div>399,-</div>" +
            "<h2>Adres- en betaalinformatie</h2>" +
            "</body></html>";

        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(page, Options));

        Assert.Equal("Testmerk Koelkast RB100", line.Name);
        Assert.Equal(39_900L, line.Total.Value);
    }

    [Fact]
    public void A_product_with_no_price_beside_it_is_a_shape_change()
    {
        // The heading survives; its amount does not.
        var priceless = Details.Replace(
            "<div class=\"css-1u8qly9\">€ 399,-</div>", "<div class=\"css-1u8qly9\"></div>",
            StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(priceless, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Testmerk Koelkast RB100", error.Detail!, StringComparison.Ordinal);
    }

    /// <summary>
    /// A line unit is DECLARED, exactly as a total's is, and for the same
    /// reason: an order page states a total and its lines in two different
    /// places, which is no guarantee they agree on units.
    /// </summary>
    [Fact]
    public void An_undeclared_line_unit_refuses_instead_of_guessing()
    {
        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(Details, new CoolblueOptions { ItemUnit = null }));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("ItemUnit", error.Detail!, StringComparison.Ordinal);
    }

    // ---- shape changes -----------------------------------------------------

    /// <summary>
    /// A label names the thing IMMEDIATELY after it, not the nearest thing of
    /// the right shape.
    ///
    /// The difference decides what a card that has lost its own date does: read
    /// strictly it refuses, and read loosely it takes whatever date it can see
    /// and hands one order another's purchase date. Both look like a working
    /// fetch, and only one of them is.
    /// </summary>
    [Fact]
    public void A_date_near_the_label_is_not_the_labels_date()
    {
        const string card =
            "<a href=\"/mijn-coolblue-account/orderoverzicht/80000009\" class=\"css-ov5677\"></a>" +
            "<p class=\"css-1x2y3z\">Besteld op<!-- -->:</p><p class=\"css-i623zk\">Onbekend</p>" +
            "<p class=\"css-i623zk\">15 december 2025</p>";

        var error = Assert.Throws<ConnectorException>(() => Listings(card));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("80000009", error.Detail!, StringComparison.Ordinal);
    }

    /// <summary>
    /// Every occurrence of a label is tried, not just the first.
    ///
    /// The real details page says "Totaalbedrag" six times and the rendered
    /// total happens to come first - but that ordering is Next.js's, not a
    /// promise. A reader that gave up on the first mention would be one
    /// framework release away from finding the translation dictionary instead
    /// and refusing a page that states its total perfectly clearly.
    /// </summary>
    [Fact]
    public void A_label_with_nothing_beside_it_falls_through_to_the_one_that_has_a_value()
    {
        var body =
            "<div>Totaalbedrag</div><div>Betalingsdetails</div>" +
            string.Concat(Enumerable.Repeat("<div class=\"css-filler\"></div>", 30)) +
            "<div class=\"css-dt07t8\"><div>Totaalbedrag</div><div>463,-</div></div>";

        Assert.Equal(46_300L, CoolblueHtmlOrders.ParseTotal(body, Options).Value);
    }

    [Fact]
    public void A_card_with_no_date_is_a_shape_change_rather_than_a_silent_gap()
    {
        var undated = Overview.Replace("Besteld op", "Geplaatst op", StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(() => Listings(undated));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public void A_page_with_no_orders_yields_none_rather_than_failing()
    {
        Assert.Empty(Listings("<html><body><p>Je hebt nog geen bestellingen</p></body></html>"));
    }
}
