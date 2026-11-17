using System.Net;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Security;
using ShopConnector.Adapters.AlbertHeijn;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// the browser login is exercised live; here is what failed the previous live run:
// client id, header block, receipts as GraphQL
public sealed class AlbertHeijnAdapterTests
{
    private const string TokenPath = "/mobile-auth/v1/auth/token";
    private const string RefreshPath = "/mobile-auth/v1/auth/token/refresh";
    private const string GraphQlPath = "/graphql";

    private static readonly DateTimeOffset Now = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    // list and detail share one path and method: the operation is in the body, as upstream
    private static HttpResponseMessage Route(RecordedRequest request, int _) => request.Path switch
    {
        RefreshPath => Stub.Fixture("ah/token.json"),
        TokenPath => Stub.Fixture("ah/token.json"),
        GraphQlPath => IsDetail(request) ? Stub.Fixture("ah/receipt-detail.json") : Stub.Fixture("ah/receipts-list.json"),
        _ => Stub.Status(HttpStatusCode.NotFound),
    };

    private static bool IsDetail(RecordedRequest request) =>
        request.Body?.Contains("posReceiptDetails", StringComparison.Ordinal) == true;

    // typed login by default; production streams AH's own page, which asks for nothing,
    // so a missing-credential test needs the typed one
    private static AlbertHeijnAdapter Adapter(bool liveLogin = false) =>
        new(new AlbertHeijnOptions { LiveLogin = liveLogin }, new FixedTimeProvider(Now));

    private static AlbertHeijnAdapter Adapter(AlbertHeijnOptions options) => new(options, new FixedTimeProvider(Now));

    [Fact]
    public void The_authorize_url_names_the_corrected_client_id()
    {
        var url = Adapter().AuthorizeUrl();

        Assert.StartsWith("https://login.ah.nl/login?", url, StringComparison.Ordinal);
        Assert.Contains("client_id=appie-ios", url, StringComparison.Ordinal);
        Assert.Contains("response_type=code", url, StringComparison.Ordinal);

        // verbatim, as the reference sends it: percent-encoding the scheme fails the authorize request
        Assert.Contains("redirect_uri=appie://login-exit", url, StringComparison.Ordinal);
        Assert.DoesNotContain("appie%3A%2F%2F", url, StringComparison.Ordinal);

        // the old value `appie` made a real login fail; the suffix is not cosmetic
        Assert.DoesNotContain("client_id=appie&", url, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Every_call_carries_the_header_block_the_api_answers_to()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        await Adapter().FetchAsync(ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15)), CancellationToken.None);

        // the API needs these to route and answer, not to disguise anything
        Assert.All(handler.Requests, request =>
        {
            AssertUserAgent(request);
            Assert.Equal("appie-ios", request.Header("x-client-name"));
            Assert.Equal("9.28", request.Header("x-client-version"));
            Assert.Equal("AHWEBSHOP", request.Header("x-application"));
            Assert.Equal("application/json", request.Header("Accept"));
            Assert.StartsWith("application/json", request.Header("Content-Type"), StringComparison.Ordinal);
            Assert.Equal("Bearer live", request.Header("Authorization"));
        });
    }

    [Fact]
    public async Task Receipts_are_graphql_and_never_a_rest_path()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        await Adapter().FetchAsync(ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15)), CancellationToken.None);

        // /mobile-services/v2/receipts does not exist
        Assert.All(handler.Requests, request =>
        {
            Assert.Equal(GraphQlPath, request.Path);
            Assert.Equal(HttpMethod.Post, request.Method);
        });

        var list = handler.Requests[0].Body;
        Assert.NotNull(list);
        Assert.Contains("posReceiptsPage", list, StringComparison.Ordinal);
        Assert.Contains("\"offset\":0", list, StringComparison.Ordinal);
        Assert.Contains("\"limit\":50", list, StringComparison.Ordinal);

        // query and variables, no operationName
        Assert.DoesNotContain("operationName", list, StringComparison.Ordinal);

        var detail = handler.Requests[1].Body;
        Assert.NotNull(detail);
        Assert.Contains("posReceiptDetails", detail, StringComparison.Ordinal);
        Assert.Contains("ah-2026-07-19-4711", detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_redirect_handed_over_up_front_needs_no_browser_and_no_human()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            // escape hatch: a native consumer that intercepted appie:// already holds the answer
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["redirect_url"] = "appie://login-exit?code=already-collected",
            },
        };

        var result = await Adapter().LoginAsync(ctx, CancellationToken.None);

        Assert.Empty(ctx.Asked);
        Assert.False(ctx.Browser.Started);

        // an OAuth code is single-use: the latch closes before it goes upstream,
        // so a lost lease fails the job instead of replaying a spent code
        Assert.True(ctx.CredentialWasSubmitted);

        var exchange = Assert.Single(handler.Requests, r => r.Path == TokenPath);
        Assert.Equal(HttpMethod.Post, exchange.Method);
        Assert.NotNull(exchange.Body);
        Assert.Contains("\"clientId\":\"appie-ios\"", exchange.Body, StringComparison.Ordinal);
        Assert.Contains("already-collected", exchange.Body, StringComparison.Ordinal);
        AssertUserAgent(exchange);

        Assert.Equal("ah-access-token-fixture", result.Material.AccessToken);
        Assert.Equal("ah-refresh-token-fixture", result.Material.RefreshToken);

        // unset: the access token's expiry says nothing about the connection's life.
        // the short one would prompt needless reconnects
        Assert.Null(result.ExpiresAt);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_login_missing_a_credential_is_refused_before_any_browser_or_call(string missing)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "shopper@example.com",
            ["password"] = "hunter2",
        };
        inputs.Remove(missing);

        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler) { Inputs = inputs };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, CancellationToken.None));

        // nothing went upstream, so nothing counted against the user, and no browser started
        Assert.Equal(ErrorCode.InvalidRequest, error.Code);
        Assert.False(ctx.CredentialWasSubmitted);
        Assert.False(ctx.Browser.Started);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Fetch_returns_a_normalised_reconciled_receipt_with_its_discounts_folded_in()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live", RefreshToken = "r" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15)), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        Assert.Equal("ah-2026-07-19-4711", receipt.ExternalId);
        Assert.Equal("ah", receipt.Merchant.Id);

        // the confirmed operations select no store: null, not a guess
        Assert.Null(receipt.Merchant.StoreName);

        Assert.Equal(636, receipt.Total.Value);
        Assert.Equal("EUR", receipt.Total.Currency);
        Assert.Equal(TimeSpan.FromHours(2), receipt.PurchasedAt.Offset);

        // three products and the bonus, which AH states in its own array with nothing linking it to a product
        Assert.Equal(4, receipt.Items.Count);
        Assert.True(receipt.Reconciled);

        Assert.NotNull(receipt.Payment);
        Assert.Equal("card", receipt.Payment.Method);

        // null, not omitted: the operation selects nothing that could carry a tail, so the consumer's match is weaker
        Assert.Null(receipt.Payment.CardLast4);
        Assert.Null(receipt.Payment.IbanTail);

        Assert.True(result.Complete);
        Assert.Equal("graphql", result.Via);

        // nothing rotated, so the stored bundle is current and must not be re-sealed
        Assert.Null(result.RefreshedMaterial);

        // a fetch is plain HTTP; the browser is only for the login
        Assert.False(ctx.Browser.Started);
        Assert.Contains(JobStep.Normalizing, ctx.Steps);
    }

    [Fact]
    public async Task Fetch_without_items_skips_the_detail_call_entirely()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        // the detail call is the expensive one and the likeliest to trip protection: only when items were asked for
        Assert.Single(handler.Requests);
        Assert.Equal(2, result.Receipts.Count);
        Assert.All(result.Receipts, r => Assert.Empty(r.Items));
    }

    [Fact]
    public async Task An_account_with_no_receipts_yields_no_records_rather_than_an_error()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Fixture("ah/receipts-empty.json"));
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task An_errors_array_under_a_200_is_a_shape_change_and_never_an_empty_history()
    {
        var handler = new StubHttpHandler((_, _) => Stub.Fixture("ah/graphql-errors.json"));
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None));

        // GraphQL puts failures in the body under a 200; reading only the status would answer "never shopped here"
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.Contains("Member is not entitled", error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_providers_own_document_comes_back_only_when_it_was_asked_for()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15), raw: true), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        var raw = Assert.Contains(receipt.ExternalId, result.Raw);

        // AH's own detail document, verbatim: when AH renames a field the normalised receipt silently loses a value,
        // and this shows why
        Assert.Contains("posReceiptDetails", raw, StringComparison.Ordinal);

        // the detail answer only: the list page carries other receipts, and another shopper's rows would be a leak
        Assert.DoesNotContain("posReceiptsPage", raw, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_fetch_that_did_not_ask_for_raw_carries_none()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15)), CancellationToken.None);

        // raw is more sensitive than normalised (it restores dropped fields): never a default
        Assert.NotEmpty(result.Receipts);
        Assert.Empty(result.Raw);
    }

    [Fact]
    public async Task Raw_without_items_hands_back_the_list_row_rather_than_nothing()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(items: false, raw: true), CancellationToken.None);

        Assert.Equal(2, result.Receipts.Count);

        // returning nothing read as "provider sent nothing" rather than "you did not ask for the richer call"
        Assert.Equal(2, result.Raw.Count);

        var first = result.Receipts[0];
        var raw = Assert.Contains(first.ExternalId, result.Raw);

        // the receipt's own row, not the page, which carries every other receipt in the pass
        Assert.Contains(first.ExternalId, raw, StringComparison.Ordinal);
        Assert.DoesNotContain("posReceiptsPage", raw, StringComparison.Ordinal);
        Assert.DoesNotContain(result.Receipts[1].ExternalId, raw, StringComparison.Ordinal);

        // no detail call: asking for raw must not make the fetch expensive
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Raw_with_items_prefers_the_detail_document_over_the_list_row()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(since: Requests.Day(2026, 7, 15), raw: true), CancellationToken.None);

        var receipt = Assert.Single(result.Receipts);
        var raw = Assert.Contains(receipt.ExternalId, result.Raw);

        // the detail document carries the line items, where a renamed field shows up
        Assert.Contains("posReceiptDetails", raw, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_fetch_that_did_not_ask_for_raw_pays_nothing_to_keep_one()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(items: false), CancellationToken.None);

        // never stringified at all, which matters on a two-hundred-receipt page
        Assert.NotEmpty(result.Receipts);
        Assert.Empty(result.Raw);
    }

    [Fact]
    public async Task A_history_longer_than_one_pass_stops_at_the_cap_and_says_so()
    {
        var handler = new StubHttpHandler((request, ordinal) => FullPage(ordinal));
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        // the seam, not the manifest's number (two thousand): a fixture that size would be unreadable
        const int cap = 200;
        var result = await Adapter(new AlbertHeijnOptions { RecordCap = cap })
            .FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Equal(cap, result.Receipts.Count);

        // false: the caller comes back for the rest rather than believing it has the lot
        Assert.False(result.Complete);

        Assert.Equal(5, handler.Requests.Count);
        Assert.Collection(
            handler.Requests.Select(r => r.Body!),
            b => Assert.Contains("\"offset\":0", b, StringComparison.Ordinal),
            b => Assert.Contains("\"offset\":50", b, StringComparison.Ordinal),
            b => Assert.Contains("\"offset\":100", b, StringComparison.Ordinal),
            b => Assert.Contains("\"offset\":150", b, StringComparison.Ordinal),
            b => Assert.Contains("\"offset\":200", b, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_list_that_keeps_answering_the_same_page_stops_instead_of_looping()
    {
        // the symptom of an offset that stopped advancing upstream.
        // without the guard it is one request five times against a defended endpoint
        var handler = new StubHttpHandler((_, _) => FullPage(0));
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Equal(50, result.Receipts.Count);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task An_expired_access_token_refreshes_once_retries_once_and_rotates_the_material()
    {
        var handler = new StubHttpHandler((request, ordinal) => request.Path switch
        {
            GraphQlPath when ordinal == 0 => Stub.Status(HttpStatusCode.Unauthorized),
            _ => Route(request, ordinal),
        });

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "stale", RefreshToken = "still-good" },
        };

        var result = await Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None);

        Assert.Equal(2, result.Receipts.Count);
        Assert.Equal([GraphQlPath, RefreshPath, GraphQlPath], handler.Requests.Select(r => r.Path));

        var refresh = handler.Requests[1];
        Assert.NotNull(refresh.Body);
        Assert.Contains("\"clientId\":\"appie-ios\"", refresh.Body, StringComparison.Ordinal);
        Assert.Contains("still-good", refresh.Body, StringComparison.Ordinal);

        // a rotation must be reported so the caller persists the newest bundle
        Assert.NotNull(result.RefreshedMaterial);
        Assert.Equal("ah-access-token-fixture", result.RefreshedMaterial.AccessToken);
        Assert.Equal("ah-refresh-token-fixture", result.RefreshedMaterial.RefreshToken);
    }

    [Fact]
    public async Task A_second_rejection_after_a_refresh_ends_the_session_rather_than_looping()
    {
        var handler = new StubHttpHandler((request, ordinal) => request.Path switch
        {
            GraphQlPath => Stub.Status(HttpStatusCode.Unauthorized),
            _ => Route(request, ordinal),
        });

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "stale", RefreshToken = "dead" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None));

        // one refresh, one retry: repeatedly presenting a dead session makes a provider treat the client as hostile
        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Equal(3, handler.Requests.Count);
        Assert.False(error.Retriable);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task A_refusal_from_the_provider_is_reported_as_a_refusal(HttpStatusCode status)
    {
        var handler = new StubHttpHandler((request, ordinal) => request.Path switch
        {
            GraphQlPath => Stub.Status(status),
            _ => Route(request, ordinal),
        });

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None));

        // bot protection is not a wrong password: saying so sends the user to reset a fine one
        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.NotEqual(ErrorCode.InvalidCredentials, error.Code);
    }

    [Fact]
    public async Task An_interstitial_where_json_was_promised_is_a_shape_change()
    {
        var handler = new StubHttpHandler((request, ordinal) => request.Path switch
        {
            GraphQlPath => Stub.Html(),
            _ => Route(request, ordinal),
        });

        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(items: false), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public async Task A_fetch_with_no_stored_token_ends_the_session_before_any_call()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Requests.Receipts(), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task An_unknown_resource_is_refused_without_contacting_the_provider()
    {
        var handler = new StubHttpHandler(Route);
        using var ctx = new FakeJobContext(handler)
        {
            Material = new SessionMaterial { AccessToken = "live" },
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(
                ctx, new ResourceRequest { ResourceId = "transactions" }, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
        Assert.Empty(handler.Requests);
    }

    // HttpRequestMessage parses User-Agent into tokens, so the recorder sees them separately.
    // on the wire they rejoin with a space
    private static void AssertUserAgent(RecordedRequest request)
    {
        var agent = request.Header("User-Agent");
        Assert.NotNull(agent);
        Assert.StartsWith("Appie/9.28", agent, StringComparison.Ordinal);
        Assert.Contains("(iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)", agent, StringComparison.Ordinal);
    }

    // the ordinal makes page ids unique, so a walk that advances differs from one re-reading page one
    private static HttpResponseMessage FullPage(int ordinal, int size = 50)
    {
        var rows = new JsonArray();
        for (var i = 0; i < size; i++)
        {
            rows.Add(new JsonObject
            {
                ["id"] = $"ah-{ordinal:D2}-{i:D3}",
                ["dateTime"] = "2026-07-19T17:42:00+02:00",
                ["totalAmount"] = new JsonObject { ["amount"] = 1.00 },
            });
        }

        var body = new JsonObject
        {
            ["data"] = new JsonObject
            {
                ["posReceiptsPage"] = new JsonObject { ["posReceipts"] = rows },
            },
        };

        return Stub.Json(body.ToJsonString());
    }
}
