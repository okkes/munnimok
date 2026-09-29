using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// Which calls the fetch makes, which it refuses to make, and what a bad
/// answer means.
///
/// All three are decisions rather than plumbing, and none of them should need a
/// browser and a citizen's DigiD to exercise - which is what the portal seam is
/// for.
/// </summary>
public sealed class DuoFetchTests
{
    private static readonly DuoOptions Options = new();

    private static DuoAdapter Adapter() =>
        new(Options, new FixedTimeProvider(new DateTimeOffset(2026, 8, 10, 12, 0, 0, TimeSpan.Zero)));

    private static ResourceRequest Debt(params string[] include) => new()
    {
        ResourceId = DuoAdapter.DebtResource,
        Selections = include.Length == 0
            ? new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            : new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                [ResourceRequest.IncludeParam] = include,
            },
    };

    /// <summary>
    /// THE SECOND BUG THAT SHIPPED, as a test.
    ///
    /// Every read goes through the page's own <c>fetch</c>, which is
    /// same-origin only while the page is on DUO. A browser restored from a
    /// cookie jar starts on <c>about:blank</c>, where all three reads are
    /// cross-origin requests that die as <c>TypeError: Failed to fetch</c> -
    /// and reached a user as "Something broke on our side, HTTP 500".
    /// </summary>
    [Fact]
    public async Task The_portal_is_opened_before_anything_is_read()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(["https://mijn.duo.nl/"], portal.Opened);
    }

    /// <summary>
    /// And where that navigation lands is the cheapest session check there is:
    /// signed out, DUO bounces it into the SAML chain. Caught here it is one
    /// navigation and a clear answer; caught later it is three failed fetches
    /// and a guess about why.
    /// </summary>
    [Fact]
    public async Task A_navigation_that_lands_in_the_login_chain_is_a_dead_session()
    {
        var portal = StubDuoPortal.Answering()
            .LandingOn("https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?ForceAuthn=true");

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);

        // Nothing was read, because there was nothing to read from.
        Assert.Empty(portal.Requested);
    }

    [Fact]
    public async Task A_fetch_reads_only_the_narrow_endpoints_and_never_the_dossier()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        // The session endpoint FIRST, which is the order the portal itself
        // uses: in the capture sessietoken/rest/jwt precedes every other
        // service call the dashboard makes. Skipping it got a 401 back from
        // the debt endpoint on a browser that had signed in seconds earlier.
        Assert.Equal(
            [
                "https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/mijn-schulden",
                "https://mijn.duo.nl/particulier/services/pfd/json/schulden",
                // WITH the peildatum. DUO 400s without one, and this connector
                // spent a live fetch discovering that because the query string
                // was stripped while the capture's urls were being mapped.
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/"
                + "resterend-aantal-maanden-aflosvrij?peildatum=2026-08-10",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/schuldhistorie",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/"
                + "bepalen-grondslaggegevens-over-periode?request=eyJiZWdpbm1hYW5kUGVyaW9kZSI6IjIwMjYtMDgiLCJlaW5kbWFh"
                + "bmRQZXJpb2RlIjoiMjAyNi0wOSIsImdyb25kc2xhZ2dlZ2V2ZW5zIjpbeyJkZWZpbml0aWVOYWFtIjoiUkVTVEVSRU5EX0FBTlRB"
                + "TF9NQUFOREVOX0FGTE9TRkFTRSIsImNvbnRleHRJZCI6IjEifV0sIm5vcm1lblZlcmxlbmdlbiI6dHJ1ZX0%3D",
            ],
            portal.Requested);

        // The whole list, checked as a list. klantbeeld is refused in code, and
        // this is the other half of that: no call this fetch makes is the
        // dossier by another name.
        Assert.DoesNotContain(portal.Requested, u => u.Contains("klantbeeld", StringComparison.Ordinal));

        var debt = Assert.Single(result.Debts);
        Assert.Equal(1_243_477, debt.Total.Value);

        // And the answer arrives, rather than being lost to a 400 nobody saw.
        Assert.Equal(60, debt.PaymentHolidayMonthsRemaining);

        // One record for the whole position, and it is the only kind of record
        // this provider emits.
        Assert.Equal(1, result.Count);
        Assert.True(result.Complete);
    }

    /// <summary>
    /// THE LEDGER IS OPT-IN, and this is the test that keeps the connector's
    /// original promise intact now that the dossier can be reached at all.
    ///
    /// Every movement DUO has booked exists in exactly one place, and that
    /// place also holds a BSN, both parents, twenty years of tax income, IBANs
    /// and every address the account holder has lived at. Asking for the ledger
    /// means that request is made. Not asking must mean it never is.
    /// </summary>
    [Fact]
    public async Task A_fetch_that_did_not_ask_for_the_ledger_never_reads_the_dossier()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.DoesNotContain(portal.Requested, u => u.Contains("klantbeeld", StringComparison.Ordinal));
        Assert.Empty(Assert.Single(result.Debts).Ledger);
    }

    [Fact]
    public async Task A_fetch_that_asked_for_the_ledger_reads_it_and_says_so()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var result = await Adapter()
            .FetchAsync(ctx, Debt(ResourceRequest.LedgerInclude), portal, CancellationToken.None);

        Assert.Contains(portal.Requested, u => u.EndsWith("raadplegen/klantbeeld", StringComparison.Ordinal));

        // Said out loud in the operator log. A connector that reaches a
        // dossier should never do it quietly, even when it was asked to.
        Assert.Contains(ctx.Notes, n => n.Contains("whole customer dossier", StringComparison.Ordinal));

        var ledger = Assert.Single(result.Debts).Ledger;
        Assert.NotEmpty(ledger);
    }

    /// <summary>
    /// And the refusal still stands for everything else. The dossier is
    /// reachable through exactly one call site, which had to be written on
    /// purpose - not by somebody deleting a check.
    /// </summary>
    [Fact]
    public async Task The_dossier_is_still_refused_to_an_ordinary_read()
    {
        var portal = StubDuoPortal.Answering();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => DuoCalls.ReadAsync(
                portal, Options, "pfd/json/raadplegen/klantbeeld", required: false, CancellationToken.None));

        Assert.Empty(portal.Requested);
    }

    /// <summary>
    /// The rule that exists in code rather than in a design document, because
    /// a design document cannot stop whoever adds the fourth endpoint.
    ///
    /// <c>raadplegen/klantbeeld</c> answers with 2.5 MB carrying a BSN, both
    /// parents, a partner, twenty years of tax income, IBANs and every address
    /// somebody has lived at - and DUO's own portal calls it to draw a debt
    /// page, which is exactly why the temptation is real.
    /// </summary>
    [Fact]
    public async Task The_customer_dossier_is_refused_by_this_connector()
    {
        var portal = StubDuoPortal.Answering();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => DuoCalls.ReadAsync(
                portal, Options, "pfd/json/raadplegen/klantbeeld", required: true, CancellationToken.None));

        Assert.Contains("klantbeeld", error.Message, StringComparison.Ordinal);

        // Refused before anything is sent. A request that went out and was
        // then discarded would already have put the dossier on the wire and in
        // DUO's logs against this connector's name.
        Assert.Empty(portal.Requested);

        // Deliberately NOT a ConnectorException: that type means a provider
        // did something, and this is our own code asking for what it must not.
        Assert.IsNotType<ConnectorException>(error);
    }

    [Fact]
    public async Task An_unknown_resource_is_unsupported_rather_than_empty()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt() with { ResourceId = "credits" }, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, error.Code);
        Assert.Empty(portal.Requested);
    }

    // ---- a session that is over ---------------------------------------------

    /// <summary>
    /// The shape a dead session takes here, and the reason the reading carries
    /// its final url: a signed-out visitor is not refused, they are BOUNCED -
    /// into DUO's SAML chain, which answers 200 with a login page. A reader
    /// that looked only at the status would hand that HTML to the parser and
    /// report the provider as rebuilt, sending the user to wait for an engineer
    /// when what they need is a sign-in button.
    /// </summary>
    [Fact]
    public async Task A_bounce_into_the_sign_in_chain_is_a_dead_session_and_not_a_changed_provider()
    {
        var portal = StubDuoPortal.Bouncing(
            "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?ForceAuthn=true");

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.NotEqual(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public async Task A_bounce_all_the_way_to_digid_is_also_a_dead_session()
    {
        var portal = StubDuoPortal.Bouncing("https://login.digid.nl/inloggen");
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
    }

    /// <summary>
    /// THE READING THAT COST FOUR DIGID SIGN-INS IN ONE DAY, corrected.
    ///
    /// On 2026-09-20 two live runs against the real DUO each got a 200 and
    /// <c>{"profiel":"PP",…}</c> out of <c>sessietoken/rest/jwt</c>, then 200s
    /// with real figures out of the next two or three calls, and then a 401 -
    /// which this adapter reported as <c>session_expired</c> and which the
    /// account holder read as "This connection has expired. Sign in again."
    /// DUO had said the opposite about itself, in the line above it, in the
    /// same second.
    ///
    /// It is not a pedantic correction. DUO's SAML request carries
    /// <c>ForceAuthn</c>, so every needless "sign in again" is a full DigiD
    /// authentication that Logius counts, against the citizen's own account.
    /// <see cref="ErrorCode.SessionExpired"/> is the one code in the catalogue
    /// that tells a consumer <see cref="UserAction.Reauth"/>, and that
    /// instruction was both wrong and expensive here.
    /// </summary>
    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task A_refusal_after_DUO_has_named_the_profile_is_a_changed_provider(int status)
    {
        var portal = StubDuoPortal.Failing(status);
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.NotEqual(ErrorCode.SessionExpired, error.Code);

        // The half that reaches the person on the other end: an operator is
        // paged and nobody is sent back to DigiD.
        Assert.Equal(UserAction.Wait, ErrorCatalog.ActionFor(error.Code));

        // And the message states what was observed rather than what was
        // guessed - which is the whole difference between this and the
        // sentence it replaces.
        Assert.Contains(Options.SessionPath, error.Message, StringComparison.Ordinal);
        Assert.Contains("had already answered 200 and named a profile", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// And the old reading is still there for the case it was always right
    /// about: a refusal when nothing has confirmed a session in this run.
    ///
    /// That is the path DUO's own session call takes, and a browser whose
    /// session really has ended is refused exactly like this. Told apart by
    /// evidence rather than by status, so being right about the expensive case
    /// does not mean being wrong about the cheap one.
    /// </summary>
    [Fact]
    public async Task A_refusal_with_no_session_confirmed_in_this_run_is_still_a_dead_session()
    {
        var portal = StubDuoPortal.Failing(401, """{"error":"unauthorized"}""");

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => DuoCalls.ReadAsync(
                portal, Options, Options.DebtPath, required: true, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Equal(UserAction.Reauth, ErrorCatalog.ActionFor(error.Code));
        Assert.Contains("nothing has confirmed a session in this run", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A refusal on an ENRICHMENT call costs the enrichment and nothing else,
    /// now that it is no longer being read as a dead session.
    ///
    /// This is the shape both failed runs actually had. Run A lost the payment
    /// holiday; run B lost the balance history. In both, the required amounts
    /// had already come back 200 with the account holder's real figures - and
    /// in both, the fetch threw them away and asked for another DigiD. The
    /// rule this file has kept for every other bad status was simply being
    /// routed around by a special case for 401.
    /// </summary>
    [Fact]
    public async Task An_enrichment_call_refused_after_a_confirmed_session_costs_only_the_enrichment()
    {
        var portal = StubDuoPortal.Answering();
        portal.Break(Options.HistoryPath, 401);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        var debt = Assert.Single(result.Debts);

        // The money survives, exactly.
        Assert.Equal(1_243_477, debt.Total.Value);

        // And the one thing that endpoint carried does not.
        Assert.Null(debt.AsOf);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("the amounts stand and the fetch carries on", StringComparison.Ordinal));
    }

    /// <summary>
    /// A refusal from the portal and a bounce into the sign-in chain are
    /// DIFFERENT THINGS and no longer share a sentence.
    ///
    /// They did, and the shared sentence was wrong where it mattered: a 401
    /// from the portal's own services url was reported as "which is the
    /// sign-in chain rather than the portal", with DUO's session endpoint
    /// answering a healthy 200 on the line above. An error that asserts
    /// something the log contradicts sends the next reader to the wrong place.
    /// </summary>
    [Fact]
    public async Task A_refusal_from_the_portal_does_not_claim_to_be_the_sign_in_chain()
    {
        var portal = StubDuoPortal.Failing(401);
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.DoesNotContain("sign-in chain", error.Message, StringComparison.Ordinal);
        Assert.Contains("the portal's own services", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// DUO's own words for a refusal, quoted into the log.
    ///
    /// A gateway that refuses a call usually says what was missing, and that
    /// sentence is the difference between another live DigiD sign-in and an
    /// answer - DUO answered one of these with 163 characters that nobody had
    /// ever read.
    /// </summary>
    [Fact]
    public async Task A_refusal_is_quoted_so_the_reason_can_be_read()
    {
        const string Refusal = """{"error":"unauthorized","message":"missing token"}""";

        var portal = StubDuoPortal.Failing(401, Refusal);
        using var ctx = new FakeJobContext();

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Contains(ctx.Notes, n => n.Contains("missing token", StringComparison.Ordinal));
    }

    /// <summary>
    /// And a body big enough to be a page is capped, so a redesigned portal
    /// answering HTML cannot empty itself into an operator's terminal.
    /// </summary>
    [Fact]
    public async Task A_refusal_the_size_of_a_web_page_is_capped()
    {
        var portal = StubDuoPortal.Failing(500, new string('x', 20_000));
        using var ctx = new FakeJobContext();

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.All(ctx.Notes, n => Assert.True(n.Length < 600, $"a note ran to {n.Length} characters"));
    }

    // ---- a call a navigation interrupted ------------------------------------

    /// <summary>
    /// A CALL A NAVIGATION KILLED DID NOT FAIL - IT WAS INTERRUPTED.
    ///
    /// Two live runs on 2026-09-20 each lost exactly one call this way. Run A
    /// lost <c>pfd/json/schulden</c> to "TypeError: Failed to fetch", raised
    /// through DUO's own polyfill bundle; run B got a 200 out of that same
    /// call and lost the next one instead, with Playwright naming the
    /// mechanism outright - "Execution context was destroyed, most likely
    /// because of a navigation". So the call that dies is not a particular
    /// endpoint: DUO's page moves under the sequence, and whatever is in
    /// flight at that moment is what is lost.
    ///
    /// Nothing reached DUO, so nothing was served and nothing can have been
    /// half-applied - and every call here is a GET in any case. Asking again
    /// costs DUO one request and the account holder nothing, where letting it
    /// stand cost them a DigiD.
    /// </summary>
    [Theory]
    [InlineData(StubDuoPortal.ContextDestroyed)]
    [InlineData(StubDuoPortal.FailedToFetch)]
    public async Task A_call_a_navigation_interrupted_is_asked_once_more_and_the_fetch_completes(string reason)
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(Options.PositionsPath, reason: reason);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(2, portal.Requested.Count(u => u.EndsWith(Options.PositionsPath, StringComparison.Ordinal)));

        var debt = Assert.Single(result.Debts);

        Assert.Equal(1_243_477, debt.Total.Value);

        // The second ask answered, and what it carried reached the record.
        // Before this, an interrupted enrichment call simply went missing.
        Assert.Equal(2.57m, debt.InterestRate);
    }

    /// <summary>
    /// And the token is still on the second ask, which is the point of moving
    /// the carry into the origin's session store.
    ///
    /// The 401s that ended both runs came back with no <c>authorization</c>
    /// header on the RESPONSE, and the notes could not say whether the request
    /// that earned them had presented one - that had to be inferred. It no
    /// longer does: every line now says what the request carried.
    /// </summary>
    [Fact]
    public async Task The_token_still_reaches_the_call_that_a_navigation_interrupted()
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(Options.PositionsPath);

        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        var again = ctx.Notes.Single(n => n.Contains("(asked again)", StringComparison.Ordinal));

        Assert.Contains($"{Options.PositionsPath} (asked again) -> 200", again, StringComparison.Ordinal);
        Assert.Contains("sent [accept authorization]", again, StringComparison.Ordinal);
    }

    /// <summary>
    /// ONCE, AND THE BOUND IS WHERE IT IS ON PURPOSE.
    ///
    /// The first retry wins the ordinary case, because the navigation has
    /// landed by then. A second interruption of the same call means the page
    /// is still moving, and a loop would be this adapter racing a redirect on
    /// a job that is already spending somebody's DigiD - so the second reading
    /// is reported, whatever it says.
    /// </summary>
    [Fact]
    public async Task A_call_a_navigation_keeps_interrupting_is_asked_once_more_and_no_more()
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(Options.PositionsPath, times: 5);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(2, portal.Requested.Count(u => u.EndsWith(Options.PositionsPath, StringComparison.Ordinal)));

        // Enrichment, so the fetch survives losing it - with the rate missing
        // and the log saying so, which is the rule this file already keeps.
        var debt = Assert.Single(result.Debts);

        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Null(debt.InterestRate);
    }

    /// <summary>
    /// What the next run has to be able to say without anybody asking: the
    /// browser's own words for why the call never landed, and where the page
    /// went.
    /// </summary>
    /// <remarks>
    /// The destination is the observation that separates the two cases - a
    /// move inside the portal costs a token and is recoverable, a move out to
    /// DigiD is a session that ended. It is logged with the query cut off,
    /// because that is where a SAMLRequest lives and an operator's terminal is
    /// not the place for one.
    /// </remarks>
    [Fact]
    public async Task An_interrupted_call_reports_the_browsers_own_words_and_where_the_page_went()
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(
            Options.PositionsPath,
            landedOn: "https://mijn.duo.nl/particulier/portaal/dashboard?SAMLRequest=fZJNb9swDIb");

        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        var lost = ctx.Notes.Single(n => n.Contains("never landed", StringComparison.Ordinal));

        Assert.Contains(StubDuoPortal.ContextDestroyed, lost, StringComparison.Ordinal);
        Assert.Contains(
            "the page is now on https://mijn.duo.nl/particulier/portaal/dashboard,",
            lost,
            StringComparison.Ordinal);

        Assert.All(ctx.Notes, n => Assert.DoesNotContain("SAMLRequest", n, StringComparison.Ordinal));
    }

    /// <summary>
    /// And a navigation that carried the browser OUT to the sign-in chain is
    /// not retried at all.
    ///
    /// That is not a lost token, it is a session that ended: a fetch at DUO's
    /// services from DigiD's origin is refused by the browser before a token
    /// would matter. Retrying it would be racing a redirect that has already
    /// won, and would turn the one shape this connector can honestly call
    /// <c>session_expired</c> into a second wasted call.
    /// </summary>
    [Fact]
    public async Task A_navigation_that_carried_the_browser_into_the_sign_in_chain_is_not_retried()
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(Options.DebtPath, landedOn: StubDuoPortal.SignInChain);

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Contains(
            "never landed, because the page left for the sign-in chain",
            error.Message,
            StringComparison.Ordinal);

        Assert.Equal(1, portal.Requested.Count(u => u.EndsWith(Options.DebtPath, StringComparison.Ordinal)));
    }

    // ---- required versus enrichment -----------------------------------------

    [Fact]
    public async Task A_failure_on_the_amounts_stops_the_fetch()
    {
        var portal = StubDuoPortal.Answering();
        portal.Break(Options.DebtPath, 500);

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    /// <summary>
    /// And a failure on the extras costs only the extras. Every fetch here
    /// costs a human a DigiD sign-in, so throwing away a balance because an
    /// interest rate did not arrive is an expensive way to say nothing.
    /// </summary>
    [Fact]
    public async Task A_failure_on_the_extras_costs_only_the_extras_and_says_so()
    {
        var portal = StubDuoPortal.Answering();
        portal.Break(Options.PositionsPath, 500);
        portal.Break(Options.PaymentHolidayPath, 500);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        var debt = Assert.Single(result.Debts);

        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Null(debt.InterestRate);
        Assert.Null(debt.PaymentHolidayMonthsRemaining);

        // A record that lost its rate and a provider that states none look
        // identical from outside. Only the note tells them apart, and without
        // one this is diagnosed by reading a database.
        Assert.Contains(
            ctx.Notes,
            n => n.Contains(Options.PositionsPath, StringComparison.Ordinal)
                 && n.Contains("500", StringComparison.Ordinal));

        Assert.Contains(ctx.Notes, n => n.Contains("gave nothing", StringComparison.Ordinal));
    }

    /// <summary>
    /// EVERY call leaves a line, not just the failures.
    ///
    /// This test used to assert the opposite - that a healthy fetch is silent -
    /// and that was the wrong goal. Three separate faults in this adapter were
    /// each diagnosed from one line of agent log, and every time the question
    /// was the same: which call, and what did it answer. A silent success tells
    /// whoever reads the log next to nothing.
    /// </summary>
    [Fact]
    public async Task Every_call_leaves_its_path_and_status_in_the_log()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(6, ctx.Notes.Count);
        Assert.All(ctx.Notes, n => Assert.Contains("200", n, StringComparison.Ordinal));

        foreach (var path in new[]
                 {
                     Options.SessionPath, Options.DebtPath, Options.PositionsPath, Options.PaymentHolidayPath,
                     Options.HistoryPath, Options.GrondslagPath,
                 })
        {
            Assert.Contains(ctx.Notes, n => n.Contains(path, StringComparison.Ordinal));
        }
    }

    /// <summary>
    /// A log line is not a place for a SAMLRequest. The path says which call it
    /// was, which is the whole diagnostic value; the url after a bounce carries
    /// an authentication request and belongs nowhere near an operator's
    /// terminal.
    /// </summary>
    [Fact]
    public async Task The_log_names_the_path_and_never_the_landing_url()
    {
        var portal = StubDuoPortal.Bouncing(
            "https://login.digid.nl/saml/v4/entrance/request_authentication?SAMLRequest=fZJNb9swDIb");

        using var ctx = new FakeJobContext();

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.All(ctx.Notes, n => Assert.DoesNotContain("SAMLRequest", n, StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, n => n.Contains("from the sign-in chain", StringComparison.Ordinal));
    }

    /// <summary>
    /// The 401 that came back on a browser which had signed in seven seconds
    /// earlier and was sitting on the portal with its cookies restored.
    ///
    /// It is reported against the session endpoint now rather than the debt
    /// one, which is both the truth and a better sentence: "DUO says nobody is
    /// signed in" is diagnosable, "the debt endpoint refused us" leaves a
    /// reader guessing whether the session died or the endpoint moved.
    /// </summary>
    [Fact]
    public async Task A_portal_that_names_no_session_stops_the_fetch_before_the_data_calls()
    {
        var portal = StubDuoPortal.WithNoSession();
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);

        // The session endpoint and nothing after it.
        Assert.Equal(
            ["https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt"],
            portal.Requested);
    }

    // ---- raw ----------------------------------------------------------------

    [Fact]
    public async Task The_providers_own_payload_travels_only_when_it_was_asked_for()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var quiet = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);
        Assert.Empty(quiet.Raw);

        var asked = await Adapter()
            .FetchAsync(ctx, Debt(ResourceRequest.RawInclude), portal, CancellationToken.None);

        var raw = Assert.Single(asked.Raw);
        Assert.Equal(DuoAdapter.DebtResource, raw.Key);
        Assert.Contains("schuldbedragLening", raw.Value, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_fetch_reports_its_progress_in_order()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(
            [JobStep.Downloading, JobStep.Parsing, JobStep.Normalizing],
            ctx.Steps);
    }
}

/// <summary>
/// DUO's JSON API, without DUO. Answers the recorded payloads by path and can
/// be told to fail, to bounce, to land somewhere else, to be interrupted by a
/// navigation, or to deny that anybody is signed in.
/// </summary>
internal sealed class StubDuoPortal : IDuoPortal
{
    /// <summary>DUO's own answer when there is a session, verbatim from the capture.</summary>
    public const string SessionJson =
        """{"profiel":"PP","nieuwToken":true,"timeout":900,"modus":null,"isGemachtigd":false,"authRealm":null}""";

    /// <summary>What the same endpoint answers when nobody is signed in: DUO's sign-in page.</summary>
    public const string SignInPage = "<html><body>Inloggen bij DUO</body></html>";

    /// <summary>Where DUO sends a browser it has no session for.</summary>
    public const string SignInChain =
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?Target=https://mijn.duo.nl:443/" +
        "particulier/portaal/dashboard&ForceAuthn=true";

    /// <summary>
    /// Playwright's own words when DUO's page moves under a fetch, verbatim
    /// from the live run of 2026-09-20 20:58.
    /// </summary>
    public const string ContextDestroyed =
        "Execution context was destroyed, most likely because of a navigation";

    /// <summary>
    /// The same event a moment earlier, from the run of 20:54: the navigation
    /// aborts a request that is already in flight, and DUO's own polyfill
    /// bundle reports it as the browser's generic fetch failure.
    /// </summary>
    public const string FailedToFetch = "TypeError: Failed to fetch";

    /// <summary>
    /// The header name the whole diagnosis turned on. Every 200 from DUO's
    /// services carried it; neither 401 did.
    /// </summary>
    public const string TokenHeader = "authorization";

    private readonly Dictionary<string, int> _broken = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _interrupts = new(StringComparer.Ordinal);
    private readonly List<string> _requested = [];
    private readonly List<string> _opened = [];
    private readonly List<TimeSpan> _waited = [];

    /// <summary>
    /// What this browser is carrying forward, by header name.
    /// </summary>
    /// <remarks>
    /// The stub keeps a carry at all because the thing being tested is what
    /// happens ACROSS a navigation, and a portal that presented the same
    /// headers on every call could not tell the fixed behaviour from the
    /// broken one. What it models is the contract this adapter now claims:
    /// DUO hands a token back on a 200, the next request presents it, and an
    /// interruption does not throw it away. The half that DELIVERS that -
    /// keeping the carry in the origin's session store rather than on
    /// <c>window</c> - lives in a string only Chromium can run, and is pinned
    /// at that end by <c>DuoCarryTests</c>.
    /// </remarks>
    private readonly List<string> _carry = [];

    private readonly string? _bounceTo;
    private readonly int _status;
    private readonly string _refusal;
    private string _interruptReason = ContextDestroyed;
    private string? _interruptLanding;

    private StubDuoPortal(string? bounceTo, int status, string refusal = "")
    {
        _bounceTo = bounceTo;
        _status = status;
        _refusal = refusal;
    }

    /// <summary>Every url the adapter actually asked for, in order.</summary>
    public IReadOnlyList<string> Requested => _requested;

    /// <summary>Every url the adapter navigated to, in order.</summary>
    public IReadOnlyList<string> Opened => _opened;

    /// <summary>Every patience the adapter spent waiting for the bounce, in order.</summary>
    public IReadOnlyList<TimeSpan> Waited => _waited;

    /// <summary>
    /// How long this browser takes to leave DUO for the sign-in chain, or null
    /// when it never does - which is what being signed in looks like from
    /// outside.
    /// </summary>
    /// <remarks>
    /// ZERO BY DEFAULT, because every other login fixture in this suite is a
    /// browser on its way to DigiD: they show DUO's chooser, DigiD's method
    /// list and DigiD's own form, which is a page nobody reaches without
    /// having been bounced there first. A default of "never bounces" would
    /// quietly turn all of them into profiles that were already signed in.
    /// <para>
    /// A wait whose budget is shorter than this runs out with the browser
    /// still on DUO's own pages, which is the only way a fixture can state
    /// that the window is the right LENGTH rather than merely present.
    /// </para>
    /// </remarks>
    public TimeSpan? BouncesAfter { get; set; } = TimeSpan.Zero;

    public Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct)
    {
        _waited.Add(patience);

        if (BouncesAfter is not { } after || patience < after) return Task.FromResult(false);

        // THE BROWSER WENT WHERE IT WENT. A stub that answered yes and left
        // its own landing address on the dashboard would model a bounce no
        // browser has ever performed.
        Landing = SignInChain;

        return Task.FromResult(true);
    }

    /// <summary>Where a navigation ends up. Signed in, that is the portal.</summary>
    public string Landing { get; private set; } = "https://mijn.duo.nl/particulier/portaal/dashboard";

    /// <summary>Whether DUO's session endpoint names a profile.</summary>
    public bool HasSession { get; private set; } = true;

    public static StubDuoPortal Answering() => new(null, 200);

    /// <summary>A signed-out visitor: 200, but from the sign-in chain.</summary>
    public static StubDuoPortal Bouncing(string to) => new(to, 200);

    public static StubDuoPortal Failing(int status, string refusal = "") => new(null, status, refusal);

    /// <summary>
    /// The transient state that shipped a broken login: the browser IS on a
    /// portal address, and DUO says nobody is signed in - because the redirect
    /// to the dashboard happens before the bounce into SAML.
    /// </summary>
    public static StubDuoPortal WithNoSession()
    {
        var portal = new StubDuoPortal(null, 200);
        portal.HasSession = false;

        return portal;
    }

    /// <summary>
    /// A profile that is STILL INSIDE DUO: the browser never leaves the
    /// portal, and DUO names a profile when it is asked.
    /// </summary>
    /// <remarks>
    /// The state a kept browser profile exists to produce, and the one no
    /// fixture here could express before: every other portal in this suite
    /// models a browser on its way to DigiD.
    /// </remarks>
    public static StubDuoPortal Inside()
    {
        var portal = new StubDuoPortal(null, 200);
        portal.BouncesAfter = null;

        return portal;
    }

    public StubDuoPortal LandingOn(string url)
    {
        Landing = url;
        return this;
    }

    public void Break(string path, int status) => _broken[path] = status;

    /// <summary>
    /// Make the next <paramref name="times"/> reads of this route die the way
    /// DUO's own page killed one on 2026-09-20: nothing reaches DUO, the
    /// browser complains in its own words, and the page is somewhere else
    /// afterwards.
    /// </summary>
    /// <param name="landedOn">
    /// Where the navigation took the page. Defaults to wherever this browser
    /// already was, which is what a same-origin move inside the portal looks
    /// like; pass <see cref="SignInChain"/> for the navigation that is a dead
    /// session rather than a lost token.
    /// </param>
    public void Interrupt(string path, int times = 1, string? reason = null, string? landedOn = null)
    {
        _interrupts[path] = times;
        _interruptReason = reason ?? ContextDestroyed;
        _interruptLanding = landedOn;
    }

    public Task<string> OpenAsync(string url, CancellationToken ct)
    {
        _opened.Add(url);

        return Task.FromResult(Landing);
    }

    /// <summary>
    /// What the page shape probe hands back, or a thrown exception instead.
    /// </summary>
    /// <remarks>
    /// The THROWING half is not padding. This probe only ever runs inside a
    /// catch clause on its way to the streamed hand-over, and this tier has
    /// already shipped a second exception escaping that path twice - both times
    /// reaching the account holder as "This login failed" at the "Signing in"
    /// step, which is the one outcome the whole tier exists to be incapable of.
    /// A stub that could only succeed could not state that a broken instrument
    /// costs nothing.
    /// </remarks>
    public Exception? DescribeThrows { get; set; }

    /// <summary>
    /// A shape in the form PageShape really produces - the page's address, then
    /// its structure - short enough to assert on whole.
    /// </summary>
    public string Shape { get; set; } =
        "at https://login.digid.nl/inloggen_methode | headings Hoe wilt u inloggen? | inputs (none)";

    public Task<string> DescribeAsync(CancellationToken ct)
    {
        if (DescribeThrows is { } ex) throw ex;

        return Task.FromResult(Shape);
    }

    public Task<DuoReading> ReadAsync(string url, CancellationToken ct)
    {
        _requested.Add(url);

        // On the ROUTE, not the whole url: the payment-holiday call carries a
        // peildatum query now, so anything keyed on the bare path would
        // quietly stop applying to it.
        var route = url.Split('?')[0];

        // THE NAVIGATION, MODELLED WHERE IT REALLY HAPPENS - in the browser,
        // before the request is on the wire. DUO is never asked, so nothing
        // there can have been served, which is why the adapter is free to ask
        // again. The carry is untouched on the way through: that is the
        // property the fix buys, and a stub that cleared it here would be
        // modelling the bug.
        var interrupted = _interrupts.FirstOrDefault(i => route.EndsWith(i.Key, StringComparison.Ordinal));

        if (interrupted.Key is not null && interrupted.Value > 0)
        {
            _interrupts[interrupted.Key] = interrupted.Value - 1;

            return Task.FromResult(new DuoReading(
                0, _interruptLanding ?? Landing, null, Sent: Sent(), NotReached: _interruptReason));
        }

        if (url.EndsWith("sessietoken/rest/jwt", StringComparison.Ordinal))
        {
            return Task.FromResult(HasSession ? Answered(url, SessionJson) : Answered(url, SignInPage));
        }

        if (_bounceTo is not null)
        {
            return Task.FromResult(new DuoReading(
                _status, _bounceTo, "<html>Inloggen</html>", Headers: [], Sent: Sent()));
        }

        foreach (var (path, status) in _broken)
        {
            if (route.EndsWith(path, StringComparison.Ordinal)) return Task.FromResult(Refused(url, status, string.Empty));
        }

        if (_status != 200) return Task.FromResult(Refused(url, _status, _refusal));

        // DUO's own refusal, reproduced. The payment-holiday endpoint takes a
        // peildatum and 400s without one, which this connector did not know:
        // the query string was stripped while mapping the capture's urls, so
        // the call silently failed on every fetch and the record carried no
        // payment holiday at all. A stub that answered regardless would let
        // that happen again.
        if (route.EndsWith("resterend-aantal-maanden-aflosvrij", StringComparison.Ordinal)
            && !url.Contains("peildatum=", StringComparison.Ordinal))
        {
            return Task.FromResult(Refused(
                url,
                400,
                """{"detail":"Required parameter 'peildatum' is not present.","status":400,"title":"Bad Request"}"""));
        }

        return Task.FromResult(Answered(url, Body(route)));
    }

    /// <summary>What this request presented, by name. Accept always, and the token once DUO has issued one.</summary>
    private string[] Sent() => ["accept", .. _carry];

    /// <summary>
    /// A 200 from DUO's services, with the headers the live runs recorded on
    /// one: DUO states a session timeout on every answer, and mints the token
    /// the next request has to send back.
    /// </summary>
    private DuoReading Answered(string url, string body)
    {
        var sent = Sent();

        if (!_carry.Contains(TokenHeader)) _carry.Add(TokenHeader);

        return new DuoReading(
            200, url, body, Headers: ["content-type", "session-timeout", TokenHeader], Sent: sent);
    }

    /// <summary>
    /// A refusal, with NO token on it - which is what both failed runs
    /// recorded and is how a 401 earned by a missing header looks from
    /// outside.
    /// </summary>
    private DuoReading Refused(string url, int status, string body) =>
        new(status, url, body, Headers: ["content-type", "session-timeout"], Sent: Sent());

    private static string Body(string path) => path switch
    {
        var u when u.EndsWith("raadplegen/mijn-schulden", StringComparison.Ordinal) =>
            Fixture.Read("duo/mijn-schulden.json"),
        var u when u.EndsWith("json/schulden", StringComparison.Ordinal) =>
            Fixture.Read("duo/schulden.json"),
        var u when u.EndsWith("resterend-aantal-maanden-aflosvrij", StringComparison.Ordinal) =>
            Fixture.Read("duo/resterend-aantal-maanden-aflosvrij.json"),
        var u when u.EndsWith("raadplegen/schuldhistorie", StringComparison.Ordinal) =>
            Fixture.Read("duo/schuldhistorie.json"),
        var u when u.EndsWith("bepalen-grondslaggegevens-over-periode", StringComparison.Ordinal) =>
            Fixture.Read("duo/grondslaggegevens.json"),
        var u when u.EndsWith("raadplegen/klantbeeld", StringComparison.Ordinal) =>
            Fixture.Read("duo/klantbeeld-reduced.json"),
        _ => throw new InvalidOperationException($"the fixture portal was asked for '{path}', which it has no answer for"),
    };
}
