using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.MediaMarkt;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// The fetch loop, without a browser.
///
/// What is worth testing here is not the parsing - <see cref="MediaMarktOrdersTests"/>
/// does that - but the walk: when it asks for another page, when it stops, and
/// what it does when MediaMarkt answers with something other than orders. All
/// three are decisions this adapter makes, and none of them should need a real
/// account to exercise.
/// </summary>
public sealed class MediaMarktAdapterTests
{
    private const string FirstUrl =
        "https://www.mediamarkt.nl/api/v1/graphql?operationName=GetCombinedOrdersV3"
        + "&variables=%7B%22limit%22%3A10%2C%22offset%22%3A0%7D"
        + "&extensions=%7B%22persistedQuery%22%3A%7B%22sha256Hash%22%3A%22abc123%22%7D%7D";

    /// <summary>
    /// The real options, except that pages follow each other immediately.
    ///
    /// The gap between pages is a courtesy to Cloudflare, not behaviour worth
    /// asserting - and paying it for real turned eighteen offline tests into a
    /// three-second run. What IS asserted about pacing lives in the manifest's
    /// MinRequestGapMs, which the platform enforces above this adapter.
    /// </summary>
    private static readonly MediaMarktOptions Options = new() { PageGapMs = 0 };

    /// <summary>
    /// A portal that answers from a script and remembers what it was asked.
    /// </summary>
    private sealed class ScriptedPortal(params string[] pages) : IMediaMarktPortal
    {
        private int _served;

        public List<string> Asked { get; } = [];

        /// <summary>
        /// MediaMarkt's own client's headers on that call, WHICH THIS FIXTURE
        /// USED TO OMIT ENTIRELY.
        /// </summary>
        /// <remarks>
        /// The adapter carries the observed call's headers onto the page it
        /// composes itself, filtered to <c>CarriedHeaders</c> - a mechanism that
        /// exists because the first live fetch died without it. With no headers
        /// on the opening call there was nothing to carry, so every test here
        /// exercised the empty case and the fix was never once run.
        /// <para>
        /// The values are representative rather than captured; what is asserted
        /// is that they SURVIVE the hop, which is what the live 400 was about.
        /// </para>
        /// </remarks>
        public static readonly IReadOnlyDictionary<string, string> ClientHeaders =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                // First and load-bearing: this is what satisfies Apollo's CSRF
                // check on a GET that carries no body.
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

        public MediaMarktCall Later { get; set; }

        public bool LaterIsScripted { get; init; } = true;

        public Task<MediaMarktCall?> ObserveAsync(
            string url, string operationName, int timeoutMs, CancellationToken ct)
        {
            Navigated++;
            _served = 1;
            return Task.FromResult(Opening);
        }

        /// <summary>How many times the portal was told to navigate.</summary>
        public int Navigated { get; private set; }

        public Task<MediaMarktCall?> WatchAsync(string operationName, int timeoutMs, CancellationToken ct)
        {
            Watched++;
            _served = 1;
            return Task.FromResult(Opening);
        }

        /// <summary>How many times it was told to wait without navigating.</summary>
        public int Watched { get; private set; }

        public Task<string> DescribeAsync(CancellationToken ct) =>
            Task.FromResult("at https://www.mediamarkt.nl/nl/myaccount/auth/login; it says 'Onjuist wachtwoord'");

        /// <summary>The headers each composed call actually carried, in order.</summary>
        /// <remarks>
        /// Thrown away by the first version of this stub, which is how the one
        /// header MediaMarkt's API refuses a request without came to be
        /// untested: <c>CarriedHeaders</c> exists BECAUSE the first live fetch
        /// died on it, and every test here passed with or without it.
        /// </remarks>
        public List<IReadOnlyDictionary<string, string>> AskedWith { get; } = [];

        /// <summary>
        /// What Apollo Server does to a GET that cannot be a simple request.
        /// </summary>
        /// <remarks>
        /// Its CSRF prevention refuses any GET whose content type is "simple"
        /// or absent unless the request carries <c>x-apollo-operation-name</c>
        /// or <c>apollo-require-preflight</c>. MediaMarkt's own client sends
        /// <c>content-type: application/json</c> on every GET - pointless on a
        /// request with no body, and precisely what satisfies that check.
        /// <para>
        /// Modelled here rather than assumed away, because this is the exact
        /// 400 that killed the first live fetch: page one, the SPA's own call,
        /// came back 200 and page two, the one this connector builds, did not.
        /// A stub that answers 200 whatever it is handed cannot fail that way.
        /// </para>
        /// </remarks>
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

    /// <summary>Builds a page of <paramref name="count"/> orders from the fixture's first one.</summary>
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

    // ---- paging ------------------------------------------------------------

    /// <summary>
    /// A page smaller than the one we asked for is the end, and the ONLY end
    /// MediaMarkt states. The payload carries no total count anywhere - checked
    /// across every captured response - so the walk either stops here or never.
    /// </summary>
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

    /// <summary>
    /// The part of the request that must survive a rewrite untouched. The hash
    /// is MediaMarkt's, the channel config is MediaMarkt's, and this connector
    /// deliberately does not understand either.
    /// </summary>
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

    /// <summary>
    /// A ten-year-old account is twenty pages a caller asked nothing about.
    /// Checked page by page rather than after the walk, so the requests are not
    /// spent in the first place.
    /// </summary>
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

    // ---- what a bad answer means -------------------------------------------

    /// <summary>
    /// The shape an expired session takes here. A signed-out browser never
    /// fires the orders call at all, so the portal sees nothing rather than a
    /// 401 - and "nothing" has to mean "sign in again", not "no orders".
    /// </summary>
    [Fact]
    public async Task A_page_that_never_asks_for_orders_is_an_expired_session()
    {
        var (ctx, adapter) = Rig();
        var portal = new ScriptedPortal(PageOf(1)) { Opening = null };

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => adapter.FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    /// <summary>
    /// The other shape, and the reason the landing url is checked before the
    /// status: a bounced request arrives as a perfectly successful 200 carrying
    /// the login page.
    /// </summary>
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

    // ---- what comes out ----------------------------------------------------

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

    /// <summary>
    /// The whole point of the four identities: a receipt built from this
    /// payload reconciles, so the flag means something when it is false.
    /// </summary>
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

        // And the total is still MediaMarkt's own figure rather than a sum of
        // lines nobody asked for.
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

    // ---- the login ---------------------------------------------------------

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

    /// <summary>
    /// THE REGRESSION THE FIRST LIVE RUN FOUND, and the reason this test exists
    /// rather than a comment.
    ///
    /// The login used to submit the form and then navigate to the orders page
    /// to check whether it had worked. A navigation on top of a sign-in still in
    /// flight cancels it - so the browser arrived anonymous, was bounced back to
    /// the form, never asked for orders, and the adapter told the account holder
    /// their credentials were refused. They were not.
    ///
    /// After pressing the button the right thing to do is nothing: the form
    /// carries redirectURL and MediaMarkt's own app navigates itself.
    /// </summary>
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

        // Exactly one navigation in the whole login, and it is the opening one
        // to the protected page - which is what makes MediaMarkt issue the
        // redirectURL the app later follows.
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

    /// <summary>
    /// The narrow answer, never "Alles accepteren". A connector signing in on
    /// somebody's behalf has no business opting them into marketing tracking.
    /// </summary>
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

    /// <summary>
    /// THE PAGE THIS CONNECTOR COMPOSES CARRIES THE CLIENT'S OWN HEADERS.
    /// </summary>
    /// <remarks>
    /// The one live failure this adapter has had: page one - MediaMarkt's own
    /// call - came back 200, and page two, the one built here, answered 400.
    /// Apollo Server's CSRF prevention refuses a GET whose content type is
    /// simple or absent, and MediaMarkt's client sends
    /// <c>content-type: application/json</c> on every GET, which is exactly
    /// what satisfies it.
    /// <para>
    /// <c>CarriedHeaders</c> was written to fix that and then went untested for
    /// the plainest possible reason: the fixture's observed call had no headers
    /// on it, so there was never anything to carry, and the stub answered 200
    /// whatever it was handed. Both halves are fixed here - the fixture states
    /// the client's headers, and it now refuses a call that arrives without one
    /// the way the real server did.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_page_this_connector_composes_carries_the_header_the_api_refuses_it_without()
    {
        var ctx = WithCredentials();
        var portal = new ScriptedPortal(PageOf(Options.PageSize), PageOf(1));

        await new MediaMarktAdapter(Options).FetchAsync(ctx, Requests.Receipts(), portal, CancellationToken.None);

        // It really did compose a second page, or there is nothing to assert.
        Assert.NotEmpty(portal.Asked);

        var carried = portal.AskedWith[0];

        Assert.Equal("application/json", carried["content-type"]);

        // And the rest of the allowlist came with it, because what identifies
        // the caller as MediaMarkt's own front end is the whole set.
        Assert.Equal("NL", carried["x-mms-country"]);
        Assert.Equal("pwa-client", carried["apollographql-client-name"]);
    }

    /// <summary>
    /// Google and Apple sit beside the password form, and both hand off to an
    /// identity provider this connector holds no credential for. A stray click
    /// lands the browser on a consent screen nobody can answer - the same guard
    /// Amazon's passkey nudge needed.
    /// </summary>
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

    /// <summary>
    /// A failure that names something. The first version of this message said
    /// "either the credentials were refused or the form has changed", which is
    /// the sort of sentence that costs a live sign-in to get past.
    /// </summary>
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

    // ---- what a page we build ourselves has to carry -----------------------

    /// <summary>
    /// The header whose absence broke the first live fetch.
    ///
    /// Page one is MediaMarkt's own call and answered 200; page two is the one
    /// this connector builds, and answered 400. Apollo Server's CSRF prevention
    /// refuses a GET whose content type is simple or absent unless it carries
    /// one of two Apollo-specific headers - and MediaMarkt's client sends
    /// `content-type: application/json` on every GET, which looks pointless on
    /// a request with no body and is exactly what satisfies that check.
    /// </summary>
    [Fact]
    public void A_page_we_ask_for_carries_the_content_type_the_client_sends()
    {
        Assert.Contains("content-type", new MediaMarktOptions().CarriedHeaders, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// And still carries nothing that could sign anybody in. The session is the
    /// browser's own cookie jar, spent by `credentials: 'same-origin'`; a
    /// connector that started copying cookies into headers would have moved a
    /// credential into this process for no reason at all.
    /// </summary>
    [Fact]
    public void No_carried_header_is_a_credential()
    {
        string[] forbidden = ["cookie", "authorization", "x-csrf", "x-api-key", "set-cookie"];

        Assert.All(
            new MediaMarktOptions().CarriedHeaders,
            header => Assert.DoesNotContain(
                forbidden, bad => header.Contains(bad, StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// A refusal has to arrive readable. "Page 2 answered 400 with 406
    /// characters" was this adapter's first live fetch failure - 406 characters
    /// that named the problem exactly and that nobody could read.
    /// </summary>
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

    // ---- url rewriting -----------------------------------------------------

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

        // The single-order call, whose name is a PREFIX of nothing but whose
        // shape is one character away. Matching loosely here would hand the
        // walk a payload with a different root field.
        var single = FirstUrl.Replace(
            "operationName=GetCombinedOrdersV3", "operationName=GetCombinedOrderV3", StringComparison.Ordinal);

        Assert.False(MediaMarktCalls.IsOperation(single, "GetCombinedOrdersV3", Options));

        // And a call to something else entirely on the same endpoint.
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
