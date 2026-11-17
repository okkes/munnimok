using System.Text.Json;
using BankConnector.Adapters.Ing;
using BankConnector.Adapters.Parsing;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

public sealed class IngAdapterTests
{
    private const string Iban = "NL01INGB0002345678";
    private const string Username = "input[name='username']";
    private const string Password = "input[name='password']";
    private const string Submit = "#submitButton";
    /// the phone layout's control, a list item not a button: ING ships both layouts and hides the desktop one with CSS
    private const string ToPasswordForm = "li.list__item:has-text('gebruikersnaam'):visible";
    private const string LogoutButton = "ing-button:has-text('Uitloggen')";

    /// shaped like ING's real agreement id (mixed case, digits, encrypted per session): endpoint redaction runs on it
    private const string FirstUrl =
        "https://api.mijn.ing.nl/v1/agreements/aYDrNOy1xKmQ/transactions?productType=NL_CURRENT&currency=EUR";

    private static readonly DateTimeOffset Now = new(2026, 9, 1, 10, 0, 0, TimeSpan.Zero);

    private static readonly IngOptions Options = new() { PageGapMs = 0 };

    private static IngAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    /// answers 206 on purpose: ING serves its transactions endpoint as Partial Content on a full page, so 2xx is not "200 only"
    private sealed class ScriptedPortal : IIngPortal
    {
        public List<string> Asked { get; } = [];

        public List<string> Visited { get; } = [];

        public int Watched { get; private set; }

        /// keyed by path marker: account lists arrive by being watched, as the transactions do, since ING refuses a composed request
        public Dictionary<string, IReadOnlyList<IngCall>> Observed { get; init; } =
            new(StringComparer.Ordinal)
            {
                ["/transactions"] =
                [
                    new IngCall(
                        206,
                        FirstUrl,
                        BankFixtures.Read(BankFixtures.IngTransactionsDutch),
                        // ING's own headers on that call: the cursor page must repeat them, not inherit the last API call's
                        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                        {
                            ["accept"] = "application/json",
                            ["authorization"] = "Bearer not-a-real-token",
                        }),
                ],
                ["/global/agreements"] =
                [
                    new IngCall(
                        200,
                        "/global/agreements",
                        BankFixtures.Read(BankFixtures.IngAgreements),
                        // ING's own headers on that call: the card's details continue it and must carry them
                        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                        {
                            ["accept"] = "application/json",
                            ["x-request-id"] = "not-a-real-request-id",
                        }),
                ],
                ["/accounts/current"] =
                    [new IngCall(200, "/accounts/current", BankFixtures.Read(BankFixtures.IngCurrentAccounts))],
                ["/savings/accounts/products"] =
                    [new IngCall(200, "/savings/accounts/products", BankFixtures.Read(BankFixtures.IngSavingsAccounts))],
                ["/credit-cards/cards"] =
                    [new IngCall(200, "/credit-cards/cards", BankFixtures.Read(BankFixtures.IngCreditCards))],
            };

        public Dictionary<string, IngCall> Answers { get; init; } = new(StringComparer.Ordinal);

        public string? CardDetails { get; init; }

        public string? OwnFeed { get; init; }

        public bool ApiSeen { get; init; } = true;

        public Task<IReadOnlyList<IngCall>> ObserveAsync(
            string url, string pathMarker, int timeoutMs, CancellationToken ct)
        {
            Visited.Add(url);
            return Task.FromResult(Seen(pathMarker));
        }

        public Task<IReadOnlyList<IngCall>> WatchAsync(string pathMarker, int timeoutMs, CancellationToken ct)
        {
            Watched++;
            WatchedWith.Add(timeoutMs);
            return Task.FromResult(Seen(pathMarker));
        }

        public List<int> WatchedWith { get; } = [];

        public IReadOnlyList<IngCall> Seen(string pathMarker) =>
            Observed.TryGetValue(pathMarker, out var calls) ? calls : [];

        public Task<bool> AwaitApiAsync(int timeoutMs, CancellationToken ct) => Task.FromResult(ApiSeen);

        public IReadOnlyList<string> Endpoints() =>
            [.. Observed.SelectMany(entry => entry.Value)
                .Select(call => PageIngPortal.Endpoint(call.Url))
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)];

        public List<IReadOnlyList<string>> AskedWith { get; } = [];

        public Task<IngCall> ReadAsync(
            string path, IReadOnlyDictionary<string, string>? headers, CancellationToken ct)
        {
            Asked.Add(path);
            AskedWith.Add([.. (headers?.Keys ?? []).Order(StringComparer.Ordinal)]);

            foreach (var (prefix, answer) in Answers)
            {
                if (path.StartsWith(prefix, StringComparison.Ordinal)) return Task.FromResult(answer);
            }

            // every url asked for is one ING stated (cursor link, agreement self link); a composed request got 401
            if (!path.StartsWith("/v1/agreements/", StringComparison.Ordinal)
                && !path.StartsWith("/nl/agreements/", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"the adapter composed a request for '{path}'; only links ING itself stated may be asked for");
            }

            // not a capture: the contract the details reader offers; if the live shape differs the adapter reports its structure
            if (path.EndsWith("/carddetails", StringComparison.Ordinal))
            {
                return Task.FromResult(new IngCall(
                    200, path, CardDetails ?? """{"balance":{"currency":"EUR","value":"-1051.48"}}"""));
            }

            // a cursor page and an account's own feed share an endpoint but differ: a stub answering both alike hides a mix-up
            var feed = OwnFeed ?? BankFixtures.Read(BankFixtures.IngTransactionsPageTwo);

            return Task.FromResult(new IngCall(
                200,
                path,
                path.Contains("cursor=", StringComparison.Ordinal)
                    ? BankFixtures.Read(BankFixtures.IngTransactionsPageTwo)
                    : feed));
        }

        public Task<string> DescribeAsync(CancellationToken ct) =>
            Task.FromResult("at https://mijn.ing.nl/login/; showing 'Log in bij Mijn ING'");
    }

    private static ScriptedPortal SignedOut() =>
        new() { Observed = new Dictionary<string, IReadOnlyList<IngCall>>(StringComparer.Ordinal) };

    private const string Agreements = "/global/agreements";

    /// dropping Agreements is how a test reaches the statement-screen route, which only runs without the agreement list
    private static ScriptedPortal Without(params string[] pathMarkers)
    {
        var observed = new Dictionary<string, IReadOnlyList<IngCall>>(
            new ScriptedPortal().Observed, StringComparer.Ordinal);

        foreach (var marker in pathMarkers) observed.Remove(marker);

        return new ScriptedPortal { Observed = observed };
    }

    /// the refusal is injected into what ING's client received, the only way the adapter learns the account lists now
    private static ScriptedPortal Refusing(string pathMarker, IngCall answer, params string[] without)
    {
        var observed = new Dictionary<string, IReadOnlyList<IngCall>>(
            Without(without).Observed, StringComparer.Ordinal)
        {
            [pathMarker] = [answer],
        };

        return new ScriptedPortal { Observed = observed };
    }

    private static FakeJobContext Signing(StubLoginPage page) => new()
    {
        Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "voorbeeld",
            ["password"] = "not-a-real-password",
        },
        Browser = new StubBrowserLease(),
        Answer = challenge => string.Empty,
    };

    /// the portal latches calls in a ConcurrentDictionary with no order: the newest wins, "the first" was an arbitrary pick
    /// that decided which account list was read and whose headers the cursor walk repeated, with no visible failure
    [Fact]
    public void The_latch_hands_back_the_newest_call_for_an_endpoint_first()
    {
        var older = new IngCall(200, FirstUrl, "{\"first\":true}", null, Seq: 1);
        var newer = new IngCall(200, FirstUrl + "&page=2", "{\"second\":true}", null, Seq: 2);

        // the portal's own ordering, handed in back-to-front so a version that returns what it was given fails
        var ordered = PageIngPortal.Freshest([older, newer]);

        Assert.Equal(newer.Url, ordered[0].Url);
        Assert.Equal(older.Url, ordered[1].Url);
    }

    /// the fixture offers the forbidden controls (credential recovery, "App openen"): without them no decline is shown
    /// the stub matches selectors by string, so a broadened live selector hitting two elements is not caught here
    [Fact]
    public async Task The_login_never_presses_a_control_ing_forbids()
    {
        var forbidden = Options.ForbiddenSelectors;

        Assert.NotEmpty(forbidden);

        // without the password box, so the step that presses the switch runs: the app sign-in screen has no password form until then
        var page = StubLoginPage.Showing([Username, Submit, ToPasswordForm, .. forbidden]);

        page.WhenClicked = (showing, clicked) =>
        {
            if (clicked == ToPasswordForm) showing.Reveal(Password);
        };

        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.Contains(ToPasswordForm, page.Clicked);
        Assert.Contains(Submit, page.Clicked);

        Assert.All(forbidden, selector => Assert.DoesNotContain(selector, page.Clicked));
    }

    /// a control that is there but cannot be pressed is not a missing one: Playwright reports both as false, the repairs differ
    [Fact]
    public async Task A_sign_in_button_that_cannot_be_pressed_is_not_reported_as_missing()
    {
        var page = StubLoginPage.Showing(Username, Password);
        page.Unclickable(Submit);

        using var ctx = Signing(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);

        Assert.Contains("IS on the sign-in form", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("could not find", error.Message, StringComparison.Ordinal);

        // names the selector that matched: the repair is to narrow it
        Assert.Contains(Submit, error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_sign_in_button_that_is_not_there_at_all_still_reads_as_missing()
    {
        var page = StubLoginPage.Showing(Username, Password);
        using var ctx = Signing(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None));

        Assert.Contains("could not find the sign-in button", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_sign_in_fills_the_form_declares_the_credential_and_waits_for_the_app()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);
        var portal = new ScriptedPortal();

        var result = await Adapter().LoginAsync(ctx, page, portal, CancellationToken.None);

        Assert.Equal("voorbeeld", page.Filled[Username]);
        Assert.Equal("not-a-real-password", page.Filled[Password]);
        Assert.Contains(Submit, page.Clicked);

        // said before the waiting starts: what makes a retry dangerous is that the form went in
        Assert.True(ctx.CredentialWasSubmitted);

        // the password leaves the DOM before the challenge, when a screenshot is taken
        Assert.False(page.HoldsSecret);
        Assert.Equal(["goto", "fill", "fill", "click", "clear-secrets"], page.Calls);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.AppApproval, challenge.Type);
        Assert.True(challenge.IsPassive);
        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);

        Assert.Equal(Now.AddSeconds(900), result.ExpiresAt);
        Assert.Equal("""{"cookies":[],"origins":[]}""", result.Material.StorageState);
    }

    /// nobody presses anything: ING fetching transactions by itself witnesses the approval; the challenge only tells the human
    [Fact]
    public async Task A_sign_in_finishes_without_anybody_answering_the_card()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = "voorbeeld",
                ["password"] = "not-a-real-password",
            },
            Browser = new StubBrowserLease(),
            AnswersNever = true,
        };

        var result = await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.NotNull(result.Material.StorageState);
        Assert.Single(ctx.Asked);

        // cancelled, not dropped: the platform releases the job's budget park on this unwind
        // awaited, since the cancelled wait resumes on the thread pool and reading the counter straight away races it
        Assert.True(await ctx.AbandonedAsync(), "the challenge was never cancelled by its asker");
        Assert.Equal(1, ctx.ChallengesAbandoned);
    }

    /// the card outlives the whole login: an expired challenge fails the job and discards a finished login, unretried
    /// asserted as the exact value, since the margin would rot
    [Fact]
    public async Task The_card_outlives_the_rest_of_the_login_and_not_only_the_wait()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        var challenge = Assert.Single(ctx.Asked);

        Assert.Equal(Now.AddMilliseconds(Options.ChallengeTtlMs), challenge.ExpiresAt);
        Assert.True(
            Options.ChallengeTtlMs > Options.AppApprovalTimeoutMs,
            "the card must outlast the wait, or a finished login is swept away while it finishes");
    }

    /// the wait gets the human's budget, not the network's: 45 s reports a correct password as refused
    [Fact]
    public async Task The_wait_for_the_approval_is_given_the_time_a_person_needs()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);
        var portal = new ScriptedPortal();

        await Adapter().LoginAsync(ctx, page, portal, CancellationToken.None);

        Assert.Equal([Options.AppApprovalTimeoutMs], portal.WatchedWith);
        Assert.True(Options.AppApprovalTimeoutMs > Options.ApiCallTimeoutMs);
    }

    /// watch first, navigate second: navigating over an in-flight sign-in cancels it, reported as a refused password
    [Fact]
    public async Task A_finished_sign_in_is_never_navigated_on_top_of()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);
        var portal = new ScriptedPortal();

        await Adapter().LoginAsync(ctx, page, portal, CancellationToken.None);

        Assert.Equal(1, portal.Watched);
        Assert.DoesNotContain(Options.OverviewUrl, portal.Visited);
    }

    /// both wordings confirmed 2026-08-13 on ING's live sign-in page; the language is not ours to choose
    [Theory]
    [InlineData("li.list__item:has-text('gebruikersnaam'):visible")]
    [InlineData("li.list__item:has-text('username'):visible")]
    public async Task The_password_form_is_opened_in_either_language(string switchSelector)
    {
        var page = StubLoginPage.Showing(switchSelector, Submit);
        page.WhenClicked = (p, selector) =>
        {
            if (selector == switchSelector) p.Reveal(Username, Password);
        };

        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.Contains(switchSelector, page.Clicked);
        Assert.Equal("voorbeeld", page.Filled[Username]);
    }

    /// the phone layout's list item goes before the desktop ing-button: the hidden desktop control never becomes visible
    [Fact]
    public void The_invisible_desktop_control_is_never_the_first_thing_tried()
    {
        var candidates = Options.PasswordFormSelectors;

        var lastListItem = candidates.Select((s, i) => (s, i))
            .Where(c => c.s.StartsWith("li.", StringComparison.Ordinal))
            .Max(c => c.i);

        var firstButton = candidates.Select((s, i) => (s, i))
            .Where(c => c.s.StartsWith("ing-button", StringComparison.Ordinal))
            .Min(c => c.i);

        Assert.True(
            lastListItem < firstButton,
            "every li.list__item candidate must be tried before any ing-button one");

        // the first is visibility-qualified: the text matches once per layout
        Assert.EndsWith(":visible", candidates[0], StringComparison.Ordinal);
    }

    /// not clicked when the form is already there: only the Dutch wording was captured, the English selector is inferred
    [Fact]
    public async Task The_password_form_is_not_reopened_when_it_is_already_showing()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit, ToPasswordForm);
        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.DoesNotContain(ToPasswordForm, page.Clicked);
    }

    [Fact]
    public async Task A_sign_in_that_never_reached_the_overview_quotes_the_page_and_seals_nothing()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        var lease = new StubBrowserLease();

        using var ctx = new FakeJobContext
        {
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = "voorbeeld",
                ["password"] = "not-a-real-password",
            },
            Browser = lease,
            Answer = challenge => string.Empty,
        };

        var portal = SignedOut();

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
        Assert.Contains("Log in bij Mijn ING", refused.Message, StringComparison.Ordinal);

        Assert.Equal(1, portal.Watched);
        Assert.Equal([Options.OverviewUrl], portal.Visited);

        // nothing sealed: a jar of anonymous cookies read early passes a signed-out session for a real one
        Assert.Equal(0, lease.StorageReads);
    }

    [Fact]
    public async Task A_missing_username_box_names_the_selectors_it_tried()
    {
        var page = StubLoginPage.Showing(Submit);
        using var ctx = Signing(page);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains(Username, refused.Message, StringComparison.Ordinal);
        Assert.False(ctx.CredentialWasSubmitted);
    }

    [Theory]
    [InlineData("username")]
    [InlineData("password")]
    public async Task A_blank_credential_is_refused_before_a_browser_is_leased(string missing)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["username"] = "voorbeeld",
            ["password"] = "not-a-real-password",
        };

        inputs.Remove(missing);

        // NoBrowserLease throws on any use, so reaching a browser at all fails
        // this test rather than merely slowing it down.
        using var ctx = new FakeJobContext { Inputs = inputs };

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, CancellationToken.None));

        Assert.Equal(ErrorCode.InvalidCredentials, refused.Code);
    }

    /// four types from one call, including the loan the statement screen never saw (savings, cards only on a picker switch)
    [Fact]
    public async Task A_finished_login_states_every_account_the_session_reaches()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);

        var result = await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.Equal(
            [Iban, "NL02INGB0009876543", "900012345678", "700000000009"],
            result.Reachable.Select(a => a.ExternalId));

        Assert.Equal(["current", "savings", "credit_card", "loan"], result.Reachable.Select(a => a.Type));

        // not the loyalty agreement: ING Punten has a balance of points, which must not be added to euros
        Assert.DoesNotContain(result.Reachable, a => a.ExternalId == "0000001");
    }

    /// BankEmission.Verified throws on a broken chain, so this test passing is the chain check
    /// the current account alone, so this stays about the cursor
    private static ResourceRequest TransactionsFor(params string[] types) => new()
    {
        ResourceId = BankResources.Transactions,
        Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["accounts"] = types,
        },
    };

    /// two unnamed second pages break the fallback's premise (one current account): refused and reported
    /// the first is still attributed, the current account has no other route
    [Fact]
    public async Task A_second_page_that_names_no_account_is_refused_and_reported()
    {
        var anonymous = BankFixtures.Read(BankFixtures.IngTransactionsDutch)
            .Replace("productAgreementId=", "agreementRef=", StringComparison.Ordinal);

        var portal = new ScriptedPortal();

        portal.Observed["/transactions"] =
        [
            new IngCall(206, FirstUrl, anonymous),
            new IngCall(206, FirstUrl.Replace("NL_CURRENT", "NL_SAVINGS", StringComparison.Ordinal), anonymous),
        ];

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("current"), portal, CancellationToken.None);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("2 pages of transactions state no account", StringComparison.Ordinal)
                 && n.Contains("wrong account", StringComparison.Ordinal));

        // the first still goes through: there is no other route to a current account's history
        var accountId = BankRecords.AccountId(ctx.SessionId, Iban);

        Assert.NotEmpty(result.Transactions);
        Assert.All(result.Transactions, t => Assert.Equal(accountId, t.AccountId));
    }

    /// the fact the fallback rests on, ING's to change: once the current agreement states a transactions link, refusing is free
    [Fact]
    public async Task Ing_states_a_transactions_link_for_every_account_except_the_current_one()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        var listed = BankFixtures.Read(BankFixtures.IngAgreements);

        Assert.Contains("NL02INGB0009876543", listed, StringComparison.Ordinal);

        var portal = new ScriptedPortal();
        using var fetching = new FakeJobContext();

        var refused = await Assert.ThrowsAsync<ConnectorException>(async () =>
        {
            portal.Observed["/transactions"] = [];

            await Adapter().FetchAsync(fetching, TransactionsFor("current"), portal, CancellationToken.None);
        });

        Assert.Contains("could be read", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_fetch_walks_ings_own_cursor_and_emits_oldest_first()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("current"), portal, CancellationToken.None);

        Assert.Equal(6, result.Transactions.Count);
        Assert.True(result.Complete);
        Assert.Equal("v1/agreements/transactions", result.Via);

        Assert.Equal(
            [
                new DateOnly(2026, 7, 20), new DateOnly(2026, 7, 28), new DateOnly(2026, 8, 3),
                new DateOnly(2026, 8, 6), new DateOnly(2026, 8, 11), new DateOnly(2026, 8, 12),
            ],
            result.Transactions.Select(t => t.BookedAt));

        // Every row hangs off the current account, by the UUID ING repeats in
        // its own action links.
        var accountId = BankRecords.AccountId(ctx.SessionId, Iban);
        Assert.All(result.Transactions, t => Assert.Equal(accountId, t.AccountId));

        // nothing is composed: a request this connector builds got 401 on a live session ING's own javascript was using
        Assert.Equal(2, portal.Asked.Count);
        Assert.Equal("/nl/agreements/900012345678/carddetails", portal.Asked[0]);
        Assert.StartsWith("/v1/agreements/", portal.Asked[1], StringComparison.Ordinal);

        // one navigation for the whole fetch: the overview's /global/agreements names every account
        Assert.Equal([Options.OverviewUrl], portal.Visited);

        // every call carries the headers of the one it continues: ING's webserver refuses the last-sent ones
        Assert.Equal(
            [["accept", "x-request-id"], ["accept", "authorization"]],
            portal.AskedWith);
    }

    [Fact]
    public async Task A_narrow_window_stops_the_walk_before_the_next_page()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx,
            // Widened by the fourteen-day settlement lag to 2026-08-11, which
            // is later than the first page's oldest row.
            TransactionsFor("current") with { Since = new DateOnly(2026, 8, 25) },
            portal,
            CancellationToken.None);

        Assert.Equal(2, result.Transactions.Count);
        Assert.DoesNotContain(portal.Asked, path => path.StartsWith("/v1/agreements/", StringComparison.Ordinal));
    }

    /// the cap is shared between accounts: handed whole to each, one heavy account filled it and the rest emitted nothing
    /// while still listed with balances, which reads as an account nothing happened on
    [Fact]
    public async Task A_heavy_account_cannot_eat_the_whole_page()
    {
        using var ctx = new FakeJobContext();

        var adapter = new IngAdapter(Options with { RecordCap = 4 }, new FixedTimeProvider(Now));

        var result = await adapter.FetchAsync(
            ctx,
            TransactionsFor("current", "savings", "credit_card", "loan"),
            new ScriptedPortal(),
            CancellationToken.None);

        Assert.Equal(4, result.Transactions.Count);

        Assert.Equal(4, result.Transactions.Select(t => t.AccountId).Distinct(StringComparer.Ordinal).Count());

        Assert.False(result.Complete);
    }

    /// a count of derived ids counts the rows the caller gets, not the rows the reader saw (a live note said "10 of 3")
    [Fact]
    public async Task A_count_of_derived_ids_never_exceeds_the_rows_it_counts()
    {
        using var ctx = new FakeJobContext();

        const string Old = """
        {"transactions":[
          {"executionDate":"2026-08-20","amount":{"currency":"EUR","value":"-1.00"},"type":{"id":"PL_TRM"}},
          {"executionDate":"2026-01-05","amount":{"currency":"EUR","value":"-2.00"},"type":{"id":"PL_TRM"}},
          {"executionDate":"2026-01-04","amount":{"currency":"EUR","value":"-3.00"},"type":{"id":"PL_TRM"}}]}
        """;

        var result = await Adapter().FetchAsync(
            ctx,
            TransactionsFor("savings") with { Since = new DateOnly(2026, 8, 15) },
            new ScriptedPortal { OwnFeed = Old },
            CancellationToken.None);

        var note = Assert.Single(ctx.Notes, n => n.Contains("derived", StringComparison.Ordinal));

        Assert.Contains($"{result.Transactions.Count} of {result.Transactions.Count}", note, StringComparison.Ordinal);
        Assert.DoesNotContain("3 of 1", note, StringComparison.Ordinal);
    }

    /// the count is of rows the caller received, the codes come off every row the reader saw: the note must name which set
    [Fact]
    public async Task The_unclassified_codes_say_which_rows_they_came_off()
    {
        using var ctx = new FakeJobContext();

        // one of four rows falls inside the window: the count and the code list disagree by construction
        const string Feed = """
        {"transactions":[
          {"executionDate":"2026-08-20","amount":{"currency":"EUR","value":"-1.00"},"type":{"id":"SAV-rente"}},
          {"executionDate":"2026-01-05","amount":{"currency":"EUR","value":"-2.00"},"type":{"id":"SAV-opname"}},
          {"executionDate":"2026-01-04","amount":{"currency":"EUR","value":"-3.00"},"type":{"id":"SAV-inleg"}},
          {"executionDate":"2026-01-03","amount":{"currency":"EUR","value":"-4.00"},"type":{"id":"SDSCO"}}]}
        """;

        var result = await Adapter().FetchAsync(
            ctx,
            TransactionsFor("savings") with { Since = new DateOnly(2026, 8, 15) },
            new ScriptedPortal { OwnFeed = Feed },
            CancellationToken.None);

        var note = Assert.Single(ctx.Notes, n => n.Contains("could not be classified", StringComparison.Ordinal));

        Assert.Contains($"of the {result.Transactions.Count} transaction(s) you received", note, StringComparison.Ordinal);
        Assert.Contains("across EVERY row read for this account", note, StringComparison.Ordinal);

        Assert.DoesNotContain(
            "codes on the rows this connector could not classify", note, StringComparison.Ordinal);
    }

    /// a cut code list says so: a truncated list reads as complete, and it decides which ING codes need mapping
    [Fact]
    public async Task A_truncated_list_of_codes_says_how_many_it_left_out()
    {
        using var ctx = new FakeJobContext();

        var rows = string.Join(",", Enumerable.Range(0, 30).Select(i =>
            "{\"executionDate\":\"2026-08-2" + (i % 10)
            + "\",\"amount\":{\"currency\":\"EUR\",\"value\":\"-1.00\"},\"type\":{\"id\":\"ZZ" + i + "\"}}"));

        await Adapter().FetchAsync(
            ctx,
            TransactionsFor("savings"),
            new ScriptedPortal { OwnFeed = "{\"transactions\":[" + rows + "]}" },
            CancellationToken.None);

        var note = Assert.Single(ctx.Notes, n => n.Contains("could not be classified", StringComparison.Ordinal));

        Assert.Contains("and 6 more", note, StringComparison.Ordinal);
    }

    /// the alternative to a derived id is reported as a measurement, never values: a link's tail may be an id or a row position,
    /// and mistaking a position for an id re-imports the whole history on every sync
    [Fact]
    public async Task What_could_replace_a_derived_id_is_measured_without_being_quoted()
    {
        using var ctx = new FakeJobContext();

        const string Card = """
        {"transactions":[
          {"executionDate":"2026-08-20","amount":{"currency":"EUR","value":"-1.00"},"id":"",
           "_links":[{"rel":"transactiondetails","href":"/nl/card-transactions/41"}]},
          {"executionDate":"2026-08-19","amount":{"currency":"EUR","value":"-2.00"},"id":"",
           "_links":[{"rel":"transactiondetails","href":"/nl/card-transactions/42"}]}]}
        """;

        await Adapter().FetchAsync(
            ctx,
            TransactionsFor("savings") with { Since = new DateOnly(2026, 8, 1) },
            new ScriptedPortal { OwnFeed = Card },
            CancellationToken.None);

        var note = Assert.Single(ctx.Notes, n => n.Contains("transactiondetails", StringComparison.Ordinal));

        Assert.Contains(
            "offers 2 candidate id(s) for them, 2 distinct, 2 character(s) of digits, counting up one by one",
            note,
            StringComparison.Ordinal);

        Assert.All(
            ctx.Notes,
            n =>
            {
                Assert.DoesNotContain("card-transactions", n, StringComparison.Ordinal);
                Assert.DoesNotContain("41", n, StringComparison.Ordinal);
                Assert.DoesNotContain("42", n, StringComparison.Ordinal);
            });
    }

    /// one walk per account: the portal latches on request url, so one account asked twice arrives as two entries,
    /// and walking both doubles its rows, which the balance chain rejects
    [Fact]
    public async Task An_account_ing_asked_for_twice_is_walked_once()
    {
        using var ctx = new FakeJobContext();

        var twice = new ScriptedPortal();
        var doubled = new Dictionary<string, IReadOnlyList<IngCall>>(twice.Observed, StringComparer.Ordinal)
        {
            ["/transactions"] =
            [
                twice.Observed["/transactions"][0],
                twice.Observed["/transactions"][0] with { Url = FirstUrl + "&senderref=MOBIEL" },
            ],
        };

        var result = await Adapter().FetchAsync(
            ctx,
            TransactionsFor("current"),
            new ScriptedPortal { Observed = doubled },
            CancellationToken.None);

        Assert.Equal(6, result.Transactions.Count);
        Assert.Equal(6, result.Transactions.Select(t => t.Id).Distinct(StringComparer.Ordinal).Count());
    }

    /// a capped pass names where it stopped: ING serves newest first, so the oldest row read is the next until
    [Fact]
    public async Task A_pass_that_stops_at_its_cap_names_the_date_to_continue_from()
    {
        using var ctx = new FakeJobContext();

        var adapter = new IngAdapter(Options with { MaxPages = 1 }, new FixedTimeProvider(Now));

        var result = await adapter.FetchAsync(
            ctx, TransactionsFor("current"), new ScriptedPortal(), CancellationToken.None);

        Assert.False(result.Complete);
        Assert.NotEmpty(result.Transactions);

        var note = Assert.Single(ctx.Notes, n => n.Contains("stopped after", StringComparison.Ordinal));

        // the oldest row read, not the newest: asking again with the newest returns the same page forever
        var oldest = result.Transactions.Min(t => t.BookedAt);

        Assert.Contains($"until={oldest:yyyy-MM-dd}", note, StringComparison.Ordinal);
        Assert.Contains(Iban, note, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_accounts_resource_returns_every_kind_and_no_transactions()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        Assert.Equal(4, result.Accounts.Count);
        Assert.Empty(result.Transactions);

        Assert.Equal(
            [AccountType.Current, AccountType.Savings, AccountType.CreditCard, AccountType.Loan],
            result.Accounts.Select(a => a.Type));

        Assert.DoesNotContain(portal.Asked, path => path.StartsWith("/v1/agreements/", StringComparison.Ordinal));
    }

    /// the card's balance comes from its own screen (self link /carddetails): no list has it, the overview shows none either
    [Fact]
    public async Task A_cards_balance_is_read_from_the_link_ing_states_on_the_agreement()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        var card = result.Accounts[2];

        Assert.Equal(AccountType.CreditCard, card.Type);
        Assert.Equal(-105_148, card.Balance!.Amount.Value);

        // followed, not composed: this edge answers composed requests with 401
        Assert.Contains("/nl/agreements/900012345678/carddetails", portal.Asked);

        // the hash must cover the late balance: the platform republishes an account on it, and a `with` copy keeps the stale hash
        var rebuilt = BankRecords.NewAccount(ctx.SessionId, new AccountDraft
        {
            ExternalId = card.ExternalId,
            Type = card.Type,
            DisplayName = card.DisplayName,
            Currency = card.Currency,
            Iban = card.Iban,
            MaskedNumber = card.MaskedNumber,
            Balance = card.Balance,
        });

        Assert.Equal(rebuilt.ContentHash, card.ContentHash);

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("no balance", StringComparison.Ordinal));
    }

    /// the balance spelling is a guess, nobody has seen the response: failure must report structure, not a figure
    [Fact]
    public async Task A_card_screen_that_spells_its_balance_otherwise_reports_its_shape()
    {
        using var ctx = new FakeJobContext();

        var portal = new ScriptedPortal
        {
            CardDetails = """{"outstandingAmount":{"currency":"EUR","value":"-847.30"},"creditLimit":3500}""",
        };

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        // blank rather than zero, which reads as a settled card
        Assert.Null(result.Accounts[2].Balance);

        var note = Assert.Single(ctx.Notes, n => n.Contains("Its shape is", StringComparison.Ordinal));

        Assert.Contains("outstandingAmount:{currency:string(3),value:string(7)}", note, StringComparison.Ordinal);
        Assert.Contains("creditLimit:number", note, StringComparison.Ordinal);
        Assert.DoesNotContain("847.30", note, StringComparison.Ordinal);
    }

    /// a refusal on that link costs the balance only: the session is alive (the agreement list just came)
    [Fact]
    public async Task A_refused_card_screen_leaves_the_account_listed_without_its_balance()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            new ScriptedPortal { CardDetails = "<!DOCTYPE html><html>Log in</html>" },
            CancellationToken.None);

        Assert.Equal(4, result.Accounts.Count);
        Assert.Null(result.Accounts[2].Balance);
        Assert.Contains(ctx.Notes, n => n.Contains("could not be read", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_account_with_no_balance_and_no_link_names_the_endpoints_touched()
    {
        using var ctx = new FakeJobContext();

        const string Linkless = """
        {"agreements":[{"type":"CARD","accountId":"0012345"}]}
        """;

        await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            Refusing(Agreements, new IngCall(200, Agreements, Linkless)),
            CancellationToken.None);

        var note = Assert.Single(ctx.Notes, n => n.Contains("endpoints this session touched", StringComparison.Ordinal));

        Assert.Contains("credit_card", note, StringComparison.Ordinal);
        Assert.Contains("/v1/agreements/…/transactions", note, StringComparison.Ordinal);

        // nothing that says whose: the path carries a per-session encrypted agreement id, the query names the product
        Assert.DoesNotContain("aYDrNOy1xKmQ", note, StringComparison.Ordinal);
        Assert.DoesNotContain("NL_CURRENT", note, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_account_list_that_is_complete_follows_no_links_and_says_nothing()
    {
        using var ctx = new FakeJobContext();

        const string Whole = """
        {"agreements":[{"type":"CURRENT","commercialId":{"type":"IBAN","value":"NL01INGB0002345678"},
          "balance":{"currency":"EUR","value":"-1730.01"},
          "_links":[{"rel":"self","href":"/nl/agreements/x/carddetails"}]}]}
        """;

        var portal = Refusing(Agreements, new IngCall(200, Agreements, Whole));

        await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("balance", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(portal.Asked);
    }

    /// goes into an operator's log: long AND containing a digit marks an identifier; no length alone separates them
    [Theory]
    [InlineData("https://api.mijn.ing.nl/global/agreements", "/global/agreements")]
    [InlineData("https://api.mijn.ing.nl/credit-cards/cards?includeInactiveCards=false", "/credit-cards/cards")]
    [InlineData("https://api.mijn.ing.nl/v1/agreements/aYDrNOy1xKmQ/transactions", "/v1/agreements/…/transactions")]
    [InlineData("https://api.mijn.ing.nl/cards/5248123412347201/balance", "/cards/…/balance")]
    [InlineData("https://api.mijn.ing.nl/accounts/NL02INGB0000019507", "/accounts/…")]
    public void An_endpoint_keeps_its_words_and_loses_its_identifiers(string url, string expected) =>
        Assert.Equal(expected, PageIngPortal.Endpoint(url));

    /// savings and card history come from the link each agreement states: the overview fetches current accounts only
    /// only the card's link set was observed live; savings and the loan carry the same shape in the fixture
    [Fact]
    public async Task Savings_and_card_history_come_from_the_link_each_agreement_states()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("savings", "credit_card"), portal, CancellationToken.None);

        Assert.True(result.Complete);
        Assert.NotEmpty(result.Transactions);

        // both accounts, and no rows filed under the current one: a failure that reconciles perfectly and is invisible
        var savings = BankRecords.AccountId(ctx.SessionId, "NL02INGB0009876543");
        var card = BankRecords.AccountId(ctx.SessionId, "900012345678");

        Assert.Contains(result.Transactions, t => t.AccountId == savings);
        Assert.Contains(result.Transactions, t => t.AccountId == card);
        Assert.All(result.Transactions, t => Assert.Contains(t.AccountId, new[] { savings, card }));

        Assert.Contains("/v1/agreements/x2/transactions", portal.Asked);
        Assert.Contains("/v1/agreements/900012345678/transactions", portal.Asked);

        // carrying ING's own headers from the transactions call its client made: composed without them this family got 401
        var feeds = portal.Asked
            .Select((path, i) => (path, headers: portal.AskedWith[i]))
            .Where(c => c.path.EndsWith("/transactions", StringComparison.Ordinal))
            .ToList();

        Assert.Equal(2, feeds.Count);
        Assert.All(feeds, f => Assert.Equal(["accept", "authorization"], f.headers));
    }

    /// nothing readable is an error, not an empty list: an empty incomplete page reads as "you have no transactions"
    [Fact]
    public async Task An_account_with_no_transactions_link_is_named_rather_than_returned_empty()
    {
        using var ctx = new FakeJobContext();

        const string Linkless = """
        {"agreements":[{"type":"SAVINGS","commercialId":{"type":"IBAN","value":"NL02INGB0009876543"},
          "balance":{"currency":"EUR","value":"8.20"}}]}
        """;

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx,
            TransactionsFor("savings"),
            Refusing(Agreements, new IngCall(200, Agreements, Linkless)),
            CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, refused.Code);
        Assert.Contains("link for none of the accounts", refused.Message, StringComparison.Ordinal);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("no transactions link", StringComparison.Ordinal)
                 && n.Contains("savings", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_refused_own_feed_keeps_every_other_account_that_worked()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            TransactionsFor("current", "savings", "credit_card"),
            new ScriptedPortal { OwnFeed = "<!DOCTYPE html><html>Log in</html>" },
            CancellationToken.None);

        Assert.Equal(6, result.Transactions.Count);
        Assert.False(result.Complete);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("could not be read", StringComparison.Ordinal)
                 && n.Contains("with no history rather than with none found", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_skipped_reservation_is_reported_to_the_operator()
    {
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Transactions },
            new ScriptedPortal(), CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("reservation", StringComparison.OrdinalIgnoreCase));
    }

    /// a 401 is a dead session on either route and must not become a fallback: half the accounts with no error
    /// reads like a customer with only a current account, so only provider_changed is caught
    [Theory]
    [InlineData(Agreements)]
    [InlineData("/accounts/current")]
    public async Task A_401_from_ing_is_an_expired_session_rather_than_a_broken_bank(string pathMarker)
    {
        using var ctx = new FakeJobContext();

        // the statement screen is reached only without the agreement list, so the test takes that away first
        var portal = pathMarker == Agreements
            ? Refusing(pathMarker, new IngCall(401, pathMarker, "{}"))
            : Refusing(pathMarker, new IngCall(401, pathMarker, "{}"), Agreements);

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
    }

    /// a signed-out browser asked for JSON gets ING's login page with a successful status
    [Theory]
    [InlineData(Agreements)]
    [InlineData("/accounts/current")]
    public async Task A_page_of_markup_where_data_was_asked_for_is_an_expired_session(string pathMarker)
    {
        using var ctx = new FakeJobContext();
        var markup = new IngCall(200, pathMarker, "<!DOCTYPE html><html>Log in</html>");

        var portal = pathMarker == Agreements
            ? Refusing(pathMarker, markup)
            : Refusing(pathMarker, markup, Agreements);

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
    }

    /// savings and cards are best effort on the fallback route: nobody has established what ING answers without them
    [Fact]
    public async Task A_refused_savings_list_is_noted_and_the_rest_is_still_served()
    {
        using var ctx = new FakeJobContext();

        var portal = Refusing(
            "/savings/accounts/products", new IngCall(500, "/savings/accounts/products", "{}"), Agreements);

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        Assert.Equal(
            [AccountType.Current, AccountType.CreditCard], result.Accounts.Select(a => a.Type));

        Assert.Contains(ctx.Notes, note => note.Contains("savings", StringComparison.OrdinalIgnoreCase));
    }

    /// the refusal itself is quoted: a gateway that says no usually says what was missing
    [Fact]
    public async Task A_refusal_from_ing_is_quoted_into_the_operators_log()
    {
        using var ctx = new FakeJobContext();

        var portal = Refusing(
            "/accounts/current",
            new IngCall(400, "/accounts/current", """{"error":"agreement scope missing"}"""),
            Agreements);

        await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None));

        Assert.Contains(ctx.Notes, note => note.Contains("agreement scope missing", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_overview_that_calls_nothing_at_all_is_an_expired_session()
    {
        using var ctx = new FakeJobContext();

        var portal = new ScriptedPortal
        {
            Observed = new Dictionary<string, IReadOnlyList<IngCall>>(StringComparer.Ordinal),
            ApiSeen = false,
        };

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
    }

    [Fact]
    public async Task An_unknown_resource_is_refused()
    {
        using var ctx = new FakeJobContext();

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = "statements" }, new ScriptedPortal(), CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, refused.Code);
    }

    private static ScriptedPortal SignedOutUpstream() =>
        Refusing("/sessions/logout", new IngCall(200, "https://api.mijn.ing.nl/api/sessions/logout", "{}"));

    /// a disconnect opens a page on ING first: it arrives as a standalone logout job with no browser started, and the adapter
    /// used to return early on Browser.Started, reporting success having sent nothing
    [Fact]
    public async Task Disconnecting_opens_ings_page_and_presses_its_own_sign_out_button()
    {
        var page = StubLoginPage.Showing(LogoutButton);
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOutUpstream(), CancellationToken.None);

        // the navigation comes first: otherwise the selectors hunt about:blank and the miss reads as ING moving its button
        Assert.Equal(["goto", "click"], page.Calls);
        Assert.Equal([LogoutButton], page.Clicked);
        Assert.Contains(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
    }

    /// signed out is said only when ING's own sign-out call followed the click: a click alone could leave a live session open
    [Fact]
    public async Task A_press_that_ing_never_acted_on_is_not_called_a_sign_out()
    {
        var page = StubLoginPage.Showing(LogoutButton);
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOut(), CancellationToken.None);

        Assert.Equal([LogoutButton], page.Clicked);
        Assert.DoesNotContain(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, note => note.Contains("may still be alive", StringComparison.Ordinal));
    }

    /// the capture recorded POST /api/sessions/logout without host and the portal latches ING's API origin only:
    /// the goodbye page is the fallback proof
    [Fact]
    public async Task Landing_on_ings_goodbye_page_counts_as_a_sign_out()
    {
        var page = StubLoginPage.Showing(LogoutButton);
        page.WhenClicked = (p, _) => p.Url = "https://mijn.ing.nl/particulier/logoff";

        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOut(), CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_sign_out_that_cannot_be_found_says_so_instead_of_failing()
    {
        var page = StubLoginPage.Showing();
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOut(), CancellationToken.None);

        Assert.Empty(page.Clicked);
        Assert.DoesNotContain(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, note => note.Contains("left to expire", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_disconnect_with_no_session_starts_no_browser()
    {
        // NoBrowserLease throws on any use, so reaching a browser fails this
        // test rather than merely slowing it down.
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("nothing to sign out", StringComparison.Ordinal));
    }

    /// a path marker names an endpoint, not a prefix: /transactions/search and /accounts/all/transactions/reports/history
    /// sit beside /transactions and /accounts/current in ING's capture
    [Theory]
    [InlineData("https://api.mijn.ing.nl/v1/agreements/abc/transactions", "/transactions", true)]
    [InlineData("https://api.mijn.ing.nl/v1/agreements/abc/transactions?currency=EUR", "/transactions", true)]
    [InlineData("https://api.mijn.ing.nl/v1/agreements/abc/transactions/search?q=1", "/transactions", false)]
    [InlineData("https://api.mijn.ing.nl/accounts/current", "/accounts/current", true)]
    [InlineData("https://api.mijn.ing.nl/accounts/all/transactions/reports/history", "/accounts/current", false)]
    [InlineData("https://api.mijn.ing.nl/savings/accounts/products?fields=target", "/savings/accounts/products", true)]
    public void A_path_marker_matches_the_whole_endpoint_and_not_a_prefix(
        string url, string marker, bool expected)
    {
        Assert.Equal(expected, PageIngPortal.Matches(url, marker));
    }

    /// a denylist, forced by the live 401: an allowlist carries only the headers somebody thought of, six were not enough
    [Fact]
    public void A_composed_call_carries_ings_own_headers_and_drops_only_what_it_may_not_set()
    {
        var carried = PageIngPortal.Carry(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["authorization"] = "Bearer not-a-real-token",
                ["accept"] = "application/json",
                ["x-ing-something-nobody-here-has-seen"] = "value",
                ["cookie"] = "session=secret",
                ["host"] = "api.mijn.ing.nl",
                ["sec-fetch-mode"] = "cors",
                ["user-agent"] = "Mozilla/5.0",
            },
            Options);

        Assert.Equal(
            ["accept", "authorization", "x-ing-something-nobody-here-has-seen"],
            carried.Keys.Order(StringComparer.Ordinal));

        // the browser supplies these itself and a page may not override them: trying fails the call
        Assert.DoesNotContain("cookie", carried.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("sec-fetch-mode", carried.Keys, StringComparer.OrdinalIgnoreCase);
    }

    /// a refused cursor page keeps page one: the first page is observed, later ones composed and less reliable (401 seen live),
    /// and failing would send someone to re-authenticate a working session
    [Fact]
    public async Task A_refused_cursor_page_keeps_what_ing_already_served_and_says_so()
    {
        using var ctx = new FakeJobContext();

        var portal = new ScriptedPortal
        {
            Answers = { ["/v1/agreements/"] = new IngCall(401, "/v1/agreements/next", "nope") },
        };

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Transactions }, portal, CancellationToken.None);

        Assert.Equal(3, result.Transactions.Count);
        Assert.False(result.Complete);

        // the note names the headers: an invisible refusal cost the second live run
        Assert.Contains(
            ctx.Notes,
            note => note.Contains("was refused", StringComparison.Ordinal)
                    && note.Contains("authorization", StringComparison.Ordinal));
    }

    /// an account list ING never asked for is an answer, not a breakage: nobody has established ING calls the savings endpoint
    /// for a customer without savings; it is still noted, since "could not read" and "you have none" look alike
    [Fact]
    public async Task An_account_list_ing_never_asked_for_is_noted_rather_than_fatal()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            Without("/savings/accounts/products", Agreements),
            CancellationToken.None);

        Assert.Equal([AccountType.Current, AccountType.CreditCard], result.Accounts.Select(a => a.Type));
        Assert.Contains(
            ctx.Notes,
            note => note.Contains("made no call", StringComparison.Ordinal)
                    && note.Contains("savings", StringComparison.OrdinalIgnoreCase));
    }

    /// describes a live bank payload into an operator's log: keys and string lengths come out, never values
    /// a length tells an IBAN from a product code
    [Fact]
    public void A_described_payload_states_its_keys_and_never_its_contents()
    {
        const string Payload = """
        {
          "agreements": [
            {
              "iban": "NL02INGB0000019507",
              "holder": "Hr O Doker",
              "balance": {"amount": -1234.56, "currency": "EUR"},
              "productFamily": "CURRENT",
              "closed": false
            },
            {
              "iban": "NL03INGB0000019271",
              "holder": "Hr O Doker",
              "productFamily": "SAVINGS",
              "nickName": "Huisje Boompje Beestje"
            }
          ]
        }
        """;

        using var document = JsonDocument.Parse(Payload);

        var shape = IngSchema.Describe(document.RootElement);

        // includes the field only the second entry has: describing only the first hides what a reader must treat as optional
        Assert.Contains("agreements:[2 x {", shape, StringComparison.Ordinal);
        Assert.Contains("nickName:string(22)", shape, StringComparison.Ordinal);
        Assert.Contains("balance:{amount:number,currency:string(3)}", shape, StringComparison.Ordinal);
        Assert.Contains("closed:bool", shape, StringComparison.Ordinal);

        // every value a taxonomy field takes across all entries: what a length cannot say
        Assert.Contains("""productFamily:"CURRENT|SAVINGS" """.Trim(), shape, StringComparison.Ordinal);

        foreach (var secret in new[]
                 {
                     "NL02INGB0000019507", "NL03INGB0000019271", "Doker", "1234.56", "Huisje",
                 })
        {
            Assert.DoesNotContain(secret, shape, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// a taxonomy key (type) is quoted only while its value looks like a code; a name under it is measured, which keeps this
    /// safe to point at a live payload nobody has read
    [Fact]
    public void A_taxonomy_key_holding_something_that_is_not_a_code_is_still_measured()
    {
        const string Payload = """
        {
          "type": "Hr O Doker",
          "subType": "NL_ORANJE_SPRRKG",
          "value": "NL02INGB0000019507",
          "holderName": "Hr O Doker"
        }
        """;

        using var document = JsonDocument.Parse(Payload);

        var shape = IngSchema.Describe(document.RootElement);

        Assert.Contains("subType:\"NL_ORANJE_SPRRKG\"", shape, StringComparison.Ordinal);

        Assert.Contains("type:string(10)", shape, StringComparison.Ordinal);

        // Not a taxonomy key at all, whatever it holds. `value` is the IBAN
        // under commercialId and the balance under balance.
        Assert.Contains("value:string(18)", shape, StringComparison.Ordinal);
        Assert.Contains("holderName:string(10)", shape, StringComparison.Ordinal);
        Assert.DoesNotContain("Doker", shape, StringComparison.Ordinal);
        Assert.DoesNotContain("NL74INGB", shape, StringComparison.Ordinal);
    }

    [Fact]
    public void A_described_payload_is_capped_so_it_cannot_fill_a_terminal()
    {
        var wide = string.Join(",", Enumerable.Range(0, 400).Select(i => $"\"field{i}\":\"value{i}\""));

        using var document = JsonDocument.Parse("{" + wide + "}");

        var shape = IngSchema.Describe(document.RootElement, maxChars: 200);

        Assert.True(shape.Length <= 201, $"a schema of {shape.Length} characters is not a diagnostic");
        Assert.EndsWith("…", shape, StringComparison.Ordinal);
    }

    /// an unreadable agreement list falls back AND reports what ING sent, so the next reader is written from evidence
    /// the note carries keys, nesting and string lengths, never a value
    /// a 200 with unreadable entries and one with none both fall back, rather than report no accounts
    [Theory]
    [InlineData("""{"agreements":[{"iban":"NL01INGB0002345678","productFamily":"CURRENT"}]}""")]
    [InlineData("""{"agreements":[],"iban":"NL01INGB0002345678","productFamily":"CURRENT"}""")]
    public async Task An_unreadable_agreement_list_reports_its_shape_and_falls_back(string payload)
    {
        using var ctx = new FakeJobContext();

        var portal = Refusing(Agreements, new IngCall(200, Agreements, payload));

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        Assert.Equal(
            [AccountType.Current, AccountType.Savings, AccountType.CreditCard],
            result.Accounts.Select(a => a.Type));

        var note = Assert.Single(ctx.Notes, n => n.Contains(Agreements, StringComparison.Ordinal)
                                                 && n.Contains("shape of", StringComparison.Ordinal));

        Assert.Contains("agreements:[", note, StringComparison.Ordinal);
        Assert.Contains("iban:string(18)", note, StringComparison.Ordinal);

        // the taxonomy is stated, the account number is not
        Assert.Contains("""productFamily:"CURRENT" """.Trim(), note, StringComparison.Ordinal);
        Assert.DoesNotContain("NL01INGB0002345678", note, StringComparison.Ordinal);
    }

    /// a balance ING spells unreadably must not reach the note: the money parser used to quote the value into a logged sentence
    /// the whole note is checked, since the leak was in the other half
    [Fact]
    public async Task A_balance_ing_spells_oddly_never_reaches_the_note_that_reports_it()
    {
        using var ctx = new FakeJobContext();

        const string Odd = """
        {"agreements":[{"type":"CURRENT","commercialId":{"type":"IBAN","value":"NL01INGB0002345678"},
          "balance":{"currency":"EUR","value":"EUR 1.730,01"}}]}
        """;

        await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            Refusing(Agreements, new IngCall(200, Agreements, Odd)),
            CancellationToken.None);

        Assert.NotEmpty(ctx.Notes);
        Assert.All(ctx.Notes, note => Assert.DoesNotContain("1.730,01", note, StringComparison.Ordinal));
        Assert.All(ctx.Notes, note => Assert.DoesNotContain("1730", note, StringComparison.Ordinal));
    }

    /// said plainly when the call was never made: the accounts may be short, the statement screen lists savings and cards
    /// only when its picker is switched
    [Fact]
    public async Task A_session_with_no_agreement_list_says_the_accounts_may_be_short()
    {
        using var ctx = new FakeJobContext();

        var portal = Without(Agreements);

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        Assert.Equal(
            [AccountType.Current, AccountType.Savings, AccountType.CreditCard],
            result.Accounts.Select(a => a.Type));

        Assert.Contains(
            ctx.Notes,
            note => note.Contains($"made no call to {Agreements}", StringComparison.Ordinal)
                    && note.Contains("may not include every type", StringComparison.Ordinal));

        // waits for it first: the overview fires the agreement list and transactions on mount in ING's order, giving up
        // early takes the narrow route by accident
        Assert.Contains(Options.StepProbeMs, portal.WatchedWith);
    }

    /// said in the field a program reads, not only a note: complete: true and via: overview were unconditional,
    /// announcing a partial list as the whole
    [Fact]
    public async Task A_short_account_list_is_not_reported_as_complete()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            Without(Agreements),
            CancellationToken.None);

        Assert.False(
            result.Complete,
            "the accounts came off the statement screen, which reaches less than the agreement list, and "
            + "the result still claimed to be every account");

        Assert.Equal("statement-screen", result.Via);
    }

    [Fact]
    public async Task An_account_list_from_the_agreements_is_reported_as_complete()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            new ResourceRequest { ResourceId = BankResources.Accounts },
            new ScriptedPortal(),
            CancellationToken.None);

        Assert.True(result.Complete);
        Assert.Equal("v1/agreements", result.Via);
    }

    /// a history built on a short account list is short too: completeness is computed over the accounts that reached it
    /// only the current account is asked for: on the fallback, asking for all lowers complete anyway (no transactions path)
    [Fact]
    public async Task A_history_read_against_a_short_account_list_is_not_complete_either()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("current"), Without(Agreements), CancellationToken.None);

        Assert.NotEmpty(result.Transactions);
        Assert.False(
            result.Complete,
            "every account this read COULD see was read whole, so it called itself complete - while the "
            + "route that found them reaches fewer accounts than ING has");
    }

    /// the control: without it the assertion above passes on a fetch that never reports completeness
    [Fact]
    public async Task The_same_history_on_the_agreements_route_is_complete()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("current"), new ScriptedPortal(), CancellationToken.None);

        Assert.NotEmpty(result.Transactions);
        Assert.True(result.Complete);
    }

    [Fact]
    public void The_manifest_promises_what_ing_actually_does()
    {
        var manifest = Adapter().Describe();

        Assert.Equal("ing-nl", manifest.Id);
        Assert.Equal(ProviderKind.Bank, manifest.Kind);

        Assert.Equal(AuthFlow.MobileApproval, manifest.Auth.Flow);
        Assert.Equal([ChallengeType.AppApproval], manifest.Auth.Challenges);

        // ING wants a second factor on every sign-in and nothing held here can renew it: no unattended nightly sync
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.Equal(900, manifest.Auth.Session.TtlSeconds);

        // every sync is a sign-in: the person's device keeps a sealed copy of what they typed (#543), the push stays
        // theirs to approve
        Assert.True(manifest.OffersCredentialStore);
        ManifestValidator.Validate(manifest);

        // ING's fraud detection notices an account that signs in repeatedly and never signs out
        Assert.Equal(LogoutSupport.Session, manifest.Logout);

        // ephemeral rather than None: None makes the platform refuse a web session outright, a kill switch not a warning
        Assert.Equal(WebSupport.Ephemeral, manifest.WebSupport);

        // the capture ran as the agent's default phone emulation (senderref=MOBIEL in ING's cursor links)
        Assert.False(manifest.Agent.DesktopBrowser);

        var password = Assert.Single(manifest.Auth.AllFields(), f => f.Key == "password");
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");
    }
}
