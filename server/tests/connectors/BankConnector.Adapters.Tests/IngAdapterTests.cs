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

/// <summary>
/// ING's login and its page walk, without a browser and without a bank.
///
/// What is worth testing here is not the parsing - <see cref="IngReaderTests"/>
/// does that - but the decisions: when the adapter navigates and when it must
/// not, what it does while a human is reaching for their phone, when it asks
/// for another page, and what it says when ING answers with something other
/// than transactions. None of those should need somebody's real account to
/// exercise.
/// </summary>
public sealed class IngAdapterTests
{
    private const string Iban = "NL01INGB0002345678";
    private const string Username = "input[name='username']";
    private const string Password = "input[name='password']";
    private const string Submit = "#submitButton";
    /// <summary>
    /// The phone layout's own control. A LIST ITEM, not a button: ING ships
    /// both layouts in one document and hides the desktop one with CSS, so an
    /// <c>ing-button</c> selector matches an element that can never be seen.
    /// That is what the first live sign-in ran into.
    /// </summary>
    private const string ToPasswordForm = "li.list__item:has-text('gebruikersnaam'):visible";
    private const string LogoutButton = "ing-button:has-text('Uitloggen')";

    /// <summary>
    /// The agreement id is shaped like ING's real one - mixed case and digits,
    /// encrypted per session - rather than like a readable placeholder, because
    /// this url is also what the endpoint redaction is exercised against.
    /// </summary>
    private const string FirstUrl =
        "https://api.mijn.ing.nl/v1/agreements/aYDrNOy1xKmQ/transactions?productType=NL_CURRENT&currency=EUR";

    /// <summary>
    /// A clock late enough that the fixture's transactions are comfortably
    /// inside the default ninety-day window.
    /// </summary>
    private static readonly DateTimeOffset Now = new(2026, 9, 1, 10, 0, 0, TimeSpan.Zero);

    /// <summary>
    /// The real options, except that pages follow each other immediately. The
    /// gap between pages is a courtesy to ING, not behaviour worth asserting -
    /// what IS asserted about pacing lives in the manifest's MinRequestGapMs,
    /// which the platform enforces above this adapter.
    /// </summary>
    private static readonly IngOptions Options = new() { PageGapMs = 0 };

    private static IngAdapter Adapter() => new(Options, new FixedTimeProvider(Now));

    /// <summary>
    /// A portal that answers from the fixtures and remembers what it was asked.
    /// </summary>
    /// <remarks>
    /// The opening call answers <b>206</b> on purpose. ING serves its
    /// transactions endpoint with <c>Partial Content</c> on an ordinary full
    /// page - both captured pages came back that way - so anything treating 2xx
    /// as "200 only" would reject every page of data this adapter exists to
    /// read.
    /// </remarks>
    private sealed class ScriptedPortal : IIngPortal
    {
        /// <summary>Every url the adapter composed for itself, in order.</summary>
        public List<string> Asked { get; } = [];

        /// <summary>Every page the adapter navigated to, in order.</summary>
        public List<string> Visited { get; } = [];

        public int Watched { get; private set; }

        /// <summary>
        /// What ING's own client is holding, keyed by the path marker the
        /// adapter waits on. This is the whole shape of the fixed design: the
        /// account lists arrive by being WATCHED, exactly as the transactions
        /// do, because ING refuses a request this connector composes.
        /// </summary>
        public Dictionary<string, IReadOnlyList<IngCall>> Observed { get; init; } =
            new(StringComparer.Ordinal)
            {
                // 206 on purpose: ING serves its transactions endpoint with
                // Partial Content on an ordinary full page, so anything
                // treating 2xx as "200 only" rejects every page of real data.
                ["/transactions"] =
                [
                    new IngCall(
                        206,
                        FirstUrl,
                        BankFixtures.Read(BankFixtures.IngTransactionsDutch),
                        // ING's own headers on THAT call, which the cursor page
                        // must repeat rather than inheriting from whichever API
                        // call answered last.
                        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                        {
                            ["accept"] = "application/json",
                            ["authorization"] = "Bearer not-a-real-token",
                        }),
                ],
                // The overview's own account list, which the SAME navigation
                // produces as the transactions above. It is why this adapter no
                // longer has to visit a second screen at all on the happy path.
                ["/global/agreements"] =
                [
                    new IngCall(
                        200,
                        "/global/agreements",
                        BankFixtures.Read(BankFixtures.IngAgreements),
                        // ING's own headers on THAT call. The card's details are
                        // a continuation of it and must go out carrying them,
                        // for the same reason a cursor page must.
                        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                        {
                            ["accept"] = "application/json",
                            ["x-request-id"] = "not-a-real-request-id",
                        }),
                ],
                // The fallback route's three, still answered here so that a
                // portal built without the agreement list exercises it.
                ["/accounts/current"] =
                    [new IngCall(200, "/accounts/current", BankFixtures.Read(BankFixtures.IngCurrentAccounts))],
                ["/savings/accounts/products"] =
                    [new IngCall(200, "/savings/accounts/products", BankFixtures.Read(BankFixtures.IngSavingsAccounts))],
                ["/credit-cards/cards"] =
                    [new IngCall(200, "/credit-cards/cards", BankFixtures.Read(BankFixtures.IngCreditCards))],
            };

        /// <summary>Overrides for urls the adapter composes, by prefix.</summary>
        public Dictionary<string, IngCall> Answers { get; init; } = new(StringComparer.Ordinal);

        /// <summary>What the card's own screen answers, when a test cares.</summary>
        public string? CardDetails { get; init; }

        /// <summary>
        /// What an account's OWN transactions feed answers - the link every
        /// agreement states, for the accounts ING's overview fetches nothing
        /// for.
        /// </summary>
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

        /// <summary>The budget each wait was given, in order.</summary>
        public List<int> WatchedWith { get; } = [];

        public IReadOnlyList<IngCall> Seen(string pathMarker) =>
            Observed.TryGetValue(pathMarker, out var calls) ? calls : [];

        public Task<bool> AwaitApiAsync(int timeoutMs, CancellationToken ct) => Task.FromResult(ApiSeen);

        public IReadOnlyList<string> Endpoints() =>
            [.. Observed.SelectMany(entry => entry.Value)
                .Select(call => PageIngPortal.Endpoint(call.Url))
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)];

        /// <summary>The headers each composed call actually carried.</summary>
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

            // EVERY url this adapter asks for is one ING stated: a cursor link
            // on a page of transactions, or the self link on an agreement.
            // Anything else reaching here is a regression towards the request
            // shape ING answered 401 to.
            if (!path.StartsWith("/v1/agreements/", StringComparison.Ordinal)
                && !path.StartsWith("/nl/agreements/", StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"the adapter composed a request for '{path}'; only links ING itself stated may be asked for");
            }

            // The card's own screen. THIS SHAPE IS NOT A CAPTURE - it is the
            // contract the details reader offers, spelled the way every other
            // ING payload spells a balance. If the live one differs, the adapter
            // reports its structure instead, which is the behaviour below it.
            if (path.EndsWith("/carddetails", StringComparison.Ordinal))
            {
                return Task.FromResult(new IngCall(
                    200, path, CardDetails ?? """{"balance":{"currency":"EUR","value":"-1051.48"}}"""));
            }

            // A CURSOR PAGE AND AN ACCOUNT'S OWN FEED ARE DIFFERENT REQUESTS
            // that share an endpoint. The first continues a page ING already
            // served; the second is the first page for an account the overview
            // fetched nothing for. A stub that answered both the same way would
            // let the adapter confuse them without a test noticing.
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

    /// <summary>
    /// A browser nobody is signed in to: ING's own client asks for nothing at
    /// all, which is exactly what its app does for an anonymous visitor.
    /// </summary>
    private static ScriptedPortal SignedOut() =>
        new() { Observed = new Dictionary<string, IReadOnlyList<IngCall>>(StringComparer.Ordinal) };

    /// <summary>The one call that names every account somebody has.</summary>
    private const string Agreements = "/global/agreements";

    /// <summary>
    /// The default portal, minus endpoints ING's own client never asked for.
    /// </summary>
    /// <remarks>
    /// DROPPING <see cref="Agreements"/> IS HOW A TEST REACHES THE STATEMENT
    /// SCREEN AT ALL. The agreement list is what every ordinary run lists
    /// accounts from now, and the endpoint-per-type route below it only runs
    /// when there is none - so a test about that route has to say so.
    /// </remarks>
    private static ScriptedPortal Without(params string[] pathMarkers)
    {
        var observed = new Dictionary<string, IReadOnlyList<IngCall>>(
            new ScriptedPortal().Observed, StringComparer.Ordinal);

        foreach (var marker in pathMarkers) observed.Remove(marker);

        return new ScriptedPortal { Observed = observed };
    }

    /// <summary>
    /// The same portal, except that ING answered one endpoint badly.
    /// </summary>
    /// <remarks>
    /// The refusal is injected into what ING's own client RECEIVED, because
    /// that is now the only way this adapter learns about the account lists. It
    /// used to be injected into a request the adapter composed - and composing
    /// one is exactly what stopped working against the live bank.
    /// </remarks>
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
        // The human taps their phone and there is nothing to type back, which
        // is what a passive challenge means.
        Answer = challenge => string.Empty,
    };

    // ---- which latched call is "the" one -------------------------------------

    /// <summary>
    /// THE FRESHEST ANSWER WINS, RATHER THAN WHATEVER THE STORE YIELDS FIRST.
    /// </summary>
    /// <remarks>
    /// The portal latches calls in a <c>ConcurrentDictionary</c> keyed by url
    /// and hands them back by enumerating it, and every caller here takes
    /// <c>[0]</c>. A dictionary promises no order at all, so on a page where
    /// ING calls the same endpoint twice - a refresh, a widget asking for its
    /// own slice - "the first" was an arbitrary pick, and it decided which
    /// account list this adapter read and whose headers the cursor walk
    /// repeated.
    /// <para>
    /// Nothing about that shows when it goes wrong: both entries parse, both
    /// look like answers, and the run reports success either way.
    /// </para>
    /// <para>
    /// Asserted on the portal rather than through the adapter, because the
    /// adapter's own fixture hands back a list it was given and cannot express
    /// a store with no order.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_latch_hands_back_the_newest_call_for_an_endpoint_first()
    {
        var older = new IngCall(200, FirstUrl, "{\"first\":true}", null, Seq: 1);
        var newer = new IngCall(200, FirstUrl + "&page=2", "{\"second\":true}", null, Seq: 2);

        // THE PORTAL'S OWN ORDERING, not a copy of it written here. Handed in
        // back-to-front on purpose: a version that returns what it was given
        // keeps this order and fails.
        var ordered = PageIngPortal.Freshest([older, newer]);

        Assert.Equal(newer.Url, ordered[0].Url);
        Assert.Equal(older.Url, ordered[1].Url);
    }

    // ---- what must never be pressed ------------------------------------------

    /// <summary>
    /// THE THREE CONTROLS ING'S OPTIONS FORBID ARE ON THE PAGE HERE.
    /// </summary>
    /// <remarks>
    /// <c>IngOptions.ForbiddenSelectors</c> named three controls that "would do
    /// real damage" and <b>nothing read it</b> - not the adapter, not a test.
    /// A safety rule written as data with no enforcement is a comment with
    /// extra steps.
    /// <list type="bullet">
    /// <item><c>#up-kbq-button</c> starts ING's credential-recovery flow. The
    /// same class of mistake as Coolblue's "Wachtwoord vergeten?", which this
    /// project has already made once.</item>
    /// <item>"App openen" hands off to the ING app.</item>
    /// </list>
    /// <para>
    /// THE FIXTURE OFFERS THEM, which is the whole point: a page that does not
    /// have the dangerous button cannot show that the adapter declined it. On
    /// the real sign-in screen "Inloggegevens kwijt?" sits directly beside the
    /// control this adapter DOES press, and the risk is a selector broadened
    /// until it matches both.
    /// </para>
    /// <para>
    /// What this cannot catch is exactly that broadening: the stub matches
    /// selectors by string, so a live <c>ing-button.list__button</c> hitting
    /// two elements looks like one hit here. That needs the browser.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_login_never_presses_a_control_ing_forbids()
    {
        var forbidden = Options.ForbiddenSelectors;

        Assert.NotEmpty(forbidden);

        // WITHOUT THE PASSWORD BOX, which is what makes this test run the step
        // that matters. ING's app sign-in screen has no password form until the
        // control naming it is pressed - and the first version of this test
        // showed the box from the start, so the adapter skipped the click
        // entirely and the assertion below passed against an adapter that had
        // been made to press "Inloggegevens kwijt?" on purpose.
        var page = StubLoginPage.Showing([Username, Submit, ToPasswordForm, .. forbidden]);

        page.WhenClicked = (showing, clicked) =>
        {
            if (clicked == ToPasswordForm) showing.Reveal(Password);
        };

        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        // It opened the form and signed in, so this is a login that reached
        // every control on the screen and had every chance to press the wrong
        // one.
        Assert.Contains(ToPasswordForm, page.Clicked);
        Assert.Contains(Submit, page.Clicked);

        Assert.All(forbidden, selector => Assert.DoesNotContain(selector, page.Clicked));
    }

    /// <summary>
    /// A CONTROL THAT IS THERE AND CANNOT BE USED IS NOT A MISSING ONE.
    /// </summary>
    /// <remarks>
    /// ING ships a phone layout and a desktop layout in the same document and
    /// hides one with CSS, so a selector can match an element nobody is able to
    /// press. Playwright finds it, waits for it to become actionable, and gives
    /// up - which arrives at the adapter as the same false a genuinely absent
    /// element does.
    /// <para>
    /// The two send an engineer to opposite repairs: one is a selector that
    /// matches nothing, the other a selector that matches too much. The first
    /// live sign-in against this bank was the second kind and was reported as
    /// the first.
    /// </para>
    /// <para>
    /// Untestable until now, because the stub knew only "present" and "absent"
    /// - so the two failures were literally the same fixture.
    /// </para>
    /// </remarks>
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

        // And the selector that matched it, because the repair is to narrow
        // that one rather than to go hunting for a control that is on screen.
        Assert.Contains(Submit, error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// And a control that is genuinely absent still says so.
    /// </summary>
    [Fact]
    public async Task A_sign_in_button_that_is_not_there_at_all_still_reads_as_missing()
    {
        var page = StubLoginPage.Showing(Username, Password);
        using var ctx = Signing(page);

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None));

        Assert.Contains("could not find the sign-in button", error.Message, StringComparison.Ordinal);
    }

    // ---- the login -----------------------------------------------------------

    /// <summary>
    /// The ordinary sign-in, and the four orderings it has to get right.
    /// </summary>
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

        // Said before the waiting starts: what makes a retry dangerous is that
        // the form went in, not that anything came back.
        Assert.True(ctx.CredentialWasSubmitted);

        // The password is out of the DOM before the challenge, because the
        // challenge is exactly when a screenshot is taken - and nothing touches
        // the page after it, which is the sequence rather than the fact.
        Assert.False(page.HoldsSecret);
        Assert.Equal(["goto", "fill", "fill", "click", "clear-secrets"], page.Calls);

        var challenge = Assert.Single(ctx.Asked);
        Assert.Equal(ChallengeType.AppApproval, challenge.Type);
        Assert.True(challenge.IsPassive);
        Assert.Contains(JobStep.AwaitingHuman, ctx.Steps);

        Assert.Equal(Now.AddSeconds(900), result.ExpiresAt);
        Assert.Equal("""{"cookies":[],"origins":[]}""", result.Material.StorageState);
    }

    /// <summary>
    /// NOBODY PRESSES ANYTHING. The human approves on their phone, ING's own
    /// page advances, and the login finishes without the card in the consumer
    /// ever being answered.
    /// </summary>
    /// <remarks>
    /// This is the behaviour the account holder asked for, and it is only
    /// possible because the approval has a witness that is not the human: ING
    /// fetches transactions by itself the moment it lands on the overview. The
    /// challenge is still raised, because somebody has to be TOLD to reach for
    /// their phone - it just is not the thing that decides.
    /// </remarks>
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
            // The card is never touched, exactly as it would not be by somebody
            // who approved on their phone and closed the tab.
            AnswersNever = true,
        };

        var result = await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.NotNull(result.Material.StorageState);
        Assert.Single(ctx.Asked);

        // CANCELLED, not dropped. The platform releases the job's budget park
        // on this unwind; abandoning the task instead stops the run's working
        // clock for the whole rest of the login.
        //
        // Awaited rather than read, because the cancelled wait resumes on the
        // thread pool: reading the counter straight after the login returns is
        // racing it, and that race is only lost on a loaded machine.
        Assert.True(await ctx.AbandonedAsync(), "the challenge was never cancelled by its asker");
        Assert.Equal(1, ctx.ChallengesAbandoned);
    }

    /// <summary>
    /// The card outlives the WHOLE login, not just the wait for the phone.
    /// </summary>
    /// <remarks>
    /// THIS ONE GUARDS AGAINST SILENT DATA LOSS. An unanswered challenge parks
    /// the job in <c>AwaitingInput</c> until the run completes; if it expires
    /// first, the platform's sweeper fails the job <c>challenge_expired</c> and
    /// clears its lease, and the agent's result is then refused by the owner
    /// check and discarded. A finished bank login, with a sealed session,
    /// thrown away - and not retried, because a parked job has no edge back to
    /// the queue.
    /// <para>
    /// So the expiry has to cover the approval wait AND everything after it.
    /// Asserted as the exact stated value rather than "longer than the wait",
    /// because the margin is the part that would rot.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// The wait for ING's page is given the HUMAN's budget, not the network's.
    /// </summary>
    /// <remarks>
    /// It used to be the other way round, and only because the human was
    /// awaited separately first. Now that the two run together, a
    /// forty-five-second wait would give somebody forty-five seconds to find
    /// their phone and then report their correct password as refused.
    /// </remarks>
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

    /// <summary>
    /// WATCH FIRST, NAVIGATE SECOND, and this is the test that pins it.
    /// </summary>
    /// <remarks>
    /// ING takes itself to the overview once the approval lands and fires the
    /// transactions call by itself. MediaMarkt's first live run navigated at
    /// this exact moment instead, cancelled a sign-in that was still in flight,
    /// and reported the password as refused - so on the happy path this
    /// adapter must not navigate at all.
    /// </remarks>
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

    /// <summary>
    /// ING opens on its app screen and the password form is one tap away, in
    /// whichever language the account holder banks in.
    /// </summary>
    /// <remarks>
    /// Both were confirmed on 2026-08-13 by clicking them on ING's live public
    /// sign-in page and checking that the form appeared. The language is not
    /// ours to choose, so covering only the Dutch one would be covering only
    /// some of the people who can connect.
    /// </remarks>
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

    /// <summary>
    /// The phone layout's control is tried before the desktop layout's, and
    /// this is the defect that cost a live sign-in rather than a style rule.
    /// </summary>
    /// <remarks>
    /// ING ships BOTH layouts in one document and hides one with CSS. On a
    /// phone the desktop <c>ing-button</c> is present, matches a selector, and
    /// has no box at all - so a candidate list that reaches it first spends its
    /// whole budget waiting for something that will never become visible, while
    /// the list item a person would tap sits there unclicked. That is exactly
    /// what happened: "could not find the username box … showing 'Inloggen via
    /// je app'".
    /// </remarks>
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

        // And the very first is visibility-qualified, because the text matches
        // twice - once per layout - and which one a bare selector resolves to
        // is an ordering assumption rather than a fact.
        Assert.EndsWith(":visible", candidates[0], StringComparison.Ordinal);
    }

    /// <summary>
    /// And it is NOT clicked when the form is already there.
    /// </summary>
    /// <remarks>
    /// Only ING's Dutch wording was captured, so the English selector is
    /// inferred. Checking for the FORM rather than for the screen is what keeps
    /// that guess from breaking a login that never needed it.
    /// </remarks>
    [Fact]
    public async Task The_password_form_is_not_reopened_when_it_is_already_showing()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit, ToPasswordForm);
        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        Assert.DoesNotContain(ToPasswordForm, page.Clicked);
    }

    /// <summary>
    /// Nothing asked for transactions, so nobody is signed in - and the failure
    /// says what the browser is actually showing rather than blaming the
    /// password.
    /// </summary>
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

        // The navigation fallback was tried before giving up.
        Assert.Equal(1, portal.Watched);
        Assert.Equal([Options.OverviewUrl], portal.Visited);

        // AND NOTHING WAS SEALED. A jar of anonymous cookies is exactly what
        // this project has shipped before - reading it early is how an adapter
        // convinces itself a signed-out session is a real one.
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

    /// <summary>
    /// A finished login states what the session can reach, so the next fetch
    /// does not have to discover it again.
    /// </summary>
    /// <remarks>
    /// FOUR TYPES FROM ONE CALL, including the loan the statement-screen route
    /// could never see. A live run reported an account holder's own savings
    /// account as unreachable because ING fetches savings and cards there only
    /// when somebody switches its picker; the agreement list has all of them.
    /// </remarks>
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

        // AND NOT THE LOYALTY AGREEMENT. ING lists ING Punten alongside the
        // accounts, with a balance of 1420 of something that is not money; a
        // ledger that carries it is a ledger that adds points to euros.
        Assert.DoesNotContain(result.Reachable, a => a.ExternalId == "0000001");
    }

    // ---- the walk ------------------------------------------------------------

    /// <summary>
    /// The whole history: the observed call, then ING's own cursor link, then
    /// oldest-first with the balance chain verified.
    /// </summary>
    /// <remarks>
    /// <see cref="BankEmission.Verified"/> throws on a broken chain, so this
    /// test passing IS the chain check - reversing each account's rows is not
    /// decoration.
    /// </remarks>
    /// <summary>The current account alone, so this stays about the cursor.</summary>
    private static ResourceRequest TransactionsFor(params string[] types) => new()
    {
        ResourceId = BankResources.Transactions,
        Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["accounts"] = types,
        },
    };

    /// <summary>
    /// A SECOND PAGE THAT NAMES NO ACCOUNT IS REFUSED, AND SAID OUT LOUD.
    /// </summary>
    /// <remarks>
    /// The fallback files a page that states no agreement under the one current
    /// account, on the reasoning that with a single current account there is
    /// nothing to confuse it with. That rests on a fact about ING - its
    /// overview fetches transactions for current accounts and for nothing else
    /// - which was written in a comment and checked nowhere.
    /// <para>
    /// Two unnamed pages say the premise has broken, because one account cannot
    /// be the subject of both. The danger is what follows: if one of them is a
    /// savings feed, its rows are walked as the current account's while the
    /// savings account is ALSO walked by its own link, so the same history ends
    /// up filed twice and reconciles perfectly under both names.
    /// </para>
    /// <para>
    /// <b>The first is still attributed, and the assertion below says so rather
    /// than pretending otherwise.</b> Refusing both would be safer if the
    /// current account could be read another way - and it cannot. That was the
    /// assumption this test was first written on, and the fetch died on "none
    /// of the selected accounts could be read": ING states a transactions link
    /// on the savings, card and loan agreements and NOT on the current one.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_second_page_that_names_no_account_is_refused_and_reported()
    {
        // The same page ING serves, with the one thing that identifies its
        // owner taken out of the action links.
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

        // The second page is not filed under the account the first one took,
        // and the caller is told the history they were given may be misfiled.
        Assert.Contains(
            ctx.Notes,
            n => n.Contains("2 pages of transactions state no account", StringComparison.Ordinal)
                 && n.Contains("wrong account", StringComparison.Ordinal));

        // The first still went through, because there is no other route to a
        // current account's history.
        var accountId = BankRecords.AccountId(ctx.SessionId, Iban);

        Assert.NotEmpty(result.Transactions);
        Assert.All(result.Transactions, t => Assert.Equal(accountId, t.AccountId));
    }

    /// <summary>
    /// WHY THE COMPROMISE ABOVE IS ONE: the current account has no other route.
    /// </summary>
    /// <remarks>
    /// Stated as a test rather than left in a comment, because it is the fact
    /// the whole fallback rests on and it is ING's to change. The day a
    /// transactions link appears on the current agreement, refusing every
    /// unnamed page becomes free - and this is what will say so.
    /// </remarks>
    [Fact]
    public async Task Ing_states_a_transactions_link_for_every_account_except_the_current_one()
    {
        var page = StubLoginPage.Showing(Username, Password, Submit);
        using var ctx = Signing(page);

        await Adapter().LoginAsync(ctx, page, new ScriptedPortal(), CancellationToken.None);

        var listed = BankFixtures.Read(BankFixtures.IngAgreements);

        // The three that state one, by the ids their agreements carry.
        Assert.Contains("NL02INGB0009876543", listed, StringComparison.Ordinal);

        // And the current account's own history is reachable only through the
        // page ING's overview fetches for itself.
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

        // NOTHING IS COMPOSED. Every url this adapter asks for is one ING
        // stated - a cursor link on a page of transactions, or the self link on
        // an agreement - because a request this connector builds is the shape
        // ING answered 401 to on a live session its own javascript was using at
        // that moment.
        Assert.Equal(2, portal.Asked.Count);
        Assert.Equal("/nl/agreements/900012345678/carddetails", portal.Asked[0]);
        Assert.StartsWith("/v1/agreements/", portal.Asked[1], StringComparison.Ordinal);

        // ONE NAVIGATION FOR THE WHOLE FETCH. The overview's own call to
        // /global/agreements names every account, so the statement screen that
        // used to be visited for the account lists is not visited at all - and
        // it reached less than this does.
        Assert.Equal([Options.OverviewUrl], portal.Visited);

        // EVERY CALL CARRIES THE HEADERS OF THE ONE IT CONTINUES. A request
        // asked for with whatever ING's client last happened to send is one
        // ING's webserver refuses, which is what the live run met - so the
        // card's details repeat the agreement call's headers and the cursor
        // page repeats the transactions call's, rather than either inheriting
        // the other's.
        Assert.Equal(
            [["accept", "x-request-id"], ["accept", "authorization"]],
            portal.AskedWith);
    }

    /// <summary>
    /// The walk stops as soon as a page's oldest row is already before the
    /// window, rather than reading an account's whole history to throw it away.
    /// </summary>
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

    /// <summary>
    /// THE CAP IS SHARED BETWEEN ACCOUNTS, so one heavy account cannot leave
    /// every other selected account reporting an empty history.
    /// </summary>
    /// <remarks>
    /// The cap used to be handed to each account whole, and the emitted page is
    /// trimmed to the first N rows oldest-first. On the DEFAULT fetch - which
    /// selects everything - one current account with more history than the cap
    /// filled it, and savings, card and loan each emitted nothing while still
    /// appearing in the account list with their balances. An empty history is
    /// indistinguishable from an account nothing has happened on.
    /// <para>
    /// Four rows for four accounts: one each, so a route that gives the first
    /// account everything leaves the other three at zero and this fails.
    /// </para>
    /// </remarks>
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

        // EVERY selected account contributed. That is the claim; the count
        // above only bounds it.
        Assert.Equal(4, result.Transactions.Select(t => t.AccountId).Distinct(StringComparer.Ordinal).Count());

        // And the pass says it is short, because it is.
        Assert.False(result.Complete);
    }

    /// <summary>
    /// A count of derived ids counts the rows a CALLER GETS, not the rows the
    /// reader saw.
    /// </summary>
    /// <remarks>
    /// The two differ on every page that straddles the edge of the window, and
    /// the live run said "10 of 3 transaction(s) on R13792519 carry an id this
    /// connector derived" - a loan feed of ten rows, three of them inside the
    /// window. Not a sentence about anything, in a panel whose whole purpose is
    /// to be believed.
    /// </remarks>
    [Fact]
    public async Task A_count_of_derived_ids_never_exceeds_the_rows_it_counts()
    {
        using var ctx = new FakeJobContext();

        // A feed with no ids, most of it older than the window - the shape
        // that produced the nonsense.
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

    /// <summary>
    /// THE COUNT AND THE CODE LIST ARE ABOUT DIFFERENT SETS, and the sentence
    /// has to say which.
    /// </summary>
    /// <remarks>
    /// A live run produced "1 of 1 transaction(s) in the requested window could
    /// not be classified, and these are ING's own codes on the rows this
    /// connector could not classify: IIPS, SAV-rente, SWNP, SAV-opname, SDSCO,
    /// SAV-inleg, SD" - seven codes on one row, which is impossible, because a
    /// row carries one code.
    /// <para>
    /// The count is of rows the CALLER RECEIVED; the codes come off every row
    /// the reader saw, window or not. That distinction had already been noticed
    /// once and the repair did not land: the sentence still attached the codes
    /// to the rows it had just counted. Naming the second set is what fixes it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_unclassified_codes_say_which_rows_they_came_off()
    {
        using var ctx = new FakeJobContext();

        // Four rows ING states a different unknown code for, of which one falls
        // inside the window. The count and the code list therefore disagree by
        // construction, exactly as they did live.
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

        // The two halves are separate sentences about separate sets, and the
        // second says out loud that it read more than the caller was given.
        Assert.Contains($"of the {result.Transactions.Count} transaction(s) you received", note, StringComparison.Ordinal);
        Assert.Contains("across EVERY row read for this account", note, StringComparison.Ordinal);

        // And the old phrasing, which tied the codes to the counted rows, is gone.
        Assert.DoesNotContain(
            "codes on the rows this connector could not classify", note, StringComparison.Ordinal);
    }

    /// <summary>
    /// A CODE LIST THAT WAS CUT SAYS SO.
    /// </summary>
    /// <remarks>
    /// Twenty-four was a silent truncation in the one sentence whose entire
    /// purpose is to be reasoned from - the instrument for deciding which of
    /// ING's codes still need mapping. A list that cannot be told from a
    /// complete one is read as complete.
    /// </remarks>
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

    /// <summary>
    /// THE ALTERNATIVE TO A DERIVED ID IS REPORTED BESIDE IT, MEASURED.
    /// </summary>
    /// <remarks>
    /// Every row ING states no id for links to its own detail page, and that
    /// link ends in something id-shaped. Whether it is an id or a row's
    /// position cannot be told from one payload, and mistaking the second for
    /// the first would re-import the account's whole history on every sync - so
    /// what goes in the note is the measurement, and the values stay out of it.
    /// </remarks>
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

        // The measurement travels; the link does not. Two rows counting up from
        // 41 is a position, and saying so requires naming neither.
        Assert.All(
            ctx.Notes,
            n =>
            {
                Assert.DoesNotContain("card-transactions", n, StringComparison.Ordinal);
                Assert.DoesNotContain("41", n, StringComparison.Ordinal);
                Assert.DoesNotContain("42", n, StringComparison.Ordinal);
            });
    }

    /// <summary>
    /// One walk per account, however many calls ING's own client made for it.
    /// </summary>
    /// <remarks>
    /// The portal latches on the request url, so the same account fetched twice
    /// with different query - a retry, a widget asking for its own slice -
    /// arrives as two entries naming one account. Walking both emits every row
    /// of it twice, which the balance chain would then reject: a hard failure
    /// on a session where nothing was actually wrong.
    /// </remarks>
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

        // Six, not twelve - and no duplicate ids among them.
        Assert.Equal(6, result.Transactions.Count);
        Assert.Equal(6, result.Transactions.Select(t => t.Id).Distinct(StringComparer.Ordinal).Count());
    }

    /// <summary>
    /// A pass that stops at its cap says WHERE it stopped, so the caller can
    /// continue from there instead of binary-searching their own history.
    /// </summary>
    /// <remarks>
    /// The live account hit this: thirteen pages, five hundred rows, and a note
    /// that said only "there may be more, so this pass is partial". That is
    /// unactionable - <c>until</c> is a parameter this resource already takes,
    /// and ING serves newest first, so the oldest row read is exactly the
    /// boundary to ask from next.
    /// </remarks>
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

        // The OLDEST row read, not the newest: asking again with the newest
        // would hand back the same page forever.
        var oldest = result.Transactions.Min(t => t.BookedAt);

        Assert.Contains($"until={oldest:yyyy-MM-dd}", note, StringComparison.Ordinal);
        Assert.Contains(Iban, note, StringComparison.Ordinal);
    }

    /// <summary>
    /// The accounts resource is the same navigation with no paging behind it.
    /// </summary>
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

    /// <summary>
    /// The card's balance comes from the card's own screen, reached by the link
    /// ING states on the agreement.
    /// </summary>
    /// <remarks>
    /// Three live runs established that no list has it: <c>/credit-cards/cards</c>
    /// carries no amount, the agreement list omits the balance object for a
    /// card, and nothing card-shaped is fetched by the overview at all -
    /// because ING's own overview shows no card balance either. Its
    /// <c>self</c> link points at <c>/nl/agreements/{id}/carddetails</c>, which
    /// is the screen that does.
    /// </remarks>
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

        // FOLLOWED, NOT COMPOSED. The path asked for is the href off the
        // agreement, which is the same discipline as the cursor walk - and the
        // reason this connector works at an edge that answers composed requests
        // with 401.
        Assert.Contains("/nl/agreements/900012345678/carddetails", portal.Asked);

        // THE HASH HAS TO COVER THE BALANCE THAT ARRIVED LATE. It is what the
        // platform republishes an account on, so a record still carrying the
        // hash of the version of itself that had no balance is a record that
        // will not change when the balance does - which is invisible, and
        // exactly the sort of thing a `with` expression makes easy to write.
        var rebuilt = BankRecords.NewAccount(
            ctx.SessionId,
            card.ExternalId,
            card.Type,
            card.DisplayName,
            card.Currency,
            card.Iban,
            card.MaskedNumber,
            card.Balance);

        Assert.Equal(rebuilt.ContentHash, card.ContentHash);

        // Nothing is said when there is nothing wrong.
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("no balance", StringComparison.Ordinal));
    }

    /// <summary>
    /// And when the card's own screen spells its balance some other way, the
    /// account keeps its blank and the run reports the SHAPE.
    /// </summary>
    /// <remarks>
    /// What the reader looks for is this connector's guess - a root
    /// <c>balance</c>, spelled the way every other ING payload spells one - and
    /// nobody has seen inside this response. So the failure mode has to be a
    /// structure report rather than a wrong figure: it is how every other shape
    /// here was learned, and it cannot carry the amount out of somebody's bank.
    /// </remarks>
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

        // Blank rather than zero, which would read as a settled card.
        Assert.Null(result.Accounts[2].Balance);

        var note = Assert.Single(ctx.Notes, n => n.Contains("Its shape is", StringComparison.Ordinal));

        Assert.Contains("outstandingAmount:{currency:string(3),value:string(7)}", note, StringComparison.Ordinal);
        Assert.Contains("creditLimit:number", note, StringComparison.Ordinal);
        Assert.DoesNotContain("847.30", note, StringComparison.Ordinal);
    }

    /// <summary>
    /// A refusal on that link costs the balance and nothing else.
    /// </summary>
    /// <remarks>
    /// ING served the agreement list on this very session moments ago, so a
    /// refusal here is the composed-request failure mode rather than a dead
    /// session - the same call this adapter already makes about a cursor page.
    /// Failing the fetch over it would throw away five good accounts for one
    /// missing figure.
    /// </remarks>
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

    /// <summary>
    /// An account with no balance AND no link to itself is out of leads, so the
    /// run names every endpoint the session touched.
    /// </summary>
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

        // AND NOTHING THAT SAYS WHOSE. The transactions path carries an
        // agreement id encrypted per session, and the query string beside it
        // names the product.
        Assert.DoesNotContain("aYDrNOy1xKmQ", note, StringComparison.Ordinal);
        Assert.DoesNotContain("NL_CURRENT", note, StringComparison.Ordinal);
    }

    /// <summary>
    /// And nothing is asked for at all when every account came back with a
    /// figure.
    /// </summary>
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

    /// <summary>
    /// A url reduced to the endpoint it names, and nothing that says whose.
    /// </summary>
    /// <remarks>
    /// This goes into an operator's log, so the claim is absolute: every real
    /// path segment survives and every identifier does not. The rule is LONG AND
    /// CONTAINING A DIGIT rather than length alone, because ING's own segments
    /// are words - <c>transactions</c> is twelve characters and a card number is
    /// sixteen, so no length cutoff separates them.
    /// </remarks>
    [Theory]
    [InlineData("https://api.mijn.ing.nl/global/agreements", "/global/agreements")]
    [InlineData("https://api.mijn.ing.nl/credit-cards/cards?includeInactiveCards=false", "/credit-cards/cards")]
    [InlineData("https://api.mijn.ing.nl/v1/agreements/aYDrNOy1xKmQ/transactions", "/v1/agreements/…/transactions")]
    [InlineData("https://api.mijn.ing.nl/cards/5248123412347201/balance", "/cards/…/balance")]
    [InlineData("https://api.mijn.ing.nl/accounts/NL02INGB0000019507", "/accounts/…")]
    public void An_endpoint_keeps_its_words_and_loses_its_identifiers(string url, string expected) =>
        Assert.Equal(expected, PageIngPortal.Endpoint(url));

    /// <summary>
    /// Savings and card history come from the link each agreement states, and
    /// this is the gap that took the longest to see.
    /// </summary>
    /// <remarks>
    /// ING's overview fetches transactions per current account and for nothing
    /// else, so for several releases this connector told a caller their savings
    /// history "is offered as a download only" - while the agreement list it
    /// was already reading carried the address of the feed on every account.
    /// <para>
    /// ONLY THE CARD'S LINK SET WAS OBSERVED LIVE, on the one account whose
    /// missing balance made the connector report them. The fixture carries the
    /// same shape on savings and on the loan because a hypermedia list that
    /// names an account's own feed for one product and not another would be the
    /// strange thing - and the case where ING really does not offer one is
    /// covered separately below.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Savings_and_card_history_come_from_the_link_each_agreement_states()
    {
        using var ctx = new FakeJobContext();
        var portal = new ScriptedPortal();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("savings", "credit_card"), portal, CancellationToken.None);

        Assert.True(result.Complete);
        Assert.NotEmpty(result.Transactions);

        // BOTH accounts, and no rows filed under the current one - which is the
        // failure mode that reconciles perfectly and is invisible.
        var savings = BankRecords.AccountId(ctx.SessionId, "NL02INGB0009876543");
        var card = BankRecords.AccountId(ctx.SessionId, "900012345678");

        Assert.Contains(result.Transactions, t => t.AccountId == savings);
        Assert.Contains(result.Transactions, t => t.AccountId == card);
        Assert.All(result.Transactions, t => Assert.Contains(t.AccountId, new[] { savings, card }));

        // Followed rather than composed, exactly as a cursor is.
        Assert.Contains("/v1/agreements/x2/transactions", portal.Asked);
        Assert.Contains("/v1/agreements/900012345678/transactions", portal.Asked);

        // AND CARRYING ING'S OWN HEADERS, taken from the transactions call its
        // client already made rather than from whatever answered last. A
        // request to this endpoint family composed without them is the one
        // ING's webserver answered 401 to on a live session.
        var feeds = portal.Asked
            .Select((path, i) => (path, headers: portal.AskedWith[i]))
            .Where(c => c.path.EndsWith("/transactions", StringComparison.Ordinal))
            .ToList();

        Assert.Equal(2, feeds.Count);
        Assert.All(feeds, f => Assert.Equal(["accept", "authorization"], f.headers));
    }

    /// <summary>
    /// Nothing readable at all is an ERROR, not an empty list.
    /// </summary>
    /// <remarks>
    /// An empty page marked incomplete is far too easy to read as "you have no
    /// transactions", which is the confusion this adapter has spent its whole
    /// life avoiding. So a request where no selected account could be read
    /// fails out loud - and the notes naming each reason travel with it, which
    /// they did not used to.
    /// </remarks>
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

    /// <summary>
    /// A feed ING refuses costs that account's history and nothing else.
    /// </summary>
    [Fact]
    public async Task A_refused_own_feed_keeps_every_other_account_that_worked()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx,
            TransactionsFor("current", "savings", "credit_card"),
            new ScriptedPortal { OwnFeed = "<!DOCTYPE html><html>Log in</html>" },
            CancellationToken.None);

        // The current account came from ING's own observed call and is
        // untouched by the refusal.
        Assert.Equal(6, result.Transactions.Count);
        Assert.False(result.Complete);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("could not be read", StringComparison.Ordinal)
                 && n.Contains("with no history rather than with none found", StringComparison.Ordinal));
    }

    /// <summary>
    /// An unsettled reservation is left out AND said out loud, so an operator
    /// reading the logs can tell a skipped row from a missing one.
    /// </summary>
    [Fact]
    public async Task A_skipped_reservation_is_reported_to_the_operator()
    {
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Transactions },
            new ScriptedPortal(), CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("reservation", StringComparison.OrdinalIgnoreCase));
    }

    // ---- what a refusal means ------------------------------------------------

    /// <summary>
    /// A 401 is a dead session on EITHER route, and on the agreement list it
    /// must not quietly become a fallback.
    /// </summary>
    /// <remarks>
    /// That is the whole risk of having a second route: an expired session
    /// answered with half of somebody's accounts and no error reads exactly like
    /// a customer who only has a current account. So a refusal is caught for
    /// shape only - <c>provider_changed</c> - and a 401 goes straight out.
    /// </remarks>
    [Theory]
    [InlineData(Agreements)]
    [InlineData("/accounts/current")]
    public async Task A_401_from_ing_is_an_expired_session_rather_than_a_broken_bank(string pathMarker)
    {
        using var ctx = new FakeJobContext();

        // The statement screen is only ever reached when there is no agreement
        // list, so a test about it has to take that away first.
        var portal = pathMarker == Agreements
            ? Refusing(pathMarker, new IngCall(401, pathMarker, "{}"))
            : Refusing(pathMarker, new IngCall(401, pathMarker, "{}"), Agreements);

        var refused = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, refused.Code);
    }

    /// <summary>
    /// A signed-out browser does not always get a 401: asked for JSON it is
    /// handed ING's own login page, with a perfectly successful status.
    /// </summary>
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

    /// <summary>
    /// Savings and credit cards are best effort ON THE FALLBACK ROUTE: nobody
    /// has established what ING answers for a customer who has neither, and
    /// failing their whole fetch to find out would be a defect introduced on
    /// purpose.
    /// </summary>
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

    /// <summary>
    /// The refusal ITSELF is quoted. A gateway that says no usually says what
    /// was missing, and that sentence is the difference between another live
    /// sign-in and an answer.
    /// </summary>
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

    // ---- signing out ---------------------------------------------------------

    /// <summary>The portal, with ING's own sign-out call latched.</summary>
    private static ScriptedPortal SignedOutUpstream() =>
        Refusing("/sessions/logout", new IngCall(200, "https://api.mijn.ing.nl/api/sessions/logout", "{}"));

    /// <summary>
    /// A disconnect OPENS A PAGE ON ING before hunting for a button on it.
    /// </summary>
    /// <remarks>
    /// THIS IS THE TEST THAT WAS MISSING, and its absence hid a sign-out that
    /// never once ran. A disconnect arrives as a standalone logout job with a
    /// fresh context, so no browser has been started; the adapter returned
    /// early on <c>Browser.Started</c> and reported success having sent
    /// nothing. Both tests here used to drive the internal seam with a page
    /// already showing the button, which skipped the guard AND the question of
    /// how a browser ever reached a page carrying one.
    /// </remarks>
    [Fact]
    public async Task Disconnecting_opens_ings_page_and_presses_its_own_sign_out_button()
    {
        var page = StubLoginPage.Showing(LogoutButton);
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOutUpstream(), CancellationToken.None);

        // The navigation comes FIRST. Without it the selectors hunt
        // about:blank, and the miss gets reported as ING having moved its
        // button.
        Assert.Equal(["goto", "click"], page.Calls);
        Assert.Equal([LogoutButton], page.Clicked);
        Assert.Contains(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
    }

    /// <summary>
    /// "Signed out" is said only when ING'S OWN sign-out call followed the
    /// click.
    /// </summary>
    /// <remarks>
    /// A click that lands on something else is still a click. This adapter
    /// confirms a login by watching ING ask for transactions rather than by
    /// reading a url, and a disconnect that claimed success on the strength of
    /// a click alone would be the same lie pointing the other way - one that
    /// leaves a live bank session behind while telling the account holder it is
    /// closed.
    /// </remarks>
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

    /// <summary>
    /// And the landing page is the fallback proof, for a sign-out call this
    /// connector's portal cannot see.
    /// </summary>
    /// <remarks>
    /// The capture recorded <c>POST /api/sessions/logout</c> as a path without
    /// its host, and the portal latches ING's API origin only. If that call
    /// goes to the app's own origin instead, the goodbye page is what is left
    /// to go on - so it counts, rather than being written down and unused.
    /// </remarks>
    [Fact]
    public async Task Landing_on_ings_goodbye_page_counts_as_a_sign_out()
    {
        var page = StubLoginPage.Showing(LogoutButton);
        page.WhenClicked = (p, _) => p.Url = "https://mijn.ing.nl/particulier/logoff";

        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, page, SignedOut(), CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("signed out upstream", StringComparison.Ordinal));
    }

    /// <summary>
    /// And a sign-out that could not be found never fails the disconnect - but
    /// it does not claim to have happened either.
    /// </summary>
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

    /// <summary>
    /// A disconnect carrying no stored session does not launch a browser to
    /// sign out of nothing - and says so rather than going quiet.
    /// </summary>
    [Fact]
    public async Task A_disconnect_with_no_session_starts_no_browser()
    {
        // NoBrowserLease throws on any use, so reaching a browser fails this
        // test rather than merely slowing it down.
        using var ctx = new FakeJobContext();

        await Adapter().LogoutAsync(ctx, CancellationToken.None);

        Assert.Contains(ctx.Notes, note => note.Contains("nothing to sign out", StringComparison.Ordinal));
    }

    // ---- the portal's own rules ----------------------------------------------

    /// <summary>
    /// A path marker names an endpoint, not a prefix of one.
    /// </summary>
    /// <remarks>
    /// ING hangs other endpoints off the same stems, and every pair below was
    /// in the capture: <c>/transactions/search</c> beside <c>/transactions</c>,
    /// and <c>/accounts/all/transactions/reports/history</c> beside
    /// <c>/accounts/current</c>. A prefix match would file a search result as a
    /// page of transactions.
    /// </remarks>
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

    /// <summary>
    /// What a composed call carries, and what it must not.
    /// </summary>
    /// <remarks>
    /// A DENYLIST, and the change is what the live 401 forced: an allowlist can
    /// only carry the headers somebody thought of, and the six chosen off the
    /// response side were not enough to get past ING's edge. Anything ING sends
    /// that a page's fetch is allowed to set goes through untouched, including
    /// names nobody here has ever seen.
    /// </remarks>
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

        // Carried, including the one this codebase has never met.
        Assert.Equal(
            ["accept", "authorization", "x-ing-something-nobody-here-has-seen"],
            carried.Keys.Order(StringComparer.Ordinal));

        // The browser supplies these itself, correctly, and a page may not
        // override them - trying makes the call fail outright.
        Assert.DoesNotContain("cookie", carried.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("sec-fetch-mode", carried.Keys, StringComparer.OrdinalIgnoreCase);
    }

    // ---- when ING refuses the part we composed --------------------------------

    /// <summary>
    /// A refused cursor page keeps the page ING's own client already served.
    /// </summary>
    /// <remarks>
    /// The first page is OBSERVED and every later one is COMPOSED, and those are
    /// not equally reliable - ING's edge has answered a composed request with a
    /// 401 on a live session. Failing the whole fetch over page two would throw
    /// away a good page one and send somebody to re-authenticate a session that
    /// is working.
    /// </remarks>
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

        // Page one survived; page two did not arrive.
        Assert.Equal(3, result.Transactions.Count);
        Assert.False(result.Complete);

        // And the note names the headers, because an invisible refusal is what
        // cost the second live run.
        Assert.Contains(
            ctx.Notes,
            note => note.Contains("was refused", StringComparison.Ordinal)
                    && note.Contains("authorization", StringComparison.Ordinal));
    }

    /// <summary>
    /// An account list ING never asked for is an ANSWER, not a breakage.
    /// </summary>
    /// <remarks>
    /// Nobody has established whether ING calls the savings endpoint at all for
    /// a customer who has no savings account, and failing their whole fetch to
    /// find out would be a defect introduced on purpose. It is still said out
    /// loud: "we could not read them" and "you have none" are the same empty
    /// list to a caller.
    /// </remarks>
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

    // ---- the shape of a payload nobody may read -------------------------------

    /// <summary>
    /// THE WHOLE POINT: the structure gets out and the contents do not.
    /// </summary>
    /// <remarks>
    /// This describes a live bank payload straight into an operator's log, so
    /// the claim it has to keep is absolute. Every value below is the kind of
    /// thing that must never appear - an IBAN, an account holder's name, a
    /// balance, a card number - and the assertion is that none of them does,
    /// while the keys and the string LENGTHS do. A length is what tells an
    /// eighteen-character IBAN from a seven-character product code, which is
    /// all a reader needs.
    /// </remarks>
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

        // The structure, including the field only the SECOND entry has - an
        // account list is exactly where describing only the first hides the
        // fields a reader must treat as optional.
        Assert.Contains("agreements:[2 x {", shape, StringComparison.Ordinal);
        Assert.Contains("nickName:string(22)", shape, StringComparison.Ordinal);
        Assert.Contains("balance:{amount:number,currency:string(3)}", shape, StringComparison.Ordinal);
        Assert.Contains("closed:bool", shape, StringComparison.Ordinal);

        // EVERY value a taxonomy field takes, across every entry - the one
        // thing a length cannot say, and the whole question a reader has to
        // answer. Two entries, two product families, both stated.
        Assert.Contains("""productFamily:"CURRENT|SAVINGS" """.Trim(), shape, StringComparison.Ordinal);

        // And NONE of the contents.
        foreach (var secret in new[]
                 {
                     "NL02INGB0000019507", "NL03INGB0000019271", "Doker", "1234.56", "Huisje",
                 })
        {
            Assert.DoesNotContain(secret, shape, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>
    /// The two locks on quoting a value, and the second one holding when the
    /// first assumption stops being true.
    /// </summary>
    /// <remarks>
    /// A key called <c>type</c> is taxonomy today. If a bank ever puts a
    /// person's name under one, the value stops looking like a code and gets
    /// measured instead - which is what makes this safe to point at a live
    /// payload nobody has read.
    /// </remarks>
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

        // Taxonomy key, code-shaped value: quoted.
        Assert.Contains("subType:\"NL_ORANJE_SPRRKG\"", shape, StringComparison.Ordinal);

        // Taxonomy key, but the value has spaces - measured, not quoted.
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

    /// <summary>
    /// An agreement list this reader cannot make sense of falls back AND says
    /// what ING actually sent, so the next version is written from evidence.
    /// </summary>
    /// <remarks>
    /// This reader was written from a schema rather than from a sample - the
    /// capture withheld this response, on an account with real money in it - so
    /// the day ING moves the shape is a day somebody needs the new one. The
    /// alternative is another live sign-in on a real account to find out.
    /// <para>
    /// And the note is the same instrument that made the reader possible: keys,
    /// nesting and string LENGTHS, never a value.
    /// </para>
    /// </remarks>
    /// <param name="payload">
    /// The two ways a 200 can still be no use: entries this reader makes nothing
    /// of, and no entries at all. Both have to fall back rather than report an
    /// account holder as having no accounts.
    /// </param>
    [Theory]
    [InlineData("""{"agreements":[{"iban":"NL01INGB0002345678","productFamily":"CURRENT"}]}""")]
    [InlineData("""{"agreements":[],"iban":"NL01INGB0002345678","productFamily":"CURRENT"}""")]
    public async Task An_unreadable_agreement_list_reports_its_shape_and_falls_back(string payload)
    {
        using var ctx = new FakeJobContext();

        var portal = Refusing(Agreements, new IngCall(200, Agreements, payload));

        var result = await Adapter().FetchAsync(
            ctx, new ResourceRequest { ResourceId = BankResources.Accounts }, portal, CancellationToken.None);

        // Degraded, not failed: the older route still serves what it always
        // could.
        Assert.Equal(
            [AccountType.Current, AccountType.Savings, AccountType.CreditCard],
            result.Accounts.Select(a => a.Type));

        var note = Assert.Single(ctx.Notes, n => n.Contains(Agreements, StringComparison.Ordinal)
                                                 && n.Contains("shape of", StringComparison.Ordinal));

        Assert.Contains("agreements:[", note, StringComparison.Ordinal);
        Assert.Contains("iban:string(18)", note, StringComparison.Ordinal);

        // The taxonomy is stated - it is what a reader has to be written
        // against - and the account number is not.
        Assert.Contains("""productFamily:"CURRENT" """.Trim(), note, StringComparison.Ordinal);
        Assert.DoesNotContain("NL01INGB0002345678", note, StringComparison.Ordinal);
    }

    /// <summary>
    /// A balance ING spells in a way this connector cannot read does NOT come
    /// back inside the note that reports it.
    /// </summary>
    /// <remarks>
    /// The fallback note interpolates the exception's message, and the
    /// exception here comes from the money parser - which used to quote the
    /// value it could not read. That put an account balance into a sentence
    /// that is logged, written to the job row and returned to the caller, two
    /// clauses away from the schema whose entire purpose is to keep values out.
    /// <para>
    /// The whole note is checked rather than the schema half, because the leak
    /// was in the other half.
    /// </para>
    /// </remarks>
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

    /// <summary>And it says so plainly when that call was never made at all.</summary>
    /// <remarks>
    /// Because then the accounts really may be short: the statement screen
    /// fetches savings and cards only when somebody switches its picker, which
    /// is how a live fetch came to report an account holder's own savings
    /// account as unreachable.
    /// </remarks>
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

        // AND IT WAITED FOR IT FIRST. The overview fires the agreement list and
        // the transactions on mount, in whatever order ING likes; giving up on
        // the first look would take the narrower route on a timing accident.
        Assert.Contains(Options.StepProbeMs, portal.WatchedWith);
    }

    /// <summary>
    /// AND IT SAYS SO IN THE FIELD A PROGRAM READS, not only in a note.
    /// </summary>
    /// <remarks>
    /// The note above has been right since this route was written. What went
    /// with it was <c>complete: true</c> and <c>via: "overview"</c> -
    /// unconditionally, on both routes - so the one field the API contract
    /// tells a consumer to code against announced a partial list as the whole
    /// of somebody's accounts, while the sentence explaining otherwise sat
    /// somewhere no program will ever read.
    /// <para>
    /// The two routes do not reach the same accounts, and this adapter's own
    /// remarks say a live run reported an account holder's own savings account
    /// as unreachable on the narrower one.
    /// </para>
    /// </remarks>
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

    /// <summary>The agreement route IS every agreement, and says so.</summary>
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

    /// <summary>
    /// A HISTORY BUILT ON A SHORT ACCOUNT LIST IS SHORT TOO.
    /// </summary>
    /// <remarks>
    /// The transactions path computes completeness over the accounts that
    /// reached it - an unreadable feed, a missing path, a trimmed page. An
    /// account the account-list route never found is invisible to every one of
    /// those, so a customer with four accounts and a statement-screen read
    /// would be handed three accounts' history marked whole. Each check was
    /// sound; none of them could see what was missing from outside.
    /// <para>
    /// ONLY THE CURRENT ACCOUNT IS ASKED FOR, and that is what makes this test
    /// worth having. Asking for everything on the fallback route already lowers
    /// <c>complete</c> for its own reasons - the savings and card accounts it
    /// finds there carry no transactions path - so the assertion would pass
    /// whatever this fix did. Narrowing to the one account that reads cleanly
    /// leaves the account list's own completeness as the only thing left that
    /// can lower the flag.
    /// </para>
    /// </remarks>
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

    /// <summary>The control: the same request on the full route IS complete.</summary>
    /// <remarks>
    /// Without this, the assertion above could be satisfied by a fetch that
    /// simply never reports completeness - which is a different bug wearing the
    /// same green tick.
    /// </remarks>
    [Fact]
    public async Task The_same_history_on_the_agreements_route_is_complete()
    {
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(
            ctx, TransactionsFor("current"), new ScriptedPortal(), CancellationToken.None);

        Assert.NotEmpty(result.Transactions);
        Assert.True(result.Complete);
    }

    // ---- the catalogue entry -------------------------------------------------

    /// <summary>
    /// The manifest's promises, which are the only thing a consumer codes
    /// against.
    /// </summary>
    [Fact]
    public void The_manifest_promises_what_ing_actually_does()
    {
        var manifest = Adapter().Describe();

        Assert.Equal("ing-nl", manifest.Id);
        Assert.Equal(ProviderKind.Bank, manifest.Kind);

        // Credentials, then approval in the provider's app - which is what the
        // capture showed: a password POST, then a push session polled until it
        // turned READY.
        Assert.Equal(AuthFlow.MobileApproval, manifest.Auth.Flow);
        Assert.Equal([ChallengeType.AppApproval], manifest.Auth.Challenges);

        // ING wants a second factor on EVERY sign-in and nothing this connector
        // holds can renew that, so an unattended nightly sync is not offerable.
        Assert.False(manifest.UnattendedFetch);
        Assert.False(manifest.Auth.Session.Refreshable);
        Assert.Equal(900, manifest.Auth.Session.TtlSeconds);

        // THE ACCOUNT HOLDER ASKED FOR THIS. ING's fraud detection notices an
        // account that signs in repeatedly and never signs out.
        Assert.Equal(LogoutSupport.Session, manifest.Logout);

        // EPHEMERAL rather than None. A web user does meet a full sign-in every
        // visit, but so does DUO's, and None makes the platform refuse a web
        // session outright - which is a kill switch, not a warning.
        Assert.Equal(WebSupport.Ephemeral, manifest.WebSupport);

        // The capture ran as the agent's default phone emulation, down to
        // `senderref=MOBIEL` in ING's own cursor links.
        Assert.False(manifest.Agent.DesktopBrowser);

        var password = Assert.Single(manifest.Auth.AllFields(), f => f.Key == "password");
        Assert.True(password.Secret, "an unmarked password is logged and screenshotted");
    }
}
