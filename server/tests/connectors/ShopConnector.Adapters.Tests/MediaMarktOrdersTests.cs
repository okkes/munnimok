using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.MediaMarkt;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// four identities held on a live capture (2026-08-11, 13 orders, 0 mismatches): line price = unitOriginal*qty - valued
// adjustments = unit*qty; billing.total = sum(item totals) = subtotal + shipping = sum(payments). Figures are invented
// a drift is silent: a receipt one cent light looks right everywhere
public sealed class MediaMarktOrdersTests
{
    private static readonly MediaMarktOptions Options = new();

    private static IReadOnlyList<MediaMarktOrder> Read(bool raw = false)
    {
        using var document = Fixture.Doc("mediamarkt/orders-page.json");
        return MediaMarktOrders.Read(document, Options, raw);
    }

    private static MediaMarktOrder Order(string id) => Read().Single(order => order.Id == id);

    [Fact]
    public void The_page_carries_every_order_on_it()
    {
        var orders = Read();

        Assert.Equal(3, orders.Count);
        Assert.Equal(["90000001", "90000002", "90000003"], orders.Select(order => order.Id));
    }

    // never GetDouble: 4.02 * 100 = 401.99999999999994 truncates to 401; the fixture's 40.05, 20.06, 4.02 all truncate low,
    // round numbers let a double-reading mutant survive
    [Fact]
    public void A_total_is_read_to_the_exact_cent()
    {
        Assert.Equal(new Money(11_715, "EUR"), Order("90000001").Total);
        Assert.Equal(new Money(2_006, "EUR"), Order("90000002").Total);
        Assert.Equal(new Money(1_206, "EUR"), Order("90000003").Total);
    }

    [Fact]
    public void The_currency_comes_from_the_payload_rather_than_being_assumed()
    {
        Assert.All(Read(), order => Assert.Equal("EUR", order.Total.Currency));
    }

    // identity (1): the line total is the pre-coupon price, the coupon a negative discount; else the coupon counts twice
    [Fact]
    public void A_discounted_line_states_its_full_price_and_its_coupon_separately()
    {
        var line = Order("90000001").Items[0];

        Assert.Equal("VOORBEELD Wasmachine 8kg Wit", line.Name);
        Assert.Equal(2, line.Quantity);
        Assert.Equal(new Money(4_005, "EUR"), line.UnitPrice);
        Assert.Equal(new Money(8_010, "EUR"), line.Total);
        Assert.NotNull(line.Discount);
        Assert.Equal(new Money(-200, "EUR"), line.Discount!.Amount);
        Assert.Equal("Jubilee coupon", line.Discount.Label);
    }

    // COUPON states an amount, PROMOTION null; "Gratis verzending" explains free delivery and is not money credited
    [Fact]
    public void A_promotion_with_no_amount_is_not_a_discount()
    {
        var adjustments = Fixture.Object("mediamarkt/orders-page.json")["data"]!["getCombinedOrders"]![0]!
            ["items"]![0]!["fulfillments"]![0]!["products"]![0]!["prices"]!["adjustments"]!.AsArray();

        Assert.Contains(adjustments, a => a!["type"]!.GetValue<string>() == "PROMOTION");
        Assert.Contains(adjustments, a => a!["type"]!.GetValue<string>() == "COUPON");
        Assert.Contains(adjustments, a => a!["value"] is null);

        Assert.Equal(new Money(-200, "EUR"), Order("90000001").Items[0].Discount!.Amount);
    }

    [Fact]
    public void A_line_with_nothing_taken_off_carries_no_discount()
    {
        var line = Order("90000003").Items.Single();

        Assert.Null(line.Discount);
        Assert.Equal(3, line.Quantity);
        Assert.Equal(new Money(402, "EUR"), line.UnitPrice);
        Assert.Equal(new Money(1_206, "EUR"), line.Total);
    }

    [Theory]
    [InlineData("90000001", 11_715)]
    [InlineData("90000002", 2_006)]
    [InlineData("90000003", 1_206)]
    public void The_lines_net_of_discounts_sum_to_the_stated_total(string id, long expected)
    {
        var order = Order(id);

        var sum = order.Items.Sum(item => item.Total.Value + (item.Discount?.Amount.Value ?? 0));

        Assert.Equal(expected, sum);
        Assert.Equal(expected, order.Total.Value);
    }

    // a two-parcel order states the same product once per fulfilment; reading only the first loses half the order silently
    [Fact]
    public void An_order_split_across_two_parcels_keeps_both_of_them()
    {
        var order = Order("90000001");

        Assert.Equal(2, order.Items.Count);
        Assert.Equal(new Money(8_010, "EUR"), order.Items[0].Total);
        Assert.Equal(new Money(4_005, "EUR"), order.Items[1].Total);
    }

    [Fact]
    public void The_purchase_time_keeps_its_offset()
    {
        // meta.created, not meta.updated: updated moves when a parcel ships,
        // which would make an old purchase reappear as recent.
        Assert.Equal(
            new DateTimeOffset(2026, 3, 4, 11, 20, 0, TimeSpan.Zero),
            Order("90000001").PurchasedAt);
    }

    [Fact]
    public void The_state_is_carried_through_verbatim()
    {
        Assert.Equal("COMPLETED", Order("90000001").State);
        Assert.Equal("IN_PROGRESS", Order("90000002").State);
        Assert.Equal("CREATED", Order("90000003").State);
    }

    [Fact]
    public void A_single_payment_is_mapped_to_the_platforms_vocabulary()
    {
        Assert.Equal("ideal", Order("90000001").Payment.Method);
        Assert.Equal("card", Order("90000003").Payment.Method);
    }

    // the card is what reaches a bank statement, so matching works from it; the first payment depends on MediaMarkt's ordering
    [Fact]
    public void A_split_payment_reports_the_largest_part()
    {
        // GICA 5.00 is listed first, CRECA 15.06 second: "largest" and "first" differ (a first-payment mutant passed otherwise)
        Assert.Equal("card", Order("90000002").Payment.Method);
    }

    [Fact]
    public void No_card_tail_is_invented()
    {
        Assert.All(Read(), order =>
        {
            Assert.Null(order.Payment.CardLast4);
            Assert.Null(order.Payment.IbanTail);
        });
    }

    [Fact]
    public void An_unknown_payment_code_becomes_other_rather_than_being_passed_through()
    {
        Assert.Equal("other", Options.PaymentMethod("KLARNA"));
        Assert.Equal("card", Options.PaymentMethod("creca"));
        Assert.Null(Options.PaymentMethod(null));
        Assert.Null(Options.PaymentMethod("  "));
    }

    [Fact]
    public void A_payload_with_no_order_array_is_a_changed_provider()
    {
        using var document = JsonDocument.Parse("""{"data":{"somethingElse":[]}}""");

        var error = Assert.Throws<ConnectorException>(() => MediaMarktOrders.Read(document, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("getCombinedOrders", error.Message, StringComparison.Ordinal);
    }

    // a GraphQL error payload has no data and must not read as an account with no orders
    [Fact]
    public void An_errors_payload_is_not_read_as_an_empty_history()
    {
        using var document = JsonDocument.Parse("""{"errors":[{"message":"PersistedQueryNotFound"}]}""");

        Assert.Throws<ConnectorException>(() => MediaMarktOrders.Read(document, Options));
    }

    [Fact]
    public void An_empty_history_is_an_empty_list_rather_than_an_error()
    {
        using var document = JsonDocument.Parse("""{"data":{"getCombinedOrders":[]}}""");

        Assert.Empty(MediaMarktOrders.Read(document, Options));
    }

    [Fact]
    public void An_order_with_no_total_is_skipped_and_the_rest_survive()
    {
        var payload = Fixture.Object("mediamarkt/orders-page.json");
        payload["data"]!["getCombinedOrders"]![1]!.AsObject()["billing"]!.AsObject().Remove("total");

        using var document = Fixture.Reparse(payload);
        var orders = MediaMarktOrders.Read(document, Options);

        Assert.Equal(2, orders.Count);
        Assert.DoesNotContain(orders, order => order.Id == "90000002");
    }

    // GraphQL nulls a list element when a non-nullable child errors, and TryGetProperty throws on a null element:
    // that was an InvalidOperationException (internal, retriable) which lost the whole page
    [Theory]
    [InlineData("items")]
    [InlineData("fulfillments")]
    public void A_null_inside_a_list_costs_one_order_at_most(string list)
    {
        var payload = Fixture.Object("mediamarkt/orders-page.json");
        var order = payload["data"]!["getCombinedOrders"]![0]!.AsObject();

        var nulls = new JsonArray((JsonNode?)null);

        if (list == "items") order["items"] = nulls;
        else order["items"]![0]!.AsObject()["fulfillments"] = nulls;

        using var document = Fixture.Reparse(payload);

        var orders = MediaMarktOrders.Read(document, Options);

        Assert.Equal(3, orders.Count);
        Assert.Contains(orders, o => o.Id == "90000001");
    }

    [Fact]
    public void A_field_nobody_has_seen_before_is_ignored()
    {
        var payload = Fixture.Object("mediamarkt/orders-page.json");
        payload["data"]!["getCombinedOrders"]![0]!.AsObject()["somethingNew"] = "surprise";

        using var document = Fixture.Reparse(payload);

        Assert.Equal(3, MediaMarktOrders.Read(document, Options).Count);
    }

    [Fact]
    public void Raw_is_withheld_unless_it_was_asked_for()
    {
        Assert.All(Read(), order => Assert.Null(order.Raw));
    }

    // FetchResult.Raw is keyed by external id: the whole page under one order's key would give every record the other orders
    [Fact]
    public void Raw_is_this_orders_slice_and_not_the_whole_page()
    {
        var order = Read(raw: true).Single(o => o.Id == "90000002");

        Assert.NotNull(order.Raw);
        Assert.Contains("90000002", order.Raw!, StringComparison.Ordinal);
        Assert.DoesNotContain("90000001", order.Raw, StringComparison.Ordinal);
        Assert.DoesNotContain("getCombinedOrders", order.Raw, StringComparison.Ordinal);
    }

    // raw drops the account holder (`user`: email, name, loyalty id, tax id; billing.address), cut at capture because
    // raw is staged onto the record's row and travels with it
    [Fact]
    public void Raw_carries_the_purchase_and_not_the_person()
    {
        var order = Read(raw: true).Single(o => o.Id == "90000002");

        using var kept = JsonDocument.Parse(order.Raw!);

        Assert.False(kept.RootElement.TryGetProperty("user", out _));
        Assert.False(kept.RootElement.GetProperty("billing").TryGetProperty("address", out _));

        // the address is written in two places (also on every item); a scrub that finds one looks finished
        Assert.All(
            kept.RootElement.GetProperty("items").EnumerateArray(),
            item => Assert.False(item.TryGetProperty("deliveryAddress", out _)));

        foreach (var personal in new[]
                 {
                     "test.persoon@example.invalid", "Persoon", "Voorbeeldstraat", "1000 AA",
                 })
        {
            Assert.DoesNotContain(personal, order.Raw!, StringComparison.OrdinalIgnoreCase);
        }
    }

    // two named branches, not a general scrub (raw would stop being worth asking for).
    // billing.payments stays: amount and method are the receipt
    [Fact]
    public void Raw_still_carries_everything_it_is_asked_for()
    {
        var order = Read(raw: true).Single(o => o.Id == "90000002");

        using var kept = JsonDocument.Parse(order.Raw!);
        var root = kept.RootElement;

        Assert.Equal("90000002", root.GetProperty("id").GetString());
        Assert.True(root.TryGetProperty("items", out _));
        Assert.True(root.TryGetProperty("meta", out _));
        Assert.True(root.TryGetProperty("state", out _));

        var billing = root.GetProperty("billing");

        Assert.True(billing.TryGetProperty("payments", out var payments));
        Assert.NotEqual(0, payments.GetArrayLength());
        Assert.True(billing.TryGetProperty("total", out _));
    }
}
