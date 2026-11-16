using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// the v2 list and v3 detail sit on different API versions on purpose: do not "fix" it
// a v3 detail is ticketType HTML: the paper receipt in htmlPrintedReceipt, no line-item collection
// weighed articles: the printed total (1,52) is read, not computed (0.850 x 1.79 = 1.5215), or reconciliation is a cent out
public sealed class LidlPlusParsingTests
{
    private const string ListFixture = "lidl/tickets-page-1.json";
    private const string EmptyPageFixture = "lidl/tickets-page-2.json";
    private const string DetailFixture = "lidl/ticket-detail.json";

    private static readonly LidlPlusOptions Options = new();

    private static TimeZoneInfo Dutch => RetailZones.For("NL");

    [Fact]
    public void List_reads_comma_decimal_totals_into_minor_units()
    {
        using var document = Fixture.Doc(ListFixture);

        var tickets = LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch);

        Assert.Equal(2, tickets.Count);
        Assert.Equal("lidl-2026-07-18-8801", tickets[0].Id);
        Assert.Equal(1427, tickets[0].Total.Value);
        Assert.Equal("EUR", tickets[0].Total.Currency);
        Assert.Equal(845, tickets[1].Total.Value);
        Assert.Equal("Lidl Utrecht Kanaleneiland", tickets[0].StoreName);
    }

    [Fact]
    public void A_timestamp_without_an_offset_is_read_in_the_provider_s_own_zone()
    {
        using var document = Fixture.Doc(ListFixture);

        var ticket = LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch)[0];

        // no offset stated: read in the provider's country zone (+02:00 in July), not the agent's
        Assert.Equal(TimeSpan.FromHours(2), ticket.PurchasedAt.Offset);
        Assert.Equal(new DateTimeOffset(2026, 7, 18, 18, 4, 0, TimeSpan.FromHours(2)), ticket.PurchasedAt);
    }

    [Fact]
    public void An_empty_page_is_a_real_answer_and_not_a_shape_change()
    {
        using var document = Fixture.Doc(EmptyPageFixture);

        // an empty page terminates pagination; treating it as a failure would make every complete fetch look broken
        Assert.Empty(LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch));
    }

    [Fact]
    public void The_printed_receipt_is_where_the_lines_are()
    {
        var items = Items();

        Assert.Equal(3, items.Count);
        Assert.Equal(["Bruin brood", "Halfvolle melk", "Bananen"], items.Select(i => i.Name));

        Assert.Equal(129, items[0].Total.Value);
        Assert.Equal(1m, items[0].Quantity);
        Assert.Equal(129, items[0].UnitPrice?.Value);
        Assert.Null(items[0].Discount);
    }

    // the till printed 1,52 for 0,850 x 1,79 = 1,5215: the total is read, not computed
    [Fact]
    public void A_weighed_article_takes_the_total_the_till_printed()
    {
        var bananas = Assert.Single(Items(), i => i.Name == "Bananen");

        Assert.Equal(0.850m, bananas.Quantity);
        Assert.Equal(179, bananas.UnitPrice?.Value);
        Assert.Equal(152, bananas.Total.Value);

        Assert.Equal(152, bananas.Total.Value);
    }

    // constructed: seen receipts happen not to distinguish read from computed totals
    // the printed figure is what was charged, however rounded; a multiplying parser would disagree with the bank statement
    [Fact]
    public void The_line_total_is_the_printed_one_even_when_the_attributes_disagree()
    {
        // 0,500 kg at 3,00 would compute to 1,50. The till printed 1,49.
        const string printed =
            """
            <span id="purchase_list_line_2" class="article" data-art-id="0009999" data-art-description="Druiven" data-art-quantity="0,500" data-unit-price="3,00" data-tax-type="B">Druiven</span><span id="purchase_list_line_2" class="article" data-art-id="0009999" data-art-description="Druiven" data-art-quantity="0,500" data-unit-price="3,00" data-tax-type="B">   </span><span id="purchase_list_line_2" class="article" data-art-id="0009999" data-art-description="Druiven" data-art-quantity="0,500" data-unit-price="3,00" data-tax-type="B">1,49</span>
            """;

        var item = Assert.Single(LidlPrintedReceipt.Items(printed, Options, "EUR"));

        Assert.Equal(149, item.Total.Value);
        Assert.Equal(0.500m, item.Quantity);
        Assert.Equal(300, item.UnitPrice?.Value);

        Assert.NotEqual(150, item.Total.Value);
    }

    // a markdown is printed on its own line without attributes: attach it to the article above or the items stop summing
    [Fact]
    public void A_markdown_line_attaches_to_the_article_it_was_printed_under()
    {
        var milk = Assert.Single(Items(), i => i.Name == "Halfvolle melk");

        var discount = milk.Discount;
        Assert.NotNull(discount);

        // Negative, which is what makes summing unconditional.
        Assert.Equal(-20, discount.Amount.Value);
        Assert.Equal("In prijs verlaagd", discount.Label);

        // the line total stays as printed; the discount carries the difference
        Assert.Equal(115, milk.Total.Value);

        Assert.All(Items().Where(i => i.Name != "Halfvolle melk"), i => Assert.Null(i.Discount));
    }

    [Fact]
    public void The_tender_block_states_the_method_and_the_card_tail()
    {
        using var document = Fixture.Doc(DetailFixture);
        var printed = document.RootElement.GetProperty("htmlPrintedReceipt").GetString();

        var payment = LidlPrintedReceipt.Payment(printed, Options);

        // "Bankpas" is what a Dutch till prints for a debit card, and the
        // mapping every other adapter here uses does not know the word.
        Assert.Equal("card", payment.Method);
        Assert.Equal("4321", payment.CardLast4);
        Assert.Null(payment.IbanTail);
    }

    [Fact]
    public void Items_net_of_discounts_reconcile_against_the_stated_total()
    {
        using var detail = Fixture.Doc(DetailFixture);

        var items = Items();
        var total = detail.RootElement.GetProperty("totalAmount").GetDecimal();

        // 1,29 + 1,15 - 0,20 + 1,52 = 3,76.
        var sum = items.Sum(i => i.Total.Value + (i.Discount?.Amount.Value ?? 0));
        Assert.Equal(376, sum);
        Assert.Equal((long)(total * 100), sum);

        var receipt = ReceiptFactory.Build(
            "ses_test", "22000263862026080411111", LidlPlusTicketParser.Merchant("Testdorp"),
            DateTimeOffset.UtcNow, new Connector.Kit.Normalization.Money(sum, "EUR"),
            LidlPrintedReceipt.Payment(
                detail.RootElement.GetProperty("htmlPrintedReceipt").GetString(), Options),
            items);

        Assert.True(receipt.Reconciled);
    }

    // the detail's store is an OBJECT (id "NL0263", name "Delft"); reading it as a string titled receipts with the branch code
    [Fact]
    public void The_store_is_named_rather_than_numbered()
    {
        using var document = Fixture.Doc(DetailFixture);
        var store = document.RootElement.GetProperty("store");

        Assert.Equal("Testdorp", store.GetProperty("name").GetString());
        Assert.Equal("NL0999", store.GetProperty("id").GetString());
    }

    private static IReadOnlyList<Connector.Kit.Normalization.ReceiptItem> Items()
    {
        using var document = Fixture.Doc(DetailFixture);
        var printed = document.RootElement.GetProperty("htmlPrintedReceipt").GetString();

        return LidlPrintedReceipt.Items(printed, Options, "EUR");
    }

    [Fact]
    public void An_unexpected_extra_field_is_tolerated()
    {
        var root = Fixture.Object(ListFixture);
        root["nextCursor"] = "opaque";
        root["tickets"]![0]!.AsObject()["loyaltyCampaignIds"] = new JsonArray(7, 9);

        using var document = Fixture.Reparse(root);

        var tickets = LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch);
        Assert.Equal(1427, tickets[0].Total.Value);
    }

    [Fact]
    public void A_missing_date_raises_provider_changed()
    {
        var root = Fixture.Object(ListFixture);
        root["tickets"]![0]!.AsObject().Remove("date");

        using var document = Fixture.Reparse(root);

        var error = Assert.Throws<ConnectorException>(
            () => LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("ticket.date", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void A_missing_total_raises_provider_changed()
    {
        var root = Fixture.Object(ListFixture);
        root["tickets"]![0]!.AsObject().Remove("totalAmount");

        using var document = Fixture.Reparse(root);

        var error = Assert.Throws<ConnectorException>(
            () => LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public void Malformed_money_raises_provider_changed()
    {
        var root = Fixture.Object(ListFixture);
        root["tickets"]![0]!.AsObject()["totalAmount"] = "14,2,7";

        using var document = Fixture.Reparse(root);

        var error = Assert.Throws<ConnectorException>(
            () => LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        // the FIELD, never the value: the detail travels to the caller, so an unparseable total must not ride out in the complaint
        Assert.Contains("ticket.total", error.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("14,2,7", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_unrecognisable_envelope_raises_provider_changed()
    {
        using var document = Fixture.Reparse(new JsonObject { ["receiptsMovedTo"] = "somewhere else" });

        var error = Assert.Throws<ConnectorException>(
            () => LidlPlusTicketParser.ParseList(document.RootElement, Options, Dutch));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    // headers, separators and the totals block share the markup: taking any line with a number would emit "Totaal" as a purchase
    [Fact]
    public void Only_lines_carrying_an_article_id_become_items()
    {
        var items = Items();

        Assert.DoesNotContain(items, i => i.Name.Contains("Totaal", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(items, i => i.Name.Contains("Aantal", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(items, i => i.Name.Contains("OMSCHRIJVING", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(items, i => i.Name.Contains("Lidl", StringComparison.OrdinalIgnoreCase));

        Assert.DoesNotContain(items, i => i.Name.Contains("verlaagd", StringComparison.OrdinalIgnoreCase));
    }

}
