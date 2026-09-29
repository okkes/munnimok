using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.MediaMarkt;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// MediaMarkt's order payload, and the four identities the reader is built on.
///
/// Those identities were established across a live capture on 2026-08-11 - 13
/// orders, 15 product lines, purchases from 2015 to 2026 - and every one held
/// with zero mismatches:
///
///   1. price      == unitOriginal * quantity - sum(adjustments with a value)
///   2. price      == unit * quantity
///   3. billing.total == sum(item.prices.total)
///   4. billing.total == subtotal + shipping == sum(payments)
///
/// The fixture is generated so all four hold exactly, with every figure
/// invented - the structure is the capture's, the numbers are not. What these
/// tests defend is that the reader keeps agreeing with them, because the way
/// this goes wrong is silent: a receipt one cent light looks right everywhere.
/// </summary>
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

    // ---- money -------------------------------------------------------------

    /// <summary>
    /// The reason this reader may never touch <c>GetDouble</c>.
    ///
    /// MediaMarkt states money as a JSON number in euros. The fixture's amounts
    /// are chosen so that this bites: 4.02 as a double, times 100, is
    /// 401.99999999999994, and truncating gives 401 - a line one cent light, on
    /// a value that reads correctly everywhere it is printed.
    /// <para>
    /// The first version of this fixture used round numbers - 49.99, 24.50,
    /// 10.00 - and a reader deliberately broken to read through a double passed
    /// all twenty-three tests. Only about one two-decimal value in eighteen
    /// truncates low, so the mutation survived on arithmetic luck. 40.05, 20.06
    /// and 4.02 all do, and seven tests fail the moment the decimal path is
    /// abandoned.
    /// </para>
    /// </summary>
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

    /// <summary>
    /// Identity (1), in the shape the platform's reconciliation is defined
    /// against: the line total is what it would have cost before the coupon, and
    /// the coupon rides beside it as a negative discount. Reporting the
    /// already-discounted price as the total AND a discount would count the
    /// coupon twice.
    /// </summary>
    [Fact]
    public void A_discounted_line_states_its_full_price_and_its_coupon_separately()
    {
        var line = Order("90000001").Items[0];

        Assert.Equal("VOORBEELD Wasmachine 8kg Wit", line.Name);
        Assert.Equal(2, line.Quantity);
        Assert.Equal(new Money(4_005, "EUR"), line.UnitPrice);
        // 2 x 40.05, before the coupon.
        Assert.Equal(new Money(8_010, "EUR"), line.Total);
        Assert.NotNull(line.Discount);
        Assert.Equal(new Money(-200, "EUR"), line.Discount!.Amount);
        Assert.Equal("Jubilee coupon", line.Discount.Label);
    }

    /// <summary>
    /// The distinction that keeps receipts free of empty lines. Four adjustment
    /// kinds appear live: COUPON states an amount, PROMOTION states null.
    /// "Gratis verzending" explains why delivery was free - it is not money
    /// anybody was credited.
    /// </summary>
    [Fact]
    public void A_promotion_with_no_amount_is_not_a_discount()
    {
        var adjustments = Fixture.Object("mediamarkt/orders-page.json")["data"]!["getCombinedOrders"]![0]!
            ["items"]![0]!["fulfillments"]![0]!["products"]![0]!["prices"]!["adjustments"]!.AsArray();

        // The fixture really does carry both kinds, so this test is about the
        // reader rather than about an absence.
        Assert.Contains(adjustments, a => a!["type"]!.GetValue<string>() == "PROMOTION");
        Assert.Contains(adjustments, a => a!["type"]!.GetValue<string>() == "COUPON");
        Assert.Contains(adjustments, a => a!["value"] is null);

        // And only the valued one became money: 2.00, not 2.00 plus two zeroes.
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

    /// <summary>
    /// Identity (3) and (4), end to end and per order: the lines net of their
    /// discounts have to come back to the figure MediaMarkt stated.
    /// </summary>
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

    // ---- shape -------------------------------------------------------------

    /// <summary>
    /// The middle level of the payload, and the one that is easy to skip. An
    /// order that ships in two parcels states the same product once per
    /// fulfilment; reading only the first loses half the order silently, and
    /// reconciliation would then report a receipt that does not add up.
    /// </summary>
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

    // ---- payment -----------------------------------------------------------

    [Fact]
    public void A_single_payment_is_mapped_to_the_platforms_vocabulary()
    {
        Assert.Equal("ideal", Order("90000001").Payment.Method);
        Assert.Equal("card", Order("90000003").Payment.Method);
    }

    /// <summary>
    /// A gift card plus a credit card is a real shape here. The card is what
    /// reaches a bank statement, so the card is what a transaction match has to
    /// work from - reporting the first payment would depend on MediaMarkt's
    /// ordering, and reporting nothing would throw the useful half away.
    /// </summary>
    [Fact]
    public void A_split_payment_reports_the_largest_part()
    {
        // GICA 5.00 is listed FIRST and CRECA 15.06 second, so "the largest"
        // and "the first" are different answers here. They were not in the
        // first version of this fixture, and a reader mutated to take the
        // first payment passed this test unchanged.
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

    // ---- defensive ---------------------------------------------------------

    [Fact]
    public void A_payload_with_no_order_array_is_a_changed_provider()
    {
        using var document = JsonDocument.Parse("""{"data":{"somethingElse":[]}}""");

        var error = Assert.Throws<ConnectorException>(() => MediaMarktOrders.Read(document, Options));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("getCombinedOrders", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A GraphQL error payload has no <c>data</c> at all, and must not read as
    /// an account with no orders.
    /// </summary>
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

    /// <summary>
    /// One unreadable order must not cost the caller the good ones beside it.
    /// </summary>
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

    /// <summary>
    /// A NULL INSIDE A LIST IS AN ORDINARY GRAPHQL ANSWER, not a contrived one.
    /// </summary>
    /// <remarks>
    /// GraphQL nulls a list element whenever a non-nullable child of it errors,
    /// so <c>items: [null]</c> is a shape MediaMarkt can send on any day. And
    /// <c>TryGetProperty</c> THROWS on a null rather than returning false - the
    /// <c>Try</c> in its name is only about a missing property, never about the
    /// element's own kind.
    /// <para>
    /// So this used to be an <c>InvalidOperationException</c>: not a
    /// ConnectorException, therefore <c>internal</c>, therefore retriable and
    /// blamed on us - and it killed the whole page, three orders lost to one
    /// null, against this reader's own documented promise that one malformed
    /// order must not cost somebody nine good ones.
    /// </para>
    /// </remarks>
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

        // Every order still arrives - the null costs the line, never the page.
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

    // ---- raw ---------------------------------------------------------------

    [Fact]
    public void Raw_is_withheld_unless_it_was_asked_for()
    {
        Assert.All(Read(), order => Assert.Null(order.Raw));
    }

    /// <summary>
    /// Per order, never per page. FetchResult.Raw is keyed by external id, so
    /// handing back the whole page under one order's key would give every
    /// record a copy of nine other purchases.
    /// </summary>
    [Fact]
    public void Raw_is_this_orders_slice_and_not_the_whole_page()
    {
        var order = Read(raw: true).Single(o => o.Id == "90000002");

        Assert.NotNull(order.Raw);
        Assert.Contains("90000002", order.Raw!, StringComparison.Ordinal);
        Assert.DoesNotContain("90000001", order.Raw, StringComparison.Ordinal);
        Assert.DoesNotContain("getCombinedOrders", order.Raw, StringComparison.Ordinal);
    }

    /// <summary>
    /// RAW IS FOR THE PROVIDER'S SHAPE, NOT FOR THE ACCOUNT HOLDER.
    /// </summary>
    /// <remarks>
    /// A caller asks for raw to see what MediaMarkt actually said about a
    /// purchase - a field this connector does not normalise, a discount spelled
    /// oddly, a state nobody has mapped. None of that needs to know who bought
    /// it, and the payload carried two branches that were entirely about them:
    /// an email address, a name, a loyalty id and a tax id under <c>user</c>,
    /// and their home address under <c>billing.address</c>.
    /// <para>
    /// Cut at capture rather than filtered later, because raw is staged onto
    /// the same row as the record and travels wherever that does.
    /// </para>
    /// </remarks>
    [Fact]
    public void Raw_carries_the_purchase_and_not_the_person()
    {
        var order = Read(raw: true).Single(o => o.Id == "90000002");

        using var kept = JsonDocument.Parse(order.Raw!);

        Assert.False(kept.RootElement.TryGetProperty("user", out _));
        Assert.False(kept.RootElement.GetProperty("billing").TryGetProperty("address", out _));

        // AND ON EVERY ITEM, not only on the order. The address is written in
        // two places and a scrub that found one of them looks finished.
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

    /// <summary>
    /// And everything a caller asked raw FOR is still there.
    /// </summary>
    /// <remarks>
    /// The removal is two named branches, not a general scrub: strip enough and
    /// raw stops being worth asking for, which is a quieter way to lose the
    /// feature than deleting it. <c>billing.payments</c> in particular stays -
    /// the amount and the method ARE the receipt.
    /// </remarks>
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
