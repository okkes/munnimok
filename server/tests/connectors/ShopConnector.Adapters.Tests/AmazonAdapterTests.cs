using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// no API exists to stub, so every test runs against a recorded page
/// money and locale are weighted: the best public reference parses "€ 12,50" to 1250.0 and a Dutch month to null, silently
public sealed class AmazonAdapterTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private static readonly AmazonOptions Options = new();

    private const string Year2026Page1 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    private const string Year2026Page2 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=10";

    private const string OrderOne = "402-1122334-5566778";
    private const string OrderTwo = "402-2233445-6677889";
    private const string OrderThree = "402-3344556-7788990";

    private const string Print = "https://www.amazon.nl/gp/css/summary/print.html?orderID=";

    private const string Invoice402 = Print + OrderOne;
    private const string Invoice403 = Print + OrderTwo;
    private const string Invoice404 = Print + OrderThree;

    private static AmazonAdapter Adapter(AmazonOptions? options = null) =>
        new(options ?? Options, new FixedTimeProvider(Now));

    [Fact]
    public void Manifest_validates()
    {
        ManifestValidator.Validate(Adapter().Describe());
    }

    [Fact]
    public void Manifest_admits_what_this_provider_actually_is()
    {
        var manifest = Adapter().Describe();

        Assert.Equal("amazon-nl", manifest.Id);
        Assert.Equal("NL", manifest.Country);

        Assert.Equal(ProviderRuntime.BrowserInteractive, manifest.Runtime);
        Assert.True(manifest.Agent.Required, "a browser runtime cannot run inline");
        Assert.Equal("residential", manifest.Agent.Egress?.Kind);

        // desktop is load-bearing: amazon.nl's mobile sign-in (phone emulation) does not submit in containerised headed Chromium
        Assert.True(manifest.Agent.DesktopBrowser, "amazon.nl's mobile sign-in does not submit");

        // walls are interactive widgets: claiming unattended fetch would offer scheduled sync that fails at night
        Assert.False(manifest.UnattendedFetch, "a wall can arrive with nobody watching");
        Assert.False(manifest.Auth.Session.Refreshable, "the credential is a cookie jar with no refresh grant");
        Assert.False(manifest.Auth.Reauth.Cheap);
        Assert.Equal(SecretCustody.Client, manifest.SecretCustody);

        // LiveView is the normal path: a correct password from a pooled browser lands on Amazon's verification flow
        Assert.Contains(ChallengeType.LiveView, manifest.Auth.Challenges);
        Assert.Contains(ChallengeType.MfaCode, manifest.Auth.Challenges);
        Assert.Contains(ChallengeType.Image, manifest.Auth.Challenges);

        // AppApproval is gone: it told the user to approve in an app for a widget that has none
        Assert.DoesNotContain(ChallengeType.AppApproval, manifest.Auth.Challenges);
    }

    [Fact]
    public void Manifest_asks_for_a_password_and_never_for_the_second_factor()
    {
        var fields = Adapter().Describe().Auth.AllFields().ToList();

        var password = Assert.Single(fields, f => f.Type == FieldType.Password);
        Assert.True(password.Secret, "a password that is not marked secret is logged and screenshotted");

        // the reference auto-solves the code from a TOTP secret: holding both factors is account takeover, so the code is relayed
        Assert.DoesNotContain(fields, f =>
            f.Key.Contains("otp", StringComparison.OrdinalIgnoreCase)
            || f.Key.Contains("totp", StringComparison.OrdinalIgnoreCase)
            || f.Key.Contains("secret", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void The_order_url_leaves_the_storefront_in_dutch_unless_an_operator_says_otherwise()
    {
        // no &language=en_GB: unverified on .nl, and our parser reads Dutch
        var plain = Adapter().OrdersUrl(2026, 0);

        Assert.Equal(Year2026Page1, plain);
        Assert.DoesNotContain("language", plain, StringComparison.Ordinal);

        var forced = Adapter(Options with { LanguageOverride = "en_GB" }).OrdersUrl(2026, 10);
        Assert.Contains("language=en_GB", forced, StringComparison.Ordinal);
        Assert.Contains("startIndex=10", forced, StringComparison.Ordinal);
    }

    [Theory]
    // the reference strips letters and separators: "€ 12,50" becomes "1250", a hundred times the real order
    [InlineData("€ 12,50", 1_250)]
    [InlineData("€ 1.234,56", 123_456)]
    [InlineData("EUR 1.234,56", 123_456)]
    [InlineData("€1,234.56", 123_456)]
    [InlineData("€ 0,00", 0)]
    [InlineData("-€ 9,99", -999)]
    [InlineData("€ -9,99", -999)]
    // whole euros with grouping: the kit's parser alone reads this as a thousandth
    [InlineData("€ 1.234", 123_400)]
    [InlineData("€ 1,234", 123_400)]
    public void Dutch_amounts_are_read_as_major_units_in_euros(string rendered, long expectedMinorUnits)
    {
        var money = AmazonMoney.Parse(rendered, MoneyUnit.MajorString, "EUR", "total", Options);

        Assert.Equal(expectedMinorUnits, money.Value);
        Assert.Equal("EUR", money.Currency);
    }

    [Fact]
    public void The_grouping_guard_is_the_one_thing_the_kit_cannot_decide_alone()
    {
        Assert.Equal(123_456, MoneyParser.ToMinor("1.234,56", MoneyUnit.MajorString));
        Assert.Equal(123_456, MoneyParser.ToMinor("1,234.56", MoneyUnit.MajorString));

        // one separator is read as a decimal point and the string is ambiguous, so the adapter resolves the shape first
        Assert.Equal(123, MoneyParser.ToMinor("1.234", MoneyUnit.MajorString));
        Assert.Equal(123_400, AmazonMoney.Parse("€ 1.234", MoneyUnit.MajorString, "EUR", "total", Options).Value);
    }

    [Fact]
    public void The_declared_unit_governs_and_is_never_inferred_from_the_value()
    {
        // nothing in "1234" says which unit: the field declares it, the parser never guesses
        Assert.Equal(123_400, AmazonMoney.Parse("€ 1234", MoneyUnit.MajorString, "EUR", "t", Options).Value);
        Assert.Equal(1_234, AmazonMoney.Parse("€ 1234", MoneyUnit.Minor, "EUR", "t", Options).Value);

        Assert.Equal(MoneyUnit.MajorString, Options.OrderTotalUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.ItemAmountUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.InvoiceTotalUnit);
        Assert.Equal(MoneyUnit.MajorString, Options.DiscountAmountUnit);
        Assert.Equal("EUR", Options.Currency);
    }

    [Theory]
    [InlineData("$ 12.50")]
    [InlineData("£ 12.50")]
    [InlineData("USD 1,234.56")]
    public void An_amount_in_another_currency_stops_the_parse_instead_of_becoming_euros(string rendered)
    {
        // currency is declared, never inferred from a symbol: "$" is several currencies
        var error = Assert.Throws<ConnectorException>(
            () => AmazonMoney.Parse(rendered, MoneyUnit.MajorString, "EUR", "order total", Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("another currency", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_hyphen_in_a_label_does_not_turn_a_charge_into_a_credit()
    {
        // a hyphen in a label ("Btw-bedrag") must not turn a charge into a credit: only the amount's sign counts
        var tax = AmazonMoney.Row("Btw-bedrag: € 214,26", MoneyUnit.MajorString, "EUR", "t", Options);
        Assert.Equal(21_426, tax.Amount?.Value);
        Assert.Equal("Btw-bedrag", tax.Label);

        var discount = AmazonMoney.Row("Actie-korting: -€ 9,99", MoneyUnit.MajorString, "EUR", "t", Options);
        Assert.Equal(-999, discount.Amount?.Value);
        Assert.Equal("Actie-korting", discount.Label);
    }

    [Fact]
    public void A_dutch_month_name_is_read_and_carries_a_real_amsterdam_offset()
    {
        // the reference's dateutil fuzzy parse does not know "mei" and returns None
        var summer = AmazonDate.Parse("Besteld op 14 mei 2026", RetailZones.Dutch, "order date");
        var winter = AmazonDate.Parse("Besteld op 3 januari 2026", RetailZones.Dutch, "order date");

        Assert.Equal(new DateTimeOffset(2026, 5, 14, 0, 0, 0, TimeSpan.FromHours(2)), summer);
        Assert.Equal(new DateTimeOffset(2026, 1, 3, 0, 0, 0, TimeSpan.FromHours(1)), winter);

        // never a bare date: a near-midnight purchase read in the agent's zone lands on the wrong day
        Assert.Equal(TimeSpan.FromHours(2), summer.Offset);
        Assert.Equal(TimeSpan.FromHours(1), winter.Offset);
    }

    [Theory]
    [InlineData("12 mei 2026", 2026, 5, 12)]
    [InlineData("12 May 2026", 2026, 5, 12)]
    [InlineData("May 12, 2026", 2026, 5, 12)]
    [InlineData("2 maart 2026", 2026, 3, 2)]
    [InlineData("28 augustus 2025", 2025, 8, 28)]
    [InlineData("1 okt. 2025", 2025, 10, 1)]
    [InlineData("2026-05-12", 2026, 5, 12)]
    public void Both_languages_are_read_so_the_language_switch_changes_nothing(
        string rendered, int year, int month, int day)
    {
        var parsed = AmazonDate.Parse(rendered, RetailZones.Dutch, "order date");

        Assert.Equal(new DateOnly(year, month, day), DateOnly.FromDateTime(parsed.Date));
    }

    [Fact]
    public void An_unreadable_date_is_a_shape_change_and_not_a_null()
    {
        var error = Assert.Throws<ConnectorException>(
            () => AmazonDate.Parse("Besteld op ergens", RetailZones.Dutch, "order date"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    /// real markup of 2026-08-05, values substituted: invented markup once passed while the live page lacked .yohtmlc-order-date
    [Fact]
    public void The_dutch_order_list_parses_into_summaries()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), Options, RetailZones.Dutch);

        Assert.Equal(2, rows.Count);

        Assert.Equal("402-1122334-5566778", rows[0].Id);
        Assert.Equal(2_598, rows[0].Total?.Value);
        Assert.Equal("EUR", rows[0].Total?.Currency);

        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), rows[0].PurchasedAt);
        Assert.Equal(
            "https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1122334-5566778",
            rows[0].InvoiceUrl);

        Assert.Equal("402-2233445-6677889", rows[1].Id);
    }

    /// the id is the number inside data-csa-c-slot-id, not the attribute: a widget prefix dedupes fine and matches nothing
    [Fact]
    public void An_order_id_is_the_number_inside_the_attribute_not_the_attribute()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), Options, RetailZones.Dutch);

        Assert.All(rows, row =>
        {
            Assert.Matches(@"^\d{3}-\d{7}-\d{7}$", row.Id);
            Assert.DoesNotContain("amzn1", row.Id, StringComparison.Ordinal);
        });
    }

    /// date and total are found by label: the header's four facts are identical li elements
    [Fact]
    public void The_header_is_read_by_its_labels_and_not_by_its_layout()
    {
        var blind = Options with
        {
            OrderDateSelectors = ["#nothing-date"],
            OrderTotalSelectors = ["#nothing-total"],
        };

        var rows = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), blind, RetailZones.Dutch);

        Assert.Equal(2_598, rows[0].Total?.Value);
        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), rows[0].PurchasedAt);
    }

    /// a card with no total is carried, not fatal: one order in nineteen lacked "Totaal" and failed every receipt
    [Fact]
    public void A_card_that_states_no_total_is_carried_rather_than_fatal()
    {
        var rows = AmazonOrderParser.ParseList(Dom("orders-missing-total"), Options, RetailZones.Dutch);

        var row = Assert.Single(rows);
        Assert.Null(row.Total);

        Assert.NotEqual(string.Empty, row.Id);
        Assert.NotEqual(default, row.PurchasedAt);
    }

    /// the invoice is opened for such an order even with items off: dropping a purchase over an odd card is silent data loss
    [Fact]
    public async Task An_order_with_no_card_total_still_gets_one_from_its_invoice()
    {
        var pages = new StubAmazonPages
        {
            [Year2026Page1] = "orders-missing-total",
            ["https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1234567-1234567"] = "invoice-402",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31), items: false),
            pages, wall: null, redirects: null, CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);

        Assert.Equal(2_598, receipt.Total.Value);

        Assert.Empty(receipt.Items);

        Assert.Contains(pages.Opened, url => url.Contains("print.html", StringComparison.Ordinal));
    }

    /// a cancelled order has no card total and a one-sentence invoice ("Deze bestelling is geannuleerd"):
    /// skipped, not a shape change
    [Fact]
    public async Task A_cancelled_order_is_skipped_rather_than_reported_or_failed()
    {
        var pages = new StubAmazonPages
        {
            [Year2026Page1] = "orders-missing-total",
            ["https://www.amazon.nl/gp/css/summary/print.html?orderID=402-1234567-1234567"] = "invoice-cancelled",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    [Fact]
    public void A_cancelled_invoice_is_recognised_and_a_real_one_is_not()
    {
        Assert.True(AmazonOrderParser.IsCancelled(Dom("invoice-cancelled"), Options));

        Assert.False(AmazonOrderParser.IsCancelled(Dom("invoice-402"), Options));
        Assert.False(AmazonOrderParser.IsCancelled(Dom("invoice-two-items"), Options));
    }

    /// the marker is the whole sentence: bare "Geannuleerd" also appears on a live order with one cancelled item
    [Fact]
    public void An_order_with_one_cancelled_item_is_still_a_purchase()
    {
        var page = AmazonFixture.Page("invoice-402").Html.Replace(
            "<div id=\"a-page\">",
            "<div id=\"a-page\"><div class=\"a-row\"><span>Geannuleerd: 1 artikel</span></div>",
            StringComparison.Ordinal);

        var dom = HtmlParser.Parse(page);

        Assert.Contains("Geannuleerd", page, StringComparison.Ordinal);

        Assert.False(AmazonOrderParser.IsCancelled(dom, Options));

        var invoice = AmazonOrderParser.ParseInvoice(dom, Options);
        Assert.Single(invoice.Items);
        Assert.Equal(2_598, invoice.StatedTotal?.Value);
    }

    /// prod 2026-10-05: a digital order's card (D01-…) has no date the parser knows; it is left out and named, the rest stands
    [Fact]
    public void A_card_without_a_readable_date_is_left_out_and_named_while_the_rest_of_the_list_stands()
    {
        var html = AmazonFixture.Page("orders-2026-p1").Html;
        // the recorded layout labels the date "Bestelling geplaatst" in a caps span; a digital order's card wears another word
        const string label = ">Bestelling geplaatst<";
        var first = html.IndexOf(label, StringComparison.Ordinal);
        Assert.True(first >= 0);
        var page = html[..first] + ">Digitale bestelling<" + html[(first + label.Length)..];
        var all = AmazonOrderParser.ParseList(Dom("orders-2026-p1"), Options, RetailZones.Dutch);

        var skipped = new List<string>();
        var rows = AmazonOrderParser.ParseList(HtmlParser.Parse(page), Options, RetailZones.Dutch, skipped);

        Assert.Equal(all.Count - 1, rows.Count);
        var left = Assert.Single(skipped);
        Assert.Equal(all[0].Id, left);
        Assert.DoesNotContain(rows, row => row.Id == left);
        Assert.Equal(all.Count - 1, AmazonOrderParser.ParseList(HtmlParser.Parse(page), Options, RetailZones.Dutch).Count);
    }

    [Fact]
    public void A_total_that_is_stated_and_unreadable_still_stops_everything()
    {
        var page = AmazonFixture.Page("orders-2026-p1").Html
            .Replace("&euro;&nbsp;25,98", "twenty-five ninety-eight", StringComparison.Ordinal)
            .Replace("€&nbsp;25,98", "twenty-five ninety-eight", StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(
            () => AmazonOrderParser.ParseList(HtmlParser.Parse(page), Options, RetailZones.Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("no readable total", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Pagination_stops_where_the_page_says_it_stops()
    {
        Assert.True(AmazonOrderParser.HasNextPage(Dom("orders-2026-p1"), Options));

        // the last page still renders a "Vorige" anchor with startIndex=: reading it as next costs an extra request per year
        Assert.False(AmazonOrderParser.HasNextPage(Dom("orders-2026-p2"), Options));
    }

    /// the print invoice is built from data-component attributes, no longer a table: tr.item-row matched nothing live
    [Fact]
    public void The_print_invoice_parses_into_lines_and_charges()
    {
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);

        // postage is €0,00 and the BTW row decomposes the total: no synthetic lines
        var item = Assert.Single(invoice.Items);

        Assert.Equal("Testartikel een", item.Name);
        Assert.Equal(1_299, item.UnitPrice?.Value);

        Assert.Equal(2m, item.Quantity);
        Assert.Equal(2_598, item.Total.Value);

        Assert.Equal("card", invoice.Payment.Method);
        Assert.Equal("4242", invoice.Payment.CardLast4);
        Assert.Equal(2_598, invoice.StatedTotal?.Value);
    }

    /// [data-component='quantity'] is always empty: the number is a badge over the thumbnail, absent when the quantity is one
    [Fact]
    public void A_quantity_comes_from_the_badge_because_the_quantity_element_is_empty()
    {
        var dom = Dom("invoice-402");

        var decoy = HtmlQuery.First(dom, "[data-component='quantity']");
        Assert.NotNull(decoy);
        Assert.Equal(string.Empty, decoy.Text().Trim());

        Assert.Equal(2m, Assert.Single(AmazonOrderParser.ParseInvoice(dom, Options).Items).Quantity);

        // with only the decoy the line falls back to 1: right here because Amazon omits the badge on single items
        var blind = Options with { InvoiceItemQuantitySelectors = ["[data-component='quantity']"] };
        Assert.Equal(1m, Assert.Single(AmazonOrderParser.ParseInvoice(dom, blind).Items).Quantity);
    }

    [Fact]
    public void Every_purchased_line_becomes_its_own_item()
    {
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-two-items"), Options);

        Assert.Equal(2, invoice.Items.Count);
        Assert.Equal(["Testartikel een", "Testartikel twee"], invoice.Items.Select(i => i.Name));

        Assert.Equal(2_299, invoice.Items[0].UnitPrice?.Value);
        Assert.Equal(2_199, invoice.Items[1].UnitPrice?.Value);
    }

    /// purchasedItems appears once per shipment, not per product: treating it as the row collapses a two-product order
    [Fact]
    public void A_shipment_holding_two_products_is_not_read_as_one_line()
    {
        var dom = Dom("invoice-two-items");

        Assert.Single(HtmlQuery.All(dom, "[data-component='purchasedItems']"));
        Assert.Equal(2, HtmlQuery.All(dom, "[data-component='itemTitle']").Count);

        Assert.Equal(2, AmazonOrderParser.ParseInvoice(dom, Options).Items.Count);

        var collapsed = Options with { InvoiceItemRowSelectors = ["[data-component='purchasedItems']"] };
        Assert.Single(AmazonOrderParser.ParseInvoice(dom, collapsed).Items);
    }

    /// every price renders twice in span.a-price ("€22,99€22,99"): the parser takes the first amount, so either selector works
    [Fact]
    public void A_doubled_price_is_read_once_however_it_is_selected()
    {
        var dom = Dom("invoice-two-items");

        var price = HtmlQuery.First(dom, "[data-component='unitPrice']");
        Assert.NotNull(price);
        Assert.Equal(
            "€22,99€22,99",
            HtmlText.Normalize(price.Text()).Replace(" ", string.Empty, StringComparison.Ordinal));

        Assert.Equal(2_299, AmazonOrderParser.ParseInvoice(dom, Options).Items[0].UnitPrice?.Value);

        var blunt = Options with { InvoiceItemPriceSelectors = ["[data-component='unitPrice']"] };
        Assert.Equal(2_299, AmazonOrderParser.ParseInvoice(dom, blunt).Items[0].UnitPrice?.Value);
    }

    /// "Porto- en verpakkingskosten" matched no shipping label: postage was dropped and reconciliation failed by it
    [Fact]
    public void Dutch_postage_is_recognised_as_shipping()
    {
        Assert.Equal(
            AmazonTotalKind.Shipping,
            AmazonOrderParser.Categorize("Porto- en verpakkingskosten:", Options));

        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);
        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("Porto", StringComparison.Ordinal));
    }

    /// "Totaal" is what the order came to, "Eindtotaal" what was charged: they diverge when a gift card pays part
    [Fact]
    public void The_stated_total_is_what_was_charged()
    {
        Assert.Equal(AmazonTotalKind.FinalTotal, AmazonOrderParser.Categorize("Eindtotaal:", Options));
        Assert.Equal(AmazonTotalKind.GrandTotal, AmazonOrderParser.Categorize("Totaal:", Options));

        // "Totaal excl. btw" contains "totaal" but is neither
        Assert.Equal(AmazonTotalKind.TotalBeforeTax, AmazonOrderParser.Categorize("Totaal excl. btw:", Options));
    }

    [Fact]
    public void The_btw_row_decomposes_the_total_and_is_never_added_to_it()
    {
        // consumer prices include BTW: the tax row explains the total, emitting it as a line double-counts VAT
        var invoice = AmazonOrderParser.ParseInvoice(Dom("invoice-402"), Options);

        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("Btw", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(invoice.Items, item => item.Name.Contains("vóór", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(invoice.Items,
            item => item.Name.Contains("Subtotaal", StringComparison.OrdinalIgnoreCase));

        // a switch because a tax-exclusive breakdown on Amazon is unconfirmed
        var exclusive = AmazonOrderParser.ParseInvoice(
            Dom("invoice-402"), Options with { TaxIsIncludedInItemPrices = false });

        Assert.Contains(exclusive.Items, item => item.Name.Equals("Btw", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Artikelen (Subtotaal)", "Subtotal")]
    [InlineData("Subtotaal", "Subtotal")]
    [InlineData("Totaal vóór btw", "TotalBeforeTax")]
    [InlineData("Btw", "Tax")]
    [InlineData("Verzendkosten", "Shipping")]
    [InlineData("Actiekorting", "Promotion")]
    [InlineData("Cadeaubon", "GiftCard")]
    [InlineData("Totaal", "GrandTotal")]
    [InlineData("Grand Total", "FinalTotal")]
    public void Label_priority_keeps_the_subtotal_from_becoming_the_total(string label, string expected)
    {
        // "subtotaal" contains "totaal" and "totaal vóór btw" contains "btw": one contains-match misfiles both
        Assert.Equal(expected, AmazonOrderParser.Categorize(label, Options).ToString());
    }

    [Fact]
    public async Task A_year_of_dutch_orders_becomes_normalized_receipts()
    {
        var pages = OrderPages();
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.True(result.Complete);
        Assert.Equal("orders-html+print-invoice", result.Via);
        Assert.Equal(3, result.Receipts.Count);

        var first = result.Receipts[0];
        Assert.Equal(OrderOne, first.ExternalId);
        Assert.Equal(new DateTimeOffset(2026, 6, 21, 0, 0, 0, TimeSpan.FromHours(2)), first.PurchasedAt);
        Assert.Equal(2_598, first.Total.Value);
        Assert.Equal("EUR", first.Total.Currency);
        Assert.Equal("amazon-nl", first.Merchant.Id);
        Assert.Equal("card", first.Payment?.Method);
        Assert.Equal("4242", first.Payment?.CardLast4);

        var only = Assert.Single(first.Items);
        Assert.Equal(2m, only.Quantity);
        Assert.Equal(2_598, only.Total.Value);

        // every fixture pairs a card with the invoice of that order, so reconciliation is a real check
        Assert.True(first.Reconciled, "the invoice lines must sum to the total the list card stated");
        Assert.All(result.Receipts, receipt => Assert.True(receipt.Reconciled));

        Assert.Equal(2, result.Receipts[1].Items.Count);
        Assert.Equal(4_498, result.Receipts[1].Total.Value);

        DateOnly[] days = [new(2026, 6, 21), new(2026, 6, 2), new(2026, 3, 6)];
        Assert.Equal(days, result.Receipts.Select(r => DateOnly.FromDateTime(r.PurchasedAt.Date)));
        Assert.All(result.Receipts, receipt => Assert.NotEqual(TimeSpan.Zero, receipt.PurchasedAt.Offset));

        Assert.All(result.Receipts, receipt => Assert.NotEqual(string.Empty, receipt.ContentHash));
        Assert.Equal(3, result.Receipts.Select(r => r.Id).Distinct(StringComparer.Ordinal).Count());

        string[] expected =
        [
            Year2026Page1, Year2026Page2, Invoice402, Invoice403, Invoice404,
        ];

        Assert.Equal(expected, pages.Opened);
    }

    // raw is empty on this provider: a scraped page is not a payload (see AmazonInvoiceDocumentTests)

    [Fact]
    public async Task Without_items_no_invoice_is_ever_opened()
    {
        var pages = OrderPages();
        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31), items: false),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Equal("orders-html", result.Via);
        Assert.Equal(3, result.Receipts.Count);
        Assert.All(result.Receipts, receipt => Assert.Empty(receipt.Items));
        Assert.DoesNotContain(pages.Opened, url => url.Contains("print.html", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_receipt_that_does_not_reconcile_is_flagged_and_never_dropped()
    {
        var pages = OrderPages();
        pages.Replace(Invoice403, "invoice-403-short");

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        var shortened = Assert.Single(
            result.Receipts, r => string.Equals(r.ExternalId, OrderTwo, StringComparison.Ordinal));

        Assert.False(shortened.Reconciled);
        Assert.Equal(4_498, shortened.Total.Value);                         // the list card's figure is kept
        Assert.NotEqual(4_498, shortened.Items.Sum(item => item.Total.Value));

        // still emitted: dropping hides a purchase, trusting it hands over a total that disagrees with its lines
        Assert.Equal(3, result.Receipts.Count);
    }

    [Fact]
    public async Task An_empty_year_is_an_empty_answer_and_not_an_error()
    {
        var pages = new StubAmazonPages
        {
            ["https://www.amazon.nl/your-orders/orders?timeFilter=year-2025&startIndex=0"] = "orders-2025-empty",
        };

        using var ctx = new FakeJobContext { Material = Material() };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2025, 1, 1), Requests.Day(2025, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task A_redesigned_list_is_a_shape_change_and_never_an_empty_history()
    {
        // an expired card selector must not look like a genuinely empty year
        var pages = new StubAmazonPages { [Year2026Page1] = "orders-redesigned" };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("empty-history notice", error.Detail, StringComparison.Ordinal);
        Assert.Contains("js-order-card", error.Detail, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("blocked-403")]
    [InlineData("blocked-429")]
    public async Task Bot_protection_statuses_are_blocked_by_provider_and_never_a_credential_problem(string fixture)
    {
        // 429 from a bot wall is not rate_limited: retrying into it escalates a working session to a hard block
        var pages = new StubAmazonPages { [Year2026Page1] = fixture };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
        Assert.NotEqual(ErrorCode.RateLimited, error.Code);
    }

    [Theory]
    [InlineData("challenge-acic", "Interactive")]
    [InlineData("challenge-waf", "Interactive")]
    [InlineData("captcha-image", "Image")]
    [InlineData("blocked-403", "HttpFailure")]
    [InlineData("blocked-429", "HttpFailure")]
    [InlineData("signin", "SignIn")]
    [InlineData("orders-2026-p1", "Ok")]
    public void Every_wall_amazon_serves_is_recognised_for_what_it_is(string fixture, string expected)
    {
        var page = AmazonFixture.Page(fixture);

        Assert.Equal(expected, AmazonGuard.Inspect(page, HtmlParser.Parse(page.Html), Options).Kind.ToString());
    }

    [Fact]
    public async Task An_unattended_agent_refuses_a_widget_at_once_and_nobody_is_asked()
    {
        // nobody can reach a pooled headless browser: refusing at once lets the consumer tell the user to connect elsewhere
        var pages = new StubAmazonPages { [Year2026Page1] = "challenge-acic" };

        using var ctx = new FakeJobContext { Material = Material(), Attended = false };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Empty(ctx.Asked);
    }

    [Fact]
    public async Task An_attended_browser_is_asked_to_pass_the_widget_and_the_page_is_read_again()
    {
        // the person at the browser passes the wall; nothing is solved and no solving service is called
        var pages = OrderPages();
        pages.Once(Year2026Page1, "challenge-acic");

        var wall = AmazonStubPage.Showing("#aa-challenge-page-captcha-container");
        using var ctx = new FakeJobContext
        {
            Material = Material(),
            Attended = true,
            Browser = new AmazonStubBrowser(wall),
            Answer = _ => string.Empty,
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall, new StubRedirectWaiter(null, int.MaxValue), CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.AppApproval, asked.Type);
        Assert.True(asked.IsPassive, "there is nothing for the human to type back at a widget");
        Assert.Equal(3, result.Receipts.Count);

        // asked once: a wall still standing on the retry ends the job
        Assert.Equal(2, pages.Opened.Count(url => url == Year2026Page1));
    }

    [Fact]
    public async Task Landing_on_the_sign_in_chain_during_a_fetch_is_a_dead_session()
    {
        var pages = new StubAmazonPages { [Year2026Page1] = "signin" };

        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        // not invalid_credentials: no credential is submitted during a fetch
        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    [Fact]
    public async Task A_fetch_with_no_browser_state_asks_for_a_new_login_rather_than_guessing()
    {
        using var ctx = new FakeJobContext { Material = new SessionMaterial() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1)), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.False(ctx.Browser.Started, "no browser is worth starting for a session that is not there");
    }

    [Fact]
    public async Task An_unknown_resource_is_refused_before_anything_is_opened()
    {
        using var ctx = new FakeJobContext { Material = Material() };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = "invoices" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
    }

    /// the Dutch site suffixes cookies with its marketplace (x-acbnl, at-acbnl) and never sets x-main, which is amazon.com's
    [Fact]
    public void A_real_signed_in_jar_is_recognised_on_this_storefront()
    {
        Assert.True(AmazonCookies.HasAny(
            FixtureCatalog.Read("amazon/storage-state.json"), Options.AuthCookieNames));

        Assert.DoesNotContain("x-main", Options.AuthCookieNames[0], StringComparison.Ordinal);
    }

    /// anonymous visitors get session-id, ubid-acbnl, lc-acbnl, sst-acbnl: listing any seals a failed login (live 2026-08-06)
    [Fact]
    public void An_anonymous_jar_is_refused_however_many_cookies_it_carries()
    {
        var anonymous = FixtureCatalog.Read("amazon/storage-state-anonymous.json");

        Assert.Contains("ubid-acbnl", anonymous, StringComparison.Ordinal);
        Assert.Contains("sst-acbnl", anonymous, StringComparison.Ordinal);
        Assert.Contains("session-token", anonymous, StringComparison.Ordinal);

        Assert.False(AmazonCookies.HasAny(anonymous, Options.AuthCookieNames));
    }

    [Fact]
    public void A_jar_we_cannot_read_is_one_we_cannot_vouch_for()
    {
        Assert.False(AmazonCookies.HasAny(
            """{"cookies":[{"name":"session-id","value":"x"}]}""", Options.AuthCookieNames));

        Assert.False(AmazonCookies.HasAny("not json at all", Options.AuthCookieNames));
        Assert.False(AmazonCookies.HasAny(null, Options.AuthCookieNames));
    }

    private static HtmlNode Dom(string fixture) => HtmlParser.Parse(AmazonFixture.Page(fixture).Html);

    private static SessionMaterial Material() =>
        new() { StorageState = FixtureCatalog.Read("amazon/storage-state.json") };

    private static StubAmazonPages OrderPages() => new()
    {
        [Year2026Page1] = "orders-2026-p1",
        [Year2026Page2] = "orders-2026-p2",
        [Invoice402] = "invoice-402",
        [Invoice403] = "invoice-two-items",
        [Invoice404] = "invoice-third",
    };
}
