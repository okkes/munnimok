using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

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

    // reads use the page's own fetch, same-origin only on DUO; a browser restored from a cookie jar starts on about:blank,
    // where all three die as "Failed to fetch"
    [Fact]
    public async Task The_portal_is_opened_before_anything_is_read()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(["https://mijn.duo.nl/"], portal.Opened);
    }

    // where that navigation lands is the cheapest session check: signed out, DUO bounces it into the SAML chain
    [Fact]
    public async Task A_navigation_that_lands_in_the_login_chain_is_a_dead_session()
    {
        var portal = StubDuoPortal.Answering()
            .LandingOn("https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?ForceAuthn=true");

        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);

        Assert.Empty(portal.Requested);
    }

    [Fact]
    public async Task A_fetch_reads_only_the_narrow_endpoints_and_never_the_dossier()
    {
        var portal = StubDuoPortal.Answering();
        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        // session endpoint first, as the portal does: skipping it got a 401 from the debt endpoint
        Assert.Equal(
            [
                "https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/mijn-schulden",
                "https://mijn.duo.nl/particulier/services/pfd/json/schulden",
                // DUO 400s without the peildatum
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/"
                + "resterend-aantal-maanden-aflosvrij?peildatum=2026-08-10",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/schuldhistorie",
                "https://mijn.duo.nl/particulier/services/pfd/json/raadplegen/"
                + "bepalen-grondslaggegevens-over-periode?request=eyJiZWdpbm1hYW5kUGVyaW9kZSI6IjIwMjYtMDgiLCJlaW5kbWFh"
                + "bmRQZXJpb2RlIjoiMjAyNi0wOSIsImdyb25kc2xhZ2dlZ2V2ZW5zIjpbeyJkZWZpbml0aWVOYWFtIjoiUkVTVEVSRU5EX0FBTlRB"
                + "TF9NQUFOREVOX0FGTE9TRkFTRSIsImNvbnRleHRJZCI6IjEifV0sIm5vcm1lblZlcmxlbmdlbiI6dHJ1ZX0%3D",
            ],
            portal.Requested);

        // no call this fetch makes may be the dossier (klantbeeld) by another name
        Assert.DoesNotContain(portal.Requested, u => u.Contains("klantbeeld", StringComparison.Ordinal));

        var debt = Assert.Single(result.Debts);
        Assert.Equal(1_243_477, debt.Total.Value);

        Assert.Equal(60, debt.PaymentHolidayMonthsRemaining);

        Assert.Equal(1, result.Count);
        Assert.True(result.Complete);
    }

    // the ledger is opt-in: its endpoint also holds a BSN, both parents, tax income, IBANs and addresses.
    // not asking must never request it
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

        // reaching a dossier is always said in the operator log, even when asked for
        Assert.Contains(ctx.Notes, n => n.Contains("whole customer dossier", StringComparison.Ordinal));

        var ledger = Assert.Single(result.Debts).Ledger;
        Assert.NotEmpty(ledger);
    }

    // the dossier is reachable through exactly one call site, written on purpose
    [Fact]
    public async Task The_dossier_is_still_refused_to_an_ordinary_read()
    {
        var portal = StubDuoPortal.Answering();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => DuoCalls.ReadAsync(
                portal, Options, new DuoCall("pfd/json/raadplegen/klantbeeld", Required: false),
                CancellationToken.None));

        Assert.Empty(portal.Requested);
    }

    // enforced in code, not a design doc: klantbeeld is 2.5 MB of BSN, parents, partner, tax income, IBANs and addresses,
    // and DUO's own portal calls it, so the temptation is real
    [Fact]
    public async Task The_customer_dossier_is_refused_by_this_connector()
    {
        var portal = StubDuoPortal.Answering();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => DuoCalls.ReadAsync(
                portal, Options, new DuoCall("pfd/json/raadplegen/klantbeeld", Required: true),
                CancellationToken.None));

        Assert.Contains("klantbeeld", error.Message, StringComparison.Ordinal);

        // refused before sending: a discarded request would already be in DUO's logs under this connector's name
        Assert.Empty(portal.Requested);

        // not a ConnectorException: that type means a provider did something, this is our own code
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

    // a signed-out visitor is BOUNCED into the SAML chain (200 with a login page), not refused.
    // status alone would report the provider as rebuilt
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

    // a 401/403 after DUO already answered 200 and named a profile is a changed provider, not session_expired: ForceAuthn
    // makes every needless "sign in again" a full DigiD authentication that Logius counts
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

        Assert.Equal(UserAction.Wait, ErrorCatalog.ActionFor(error.Code));

        Assert.Contains(Options.SessionPath, error.Message, StringComparison.Ordinal);
        Assert.Contains("had already answered 200 and named a profile", error.Message, StringComparison.Ordinal);
    }

    // no session confirmed in this run: a refusal is still a dead session; told apart by evidence, not by status
    [Fact]
    public async Task A_refusal_with_no_session_confirmed_in_this_run_is_still_a_dead_session()
    {
        var portal = StubDuoPortal.Failing(401, """{"error":"unauthorized"}""");

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => DuoCalls.ReadAsync(
                portal, Options, new DuoCall(Options.DebtPath, Required: true), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);
        Assert.Equal(UserAction.Reauth, ErrorCatalog.ActionFor(error.Code));
        Assert.Contains("nothing has confirmed a session in this run", error.Message, StringComparison.Ordinal);
    }

    // a refused enrichment call costs only the enrichment: the required amounts already came back 200
    // and must not trigger another DigiD
    [Fact]
    public async Task An_enrichment_call_refused_after_a_confirmed_session_costs_only_the_enrichment()
    {
        var portal = StubDuoPortal.Answering();
        portal.Break(Options.HistoryPath, 401);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        var debt = Assert.Single(result.Debts);

        Assert.Equal(1_243_477, debt.Total.Value);

        Assert.Null(debt.AsOf);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("the amounts stand and the fetch carries on", StringComparison.Ordinal));
    }

    // a portal refusal must not claim to be the sign-in chain: the log shows DUO's session endpoint healthy
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

    // DUO's own refusal text is quoted into the log: it usually says what was missing
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

    // a body the size of a page is capped so a redesigned portal answering HTML cannot flood the operator's terminal
    [Fact]
    public async Task A_refusal_the_size_of_a_web_page_is_capped()
    {
        var portal = StubDuoPortal.Failing(500, new string('x', 20_000));
        using var ctx = new FakeJobContext();

        await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.All(ctx.Notes, n => Assert.True(n.Length < 600, $"a note ran to {n.Length} characters"));
    }

    // a call a navigation killed was interrupted, not failed: nothing reached DUO and every call is a GET, so one retry is safe
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

        Assert.Equal(2.57m, debt.InterestRate);
    }

    // the token is still presented on the second ask: the carry lives in the origin's session store
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

    // one retry only: a second interruption means the page is still moving, and a loop would race a redirect
    // on a job spending a DigiD
    [Fact]
    public async Task A_call_a_navigation_keeps_interrupting_is_asked_once_more_and_no_more()
    {
        var portal = StubDuoPortal.Answering();
        portal.Interrupt(Options.PositionsPath, times: 5);

        using var ctx = new FakeJobContext();

        var result = await Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None);

        Assert.Equal(2, portal.Requested.Count(u => u.EndsWith(Options.PositionsPath, StringComparison.Ordinal)));

        var debt = Assert.Single(result.Debts);

        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Null(debt.InterestRate);
    }

    // the landing page separates a recoverable in-portal move from an ended session.
    // logged without the query, where a SAMLRequest lives
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

    // a navigation out to the sign-in chain is a dead session, not a lost token: not retried
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

    // every fetch costs a human a DigiD sign-in: a missing interest rate must not throw away a balance
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

        // a record that lost its rate and a provider that states none look identical: only the note tells them apart
        Assert.Contains(
            ctx.Notes,
            n => n.Contains(Options.PositionsPath, StringComparison.Ordinal)
                 && n.Contains("500", StringComparison.Ordinal));

        Assert.Contains(ctx.Notes, n => n.Contains("gave nothing", StringComparison.Ordinal));
    }

    // every call leaves a log line, not only failures: faults here were diagnosed from single agent log lines
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

    // the log names the path, never the landing url: after a bounce it carries a SAMLRequest
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

    // reported against the session endpoint, not the debt one: "nobody is signed in" is diagnosable
    [Fact]
    public async Task A_portal_that_names_no_session_stops_the_fetch_before_the_data_calls()
    {
        var portal = StubDuoPortal.WithNoSession();
        using var ctx = new FakeJobContext();

        var error = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter().FetchAsync(ctx, Debt(), portal, CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, error.Code);

        Assert.Equal(
            ["https://mijn.duo.nl/particulier/services/sessietoken/rest/jwt"],
            portal.Requested);
    }

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

internal sealed class StubDuoPortal : IDuoPortal
{
    public const string SessionJson =
        """{"profiel":"PP","nieuwToken":true,"timeout":900,"modus":null,"isGemachtigd":false,"authRealm":null}""";

    public const string SignInPage = "<html><body>Inloggen bij DUO</body></html>";

    public const string SignInChain =
        "https://mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial?Target=https://mijn.duo.nl:443/" +
        "particulier/portaal/dashboard&ForceAuthn=true";

    // Playwright's own words when DUO's page moves under a fetch
    public const string ContextDestroyed =
        "Execution context was destroyed, most likely because of a navigation";

    // the same event as DUO's polyfill bundle reports it: the browser's generic fetch failure
    public const string FailedToFetch = "TypeError: Failed to fetch";

    // every 200 from DUO's services carried it, neither 401 did
    public const string TokenHeader = "authorization";

    private readonly Dictionary<string, int> _broken = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _interrupts = new(StringComparer.Ordinal);
    private readonly List<string> _requested = [];
    private readonly List<string> _opened = [];
    private readonly List<TimeSpan> _waited = [];

    // the stub carries tokens across calls to model the contract: DUO hands one back on a 200, the next request presents
    // it, an interruption keeps it (the session-store delivery is pinned in DuoCarryTests)
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

    public IReadOnlyList<string> Requested => _requested;

    public IReadOnlyList<string> Opened => _opened;

    public IReadOnlyList<TimeSpan> Waited => _waited;

    // zero by default: other login fixtures are browsers on their way to DigiD,
    // and "never bounces" would turn them into signed-in profiles
    public TimeSpan? BouncesAfter { get; set; } = TimeSpan.Zero;

    public Task<bool> BouncesToSignInAsync(TimeSpan patience, CancellationToken ct)
    {
        _waited.Add(patience);

        if (BouncesAfter is not { } after || patience < after) return Task.FromResult(false);

        // the landing moves too, as a real bounce would
        Landing = SignInChain;

        return Task.FromResult(true);
    }

    public string Landing { get; private set; } = "https://mijn.duo.nl/particulier/portaal/dashboard";

    public bool HasSession { get; private set; } = true;

    public static StubDuoPortal Answering() => new(null, 200);

    public static StubDuoPortal Bouncing(string to) => new(to, 200);

    public static StubDuoPortal Failing(int status, string refusal = "") => new(null, status, refusal);

    // transient state that shipped a broken login: on a portal address while DUO says nobody is signed in
    // (the dashboard redirect precedes the SAML bounce)
    public static StubDuoPortal WithNoSession()
    {
        var portal = new StubDuoPortal(null, 200);
        portal.HasSession = false;

        return portal;
    }

    // a profile still inside DUO: the browser never leaves the portal
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

    // landedOn defaults to where the browser already was (a same-origin move).
    // SignInChain makes it a dead session, not a lost token
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

    // the throwing half is deliberate: the probe runs inside a catch on the way to hand-over,
    // and an exception escaping there shipped twice as "This login failed"
    public Exception? DescribeThrows { get; set; }

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

        // keyed on the route: the payment-holiday call carries a peildatum query
        var route = url.Split('?')[0];

        // modelled in the browser before the request is on the wire; the carry is untouched, a stub clearing it would model the bug
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

        // DUO's payment-holiday endpoint 400s without a peildatum
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

    private string[] Sent() => ["accept", .. _carry];

    // DUO states a session timeout on every answer and mints the token the next request must send back
    private DuoReading Answered(string url, string body)
    {
        var sent = Sent();

        if (!_carry.Contains(TokenHeader)) _carry.Add(TokenHeader);

        return new DuoReading(
            200, url, body, Headers: ["content-type", "session-timeout", TokenHeader], Sent: sent);
    }

    // a refusal with no token on it, as both failed runs recorded
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
