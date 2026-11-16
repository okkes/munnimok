using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Coolblue;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// the real overview has 110 css-<hash> classes (CSS-in-JS, change each deploy) and zero data-testid:
// the reader must survive losing them
// fixtures are a live capture with this account's products, ids and dates replaced
public sealed partial class CoolblueHtmlOrdersTests
{
    private static string Overview => FixtureCatalog.Read("coolblue/orders-overview.html");

    private static string Details => FixtureCatalog.Read("coolblue/order-details.html");

    private static CoolblueOptions Options => new() { TotalUnit = MoneyUnit.MajorString };

    [GeneratedRegex(@"css-([a-z0-9]+)")]
    private static partial Regex EmotionClass();

    private static IReadOnlyList<CoolblueListing> Listings(string? body = null) =>
        CoolblueHtmlOrders.ParseList(body ?? Overview, Options, RetailZones.Dutch);

    [Fact]
    public void Every_order_on_the_page_is_found_once()
    {
        Assert.Equal(["80000001", "80000002", "80000003"], Listings().Select(l => l.Id));
    }

    // every class renamed, as Coolblue's next deploy does:
    // a selector anywhere fails here against a page whose meaning is unchanged
    [Fact]
    public void A_redeploy_that_renames_every_class_changes_nothing()
    {
        var before = Listings();

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

    // the date is never beside its label: on the first card emotion emits a 406-character style block between them,
    // so a whitespace-only pattern matched the hand-written fixture and no real page
    [Fact]
    public void The_first_cards_date_is_behind_a_style_block_and_is_read_anyway()
    {
        var label = Overview.IndexOf("Besteld op", StringComparison.Ordinal);
        var style = Overview.IndexOf("<style", label, StringComparison.Ordinal);
        var date = Overview.IndexOf("15 december 2025", label, StringComparison.Ordinal);

        Assert.InRange(style, label, date);
        Assert.True(date - label > 400, $"the gap is {date - label} characters; the real one is 450");

        Assert.Equal(new DateOnly(2025, 12, 15), DateOnly.FromDateTime(Listings()[0].PlacedAt.Date));
    }

    // Coolblue writes prose in comments (the sign-in page explains its decoy field) and React emits empty comment separators:
    // a comment mentioning a label must not become its value
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

        // midnight in Amsterdam, not the agent's zone: the 1st must not become the 31st in London
        Assert.Equal(RetailZones.Dutch.GetUtcOffset(first.PlacedAt.DateTime), first.PlacedAt.Offset);
    }

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

    // the account nav links /mijn-facturen, a page not a document: anchoring on the word "factuur" would attach it to a receipt
    [Fact]
    public void The_account_navigations_facturen_link_is_not_an_invoice()
    {
        Assert.Contains("/mijn-coolblue-account/mijn-facturen", Overview, StringComparison.Ordinal);

        Assert.All(
            Listings().SelectMany(l => l.Invoices),
            invoice => Assert.Contains("/mijn-factuur/", invoice.Href, StringComparison.Ordinal));
    }

    // a whole-euro amount reads "463,-" after a non-breaking space; MoneyParser read the trailing hyphen as minus (-46300)
    // and reconciliation agreed
    [Fact]
    public void The_total_is_read_by_its_label_and_is_positive()
    {
        var total = CoolblueHtmlOrders.ParseTotal(Details, Options);

        Assert.Equal(46_300L, total.Value);
        Assert.Equal("EUR", total.Currency);
    }

    // the details page states a line price (399) above the total (463): the first euro sign would be wrong by 64 and look fine
    [Fact]
    public void The_first_amount_on_the_page_is_not_the_total()
    {
        Assert.Contains("399,-", Details, StringComparison.Ordinal);
        Assert.NotEqual(39_900L, CoolblueHtmlOrders.ParseTotal(Details, Options).Value);
    }

    // the real 610KB overview has "Totaalbedrag" four times and one euro sign, all in the flight payload
    // (translation dictionary, "minimale bestedingsbedrag EUR50"): a label on a page that states no total
    [Fact]
    public void The_overview_states_no_total_and_says_so_rather_than_inventing_one()
    {
        Assert.Contains("minimale bestedingsbedrag", Overview, StringComparison.Ordinal);
        Assert.Contains("Totaalbedrag", Overview, StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseTotal(Overview, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    // synthetic: a real page offers no decoy; the reader once searched forward without limit
    // and would answer with whatever number came next
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

    // a money unit is declared, never inferred: "463" and "463,-" look alike to a parser and differ to a bank; the refusal must
    // outlive the MajorString default
    [Fact]
    public void An_undeclared_money_unit_refuses_instead_of_guessing()
    {
        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseTotal(Details, new CoolblueOptions { TotalUnit = null }));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("MajorString", error.Detail!, StringComparison.Ordinal);
    }

    [Fact]
    public void The_products_on_an_order_page_are_read_with_what_each_cost()
    {
        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(Details, Options));

        Assert.Equal("Testmerk Koelkast RB100", line.Name);
        Assert.Equal(39_900L, line.Total.Value);
        Assert.Equal("EUR", line.Total.Currency);

        Assert.Equal(1m, line.Quantity);
    }

    // a real line from a real order; the reader once claimed quantity was not on the page
    [Fact]
    public void A_count_in_front_of_a_product_is_that_lines_quantity()
    {
        var line = Assert.Single(CoolblueHtmlOrders.ParseItems(Multiple(3, "Seagate IronWolf ST4000VN008 4TB"), Options));

        Assert.Equal(3m, line.Quantity);

        Assert.Equal("Seagate IronWolf ST4000VN008 4TB", line.Name);
    }

    // the line amount is the LINE TOTAL, never multiplied by the count: the invoice shows Aantal 3, Prijs per stuk 134,99,
    // Prijs incl. BTW 404,97 and the page prints 404,97; multiplying would be absorbed by a negative Unattributed remainder
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

        Assert.NotEqual(121_491L, line.Total.Value);
        Assert.NotEqual(13_499L, line.Total.Value);
    }

    // products really are named "3x ...": the count sits outside the product link, the name inside; stripping a leading count
    // would turn one three-pack into three of a product that does not exist
    [Theory]
    [InlineData("", "3x AA batterij Alkaline", 1)]
    // two three-packs tell the cases apart: only reading what sits before the LINK gives two
    [InlineData("2x ", "3x AA batterij Alkaline", 2)]
    // text before the link that only starts like a count is not one: guards an unseen shape (a badge);
    // the pattern needs the count to be all that precedes the name
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

    private static string Multiple(int quantity, string product) =>
        "<html><body><h2>Je bestelling</h2>" +
        $"<h3 class=\"css-i623zk\">{quantity}x <a href=\"/product/940557/seagate.html\" class=\"css-1prk0xx\">" +
        $"<span class=\"css-y6pps\">{product}</span></a></h3>" +
        "<div class=\"css-1u8qly9\">199,-</div>" +
        "<h2>Adres- en betaalinformatie</h2></body></html>";

    // after the payment block the page carries accessory recommendations shaped like the order's lines; walking the whole page
    // puts products never bought on the receipt
    [Fact]
    public void The_accessories_the_page_recommends_are_not_on_the_order()
    {
        Assert.Contains("Testmerk Koelkastfilter", Details, StringComparison.Ordinal);
        Assert.Contains("24,95", Details, StringComparison.Ordinal);

        Assert.DoesNotContain(
            CoolblueHtmlOrders.ParseItems(Details, Options),
            line => line.Name.Contains("Koelkastfilter", StringComparison.Ordinal));
    }

    // the page title "Details van je bestelling | Coolblue" matches a case-insensitive search for the section label;
    // returning nothing would reconcile trivially, so a missing section must fail
    [Fact]
    public void The_page_title_is_not_the_product_section()
    {
        Assert.Contains("<title>Details van je bestelling", Details, StringComparison.Ordinal);

        var without = Details.Replace(
            ">Je bestelling</h2>", ">Je spullen</h2>", StringComparison.Ordinal);

        Assert.Contains("je bestelling", without, StringComparison.OrdinalIgnoreCase);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(without, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Je bestelling", error.Detail!, StringComparison.Ordinal);
    }

    // synthetic: guards an unobserved shape; a shipment heading ("Bezorgd op 20 november") would otherwise become a line item
    // priced at the next amount
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
        var priceless = Details.Replace(
            "<div class=\"css-1u8qly9\">€\u00A0399,-</div>", "<div class=\"css-1u8qly9\"></div>",
            StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(priceless, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Testmerk Koelkast RB100", error.Detail!, StringComparison.Ordinal);
    }

    // a line unit is declared like a total's: total and lines are stated in different places and need not agree on units
    [Fact]
    public void An_undeclared_line_unit_refuses_instead_of_guessing()
    {
        var error = Assert.Throws<ConnectorException>(
            () => CoolblueHtmlOrders.ParseItems(Details, new CoolblueOptions { ItemUnit = null }));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("ItemUnit", error.Detail!, StringComparison.Ordinal);
    }

    // a label names what comes IMMEDIATELY after it: loose reading hands one order another's purchase date
    // and looks like a working fetch
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

    // every occurrence of a label is tried: the real page says "Totaalbedrag" six times and the rendered total comes first
    // only by Next.js ordering
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
