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

// bol's order overview as its own front end reads it: every "Toon meer" posts OrdersOverviewClient to /api/graphql.
// the fixture keeps every key and nesting level but none of the purchases (public repo)
public sealed class BolGraphQlShapeTests
{
    private static readonly BolOptions Options = new();

    private static readonly TimeZoneInfo Zone = RetailZones.Dutch;

    private static readonly BolGraphQlShape Shape = new();

    private static string Fixture() => FixtureCatalog.Read("bol/orders-graphql.json");

    private static IReadOnlyList<BolOrder> Parse() => Shape.Parse(Fixture(), Options, Zone);

    // prod 2026-10-07: "Error(s) redacted." beside data.me.orders is a partial page, not "the party changed its site"
    [Fact]
    public void Errors_beside_the_orders_are_a_partial_page_that_is_read_and_noted()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse(Fixture())!.AsObject();
        node["errors"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["message"] = "Error(s) redacted." });
        var partial = node.ToJsonString();
        var warnings = new List<string>();

        var orders = Shape.Parse(partial, Options, Zone, warn: warnings.Add);

        Assert.Equal(Parse().Count, orders.Count);
        var note = Assert.Single(warnings);
        Assert.Contains("partial page", note, StringComparison.Ordinal);
        Assert.Contains("errors=1", note, StringComparison.Ordinal);
        Assert.Contains("data=present", note, StringComparison.Ordinal);
        Assert.Equal(orders.Count, Shape.Parse(partial, Options, Zone).Count);
    }

    [Fact]
    public void Errors_without_readable_orders_are_still_a_refusal_that_says_the_operation_ran()
    {
        const string body = """{"errors":[{"message":"Error(s) redacted."}],"data":{"me":{"__typename":"IdentifiedCustomer","orders":null}}}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(body, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("data=present", error.Detail, StringComparison.Ordinal);
        Assert.Contains("me=IdentifiedCustomer", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void The_call_is_the_persisted_operation_bol_sends_itself()
    {
        using var body = JsonDocument.Parse(Shape.Body(Options, page: 1)!);
        var root = body.RootElement;

        Assert.Equal("OrdersOverviewClient", root.GetProperty("operationName").GetString());

        // persisted query, hash only: bol's schema is not public, so there is no document to fall back to
        var persisted = root.GetProperty("extensions").GetProperty("persistedQuery");
        Assert.Equal(1, persisted.GetProperty("version").GetInt32());
        Assert.Equal(
            "sha256:d195253b815a6082cdee63bef6234513d5c0520c9f064e96fc1a9037d689add2",
            persisted.GetProperty("sha256Hash").GetString());

        Assert.Equal("https://www.bol.com/api/graphql", Shape.Url(Options, page: 1));
    }

    // bol wants the operation named in a header too: the difference between 400 and 200 live, nothing in the payload hints at it
    [Fact]
    public void The_operation_is_named_again_in_a_header()
    {
        var header = Assert.Single(Shape.Headers(Options));

        Assert.Equal("bol-app-operation-name", header.Key);
        Assert.Equal("OrdersOverviewClient", header.Value);

        var renamed = Options with { OrdersOperationName = "OrdersOverviewV2" };
        Assert.Equal("OrdersOverviewV2", Assert.Single(Shape.Headers(renamed)).Value);
    }

    // the cursor is an offset in ORDERS, sent as a string as bol does
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

    // prod 2026-10-07: bol refused the request rebuilt around its own page's hash, so a learned request is replayed
    // with only the cursor rewritten
    [Fact]
    public void A_learned_request_is_replayed_with_only_the_cursor_rewritten()
    {
        const string template =
            """{"operationName":"OrdersOverviewClient","variables":{"after":"5","locale":"nl-NL"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"sha256:page"}}}""";
        var options = Options with { OrdersRequestTemplate = template };

        using var first = JsonDocument.Parse(Shape.Body(options, page: 1)!);
        var root = first.RootElement;

        Assert.Equal("0", root.GetProperty("variables").GetProperty("after").GetString());
        Assert.Equal("nl-NL", root.GetProperty("variables").GetProperty("locale").GetString());
        Assert.Equal("sha256:page", root.GetProperty("extensions").GetProperty("persistedQuery").GetProperty("sha256Hash").GetString());

        using var third = JsonDocument.Parse(Shape.Body(options, page: 3)!);
        Assert.Equal("10", third.RootElement.GetProperty("variables").GetProperty("after").GetString());
    }

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

    // amount is euros and the price of ONE ("2 x EUR 21,24" vs 21.24); declared minor, receipts would be 1/100
    // and still reconcile
    [Fact]
    public void A_line_total_is_the_unit_price_times_the_quantity()
    {
        var order = Parse().Single(o => o.Id == "A000TEST002");

        var twoOf = order.Items.Single(i => i.Name.Contains("Prullenbak", StringComparison.Ordinal));

        Assert.Equal(2, twoOf.Quantity);
        Assert.Equal(new Money(2124, "EUR"), twoOf.UnitPrice);
        Assert.Equal(4248, twoOf.Total.Value);
        Assert.Equal("EUR", twoOf.Total.Currency);
    }

    [Fact]
    public void An_orders_total_is_the_sum_of_its_own_lines()
    {
        var order = Parse().Single(o => o.Id == "A000TEST002");

        Assert.Equal(4248 + 1199, order.Total.Value);
        Assert.Equal(order.Items.Sum(i => i.Total.Value), order.Total.Value);
    }

    [Fact]
    public void Each_order_carries_its_reference_and_the_moment_it_was_placed()
    {
        var order = Parse().Single(o => o.Id == "A000TEST001");

        // bol states a local wall clock with no offset: read in Europe/Amsterdam so a near-midnight order keeps its day
        Assert.Equal(new DateTimeOffset(new DateTime(2026, 7, 29, 22, 33, 10, 329), TimeSpan.FromHours(2)), order.PlacedAt);

        var item = Assert.Single(order.Items);
        Assert.Equal("Wall mounts", item.Name);
        Assert.Equal(1, item.Quantity);
        Assert.Equal(3175, item.Total.Value);
    }

    // the seller is stated per line, so one order can carry several
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

    // an empty history is an answer: "never shopped" is only allowed when bol says so
    [Theory]
    [InlineData("""{"data":{"me":{"orders":[]}}}""")]
    [InlineData("""{"data":{"me":{"orders":null}}}""")]
    public void An_empty_history_is_an_answer_and_not_a_shape_change(string body)
    {
        Assert.Empty(Shape.Parse(body, Options, Zone));
    }

    // signed-out is a 200 with a valid payload, shape-wise like a removed field, yet one asks for a sign-in and the other
    // pages an operator: the typename separates them (confirmed live)
    [Fact]
    public void A_signed_out_answer_asks_for_a_login_rather_than_reporting_a_change()
    {
        const string anonymous = """{"data":{"me":{"__typename":"AnonymousCustomer"}}}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(anonymous, Options, Zone));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("AnonymousCustomer", error.Detail, StringComparison.Ordinal);
    }

    // a live account carries both typename and orders: reading the typename must not swallow a good response
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

    // likeliest failure: bol ships a new front end and drops the pinned hash; GraphQL reports it in a 200 body
    [Fact]
    public void A_forgotten_persisted_query_names_the_setting_an_operator_must_change()
    {
        const string refused = """{"errors":[{"message":"PersistedQueryNotFound"}]}""";

        var error = Assert.Throws<ConnectorException>(() => Shape.Parse(refused, Options, Zone));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("PersistedQueryNotFound", error.Detail, StringComparison.Ordinal);
        Assert.Contains("OrdersPersistedQueryHash", error.Detail, StringComparison.Ordinal);
    }

    // prod 2026-10-07 "Error(s) redacted.": the detail tells unknown hash, refused variables and dead session apart,
    // as tokens a log can group on, never the party's free text
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

        var replaying = Options with { OrdersRequestTemplate = Shape.Body(Options, page: 1), OrdersPersistedQueryHash = "sha256:short" };
        var again = Tokens(Assert.Throws<ConnectorException>(() => Shape.Parse(refused, replaying, Zone)).Detail);
        Assert.Equal("replay", again["body"]);
        Assert.Equal("sha256:short", again["hash"]);
    }

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

    // bol states no total, ours sums its lines: "derived" keeps the reconciliation flag meaning a stated total was checked
    [Fact]
    public void The_shape_declares_that_its_total_is_derived()
    {
        Assert.True(Shape.TotalIsDerived);

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

        // the lines agree because they are where the total came from: still not reconciled, nothing independent was checked
        Assert.False(receipt.WithReconciliation().Reconciled);
    }

    // TryGetProperty THROWS on a JSON null: one unpriced line raised InvalidOperationException (retriable, blamed on us)
    // and took the whole page, where any other unreadable line is skipped
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

        Assert.NotEmpty(orders);
        Assert.DoesNotContain(orders.SelectMany(o => o.Items), line => line.Total.Value == 0);
    }
}
