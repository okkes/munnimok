using System.Net;
using Connector.Kit.Errors;
using Connector.Kit.Security;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.Support;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

public sealed class LidlPlusAdapterTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    private static readonly IReadOnlyDictionary<string, string> DutchConfig =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL", ["language"] = "nl" };

    private static HttpResponseMessage Route(RecordedRequest request, int _)
    {
        if (request.Path.StartsWith("/api/v3/", StringComparison.Ordinal))
        {
            return Stub.Fixture("lidl/ticket-detail.json");
        }

        if (request.Path.StartsWith("/api/v2/", StringComparison.Ordinal))
        {
            return request.Query.Contains("pageNumber=1", StringComparison.Ordinal)
                ? Stub.Fixture("lidl/tickets-page-1.json")
                : Stub.Fixture("lidl/tickets-page-2.json");
        }

        return Stub.Status(HttpStatusCode.NotFound);
    }

    private static LidlPlusAdapter Adapter() => new(new LidlPlusOptions(), new FixedTimeProvider(Now));

    private static FakeJobContext Context(HttpMessageHandler handler) => new(handler)
    {
        Config = DutchConfig,
        Material = new SessionMaterial
        {
            AccessToken = "lidl-access-token-fixture",
            RefreshToken = "lidl-refresh-token-fixture",
        },
    };

    [Fact]
    public async Task Fetch_walks_the_v2_list_then_the_v3_detail()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 10)), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        Assert.Equal("lidl-2026-07-18-8801", receipt.ExternalId);
        Assert.Equal("lidl", receipt.Merchant.Id);
        // the branch NAME from the detail's store object, not its code: reading `store` as a string gave "NL0263"
        Assert.Equal("Testdorp", receipt.Merchant.StoreName);
        Assert.Equal(376, receipt.Total.Value);

        // the detail's wall-clock date in the store's country zone; the list's date put every receipt two hours late
        Assert.Equal(TimeSpan.FromHours(2), receipt.PurchasedAt.Offset);
        Assert.Equal(new DateTime(2026, 8, 4, 12, 51, 18), receipt.PurchasedAt.DateTime);

        // Three articles off the printed receipt; the markdown line is a
        // discount on one of them rather than a fourth item.
        Assert.Equal(3, receipt.Items.Count);
        Assert.True(receipt.Reconciled);
        Assert.Equal("4321", receipt.Payment?.CardLast4);
        Assert.True(result.Complete);
        Assert.Equal("tickets-v2", result.Via);

        // two list pages (the second is empty and ends the walk) and one detail call per receipt inside the window
        Assert.Equal(
            ["/api/v2/NL/tickets", "/api/v2/NL/tickets", "/api/v3/NL/tickets/lidl-2026-07-18-8801"],
            handler.Requests.Select(r => r.Path));
    }

    [Fact]
    public async Task Every_ticket_call_carries_the_app_headers_the_api_routes_on()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler);

        await Adapter().FetchAsync(ctx, Requests.Receipts(since: Requests.Day(2026, 7, 10)), CancellationToken.None);

        // sent because the API routes on them; the casing of "iOs" is the provider's, confirmed
        Assert.All(handler.Requests, request =>
        {
            // NOT "999.99.9": Lidl's edge drops the TCP connection on that sentinel (the well-known scraper's), measured 2026-08-03
            // 999.99.99 and 99.99.9 reach authentication and answer 401
            // it surfaced as a nameless "request timed out" after 60 s
            Assert.NotEqual("999.99.9", request.Header("App-Version"));
            Assert.Equal("15.20.3", request.Header("App-Version"));
            Assert.Equal("iOs", request.Header("Operating-System"));
            Assert.Equal("com.lidl.eci.lidl.plus", request.Header("App"));
            Assert.Equal("NL", request.Header("Country"));
            Assert.Equal("nl", request.Header("Accept-Language"));
            Assert.Equal("Bearer lidl-access-token-fixture", request.Header("Authorization"));
        });
    }

    [Fact]
    public async Task A_ticket_outside_the_window_is_not_fetched_in_detail()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 1), until: Requests.Day(2026, 7, 10)),
            CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        Assert.Equal("lidl-2026-07-05-8720", receipt.ExternalId);
        Assert.Single(handler.Requests, r => r.Path.StartsWith("/api/v3/", StringComparison.Ordinal));
    }

    [Fact]
    public void The_authorize_url_carries_the_confirmed_parameters_and_the_pkce_pair()
    {
        // a fixed verifier, so the URL's challenge can be computed independently
        var pkce = PkceChallenge.For("k0PBJmBFPYRe0S6dr1RxD1bcVYh7z7iHFbSC6X1IH0M");

        var url = Adapter().AuthorizeUrl(pkce, new LidlSettings("NL", "nl"));

        Assert.StartsWith("https://accounts.lidl.com/connect/authorize?", url, StringComparison.Ordinal);
        Assert.Contains("client_id=LidlPlusNativeClient", url, StringComparison.Ordinal);
        Assert.Contains("response_type=code", url, StringComparison.Ordinal);
        Assert.Contains("redirect_uri=com.lidlplus.app%3A%2F%2Fcallback", url, StringComparison.Ordinal);

        // offline_access is what yields the refresh token, and the refresh
        // token is the whole T2 story.
        Assert.Contains("offline_access", url, StringComparison.Ordinal);

        // RFC 7636: a server that recorded a challenge refuses the code exchange without the verifier
        Assert.Contains($"code_challenge={Uri.EscapeDataString(pkce.Challenge)}", url, StringComparison.Ordinal);
        Assert.Contains("code_challenge_method=S256", url, StringComparison.Ordinal);

        // OBSERVED: without these accounts.lidl.com redirects to /error instead of rendering a login page
        // bare capitalised country, lower-case full locale; "nl" alone as language is another /error
        Assert.Contains("Country=NL", url, StringComparison.Ordinal);
        Assert.Contains("language=nl-NL", url, StringComparison.Ordinal);

        // The verifier is the secret half and must never appear in a URL any
        // browser, proxy or log can see.
        Assert.DoesNotContain(pkce.Verifier, url, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("country", "ZZ")]
    [InlineData("language", "xx")]
    public async Task Config_outside_the_manifest_s_options_is_refused_before_any_call(string key, string value)
    {
        var config = new Dictionary<string, string>(DutchConfig, StringComparer.Ordinal) { [key] = value };
        var handler = new StubHttpHandler(Route);

        using var ctx = new FakeJobContext(handler)
        {
            Config = config,
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Country_and_language_fall_back_to_the_copy_sealed_into_the_material()
    {
        var handler = new StubHttpHandler(Route);

        // a session resumed without config must stay serviceable: every ticket URL and two headers need these
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial
            {
                AccessToken = "live",
                Extra = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["country"] = "nl",
                    ["language"] = "NL",
                },
            },
        };

        await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        // Lidl is case-sensitive about country (upper) and language (lower), which appear verbatim in URLs and headers
        Assert.All(handler.Requests, request =>
        {
            Assert.Contains("/NL/", request.Path, StringComparison.Ordinal);
            Assert.Equal("nl", request.Header("Accept-Language"));
        });
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task A_refusal_from_the_ticket_api_is_reported_as_a_refusal(HttpStatusCode status)
    {
        var handler = new StubHttpHandler((_, _) => Stub.Status(status));
        using var ctx = Context(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task A_list_that_keeps_answering_the_same_page_stops_instead_of_looping()
    {
        // a pagination parameter that stopped advancing upstream would repeat the request twenty times against a defended endpoint
        var handler = new StubHttpHandler((_, _) => Stub.Fixture("lidl/tickets-page-1.json"));
        using var ctx = Context(handler);

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Equal(2, result.Receipts.Count);
        Assert.Equal(2, handler.Requests.Count);
    }

    private static HttpResponseMessage PageOf(RecordedRequest request)
    {
        var page = request.Query.Contains("pageNumber=", StringComparison.Ordinal)
            ? request.Query[(request.Query.IndexOf("pageNumber=", StringComparison.Ordinal) + 11)..].Split('&')[0]
            : "1";

        return Stub.Json($$"""
        {"tickets":[{"id":"lidl-page-{{page}}-0001","date":"2026-07-18T18:04:00","totalAmount":"14,27",
          "storeName":"Lidl Testdorp","isFavorite":false,"hasReturnedItems":false}],
         "page":{{page}},"size":1,"totalCount":99}
        """);
    }

    // a history longer than MaxPages is not complete: it once came back truncated and labelled complete, invisible downstream
    [Fact]
    public async Task A_history_longer_than_the_page_budget_is_not_called_complete()
    {
        var handler = new StubHttpHandler((request, _) => PageOf(request));
        using var ctx = Context(handler);

        var adapter = new LidlPlusAdapter(new LidlPlusOptions { MaxPages = 3 }, new FixedTimeProvider(Now));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal(3, result.Receipts.Count);

        Assert.False(result.Complete);

        // names the limit that stopped it, since bare "incomplete" reads as a provider having a bad day
        Assert.Contains(ctx.Notes, n => n.Contains("3 pages", StringComparison.Ordinal));
    }

    // raw is the detail document, once captured only on the way to items: include=raw alone must answer, not come back empty
    [Fact]
    public async Task Raw_can_be_asked_for_without_items()
    {
        using var ctx = Context(new StubHttpHandler(Route));

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(items: false, raw: true), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Equal(result.Receipts.Select(r => r.ExternalId).Order(StringComparer.Ordinal),
            result.Raw.Keys.Order(StringComparer.Ordinal));

        Assert.All(result.Raw.Values, payload => Assert.Contains("ticketType", payload, StringComparison.Ordinal));
    }

    // the detail rewrites total, store name and timestamp: running it for raw-only gives one purchase two content hashes
    [Fact]
    public async Task Asking_for_raw_does_not_change_the_receipt_it_came_with()
    {
        using var plain = Context(new StubHttpHandler(Route));
        using var withRaw = Context(new StubHttpHandler(Route));

        var without = await Adapter().FetchAsync(
            plain, Requests.Receipts(items: false), CancellationToken.None);

        var with = await Adapter().FetchAsync(
            withRaw, Requests.Receipts(items: false, raw: true), CancellationToken.None);

        Assert.Equal(
            without.Receipts.Select(r => r.ContentHash),
            with.Receipts.Select(r => r.ContentHash));
    }
}
