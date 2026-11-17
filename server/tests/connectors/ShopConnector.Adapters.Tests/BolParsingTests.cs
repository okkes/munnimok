using System.Net;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// both shapes exist (HTML vs JSON was unsettled) and must give the same receipts; the unit is DECLARED per field,
// never sniffed: a provider's totals once came out 100x wrong and reconciliation cannot catch it.
// Fixtures are SYNTHETIC: they prove the machinery, not bol's markup.
public sealed class BolParsingTests
{
    // stated, not defaulted: the default shape is the captured GraphQL one
    private static readonly BolOptions Html = new() { OrdersShape = BolOrdersShape.Html };

    private static readonly BolOptions Json = new() { OrdersShape = BolOrdersShape.Json };

    // same zone the adapter resolves: a host with trimmed globalization data fails here, not as a receipt on the wrong day
    private static readonly TimeZoneInfo Amsterdam = Adapters.Support.RetailZones.Dutch;

    [Fact]
    public void Dutch_amounts_are_read_as_decimal_comma_because_the_unit_says_so()
    {
        var orders = ParseHtml("bol/orders-page.html");

        // 54,97 = 5497; the plausible wrong reads are 54 (comma as group separator) and 549700 (major read as minor)
        Assert.Equal(5497, orders[0].Total.Value);
        Assert.Equal("EUR", orders[0].Total.Currency);

        // thousands dot plus decimal comma: where an English-minded parser divides by a thousand
        Assert.Equal(124_900, orders[1].Total.Value);

        Assert.Equal(3294, orders[2].Total.Value);
    }

    [Fact]
    public void The_declared_unit_governs_the_parse_and_the_value_never_gets_a_vote()
    {
        // JsonAmountUnit is the one setting that can be wrong unnoticed: a setting, never a heuristic
        var asEuros = ParseJson("bol/orders.json", Json);
        var asCents = ParseJson("bol/orders.json", Json with { JsonAmountUnit = MoneyUnit.Minor });

        Assert.Equal(5497, asEuros[0].Total.Value);
        Assert.Equal(54, asCents[0].Total.Value);
    }

    [Theory]
    [InlineData("2e halve prijs - € 3,00", "-3,00")]
    [InlineData("€ 39,98", "39,98")]
    [InlineData("€ 1.249,00", "1.249,00")]
    [InlineData("Korting 12,50-", "-12,50")]
    [InlineData("€ 10,00 - € 12,00", "10,00")]
    [InlineData("Gratis verzending", null)]
    public void The_price_in_a_label_is_the_one_the_currency_symbol_introduces(string text, string? expected)
    {
        // "2e halve prijs - EUR 3,00" holds two numbers; a '-' between two prices is no sign, only a touching minus is
        Assert.Equal(expected, BolHtml.MoneyText(text));
    }

    [Fact]
    public void Purchased_at_carries_a_real_amsterdam_offset()
    {
        var orders = ParseHtml("bol/orders-page.html");

        Assert.Equal(TimeSpan.FromHours(2), orders[0].PlacedAt.Offset);
        Assert.Equal(new DateTimeOffset(2026, 6, 14, 10, 32, 0, TimeSpan.FromHours(2)), orders[0].PlacedAt);

        // winter CET: a bare date would put a near-midnight order on the wrong day for bank matching
        Assert.Equal(TimeSpan.FromHours(1), orders[2].PlacedAt.Offset);
    }

    [Fact]
    public void A_rendered_dutch_date_is_understood_rather_than_dropped()
    {
        var orders = ParseHtml("bol/orders-page.html");

        // invariant culture cannot read "maart": the month table is written out; the offset still comes from the one computing place
        Assert.Equal(new DateTimeOffset(2026, 3, 3, 21, 48, 0, TimeSpan.FromHours(1)), orders[1].PlacedAt);
    }

    [Theory]
    [InlineData("14 juni 2026", 2026, 6, 14)]
    [InlineData("1 mei 2026", 2026, 5, 1)]
    [InlineData("31 december 2025", 2025, 12, 31)]
    [InlineData("7 okt. 2025", 2025, 10, 7)]
    [InlineData("14-06-2026", 2026, 6, 14)]
    [InlineData("2026-06-14T10:32:00+02:00", 2026, 6, 14)]
    public void Every_shape_bol_might_write_a_date_in_resolves(string raw, int year, int month, int day)
    {
        var parsed = BolDate.Parse(raw, Amsterdam, "order.date");

        Assert.Equal(year, parsed.Year);
        Assert.Equal(month, parsed.Month);
        Assert.Equal(day, parsed.Day);
        Assert.NotEqual(TimeSpan.Zero, parsed.Offset);
    }

    [Theory]
    [InlineData("14 smurfember 2026")]
    [InlineData("gisteren")]
    [InlineData("")]
    public void A_date_that_cannot_be_read_is_named_and_never_guessed(string raw)
    {
        var error = Assert.Throws<ConnectorException>(() => BolDate.Parse(raw, Amsterdam, "order.date"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("order.date", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Items_and_discounts_sum_to_the_stated_total()
    {
        var receipts = await FetchAsync("bol/orders-page.html", Html);
        var order = Assert.Single(receipts, r => r.ExternalId == "4001234567");

        Assert.True(order.Reconciled);
        Assert.Equal(2, order.Items.Count);

        var lamps = order.Items[0];
        Assert.Equal("Philips Hue White E27 - 2-pack", lamps.Name);
        Assert.Equal(2m, lamps.Quantity);
        Assert.Equal(1999, lamps.UnitPrice!.Value.Value);
        Assert.Equal(3998, lamps.Total.Value);
        Assert.Null(lamps.Discount);

        var cable = order.Items[1];
        Assert.Equal(1799, cable.Total.Value);

        // negative, always: without discount lines items do not sum to the total and promo orders flag as suspect
        Assert.NotNull(cable.Discount);
        Assert.Equal(-300, cable.Discount.Amount.Value);
        Assert.Equal("2e halve prijs", cable.Discount.Label);

        Assert.Equal(3998 + 1799 - 300, order.Total.Value);
    }

    [Fact]
    public async Task A_receipt_that_does_not_reconcile_is_flagged_and_never_dropped()
    {
        var receipts = await FetchAsync("bol/orders-page.html", Html);
        var order = Assert.Single(receipts, r => r.ExternalId == "4000998877");

        // the total carries shipping the lines lack: dropping hides a purchase, trusting is wrong, so emit it marked
        Assert.False(order.Reconciled);
        Assert.Equal(3294, order.Total.Value);
        Assert.Equal(1295 + 1500, order.Items.Sum(i => i.Total.Value));
    }

    [Fact]
    public async Task A_row_with_a_name_and_no_price_is_not_a_line_item()
    {
        var receipts = await FetchAsync("bol/orders-page.html", Html);
        var order = Assert.Single(receipts, r => r.ExternalId == "4000998877");

        // "Bezorgd op ..." is a status label, not a zero-priced item
        Assert.Equal(2, order.Items.Count);
        Assert.DoesNotContain(order.Items, i => i.Name.StartsWith("Bezorgd", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_marketplace_seller_becomes_the_store_name()
    {
        var receipts = await FetchAsync("bol/orders-page.html", Html);

        // bol is a marketplace: who actually sold it is real information
        Assert.Equal("bol.com", Assert.Single(receipts, r => r.ExternalId == "4001234567").Merchant.StoreName);
        Assert.Equal(
            "TechDeal Nederland B.V.",
            Assert.Single(receipts, r => r.ExternalId == "4001199887").Merchant.StoreName);

        // null where the page names nobody, never bol's own name
        Assert.Null(Assert.Single(receipts, r => r.ExternalId == "4000998877").Merchant.StoreName);

        Assert.All(receipts, r => Assert.Equal("bol", r.Merchant.Id));
        Assert.All(receipts, r => Assert.Equal("bol.com", r.Merchant.Name));
    }

    [Fact]
    public async Task The_payment_method_is_normalized_and_a_missing_tail_stays_null()
    {
        var receipts = await FetchAsync("bol/orders-page.html", Html);

        Assert.Equal("ideal", Assert.Single(receipts, r => r.ExternalId == "4001234567").Payment!.Method);

        // "Achteraf betalen" is pay-later: it settles days after the order and would look like a missing payment
        Assert.Equal("invoice", Assert.Single(receipts, r => r.ExternalId == "4001199887").Payment!.Method);

        // explicit null: the consumer must know its bank match is weaker
        Assert.All(receipts, r => Assert.Null(r.Payment!.CardLast4));
    }

    [Fact]
    public async Task Both_shapes_normalize_the_same_orders_into_the_same_receipts()
    {
        var fromHtml = await FetchAsync("bol/orders-page.html", Html);
        var fromJson = await FetchAsync("bol/orders.json", Json, json: true);

        Assert.Equal(fromHtml.Count, fromJson.Count);

        foreach (var (html, json) in fromHtml.Zip(fromJson))
        {
            Assert.Equal(html.ExternalId, json.ExternalId);
            Assert.Equal(html.PurchasedAt, json.PurchasedAt);
            Assert.Equal(html.Total, json.Total);
            Assert.Equal(html.Reconciled, json.Reconciled);
            Assert.Equal(html.Merchant.StoreName, json.Merchant.StoreName);
            Assert.Equal(html.Payment!.Method, json.Payment!.Method);

            Assert.Equal(html.Items.Select(i => i.Name), json.Items.Select(i => i.Name));
            Assert.Equal(html.Items.Select(i => i.Total), json.Items.Select(i => i.Total));
            Assert.Equal(
                html.Items.Select(i => i.Discount?.Amount),
                json.Items.Select(i => i.Discount?.Amount));
        }

        // only the JSON fixture states a masked card: the field the two shapes are least likely to agree on
        Assert.Equal("4242", fromJson[2].Payment!.CardLast4);
        Assert.Null(fromHtml[2].Payment!.CardLast4);
    }

    [Fact]
    public void An_unrecognisable_page_names_the_shape_it_was_read_as()
    {
        // no known order blocks and no empty-state marker is a redesign: an operator must be able to act without a release
        var error = Assert.Throws<ConnectorException>(
            () => ParseHtml("<html><body><main><p>Iets anders</p></main></body></html>", raw: true));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("'html' shape", error.Detail, StringComparison.Ordinal);
        Assert.Contains("data-test=order-container", error.Detail, StringComparison.Ordinal);

        Assert.Contains("OrdersShape", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_account_with_no_orders_is_not_a_shape_change()
    {
        // no order blocks is a clean empty sync here, an operator page in the redesign case above
        Assert.Empty(ParseHtml("bol/orders-empty.html"));
        Assert.Empty(ParseJson("bol/orders-empty.json", Json));
    }

    [Theory]
    [InlineData("order-total", "no amount for order[4001234567].total")]
    [InlineData("order-date", "carries no date")]
    public void An_order_missing_a_required_field_is_a_shape_change(string removed, string expected)
    {
        // dropping orders whose markup moved shows a shorter history than exists, with no signal
        var page = FixtureCatalog.Read("bol/orders-page.html")
            .Replace($"data-test=\"{removed}\"", "data-test=\"gone\"", StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(() => ParseHtml(page, raw: true));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains(expected, error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_order_with_no_number_cannot_be_emitted_at_all()
    {
        var page = FixtureCatalog.Read("bol/orders-page.html")
            .Replace("data-order-id=", "data-gone=", StringComparison.Ordinal);

        var error = Assert.Throws<ConnectorException>(() => ParseHtml(page, raw: true));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        // the external id is what makes a re-run idempotent
        Assert.Contains("idempotent", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_json_payload_with_no_order_array_names_every_path_it_tried()
    {
        var error = Assert.Throws<ConnectorException>(
            () => ParseJson("""{"status":"ok","payload":{"somethingElse":[]}}""", Json, raw: true));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("'json' shape", error.Detail, StringComparison.Ordinal);
        Assert.Contains("data.orders", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_json_endpoint_that_answers_html_is_a_shape_change_that_names_the_shape()
    {
        var error = Assert.Throws<ConnectorException>(
            () => ParseJson("<html><body>not json at all</body></html>", Json, raw: true));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("'json' shape", error.Detail, StringComparison.Ordinal);
        Assert.Contains("OrdersShape", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Script_and_style_content_never_reaches_the_text_extractor()
    {
        // a JSON island in a script is what a selector would walk into; its numbers are not prices
        var text = BolHtml.Text(
            "<div>Totaal <script>var x = {\"total\": 999};</script><style>.a{content:'8'}</style>12,50</div>");

        Assert.DoesNotContain("999", text, StringComparison.Ordinal);
        Assert.DoesNotContain("content", text, StringComparison.Ordinal);
        Assert.Contains("12,50", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Nested_blocks_of_the_same_shape_are_read_once_and_balanced_correctly()
    {
        // the scanner must balance tags: pairing the next closing tag ends an order at its first inner </li>
        const string markup =
            "<li data-test=\"order-container\" data-order-id=\"1\">" +
            "<ul><li data-test=\"order-item\">a</li><li data-test=\"order-item\">b</li></ul>" +
            "</li>" +
            "<li data-test=\"order-container\" data-order-id=\"2\"><span>x</span></li>";

        var blocks = BolHtml.All(markup, new BolOptions().OrderBlockSelectors);

        Assert.Equal(2, blocks.Count);
        Assert.Equal(2, BolHtml.All(blocks[0].Inner, new BolOptions().ItemBlockSelectors).Count);
        Assert.Empty(BolHtml.All(blocks[1].Inner, new BolOptions().ItemBlockSelectors));
    }

    private static IReadOnlyList<BolOrder> ParseHtml(string nameOrMarkup, bool raw = false) =>
        BolShapes.For(BolOrdersShape.Html)
            .Parse(raw ? nameOrMarkup : FixtureCatalog.Read(nameOrMarkup), Html, Amsterdam);

    private static IReadOnlyList<BolOrder> ParseJson(string nameOrBody, BolOptions options, bool raw = false) =>
        BolShapes.For(BolOrdersShape.Json)
            .Parse(raw ? nameOrBody : FixtureCatalog.Read(nameOrBody), options, Amsterdam);

    private static async Task<IReadOnlyList<Receipt>> FetchAsync(string fixture, BolOptions options, bool json = false)
    {
        var body = FixtureCatalog.Read(fixture);
        var media = json ? "application/json" : "text/html";

        using var handler = new StubHttpHandler((_, _) => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, media),
        });

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { StorageState = FixtureCatalog.Read("bol/storage-state.json") },
        };

        var adapter = new BolAdapter(options, new FixedTimeProvider(new DateTimeOffset(2026, 7, 28, 3, 0, 0, TimeSpan.Zero)));
        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), CancellationToken.None);

        // the adapter orders newest-first and the fixtures are written that way, so index and external id agree
        return result.Receipts;
    }
}
