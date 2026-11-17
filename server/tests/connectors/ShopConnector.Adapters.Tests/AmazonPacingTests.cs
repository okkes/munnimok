using Connector.Kit.Errors;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

/// the HttpClient limiter never covers page-driving adapters (Chromium's socket)
/// a first connect then burst until Amazon answered 503
public sealed class AmazonPacingTests
{
    private static readonly DateTimeOffset Now = new(2026, 7, 28, 2, 0, 0, TimeSpan.Zero);

    private const string Year2026Page1 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    private const string Year2026Page2 =
        "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=10";

    private const string Print = "https://www.amazon.nl/gp/css/summary/print.html?orderID=";

    /// every page is paced, list pages included: a heavy account's burst starts before the first invoice
    [Fact]
    public async Task Every_page_the_walk_opens_waits_its_turn()
    {
        var pacer = new RecordingPacer();
        var pages = OrderPages(pacer);

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        var result = await Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None);

        // five: two list pages and three invoices, stated rather than derived so an adapter that paces nothing fails
        Assert.Equal(5, pages.Opened.Count);
        Assert.Equal(5, pacer.Entered);
        Assert.Equal(3, result.Receipts.Count);
    }

    /// the ticket must be released between pages: PolitenessGate stamps the gap on disposal, so a held ticket paces nothing
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

    /// the penalty is minutes long and outlives the job: an ordinary 200 must not take one
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

    /// a 429 fails this job anyway; the penalty protects the next attempt from arriving at full speed
    [Fact]
    public async Task Amazon_saying_it_has_had_enough_slows_down_what_comes_after()
    {
        var pacer = new RecordingPacer();

        var pages = new StubAmazonPages { [Year2026Page1] = "blocked-429", Trace = pacer.Trace };

        using var ctx = new FakeJobContext { Material = Material(), Pacer = pacer };

        var error = await Assert.ThrowsAsync<ConnectorException>(() => Adapter().FetchAsync(
            ctx, Requests.Receipts(Requests.Day(2026, 1, 1), Requests.Day(2026, 12, 31)),
            pages, wall: null, redirects: null, CancellationToken.None));

        Assert.Equal(ErrorCode.BlockedByProvider, error.Code);
        Assert.Equal(AmazonAdapter.ThrottlePenalty, Assert.Single(pacer.Backoffs));

        // before the verdict: the guard throws on this status, so a later backoff would never run
        Assert.Equal(["enter", "open", "backoff", "release"], pacer.Trace);
    }

    /// matches the HTTP limiter's pair exactly: one provider through two doors needs one rule
    [Theory]
    [InlineData(429, true)]
    [InlineData(503, true)]
    [InlineData(200, false)]
    // 403 is a refusal and 502/504 a gateway blip: none says anything about our rate
    [InlineData(403, false)]
    [InlineData(502, false)]
    [InlineData(504, false)]
    // Playwright reports no status for a same-document navigation: nothing stated is not a complaint
    [InlineData(0, false)]
    public void Only_a_rate_limit_is_read_as_one(int status, bool expected) =>
        Assert.Equal(expected, AmazonAdapter.IsThrottled(status));

    /// that it exceeds the operator's floor is proved in the API suite's RequestGapTests (hosting options are not visible here)
    [Fact]
    public void Amazon_asks_for_a_gap_of_its_own()
    {
        Assert.Equal(3_000, AmazonManifest.Build().Limits.MinRequestGapMs);
    }

    /// the stated duration must cover the pacing: the pre-pacing 180 would make every full fetch look like an overrun
    [Fact]
    public void The_stated_duration_covers_the_waiting_it_now_includes()
    {
        var receipts = AmazonManifest.Build().Resource("receipts")!;

        var pacing = TimeSpan.FromMilliseconds(
            (double)AmazonManifest.Build().Limits.MinRequestGapMs * receipts.MaxRecordsPerFetch);

        Assert.Equal(1_200, receipts.TypicalDurationSeconds);
        Assert.True(
            receipts.TypicalDurationSeconds > pacing.TotalSeconds,
            $"a full fetch waits {pacing.TotalSeconds}s on pacing alone, before a single page is loaded");
    }

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
