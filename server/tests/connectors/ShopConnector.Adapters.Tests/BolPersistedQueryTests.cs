using Connector.Kit.Security;
using ShopConnector.Adapters.Bol;
using Xunit;

namespace ShopConnector.Adapters.Tests;

public sealed class BolPersistedQueryTests
{
    private static readonly BolOptions Options = new();

    [Fact]
    public void The_operation_s_hash_is_read_exactly_as_the_page_spelled_it()
    {
        const string body = """
            {"operationName":"OrdersOverviewClient","variables":{"after":"0"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"abc123DEF"}}}
            """;

        Assert.True(BolPersistedQuery.TryReadHash(body, Options, out var hash));
        Assert.Equal("abc123DEF", hash);
    }

    // prod 2026-11-16: bol put "CsAccount" in front of the name; a sign-in waiting for the exact old name learned nothing,
    // every fetch then ran on the configured hash, was refused, and asked for another sign-in
    [Theory]
    [InlineData("CsAccountOrdersOverviewClient")]
    [InlineData("OrdersOverviewClient")]
    [InlineData("ShopOrdersOverviewNext")]
    public void The_orders_operation_is_known_by_what_its_name_contains_whatever_bol_puts_around_it(string name)
    {
        var body = """{"operationName":"NAME","variables":{"after":"5"},"extensions":{"persistedQuery":{"version":1,"sha256Hash":"sha256:8b5e"}}}"""
            .Replace("NAME", name, StringComparison.Ordinal);

        Assert.True(BolPersistedQuery.TryReadHash(body, Options, out var hash));
        Assert.Equal("sha256:8b5e", hash);
        Assert.Equal(name, BolPersistedQuery.OperationName(body));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""{"variables":{}}""")]
    [InlineData("""{"operationName":7}""")]
    [InlineData("""{"operationName":""}""")]
    [InlineData("""{"operationName":"Orders Overview"}""")]
    [InlineData("""{"operationName":"9Lives"}""")]
    [InlineData("""{"operationName":"Name\r\nX-Injected: 1"}""")]
    public void A_body_s_operation_counts_as_a_name_only_when_it_is_a_plain_GraphQL_name(string? body)
    {
        Assert.Null(BolPersistedQuery.OperationName(body));
    }

    [Fact]
    public void A_name_longer_than_a_header_should_carry_is_no_name()
    {
        var body = """{"operationName":"NAME"}""".Replace("NAME", new string('a', 65), StringComparison.Ordinal);

        Assert.Null(BolPersistedQuery.OperationName(body));
        Assert.Equal("SearchHistory", BolPersistedQuery.OperationName("""{"operationName":"SearchHistory"}"""));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json at all OrdersOverviewClient")]
    [InlineData("""{"operationName":"OtherOperation","extensions":{"persistedQuery":{"sha256Hash":"x"}}}""")]
    [InlineData("""{"operationName":"OrdersOverviewClient","extensions":{}}""")]
    [InlineData("""{"operationName":"OrdersOverviewClient","extensions":{"persistedQuery":{"sha256Hash":""}}}""")]
    public void Anything_that_is_not_the_operation_s_persisted_query_is_refused(string? body)
    {
        Assert.False(BolPersistedQuery.TryReadHash(body, Options, out var hash));
        Assert.Equal(string.Empty, hash);
    }

    [Fact]
    public void The_hash_rides_the_session_material_and_reads_back_from_it()
    {
        var material = new SessionMaterial { StorageState = "{}" };

        Assert.Null(BolPersistedQuery.Learned(material));
        Assert.Same(material, BolPersistedQuery.WithHash(material, null));

        var sealed_ = BolPersistedQuery.WithHash(material, "sha256:feed");
        Assert.Equal("sha256:feed", BolPersistedQuery.Learned(sealed_));
        Assert.Equal("{}", sealed_.StorageState);
    }

    // prod 2026-10-07: the page's request rides beside its hash: body verbatim, headers one JSON object, all strings
    [Fact]
    public void The_page_s_own_request_rides_the_material_beside_the_hash_and_reads_back()
    {
        var material = BolPersistedQuery.WithHash(new SessionMaterial { StorageState = "{}" }, "sha256:feed");

        Assert.Null(BolPersistedQuery.LearnedRequest(material));
        Assert.Same(material, BolPersistedQuery.WithRequest(material, null));

        var request = new BolPageRequest(
            """{"operationName":"OrdersOverviewClient","variables":{"after":"5"}}""",
            new Dictionary<string, string>(StringComparer.Ordinal) { ["accept"] = "*/*", ["bol-app-version"] = "7.3.1" });
        var sealed_ = BolPersistedQuery.WithRequest(material, request);

        Assert.Equal(request.Body, sealed_.Extra["ordersBody"]);
        Assert.Equal("""{"accept":"*/*","bol-app-version":"7.3.1"}""", sealed_.Extra["ordersHeaders"]);
        Assert.Equal("sha256:feed", BolPersistedQuery.Learned(sealed_));

        var read = BolPersistedQuery.LearnedRequest(sealed_);
        Assert.NotNull(read);
        Assert.Equal(request.Body, read.Body);

        // header names compare as HTTP's do
        Assert.Equal("7.3.1", read.Headers["BOL-APP-VERSION"]);
    }

    [Fact]
    public void A_replay_never_carries_the_jar_the_authorization_or_the_transport_s_own_headers()
    {
        var carried = BolPersistedQuery.CarryHeaders(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [":authority"] = "www.bol.com",
            ["Cookie"] = "XSC=secret",
            ["authorization"] = "Bearer x",
            ["content-length"] = "123",
            ["host"] = "www.bol.com",
            ["accept-encoding"] = "gzip, br, zstd",
            ["accept"] = "*/*",
            ["user-agent"] = "ua",
            ["x-xsrf-token"] = "token",
        });

        Assert.Equal(["accept", "user-agent", "x-xsrf-token"], carried.Keys.Order(StringComparer.Ordinal));
        Assert.False(BolPersistedQuery.MayCarry("COOKIE"));
        Assert.False(BolPersistedQuery.MayCarry(":method"));
        Assert.False(BolPersistedQuery.MayCarry(" "));
        Assert.True(BolPersistedQuery.MayCarry("bol-app-version"));
    }

    [Fact]
    public void A_bundle_whose_headers_are_not_the_object_the_sign_in_wrote_costs_the_headers_and_never_the_body()
    {
        var material = new SessionMaterial
        {
            StorageState = "{}",
            Extra = new Dictionary<string, string>(StringComparer.Ordinal) { ["ordersBody"] = "{}", ["ordersHeaders"] = "not json" },
        };

        var read = BolPersistedQuery.LearnedRequest(material);
        Assert.NotNull(read);
        Assert.Equal("{}", read.Body);
        Assert.Empty(read.Headers);

        // and the filter applies on the way out too: a hand-edited bundle cannot smuggle a cookie into a replay
        var edited = material with
        {
            Extra = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["ordersBody"] = "{}",
                ["ordersHeaders"] = """{"cookie":"x","accept":"*/*"}""",
            },
        };
        Assert.Equal(["accept"], BolPersistedQuery.LearnedRequest(edited)!.Headers.Keys);
    }

    [Theory]
    [InlineData(null, "-")]
    [InlineData("", "-")]
    [InlineData("sha256:short", "sha256:short")]
    [InlineData("sha256:d195253b815a6082cdee63bef6234513d5c0520c9f064e96fc1a9037d689add2", "sha256:d195253b815a")]
    public void A_note_quotes_enough_of_a_hash_to_tell_two_apart_and_never_the_whole(string? hash, string expected)
    {
        Assert.Equal(expected, BolPersistedQuery.Prefix(hash));
    }
}
