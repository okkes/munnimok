using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Bol;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// bol's order overview, read the way bol's own front end reads it.
///
/// This is the first bol shape written against a real payload rather than a
/// guess. The two before it were both plausible and the file said so - "nobody
/// on this project has seen this page" - and the URL they asked for now 404s.
/// A capture on 2026-08-02 settled it: the page is a shell, and every
/// "Toon meer" posts <c>OrdersOverviewClient</c> to <c>/api/graphql</c>.
///
/// The fixture keeps every key and nesting level of that response and none of
/// the purchases: a public repo is no place for somebody's order history.
/// </summary>
public sealed class BolGraphQlShapeTests
{
    private static readonly BolOptions Options = new();

    private static readonly TimeZoneInfo Zone = RetailZones.Dutch;

    private static readonly BolGraphQlShape Shape = new();

    private static string Fixture() => FixtureCatalog.Read("bol/orders-graphql.json");

    private static IReadOnlyList<BolOrder> Parse() => Shape.Parse(Fixture(), Options, Zone);

    // ---- the request --------------------------------------------------------

    [Fact]
    public void The_call_is_the_persisted_operation_bol_sends_itself()
    {
        using var body = JsonDocument.Parse(Shape.Body(Options, page: 1)!);
        var root = body.RootElement;

        Assert.Equal("OrdersOverviewClient", root.GetProperty("operationName").GetString());

        // An automatic persisted query: the hash alone, no document. bol's
        // schema is not public, so there is nothing to fall back to and
        // inventing a document would be guessing at the shape again.
        var persisted = root.GetProperty("extensions").GetProperty("persistedQuery");
        Assert.Equal(1, persisted.GetProperty("version").GetInt32());
        Assert.Equal(
            "sha256:d195253b815a6082cdee63bef6234513d5c0520c9f064e96fc1a9037d689add2",
            persisted.GetProperty("sha256Hash").GetString());

        Assert.Equal("https://www.bol.com/api/graphql", Shape.Url(Options, page: 1));
    }

    /// <summary>
    /// bol wants the operation named in a header as well as in the body. This
    /// is the single thing that made the difference between a 400 and a 200
    /// against the live endpoint, and nothing in the payload hints at it.
    /// </summary>
    [Fact]
    public void The_operation_is_named_again_in_a_header()
    {
        var header = Assert.Single(Shape.Headers(Options));

        Assert.Equal("bol-app-operation-name", header.Key);
        Assert.Equal("OrdersOverviewClient", header.Value);

        // One setting moves both, so an operator who repoints the operation
        // cannot leave the header naming the old one.
        var renamed = Options with { OrdersOperationName = "OrdersOverviewV2" };
        Assert.Equal("OrdersOverviewV2", Assert.Single(Shape.Headers(renamed)).Value);
    }

    /// <summary>
    /// The cursor is an offset in ORDERS and a string, which is how bol sends
    /// it: the first click asked for "5" with five already on the page.
    /// </summary>
    [Theory]
    [InlineData(1, "0")]
    [InlineData(2, "5")]
    [InlineData(3, "10")]
    public void The_cursor_counts_orders_from_zero_as_a_string(int page, string expected)
    {
        using var body = JsonDocument.Parse(Shape.Body(Options, page)!);

        var after = body.RootElement.GetProperty("variables").GetProperty("after");

        Assert.Equal(JsonValueKind.String, after.ValueKind);
        Assert.Equal(expected, after.GetString());
    }

    [Fact]
    public void A_page_size_change_moves_the_cursor_with_it()
    {
        var options = Options with { OrdersPageSize = 20 };

        using var body = JsonDocument.Parse(Shape.Body(options, page: 3)!);

        Assert.Equal("40", body.RootElement.GetProperty("variables").GetProperty("after").GetString());
    }

    /// <summary>
    /// 2026-10-07 (prod): bol refused the request rebuilt around the hash its
    /// own page had sent moments before - so a session that learned the
    /// page's request replays it, with only the cursor rewritten.
    /// </summary>
    [Fact]
    public void A_learned_request_is_replayed_with_only_the_cursor_rewritten()
    {
        const string template =
            """{"operationName":"OrdersOverviewClient","variables":{"after":"5","locale":"nl-NL"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"sha256:page"}}}""";
        var options = Options with { OrdersRequestTemplate = template };

        using var first = JsonDocument.Parse(Shape.Body(options, page: 1)!);
        var root = first.RootElement;

        // the cursor is this page's; everything else is the page's own, the hash included - not the option's
        Assert.Equal("0", root.GetProperty("variables").GetProperty("after").GetString());
        Assert.Equal("nl-NL", root.GetProperty("variables").GetProperty("locale").GetString());
        Assert.Equal("sha256:page", root.GetProperty("extensions").GetProperty("persistedQuery").GetProperty("sha256Hash").GetString());

        using var third = JsonDocument.Parse(Shape.Body(options, page: 3)!);
        Assert.Equal("10", third.RootElement.GetProperty("variables").GetProperty("after").GetString());
    }

    /// <summary>A template no page could have sent - not JSON, not an object, no variables to put a cursor in - is the rebuilt shape, never a guess at bol's.</summary>
    [Theory]
    [InlineData("not json at all")]
    [InlineData("[]")]
    [InlineData("""{"operationName":"OrdersOverviewClient","variables":"5"}""")]
    [InlineData("""{"operationName":"OrdersOverviewClient"}""")]
    public void A_template_that_is_not_a_body_with_variables_falls_back_to_the_rebuilt_shape(string template)
    {
        var options = Options with { OrdersRequestTemplate = template };

        using var body = JsonDocument.Parse(Shape.Body(options, page: 2)!);
        var root = body.RootElement;

        Assert.Equal("5", root.GetProperty("variables").GetProperty("after").GetString());
        Assert.Equal(
            Options.OrdersPersistedQueryHash,
            root.GetProperty("extensions").GetProperty("persistedQuery").GetProperty("sha256Hash").GetString());
    }

    // ---- the money ----------------------------------------------------------

    /// <summary>
    /// The one bol value worth being certain about. <c>amount</c> is a number
    /// in euros and it is the price of ONE - the page showed "2 x EUR 21,24"
    /// against an amount of 21.24. Declared minor instead, every bol receipt
    /// would be a hundredth of the truth AND would still reconcile, because the
    /// same number feeds both sides of the check.
    /// </summary>
    [Fact]
    public void A_line_total_is_the_unit_price_times_the_quantity()
    {
        var order = Parse().Single(o => o.Id == "A000TEST002");

        var twoOf = order.Items.Single(i => i.Name.Contains("Prullenbak", StringComparison.Ordinal));

        Assert.Equal(2, twoOf.Quantity);
        Assert.Equal(new Money(2124, "EUR"), twoOf.UnitPrice);   // EUR 21.24 as minor units
        Assert.Equal(4248, twoOf.Total.Value);           // and twice that
        Assert.Equal("EUR", twoOf.Total.Currency);
    }

    [Fact]
    public void An_orders_total_is_the_sum_of_its_own_lines()
    {
        var order = Parse().Single(o => o.Id == "A000TEST002");

        // 2 x 21.24 plus 1 x 11.99.
        Assert.Equal(4248 + 1199, order.Total.Value);
        Assert.Equal(order.Items.Sum(i => i.Total.Value), order.Total.Value);
    }

    // ---- the orders ---------------------------------------------------------

    [Fact]
    public void Each_order_carries_its_reference_and_the_moment_it_was_placed()
    {
        var order = Parse().Single(o => o.Id == "A000TEST001");

        // bol states a local wall clock with no offset, so it is read in
        // Europe/Amsterdam - a near-midnight order dated a day out is worse
        // than one never matched.
        Assert.Equal(new DateTimeOffset(new DateTime(2026, 7, 29, 22, 33, 10, 329), TimeSpan.FromHours(2)), order.PlacedAt);

        var item = Assert.Single(order.Items);
        Assert.Equal("Wall mounts", item.Name);
        Assert.Equal(1, item.Quantity);
        Assert.Equal(3175, item.Total.Value);
    }

    /// <summary>
    /// bol is a marketplace and the seller is stated per LINE, not per order,
    /// so one order can genuinely carry several.
    /// </summary>
    [Fact]
    public void The_seller_comes_off_the_line_because_that_is_where_bol_states_it()
    {
        var orders = Parse();

        Assert.Equal("Snow & Outdoor", orders.Single(o => o.Id == "A000TEST001").SellerName);
        Assert.Equal("bol", orders.Single(o => o.Id == "A000TEST002").SellerName);
    }

    [Fact]
    public void Every_order_in_the_page_is_read()
    {
        Assert.Equal(["A000TEST001", "A000TEST002"], Parse().Select(o => o.Id));
    }

    // ---- what it refuses to guess -------------------------------------------

    /// <summary>
    /// An account that has never ordered is an answer. "You have never shopped
    /// here" is only allowed when bol says so itself.
    /// </summary>
    [Theory]
    [InlineData("""{"data":{"me":{"orders":[]}}}""")]
    [InlineData("""{"data":{"me":{"orders":null}}}""")]
    public void An_empty_history_is_an_answer_and_not_a_shape_change(string body)
    {
        Assert.Empty(Shape.Parse(body, Options, Zone));
    }

    /// <summary>
    /// The signed-out answer, and it is a 200 with a perfectly valid payload
    /// that simply has no orders on it - confirmed against the live endpoint.
    ///
    /// Shape-wise it is indistinguishable from bol having removed the field,
    /// and the two call for opposite responses: one asks the user to sign in
    /// again, the other pages an operator about a change that never happened.
    /// The typename is what separates them.
    /// </summary>
    [Fact]
    public void A_signed_out_answer_asks_for_a_login_rather_than_reporting_a_change()
    {
        const string anonymous = """{"data":{"me":{"__typename":"AnonymousCustomer"}}}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(anonymous, Options, Zone));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("AnonymousCustomer", error.Detail, StringComparison.Ordinal);
    }

    /// <summary>
    /// The same payload from a live account, which really does carry both the
    /// typename and the orders. Without this, reading the typename could be
    /// made to swallow a good response and nothing would notice.
    /// </summary>
    [Fact]
    public void A_signed_in_answer_is_read_even_though_it_states_a_typename_too()
    {
        const string signedIn =
            """{"data":{"me":{"__typename":"IdentifiedCustomer","orders":[]}}}""";

        Assert.Empty(Shape.Parse(signedIn, Options, Zone));
    }

    [Theory]
    [InlineData("""{"data":{"me":{}}}""", "data.me.orders")]
    [InlineData("""{"data":{}}""", "data.me.orders")]
    [InlineData("""{"data":{"me":{"orders":{}}}}""", "not a list")]
    public void A_response_that_is_not_the_shape_we_know_is_provider_changed(string body, string says)
    {
        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(body, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains(says, error.Detail, StringComparison.Ordinal);
    }

    /// <summary>
    /// The failure this shape is most likely to meet in the wild: bol ships a
    /// new front end and stops recognising the hash we pin. GraphQL reports it
    /// in the body with a 200, so it has to be read before the data is trusted.
    /// </summary>
    [Fact]
    public void A_forgotten_persisted_query_names_the_setting_an_operator_must_change()
    {
        const string refused = """{"errors":[{"message":"PersistedQueryNotFound"}]}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(refused, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("PersistedQueryNotFound", error.Detail, StringComparison.Ordinal);
        Assert.Contains("OrdersPersistedQueryHash", error.Detail, StringComparison.Ordinal);
    }

    /// <summary>
    /// 2026-10-07 (prod): "Error(s) redacted." under the hash bol's own page
    /// had just sent, and the old detail threw away everything that would
    /// have told an unknown hash from refused variables from a dead session.
    /// The detail now says it all, as tokens a log can group on and never as
    /// the party's free text.
    /// </summary>
    [Fact]
    public void A_refusal_says_what_bol_said_and_whether_the_operation_ran()
    {
        const string refused =
            """{"errors":[{"message":"Error(s) redacted.","path":["me","orders"],"extensions":{"code":"PERSISTED_QUERY_NOT_FOUND","classification":"DataFetchingException"}}]}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(refused, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.StartsWith("bol: graphql refused OrdersOverviewClient: ", error.Detail, StringComparison.Ordinal);

        var tokens = Tokens(error.Detail);
        Assert.Equal("Error-s--redacted.", tokens["message"]);
        Assert.Equal("1", tokens["errors"]);
        Assert.Equal("PERSISTED_QUERY_NOT_FOUND", tokens["code"]);
        Assert.Equal("code,classification", tokens["extensions"]);
        Assert.Equal("me.orders", tokens["path"]);
        Assert.Equal("absent", tokens["data"]);
        Assert.Equal("-", tokens["me"]);
        Assert.Equal("sha256:d195253b815a", tokens["hash"]);
        Assert.Equal("rebuilt", tokens["body"]);
        Assert.Contains("refused the request before running it", error.Detail, StringComparison.Ordinal);

        // the page's own body in use says so, and a hash shorter than the quoted prefix is quoted whole
        var replaying = Options with { OrdersRequestTemplate = Shape.Body(Options, page: 1), OrdersPersistedQueryHash = "sha256:short" };
        var again = Tokens(Assert.Throws<ConnectorException>(() => Shape.Parse(refused, replaying, Zone)).Detail);
        Assert.Equal("replay", again["body"]);
        Assert.Equal("sha256:short", again["hash"]);
    }

    /// <summary>A refusal that came with a data entry - null or not - is one bol ran, so the hash was known and the fault lies elsewhere.</summary>
    [Theory]
    [InlineData("""{"errors":[{"message":"x"}],"data":null}""", "null")]
    [InlineData("""{"errors":[{"message":"x"}],"data":{"me":{"__typename":"IdentifiedCustomer"}}}""", "present")]
    public void A_refusal_beside_data_is_one_that_ran_so_bol_knew_the_hash(string body, string data)
    {
        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(body, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Equal(data, Tokens(error.Detail)["data"]);
        Assert.Contains("the operation ran, so bol knew the hash", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void An_anonymous_answer_beside_errors_is_a_dead_session_and_not_a_change()
    {
        const string anonymous =
            """{"errors":[{"message":"Unauthenticated","extensions":{"code":"UNAUTHENTICATED"}}],"data":{"me":{"__typename":"AnonymousCustomer"}}}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(anonymous, Options, Zone));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("AnonymousCustomer", error.Detail, StringComparison.Ordinal);
        Assert.Contains("code=UNAUTHENTICATED", error.Detail, StringComparison.Ordinal);
        Assert.Contains("me=AnonymousCustomer", error.Detail, StringComparison.Ordinal);
    }

    /// <summary>Every value in the refusal is identifier-like: nothing a party says reaches a log as free text, however long or strange.</summary>
    [Fact]
    public void A_refusal_s_values_are_tokens_and_never_the_party_s_free_text()
    {
        var message = "a \"quoted\" message, with spaces; ünïcode and " + new string('x', 100);
        var body = JsonSerializer.Serialize(new
        {
            errors = new[] { new { message, extensions = new { code = "some code!" }, path = new object[] { "me", 0, "a b" } } },
        });

        var tokens = Tokens(Assert.Throws<ConnectorException>(() => Shape.Parse(body, Options, Zone)).Detail);

        foreach (var value in tokens.Values)
        {
            Assert.Matches("^[A-Za-z0-9_.:,-]{1,64}$", value);
        }

        Assert.Equal("some-code-", tokens["code"]);
        Assert.Equal("me.0.a-b", tokens["path"]);
        Assert.Equal(64, tokens["message"].Length);
    }

    /// <summary>The <c>name=value</c> tokens between the refusal's prefix and its reading.</summary>
    private static Dictionary<string, string> Tokens(string? detail)
    {
        var run = detail!.Split(": ", 3)[2].Split(';')[0];
        return run.Split(' ').Select(token => token.Split('=', 2)).ToDictionary(pair => pair[0], pair => pair[1], StringComparer.Ordinal);
    }

    [Fact]
    public void A_body_that_is_not_json_at_all_says_so()
    {
        var error = Assert.Throws<ConnectorException>(() => Shape.Parse("<html>nope</html>", Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("not JSON", error.Detail, StringComparison.Ordinal);
    }

    // ---- the flag ------------------------------------------------------------

    /// <summary>
    /// bol states no order total, so ours is a sum of its own lines and
    /// reconciling it would compare a number with itself. Saying "derived" is
    /// what keeps the reconciliation flag meaning one thing across providers:
    /// a stated total was checked and agreed.
    /// </summary>
    [Fact]
    public void The_shape_declares_that_its_total_is_derived()
    {
        Assert.True(Shape.TotalIsDerived);

        // And the platform draws the right conclusion from it.
        var receipt = new Receipt
        {
            Id = "rcp_1",
            ExternalId = "A000TEST001",
            ContentHash = "h",
            Merchant = new Merchant { Id = "bol", Name = "bol.com" },
            PurchasedAt = DateTimeOffset.UtcNow,
            Total = new Money(3175, "EUR"),
            TotalIsDerived = true,
            Items =
            [
                new ReceiptItem { Name = "Wall mounts", Quantity = 1, Total = new Money(3175, "EUR") },
            ],
        };

        // The lines agree with the total exactly - they are where it came from -
        // and it is still not reconciled, because nothing independent was checked.
        Assert.False(receipt.WithReconciliation().Reconciled);
    }

    /// <summary>
    /// A PRICE BOL SENDS AS NULL COSTS THAT LINE, NEVER THE FETCH.
    /// </summary>
    /// <remarks>
    /// A nullable GraphQL field arrives as JSON null when the server declines
    /// to fill it, and <c>TryGetProperty</c> THROWS on a null rather than
    /// returning false. So a single unpriced line raised an
    /// <see cref="InvalidOperationException"/> - not a ConnectorException, so
    /// <c>internal</c>, so retriable and blamed on us - and took every order on
    /// the page with it, while an unreadable line anywhere else in this shape
    /// is simply skipped.
    /// </remarks>
    [Theory]
    [InlineData("listPrice")]
    [InlineData("offerInformation")]
    public void A_price_bol_sends_as_null_costs_that_line_and_nothing_else(string field)
    {
        var payload = JsonNode.Parse(Fixture())!;
        var items = payload["data"]!["me"]!["orders"]![0]!["items"]!.AsArray();

        var target = field == "listPrice"
            ? items[0]!["offerInformation"]!.AsObject()
            : items[0]!.AsObject();

        target[field] = null;

        var orders = Shape.Parse(payload.ToJsonString(), Options, Zone);

        // The order survives; only its unpriced line is gone.
        Assert.NotEmpty(orders);
        Assert.DoesNotContain(orders.SelectMany(o => o.Items), line => line.Total.Value == 0);
    }
}
