using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Jumbo;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// confirmed from vghoost360/Jumbo-API; the wrong money unit is asserted beside the right one so it cannot be inverted again
public sealed class JumboParsingTests
{
    private const string ListFixture = "jumbo/orders-and-receipts.json";

    private static readonly JumboOptions Options = new();

    private static TimeZoneInfo Dutch => RetailZones.For("NL");

    // the order total is decimal euros (app.js parseFloat, no division) while d.price.price is divided by 100
    // the adapter once declared it minor units, making every total a hundredth of the truth
    [Fact]
    public void An_order_total_is_decimal_euros_and_the_inverted_reading_is_a_hundredth_of_it()
    {
        using var document = Fixture.Doc(ListFixture);
        var row = JumboOrders.Rows(document.RootElement, Options)[0];

        var correct = JumboOrders.ParseSummary(row, Options, Dutch);
        Assert.NotNull(correct);

        Assert.Equal(3113, correct.Total.Value);
        Assert.Equal("EUR", correct.Total.Currency);

        // the old default: a silent hundredth is a wrong number no reviewer spots
        var inverted = JumboOrders.ParseSummary(row, Options with { OrderTotalUnit = MoneyUnit.Minor }, Dutch);
        Assert.NotNull(inverted);
        Assert.Equal(31, inverted.Total.Value);
    }

    // orders are euros, the catalogue is cents; "correcting" the first from the second was the mistake made once
    [Fact]
    public void The_two_money_conventions_are_declared_and_are_not_the_same()
    {
        var options = new JumboOptions();

        Assert.Equal(MoneyUnit.MajorString, options.OrderTotalUnit);
        Assert.Equal(MoneyUnit.MajorString, options.OrderLineUnit);
        Assert.Equal(MoneyUnit.MajorString, options.StoreReceiptUnit);

        // never read by the adapter; recorded because it is where the confusion came from
        Assert.Equal(MoneyUnit.Minor, options.CataloguePriceUnit);
    }

    [Fact]
    public void The_two_result_sets_are_read_from_their_confirmed_aliases()
    {
        var options = new JumboOptions();

        Assert.Equal("data.onlineOrders.orders", options.OnlineOrdersPath);
        Assert.Equal("data.storeReceipts.receipts", options.StoreReceiptsPath);

        using var document = Fixture.Doc(ListFixture);

        Assert.Equal(2, JumboOrders.Rows(document.RootElement, options).Count);
        Assert.Equal(2, JumboStoreReceipts.Rows(document.RootElement, options).Count);

        // receiptOverview states a count, so the receipt walk ends on a number
        // rather than on a guess about repeated pages.
        Assert.Equal(2, JumboOrders.TotalCount(document.RootElement, options));
        Assert.Equal(2, JumboStoreReceipts.TotalResults(document.RootElement, options));
    }

    [Fact]
    public void A_response_missing_the_orders_alias_raises_provider_changed_not_an_empty_list()
    {
        using var document = Fixture.Reparse(new JsonObject
        {
            ["data"] = new JsonObject { ["somethingWeHaveNeverSeen"] = new JsonArray() },
        });

        var error = Assert.Throws<ConnectorException>(() => JumboOrders.Rows(document.RootElement, Options));

        // "You have never shopped at Jumbo" is a worse lie than an outage.
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("data.onlineOrders.orders", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_order_carries_its_id_branch_and_a_dated_offset()
    {
        using var document = Fixture.Doc(ListFixture);
        var summary = JumboOrders.ParseSummary(JumboOrders.Rows(document.RootElement, Options)[0], Options, Dutch);

        Assert.NotNull(summary);
        Assert.Equal("90211", summary.OrderId);
        Assert.Equal("Jumbo Utrecht Amsterdamsestraatweg", summary.StoreName);

        // deliveryDate states no offset, so it is read in Europe/Amsterdam
        // rather than in whatever zone the agent runs in.
        Assert.Equal(TimeSpan.FromHours(2), summary.PurchasedAt.Offset);
        Assert.Equal(new DateOnly(2026, 7, 20), DateOnly.FromDateTime(summary.PurchasedAt.Date));
    }

    [Fact]
    public void An_order_with_no_id_is_skipped_because_it_cannot_be_deduped()
    {
        var root = JumboFixtures.OrdersFixture();
        JumboFixtures.Orders(root)[0]!.AsObject().Remove("orderId");

        using var document = Fixture.Reparse(root);

        Assert.Null(JumboOrders.ParseSummary(JumboOrders.Rows(document.RootElement, Options)[0], Options, Dutch));
    }

    [Fact]
    public void An_order_with_no_stated_total_raises_provider_changed()
    {
        var root = JumboFixtures.OrdersFixture();
        JumboFixtures.Orders(root)[0]!.AsObject().Remove("totalToPayMoneyType");

        using var document = Fixture.Reparse(root);
        var row = JumboOrders.Rows(document.RootElement, Options)[0];

        var error = Assert.Throws<ConnectorException>(() => JumboOrders.ParseSummary(row, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("totalToPayMoneyType", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_order_with_no_delivery_date_raises_provider_changed()
    {
        var root = JumboFixtures.OrdersFixture();
        JumboFixtures.Orders(root)[0]!.AsObject().Remove("deliveryDate");

        using var document = Fixture.Reparse(root);
        var row = JumboOrders.Rows(document.RootElement, Options)[0];

        var error = Assert.Throws<ConnectorException>(() => JumboOrders.ParseSummary(row, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("deliveryDate", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Malformed_money_raises_provider_changed()
    {
        var root = JumboFixtures.OrdersFixture();
        JumboFixtures.Orders(root)[0]!["totalToPayMoneyType"]!.AsObject()["amount"] = "31,1,3";

        using var document = Fixture.Reparse(root);
        var row = JumboOrders.Rows(document.RootElement, Options)[0];

        var error = Assert.Throws<ConnectorException>(() => JumboOrders.ParseSummary(row, Options, Dutch));
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public void An_unexpected_extra_field_is_tolerated()
    {
        var root = JumboFixtures.OrdersFixture();
        var order = JumboFixtures.Orders(root)[0]!.AsObject();
        order["fulfilmentPromise"] = new JsonObject { ["slot"] = "18:00-19:00" };
        order["__typename"] = "Order";

        using var document = Fixture.Reparse(root);
        var summary = JumboOrders.ParseSummary(JumboOrders.Rows(document.RootElement, Options)[0], Options, Dutch);

        Assert.NotNull(summary);
        Assert.Equal(3113, summary.Total.Value);
    }

    [Fact]
    public void Order_lines_deposits_and_surcharges_all_reach_the_receipt()
    {
        using var document = Fixture.Doc("jumbo/order-detail.json");
        var detail = JumboOrders.ParseDetail(document.RootElement, Options, "EUR", "90211");

        // seven products, one deposit, one surcharge: leaving the last two out leaves the order short
        Assert.Equal(9, detail.Items.Count);
        Assert.Contains(detail.Items, i => i.Name == "Statiegeld fles");
        Assert.Contains(detail.Items, i => i.Name == "SMALL_ORDER_FEE");

        var milk = Assert.Single(detail.Items, i => i.Name == "Jumbo Halfvolle Melk 1L");
        Assert.Equal(258, milk.Total.Value);
        Assert.Equal(2m, milk.Quantity);
        Assert.Equal(129, milk.UnitPrice?.Value);

        var deposit = Assert.Single(detail.Items, i => i.Name == "Statiegeld fles");
        Assert.Equal(30, deposit.Total.Value);          // 2 x 0.15

        Assert.Equal("ideal", detail.Payment.Method);

        // no card or IBAN tail in the document: an explicit null tells the consumer its match is weaker
        Assert.Null(detail.Payment.CardLast4);
        Assert.Null(detail.Payment.IbanTail);
    }

    // a discount is the gap between the two stated prices; promotions[].discount would add a third number to agree with them
    [Fact]
    public void A_line_discount_is_the_gap_between_the_two_stated_prices_and_is_negative()
    {
        using var document = Fixture.Doc("jumbo/order-detail.json");
        var detail = JumboOrders.ParseDetail(document.RootElement, Options, "EUR", "90211");

        var discounted = Assert.Single(detail.Items, i => i.Discount is not null);
        Assert.Equal("Jumbo Kipfilet 500g", discounted.Name);

        // 7.99 before, 6.99 after.
        Assert.Equal(799, discounted.Total.Value);
        Assert.Equal(-100, discounted.Discount!.Amount.Value);
        Assert.Equal("2e halve prijs", discounted.Discount.Label);

        // every other line states the same price twice: a zero gap is no discount
        Assert.Equal(8, detail.Items.Count(i => i.Discount is null));
    }

    [Fact]
    public void The_order_lines_reconcile_against_the_list_s_stated_total()
    {
        using var listDocument = Fixture.Doc(ListFixture);
        var summary = JumboOrders.ParseSummary(
            JumboOrders.Rows(listDocument.RootElement, Options)[0], Options, Dutch);
        Assert.NotNull(summary);

        using var detailDocument = Fixture.Doc("jumbo/order-detail.json");
        var detail = JumboOrders.ParseDetail(detailDocument.RootElement, Options, "EUR", "90211");

        var receipt = ReceiptFactory.Build(
            "ses_test", "order-90211", JumboReceipts.Merchant(summary.StoreName),
            summary.PurchasedAt, summary.Total, detail.Payment, detail.Items);

        // 32.13 in lines less a 1.00 promotion is the stated 31.13; total from the list, lines from the detail, so a real pair
        Assert.Equal(3213, detail.Items.Sum(i => i.Total.Value));
        Assert.Equal(3113, receipt.Total.Value);
        Assert.True(receipt.Reconciled);
    }

    [Fact]
    public void A_line_with_neither_price_field_raises_provider_changed()
    {
        var root = Fixture.Object("jumbo/order-detail.json");
        var line = root["data"]!["order"]!["items"]![0]!.AsObject();
        line.Remove("linePriceExDiscount");
        line.Remove("linePriceIncDiscount");

        using var document = Fixture.Reparse(root);

        var error = Assert.Throws<ConnectorException>(
            () => JumboOrders.ParseDetail(document.RootElement, Options, "EUR", "90211"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("linePriceExDiscount", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_detail_document_with_nothing_at_the_confirmed_path_raises_provider_changed()
    {
        using var document = Fixture.Reparse(new JsonObject { ["data"] = new JsonObject() });

        var error = Assert.Throws<ConnectorException>(
            () => JumboOrders.ParseDetail(document.RootElement, Options, "EUR", "90211"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("data.order", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_store_receipt_summary_states_a_moment_a_shop_and_no_total_at_all()
    {
        using var document = Fixture.Doc(ListFixture);
        var rows = JumboStoreReceipts.Rows(document.RootElement, Options);

        var till = JumboStoreReceipts.ParseSummary(rows[1], Options, Dutch);
        Assert.NotNull(till);

        Assert.Equal("TX-2026-07-19-778812", till.TransactionId);
        Assert.Equal("STORE", till.Source);
        Assert.Equal("Jumbo Utrecht Amsterdamsestraatweg", till.StoreName);
        Assert.Equal(TimeSpan.FromHours(2), till.PurchasedAt.Offset);

        Assert.Null(till.OrderId);
    }

    // an ONLINE receipt is the till record of an order already returned; its transaction id begins with the order id
    // recognising it keeps one shop from being counted twice
    [Fact]
    public void An_online_receipt_carries_the_order_id_it_belongs_to()
    {
        using var document = Fixture.Doc(ListFixture);
        var rows = JumboStoreReceipts.Rows(document.RootElement, Options);

        var online = JumboStoreReceipts.ParseSummary(rows[0], Options, Dutch);
        Assert.NotNull(online);

        Assert.Equal("ONLINE", online.Source);
        Assert.Equal("90211", online.OrderId);
    }

    [Fact]
    public void A_receipt_with_no_transaction_id_is_skipped()
    {
        var root = JumboFixtures.OrdersFixture();
        JumboFixtures.StoreReceipts(root)[0]!.AsObject().Remove("transactionId");

        using var document = Fixture.Reparse(root);
        var rows = JumboStoreReceipts.Rows(document.RootElement, Options);

        Assert.Null(JumboStoreReceipts.ParseSummary(rows[0], Options, Dutch));
    }

    [Fact]
    public void A_receipt_detail_with_no_receipt_image_raises_provider_changed()
    {
        var root = Fixture.Object("jumbo/digital-receipt.json");
        root["data"]!["receipt"]!.AsObject().Remove("receiptImage");

        using var document = Fixture.Reparse(root);

        var error = Assert.Throws<ConnectorException>(
            () => JumboStoreReceipts.Layout(document.RootElement, Options, "TX-1"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("receiptImage", error.Detail, StringComparison.Ordinal);
    }

    // a receipt rendered as a picture is a real answer, not a shape change: report "nothing to parse" and let the adapter decide
    [Fact]
    public void A_receipt_image_that_is_not_the_json_layout_yields_nothing_to_parse()
    {
        using var document = Fixture.Doc("jumbo/digital-receipt-image-only.json");

        Assert.Null(JumboStoreReceipts.Layout(document.RootElement, Options, "TX-1"));
    }
}
