using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.MediaMarkt;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

public sealed class MediaMarktAdapterTests
{
    private const string FirstUrl =
        "https://www.mediamarkt.nl/api/v1/graphql?operationName=GetCombinedOrdersV3"
        + "&variables=%7B%22limit%22%3A10%2C%22offset%22%3A0%7D"
        + "&extensions=%7B%22persistedQuery%22%3A%7B%22sha256Hash%22%3A%22abc123%22%7D%7D";

    // pages follow each other immediately: the real gap is a courtesy to Cloudflare, and paying it made offline tests slow
    // pacing is the manifest's MinRequestGapMs, enforced above this adapter
    private static readonly MediaMarktOptions Options = new() { PageGapMs = 0 };

    private sealed class ScriptedPortal(params string[] pages) : IMediaMarktPortal
    {
        private int _served;

        public List<string> Asked { get; } = [];

        // the client's headers on the observed call; the fixture once omitted them, so CarriedHeaders
        // (added after the first live fetch died) was never exercised; what is asserted is that they SURVIVE the hop
        public static readonly IReadOnlyDictionary<string, string> ClientHeaders =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                // satisfies Apollo's CSRF check on a GET that carries no body
                ["content-type"] = "application/json",
                ["apollographql-client-name"] = "pwa-client",
                ["apollographql-client-version"] = "not-a-real-version",
                ["x-operation"] = "GetCombinedOrders",
                ["x-mms-country"] = "NL",
                ["x-mms-language"] = "nl",
                ["x-mms-salesline"] = "Media",
            };

        public MediaMarktCall? Opening { get; init; } =
            new MediaMarktCall(200, FirstUrl, pages[0], ClientHeaders);

        public Dictionary<string, MediaMarktDocument?> Invoices { get; } = new(StringComparer.Ordinal);

        public List<string> InvoicesAsked { get; } = [];

        public Task<MediaMarktDocument?> InvoiceAsync(string orderId, Action<string> note, CancellationToken ct)
        {
            InvoicesAsked.Add(orderId);
            if (Invoices.TryGetValue(orderId, out var document)) return Task.FromResult(document);

            note($"order '{orderId}': no invoice download appeared (scripted)");
            return Task.FromResult<MediaMarktDocument?>(null);
        }

        public MediaMarktCall Later { get; set; }

        public bool LaterIsScripted { get; init; } = true;

        public Task<MediaMarktCall?> ObserveAsync(
            string url, string operationName, int timeoutMs, CancellationToken ct)
        {
            Navigated++;
            _served = 1;
            return Task.FromResult(Opening);
        }

        public int Navigated { get; private set; }

        public Task<MediaMarktCall?> WatchAsync(string operationName, int timeoutMs, CancellationToken ct)
        {
            Watched++;
            _served = 1;
            return Task.FromResult(Opening);
        }

        public int Watched { get; private set; }

        public Task<string> DescribeAsync(CancellationToken ct) =>
            Task.FromResult("at https://www.mediamarkt.nl/nl/myaccount/auth/login; it says 'Onjuist wachtwoord'");

        // the headers each composed call carried; the stub once discarded them, which left CarriedHeaders untested
        public List<IReadOnlyDictionary<string, string>> AskedWith { get; } = [];

        // Apollo's CSRF prevention refuses a GET with a simple or absent content type unless it sends
        // x-apollo-operation-name or apollo-require-preflight; the client sends content-type: application/json on every GET
        // modelled because this 400 killed the first live fetch and a stub answering 200 cannot fail that way
        private static bool Satisfied(IReadOnlyDictionary<string, string> headers) =>
            headers.ContainsKey("content-type")
            || headers.ContainsKey("x-apollo-operation-name")
            || headers.ContainsKey("apollo-require-preflight");

        public Task<MediaMarktCall> ReadAsync(
            string url, IReadOnlyDictionary<string, string> headers, CancellationToken ct)
        {
            Asked.Add(url);
            AskedWith.Add(headers);

            if (!Satisfied(headers))
            {
                return Task.FromResult(new MediaMarktCall(
                    400,
                    url,
                    """{"errors":[{"message":"This operation has been blocked as a potential Cross-Site Request Forgery (CSRF)."}]}"""));
            }

            if (!LaterIsScripted) return Task.FromResult(Later);

            var body = _served < pages.Length ? pages[_served] : Page();
            _served++;

            return Task.FromResult(new MediaMarktCall(200, url, body));
        }

        private static string Page() => """{"data":{"getCombinedOrders":[]}}""";
    }

    private static string PageOf(int count, int startingAt = 1)
    {
        var template = JsonNode.Parse(FixtureCatalog.Read("mediamarkt/orders-page.json"))!;
        var one = template["data"]!["getCombinedOrders"]![0]!.ToJsonString();

        var orders = new JsonArray();

        for (var i = 0; i < count; i++)
        {
            var order = JsonNode.Parse(one)!;
            var id = (startingAt + i).ToString("00000000", System.Globalization.CultureInfo.InvariantCulture);
            order["id"] = id;
            orders.Add(order);
        }

        return new JsonObject { ["data"] = new JsonObject { ["getCombinedOrders"] = orders } }.ToJsonString();
    }

    private static (FakeJobContext Ctx, MediaMarktAdapter Adapter) Rig() =>
        (new FakeJobContext(), new MediaMarktAdapter(Options));

    [Fact]
    public async Task The_walk_counts_what_it_found_page_by_page()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(10), PageOf(10, startingAt: 11), PageOf(3, startingAt: 21));

        await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Equal([10, 20, 23], ctx.Counted);
    }

    // the order's own page offers an invoice, which rides the receipt as a document;
    // a non-PDF answer (a sign-in page behind a .pdf link) is not attached
    [Fact]
    public async Task An_invoice_is_fetched_from_the_orders_own_page_and_rides_the_receipt()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(3))
        {
            Invoices =
            {
                ["00000001"] = new MediaMarktDocument(200, "application/pdf", "%PDF-1.4 factuur"u8.ToArray(), "factuur-1.pdf"),
                ["00000002"] = new MediaMarktDocument(200, "text/html", "<html>inloggen</html>"u8.ToArray(), "factuur-2.pdf"),
            },
        };

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(invoice: true), portal, CancellationToken.None);

        Assert.Equal(["00000001", "00000002", "00000003"], portal.InvoicesAsked);
        Assert.EndsWith("+invoice-pdf", result.Via, StringComparison.Ordinal);

        var first = Assert.Single(result.Receipts, r => r.ExternalId == "00000001");
        var document = Assert.Single(first.Documents);
        Assert.Equal(ReceiptDocumentKinds.Invoice, document.Kind);
        Assert.Equal("application/pdf", document.MediaType);
        Assert.Equal("factuur-1.pdf", document.Filename);
        Assert.Equal("%PDF-1.4 factuur"u8.Length, document.SizeBytes);

        // the sign-in page is refused by what it SAID it was, and the purchase stays
        var second = Assert.Single(result.Receipts, r => r.ExternalId == "00000002");
        Assert.Empty(second.Documents);
        Assert.Contains(ctx.Notes, note => note.Contains("'00000002'", StringComparison.Ordinal) && note.Contains("not attached", StringComparison.Ordinal));

        // an order whose page offers nothing is noted, not failed
        var third = Assert.Single(result.Receipts, r => r.ExternalId == "00000003");
        Assert.Empty(third.Documents);
        Assert.Contains(ctx.Notes, note => note.Contains("'00000003'", StringComparison.Ordinal));
    }

    // #430: "Factuur aanvragen" is offered on recent orders only, so an older order without one is normal:
    // one line, no note per order
    [Fact]
    public async Task An_order_that_offers_no_invoice_is_normal_and_said_once()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(3))
        {
            Invoices =
            {
                ["00000001"] = new MediaMarktDocument(200, "application/pdf", "%PDF-1.4 factuur"u8.ToArray(), "factuur-1.pdf"),
                ["00000002"] = MediaMarktDocument.NotOffered,
                ["00000003"] = MediaMarktDocument.NotOffered,
            },
        };

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(invoice: true), portal, CancellationToken.None);

        Assert.Single(Assert.Single(result.Receipts, r => r.ExternalId == "00000001").Documents);
        Assert.Empty(Assert.Single(result.Receipts, r => r.ExternalId == "00000002").Documents);
        Assert.DoesNotContain(ctx.Notes, note => note.Contains("'00000002'", StringComparison.Ordinal) || note.Contains("'00000003'", StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, note => note.Contains("2 order(s) offer no invoice", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Invoices_are_not_asked_for_unless_the_caller_wanted_them()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(3));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Empty(portal.InvoicesAsked);
        Assert.All(result.Receipts, r => Assert.Empty(r.Documents));
    }

    // each invoice is a page of its own: a first connect asks for the newest only and says which it left
    [Fact]
    public async Task The_invoice_ceiling_leaves_the_oldest_without_one_and_says_so()
    {
        var ctx = new FakeJobContext();
        var adapter = new MediaMarktAdapter(Options with { MaxDocumentOrdersPerFetch = 1 });
        var portal = new ScriptedPortal(PageOf(3));

        await adapter.FetchAsync(ctx, Requests.Receipts(invoice: true), portal, CancellationToken.None);

        Assert.Single(portal.InvoicesAsked);
        Assert.Contains(ctx.Notes, note => note.Contains("invoice ceiling", StringComparison.Ordinal));
    }

    // the payload carries no total count anywhere (checked across every captured response): a short page is the only end
    [Fact]
    public async Task A_short_page_ends_the_walk()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(3));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Empty(portal.Asked);
        Assert.Equal(3, result.Receipts.Count);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task A_full_page_is_followed_by_the_next_offset()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(10), PageOf(2, startingAt: 11));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        var asked = Assert.Single(portal.Asked);
        Assert.Equal(
            """{"limit":10,"offset":10}""",
            MediaMarktCalls.Parameter(asked, "variables"));

        Assert.Equal(12, result.Receipts.Count);
        Assert.True(result.Complete);
    }

    // the hash and the channel config are MediaMarkt's and must survive a rewrite untouched;
    // the connector deliberately understands neither
    [Fact]
    public async Task Paging_changes_the_variables_and_nothing_else()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(10), PageOf(1, startingAt: 11));

        await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        var asked = Assert.Single(portal.Asked);

        Assert.Equal("GetCombinedOrdersV3", MediaMarktCalls.Parameter(asked, "operationName"));
        Assert.Equal(
            MediaMarktCalls.Parameter(FirstUrl, "extensions"),
            MediaMarktCalls.Parameter(asked, "extensions"));
        Assert.StartsWith("https://www.mediamarkt.nl/api/v1/graphql?", asked, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_walk_stops_at_the_page_limit_and_says_the_pass_is_partial()
    {
        var (ctx, adapter) = Rig();
        var adapter2 = new MediaMarktAdapter(Options with { MaxPages = 2 });
        var portal = new ScriptedPortal(PageOf(10), PageOf(10, startingAt: 11), PageOf(10, startingAt: 21));

        var result = await adapter2.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.False(result.Complete);
        Assert.Equal(20, result.Receipts.Count);
        Assert.Contains(ctx.Notes, note => note.Contains("partial", StringComparison.Ordinal));
    }

    // checked page by page, so a ten-year-old account's twenty pages are never requested
    [Fact]
    public async Task A_page_entirely_before_the_window_ends_the_walk()
    {
        var (ctx, adapter) = Rig();

        // The fixture's orders are all March 2026; asking for April onwards
        // puts every one of them behind the window.
        var request = Requests.Receipts(since: new DateOnly(2026, 4, 1));
        var portal = new ScriptedPortal(PageOf(10), PageOf(10, startingAt: 11));

        var result = await adapter.FetchAsync(ctx, request, portal, CancellationToken.None);

        Assert.Empty(portal.Asked);
        Assert.Empty(result.Receipts);
        Assert.True(result.Complete);
    }

    // a signed-out browser never fires the orders call: "nothing" must mean sign in again, not no orders
    [Fact]
    public async Task A_page_that_never_asks_for_orders_is_an_expired_session()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(1)) { Opening = null };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    // a bounced request arrives as a successful 200 carrying the login page, so the landing url is checked before the status
    [Fact]
    public async Task An_answer_from_the_sign_in_page_is_an_expired_session()
    {
        var (ctx, adapter) = Rig();

        var portal = new ScriptedPortal(PageOf(1))
        {
            Opening = new MediaMarktCall(
                200, "https://www.mediamarkt.nl/nl/myaccount/auth/login", "<!doctype html>"),
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    [Fact]
    public async Task A_cloudflare_refusal_asks_for_a_person_rather_than_reporting_a_broken_provider()
    {
        var (ctx, adapter) = Rig();

        var portal = new ScriptedPortal(PageOf(1))
        {
            Opening = new MediaMarktCall(403, FirstUrl, "<!doctype html><title>Just a moment</title>"),
        };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains("Cloudflare", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_unknown_resource_is_refused_before_a_page_is_opened()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(1));

        await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(
                ctx, Requests.Receipts() with { ResourceId = "transactions" }, portal, CancellationToken.None));

        Assert.Empty(portal.Asked);
    }

    [Fact]
    public async Task Receipts_come_back_newest_first()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Equal(
            result.Receipts.Select(r => r.PurchasedAt).OrderByDescending(x => x),
            result.Receipts.Select(r => r.PurchasedAt));
    }

    [Fact]
    public async Task Every_receipt_reconciles_against_its_own_lines()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.All(result.Receipts, receipt => Assert.True(receipt.Reconciled));
        Assert.All(result.Receipts, receipt => Assert.False(receipt.TotalIsDerived));
        Assert.DoesNotContain(ctx.Notes, note => note.Contains("do not sum", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Items_are_withheld_unless_the_caller_asked_for_them()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(
            ctx, Requests.Receipts(items: false), portal, CancellationToken.None);

        Assert.All(result.Receipts, receipt => Assert.Empty(receipt.Items));

        // the total stays MediaMarkt's own figure, not a sum of lines nobody asked for
        Assert.All(result.Receipts, receipt => Assert.False(receipt.TotalIsDerived));
    }

    [Fact]
    public async Task Raw_is_keyed_by_the_receipts_own_external_id()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(
            ctx, Requests.Receipts(raw: true), portal, CancellationToken.None);

        Assert.Equal(
            result.Receipts.Select(r => r.ExternalId).OrderBy(x => x, StringComparer.Ordinal),
            result.Raw.Keys.OrderBy(x => x, StringComparer.Ordinal));

        foreach (var (id, payload) in result.Raw)
        {
            using var document = JsonDocument.Parse(payload);
            Assert.Equal(id, document.RootElement.GetProperty("id").GetString());
        }
    }

    [Fact]
    public async Task Nothing_is_handed_back_raw_unless_it_was_asked_for()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Empty(result.Raw);
    }

    [Fact]
    public async Task The_operation_that_answered_is_named_on_the_result()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(FixtureCatalog.Read("mediamarkt/orders-page.json"));

        var result = await adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.Equal("GetCombinedOrdersV3", result.Via);
    }

    private static StubLoginPage LoginForm() => StubLoginPage.Showing(
        "#userName", "#password", "#mms-login-form__login-button", "#required",
        "[data-test='pwa-consent-layer-save-settings']");

    private const string Jar = """{"cookies":[{"name":"mms","value":"x","domain":".mediamarkt.nl"}]}""";

    private static FakeJobContext WithCredentials() => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "someone@example.invalid",
            ["password"] = "not-a-real-password",
        },
        Browser = new StubBrowserLease(null!) { StorageState = Jar },
    };

    // after submitting, do nothing: navigating over a sign-in in flight cancels it, so the browser arrived anonymous
    // and the account holder was told their credentials were refused; the form carries redirectURL and the app navigates itself
    [Fact]
    public async Task The_login_waits_after_submitting_and_never_navigates_over_it()
    {
        var ctx = WithCredentials();
        var page = LoginForm();
        var portal = new ScriptedPortal(PageOf(1));
        var adapter = new MediaMarktAdapter(Options);

        await adapter.LoginAsync(ctx, page, portal, CancellationToken.None);

        Assert.Equal(0, portal.Navigated);
        Assert.Equal(1, portal.Watched);

        // exactly one navigation, the opening one to the protected page, which makes MediaMarkt issue the redirectURL
        Assert.Equal(["https://www.mediamarkt.nl/nl/myaccount/orders"], page.Visited);
    }

    [Fact]
    public async Task The_login_types_the_credentials_and_presses_the_button()
    {
        var ctx = WithCredentials();
        var page = LoginForm();
        var adapter = new MediaMarktAdapter(Options);

        await adapter.LoginAsync(ctx, page, new ScriptedPortal(PageOf(1)), CancellationToken.None);

        Assert.Equal("someone@example.invalid", page.Filled["#userName"]);
        Assert.Equal("not-a-real-password", page.Filled["#password"]);
        Assert.Contains("#mms-login-form__login-button", page.Clicked);
    }

    // never "Alles accepteren": a connector signing in on someone's behalf must not opt them into marketing tracking
    [Fact]
    public async Task The_cookie_layer_is_answered_with_the_necessary_categories_only()
    {
        var ctx = WithCredentials();
        var page = LoginForm();
        var adapter = new MediaMarktAdapter(Options);

        await adapter.LoginAsync(ctx, page, new ScriptedPortal(PageOf(1)), CancellationToken.None);

        Assert.Contains("#required", page.Clicked);
        Assert.Contains("[data-test='pwa-consent-layer-save-settings']", page.Clicked);
        Assert.DoesNotContain(page.Clicked, click => click.Contains("accept-all", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(ctx.Notes, note => note.Contains("necessary categories only", StringComparison.Ordinal));
    }

    // the one live failure: page two, built here, answered 400 until it carried the client's headers
    // (content-type satisfies Apollo's CSRF check)
    [Fact]
    public async Task A_page_this_connector_composes_carries_the_header_the_api_refuses_it_without()
    {
        var ctx = WithCredentials();
        var portal = new ScriptedPortal(PageOf(Options.PageSize), PageOf(1));

        await new MediaMarktAdapter(Options).FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        Assert.NotEmpty(portal.Asked);

        var carried = portal.AskedWith[0];

        Assert.Equal("application/json", carried["content-type"]);

        // the whole allowlist is what identifies the caller as MediaMarkt's own front end
        Assert.Equal("NL", carried["x-mms-country"]);
        Assert.Equal("pwa-client", carried["apollographql-client-name"]);
    }

    // Google and Apple hand off to an identity provider we hold no credential for;
    // a stray click lands on a consent screen nobody can answer
    [Fact]
    public async Task The_login_never_presses_a_social_sign_in_button()
    {
        var ctx = WithCredentials();
        var page = LoginForm();
        var adapter = new MediaMarktAdapter(Options);

        await adapter.LoginAsync(ctx, page, new ScriptedPortal(PageOf(1)), CancellationToken.None);

        Assert.All(
            new MediaMarktOptions().ForbiddenSelectors,
            forbidden => Assert.DoesNotContain(forbidden, page.Clicked));
    }

    // a failure that names something: "either refused or the form has changed" costs a live sign-in to get past
    [Fact]
    public async Task A_sign_in_that_goes_nowhere_quotes_what_the_page_is_showing()
    {
        var ctx = WithCredentials();
        var page = LoginForm();
        var portal = new ScriptedPortal(PageOf(1)) { Opening = null };
        var adapter = new MediaMarktAdapter(Options);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.LoginAsync(ctx, page, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, error.Code);
        Assert.Contains("Onjuist wachtwoord", error.Message, StringComparison.Ordinal);
        Assert.Contains("myaccount/auth/login", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_login_with_no_password_is_refused_before_a_browser_is_touched()
    {
        var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal) { ["username"] = "someone@example.invalid" },
        };

        var page = LoginForm();
        var adapter = new MediaMarktAdapter(Options);

        await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.LoginAsync(ctx, page, new ScriptedPortal(PageOf(1)), CancellationToken.None));

        Assert.Empty(page.Visited);
    }

    // the header whose absence broke the first live fetch: Apollo's CSRF prevention refuses a GET with a simple
    // or absent content type; MediaMarkt's client sends application/json on every GET
    [Fact]
    public void A_page_we_ask_for_carries_the_content_type_the_client_sends()
    {
        Assert.Contains("content-type", new MediaMarktOptions().CarriedHeaders, StringComparer.OrdinalIgnoreCase);
    }

    // the session is the browser's own cookie jar (credentials: 'same-origin');
    // copying cookies into headers would move a credential into this process
    [Fact]
    public void No_carried_header_is_a_credential()
    {
        string[] forbidden = ["cookie", "authorization", "x-csrf", "x-api-key", "set-cookie"];

        Assert.All(
            new MediaMarktOptions().CarriedHeaders,
            header => Assert.DoesNotContain(
                forbidden, bad => header.Contains(bad, StringComparison.OrdinalIgnoreCase)));
    }

    // a refusal must arrive readable: the first live failure was "Page 2 answered 400 with 406 characters" nobody could read
    [Fact]
    public async Task A_refused_page_quotes_what_the_provider_said()
    {
        var (ctx, adapter) = Rig();

        var portal = new ScriptedPortal(PageOf(10))
        {
            LaterIsScripted = false,
            Later = new MediaMarktCall(
                400, FirstUrl, """{"errors":[{"message":"This operation has been blocked as a potential CSRF attack."}]}"""),
        };

        await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None));

        Assert.Contains(
            ctx.Notes,
            note => note.Contains("CSRF", StringComparison.Ordinal) && note.Contains("refused with", StringComparison.Ordinal));
    }

    [Fact]
    public void An_offset_is_written_into_the_variables_the_client_sent()
    {
        var next = MediaMarktCalls.AtOffset(FirstUrl, 10, 30, Options);

        Assert.Equal("""{"limit":10,"offset":30}""", MediaMarktCalls.Parameter(next, "variables"));
        Assert.Equal("GetCombinedOrdersV3", MediaMarktCalls.Parameter(next, "operationName"));
    }

    [Fact]
    public void A_response_is_only_the_operation_when_the_name_matches_exactly()
    {
        Assert.True(MediaMarktCalls.IsOperation(FirstUrl, "GetCombinedOrdersV3", Options));

        // the single-order call GetCombinedOrderV3 is one character away and has a different root field:
        // loose matching would hand the walk the wrong payload
        var single = FirstUrl.Replace(
            "operationName=GetCombinedOrdersV3", "operationName=GetCombinedOrderV3", StringComparison.Ordinal);

        Assert.False(MediaMarktCalls.IsOperation(single, "GetCombinedOrdersV3", Options));

        var user = FirstUrl.Replace(
            "operationName=GetCombinedOrdersV3", "operationName=GetUser", StringComparison.Ordinal);

        Assert.False(MediaMarktCalls.IsOperation(user, "GetCombinedOrdersV3", Options));
    }

    [Fact]
    public void A_url_that_is_not_the_graphql_endpoint_is_never_the_operation()
    {
        Assert.False(MediaMarktCalls.IsOperation(
            "https://www.mediamarkt.nl/nl/myaccount/orders?operationName=GetCombinedOrdersV3",
            "GetCombinedOrdersV3",
            Options));
    }
}
