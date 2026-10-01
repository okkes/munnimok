using Connector.Kit.Errors;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// <summary>
/// How fast this adapter is allowed to walk Amazon.
///
/// The platform has had a per-provider rate limit since the beginning, and this
/// adapter was never behind it. The limiter is a delegating handler on the job's
/// own <c>HttpClient</c>, so it paces every adapter that talks over HTTP -
/// Bol's fetch, Albert Heijn's, Jumbo's - and none of the ones that drive a
/// page, because a navigation is Chromium's socket and never passes through our
/// handler at all. The gap was there, the browser walked around it, and nothing
/// in the codebase said so.
///
/// What that bought on this provider: a first connect opens an order list and
/// then an invoice per order, back to back, as fast as Amazon will serve them.
/// After a day of that Amazon answered a probe with 503 and kept doing so.
/// </summary>
public sealed class AmazonPacingTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private const string Year2026Page1 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    private const string Year2026Page2 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=10";

    private const string Print = "https://www.amazon.nl/gp/css/summary/print.html?orderID=";

    /// <summary>
    /// Every page, without exception - the list pages and the invoices alike.
    ///
    /// Pacing only the invoices would look right on this fixture set and be
    /// wrong on a heavy account, where the list is walked once per year of
    /// history and the burst starts before the first invoice is opened.
    /// </summary>
    [Fact]
    public async Task Every_page_the_walk_opens_waits_its_turn()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer);

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        // Five: two list pages and three invoices. Stated rather than derived
        // from Opened.Count on both sides, which would pass for an adapter that
        // paced nothing and opened nothing.
        Assert.Equal(5, pages.Opened.Count);
        Assert.Equal(5, pacer.Entered);
        Assert.Equal(3, result.Receipts.Count);
    }

    /// <summary>
    /// And the ticket is RELEASED between them.
    ///
    /// The count above cannot tell a paced walk from one that takes a single
    /// ticket at the top and holds it to the end - that satisfies "asked once
    /// per page" for a walk of one page and paces nothing thereafter. Only the
    /// sequence says which happened, because the gap in
    /// <c>PolitenessGate</c> is stamped on DISPOSAL: a ticket that is never
    /// released never starts a gap, and never lets the next caller in either.
    /// </summary>
    [Fact]
    public async Task A_page_is_loaded_inside_its_own_turn_and_the_turn_is_given_up_after()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer);

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        _ = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Equal(
            [
                "enter", "open", "release",
                "enter", "open", "release",
                "enter", "open", "release",
                "enter", "open", "release",
                "enter", "open", "release",
            ],
            pacer.Trace);
    }

    /// <summary>
    /// A page that loads normally is not treated as a rebuke.
    ///
    /// The penalty is minutes long and outlives the job, so spending one on an
    /// ordinary 200 would slow every later fetch for this provider across the
    /// whole agent - a self-inflicted outage that would look exactly like the
    /// provider being slow.
    /// </summary>
    [Fact]
    public async Task A_walk_that_goes_well_never_pushes_the_next_one_out()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer);

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        _ = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        Assert.Empty(pacer.Backoffs);
    }

    /// <summary>
    /// Amazon saying it has had enough pushes every later call out.
    ///
    /// This job is already lost - a 429 fails the fetch whatever we do with it -
    /// and that is precisely why the penalty is worth taking. What it protects
    /// is the NEXT attempt: a user who presses the button again ten seconds
    /// later would otherwise arrive at a provider that has just said stop, and
    /// arrive at full speed.
    /// </summary>
    [Fact]
    public async Task Amazon_saying_it_has_had_enough_slows_down_what_comes_after()
    {
        var pacer = new RecordingPacer();

        // A real capture of a throttled amazon.nl, status and all.
        var pages = new StubAmazonPages { [Year2026Page1] = "blocked-429", Trace = pacer.Trace };

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Equal(AmazonAdapter.ThrottlePenalty, Assert.Single(pacer.Backoffs));

        // Before the page was judged, not after. The guard throws on this
        // status, so a backoff placed downstream of the verdict would never run
        // on the one case it exists for.
        Assert.Equal(["enter", "open", "backoff", "release"], pacer.Trace);
    }

    /// <summary>
    /// Which answers count as "too often", and which merely count as "no".
    ///
    /// The pair matches the HTTP limiter's exactly, and deliberately: one
    /// provider is being called through two doors, and a rule that differed by
    /// door would mean the same 503 slowed us down or did not depending on
    /// which half of the adapter happened to meet it.
    /// </summary>
    [Theory]
    [InlineData(429, true)]
    [InlineData(503, true)]
    [InlineData(200, false)]
    // 403 is Amazon refusing us and 502/504 are a bad minute at a gateway.
    // None of the three says anything about our rate, and backing off for them
    // would slow every later job on a diagnosis nothing supports.
    [InlineData(403, false)]
    [InlineData(502, false)]
    [InlineData(504, false)]
    // Playwright reports no status for a same-document navigation. "Nothing was
    // stated" is not a complaint.
    [InlineData(0, false)]
    public void Only_a_rate_limit_is_read_as_one(int status, bool expected) =>
        Assert.Equal(expected, AmazonAdapter.IsThrottled(status));

    /// <summary>
    /// The gap Amazon asks for.
    ///
    /// That it is bigger than the operator's own floor - and therefore changes
    /// anything at all - is proved where the two meet, in the API suite's
    /// <c>RequestGapTests</c>; this assembly cannot see the hosting options.
    /// </summary>
    [Fact]
    public void Amazon_asks_for_a_gap_of_its_own()
    {
        Assert.Equal(3_000, AmazonManifest.Build().Limits.MinRequestGapMs);
    }

    /// <summary>
    /// And the manifest says how long a fetch now takes, having been made
    /// slower on purpose.
    ///
    /// A consumer decides whether to block or to poll on this number, and the
    /// job's own budget is derived from it. Leaving it at the pre-pacing 180
    /// would have made every full fetch look like an overrun.
    /// </summary>
    [Fact]
    public void The_stated_duration_covers_the_waiting_it_now_includes()
    {
        var receipts = AmazonManifest.Build().Resource("receipts")!;

        var pacing = TimeSpan.FromMilliseconds(
            (double)AmazonManifest.Build().Limits.MinRequestGapMs * receipts.MaxRecordsPerFetch);

        Assert.Equal(300, receipts.TypicalDurationSeconds);
        Assert.True(
            receipts.TypicalDurationSeconds > pacing.TotalSeconds,
            $"a full fetch waits {pacing.TotalSeconds}s on pacing alone, before a single page is loaded");
    }

    // ---- helpers -----------------------------------------------------------

    private static AmazonAdapter Adapter() => new(new AmazonOptions(), new FixedTimeProvider(Now));

    private static SessionMaterial Material() =>
        new() { StorageState = FixtureCatalog.Read("amazon/storage-state.json") };

    private static StubAmazonPages OrderPages(RecordingPacer pacer) => new()
    {
        Trace = pacer.Trace,
        [Year2026Page1] = "orders-2026-p1",
        [Year2026Page2] = "orders-2026-p2",
        [Print + "402-1122334-5566778"] = "invoice-402",
        [Print + "402-2233445-6677889"] = "invoice-two-items",
        [Print + "402-3344556-7788990"] = "invoice-third",
    };
}
