using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BankConnector.Adapters.MockBank;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// Every fetch a job (a zero window), and the mock banks capped at a quarter
/// of the rows they hold in reach: their history takes several passes. (A
/// quarter of what is in reach, not a number: the mock's ledger runs through
/// today, and how many rows its history limit holds moves a little with the
/// weekdays and month ends inside it.)
///
/// The day is pinned when the suite starts: the mock banks' clock stays on
/// that instant, and the cap and every expected count are read for the same
/// day - a run across midnight cannot move the window without the
/// expectation, as it could when the count came from the clock at assert time.
/// </summary>
public sealed class BackfillWalkApiFactory : ConnectorApiFactory
{
    private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;

    /// <summary>The day the mock banks' window ends on, for the whole suite.</summary>
    public DateOnly Today => DateOnly.FromDateTime(_started.UtcDateTime);

    public int Cap => Math.Max(1, BackfillFlows.LedgerRowsInReach(Today) / 4);

    protected override int FetchWaitSeconds => 0;

    protected override int? MockRecordCap => Cap;

    protected override TimeProvider? MockBankClock => new PinnedClock(_started);
}

/// <summary>A clock that stays on the instant it was given (its timers stay the system's).</summary>
file sealed class PinnedClock(DateTimeOffset at) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => at;
}

/// <summary>
/// #460: a pass that brings only the newest part of a party's history says
/// how far back it reached, and a pass with <c>until</c> fetches the older
/// part - through the job path, the way a slow party answers - until a pass
/// comes back whole. (Each class has a database of its own: the mock's IBAN
/// feeds are shared by construction, so two connections in one would mix.)
/// </summary>
public class ConnectorBackfillTests(BackfillWalkApiFactory factory) : IClassFixture<BackfillWalkApiFactory>
{
    [Fact]
    public async Task Passes_with_until_fetch_the_older_history_a_partial_pass_left_until_one_comes_back_whole()
    {
        const string sub = "backfiller";
        using var client = factory.ClientFor(sub);
        var (_, bundle) = await BackfillFlows.LoginAsync(client, "conn-backfill");

        // the first sync: accounts, then the newest rows up to the cap - partial, and how far back they reach
        var first = await BackfillFlows.SyncAsync(client, new { connectionId = "conn-backfill", bundle }, bundle);
        Assert.False(first["complete"]!.GetValue<bool>(), first.ToJsonString());
        var reached = first["oldest"]!.GetValue<string>();
        Assert.Equal(factory.Cap, BackfillFlows.Transactions(factory, sub));

        // pass after pass over older history, each asking up to where the last one reached
        var passes = 0;
        JsonObject pass;
        do
        {
            passes++;
            pass = await BackfillFlows.SyncAsync(client, new { connectionId = "conn-backfill", bundle, until = reached }, bundle, until: reached);
            Assert.Equal(0, pass["ingested"]!["accounts"]!.GetValue<int>());
            if (pass["complete"]!.GetValue<bool>()) break;
            var next = pass["oldest"]!.GetValue<string>();
            Assert.True(string.CompareOrdinal(next, reached) < 0, $"{next} did not reach below {reached}");
            reached = next;
        }
        while (passes < 10);

        Assert.True(pass["complete"]!.GetValue<bool>(), pass.ToJsonString());
        Assert.True(passes >= 2, "the history should take more than one older pass at a quarter of it each");
        // every row the party keeps in reach landed once
        Assert.Equal(BackfillFlows.LedgerRowsInReach(factory.Today), BackfillFlows.Transactions(factory, sub));
    }
}

/// <summary>#460: the relay's scheduler takes one pass over older history per run, after a run that came back partial.</summary>
public class ConnectorBackfillScheduleTests(BackfillWalkApiFactory factory) : IClassFixture<BackfillWalkApiFactory>
{
    [Fact]
    public async Task The_scheduler_takes_one_pass_over_older_history_after_a_partial_run()
    {
        const string sub = "backfiller-scheduled";
        using var client = factory.ClientFor(sub);
        var (sessionId, bundle) = await BackfillFlows.LoginAsync(client, "conn-backfill-scheduled");
        factory.Write(db => db.ConnectorSessions.Single(s => s.Id == sessionId).KeptBundle = bundle);

        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));

        var after = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Null(after.LastScheduleError);
        Assert.Equal("active", after.State);
        // the run's own pass brought the newest rows up to the cap; its backfill pass brought older ones on top
        Assert.True(BackfillFlows.Transactions(factory, sub) > factory.Cap);
        // what is left waits for the next run: one older pass per run, never more
        Assert.True(BackfillFlows.Transactions(factory, sub) <= 2 * factory.Cap);
        Assert.NotNull(after.BackfillUntil);
    }
}

/// <summary>The mock bank driven through the relay the way the app drives it.</summary>
internal static class BackfillFlows
{
    private const string MockBank = "mock-bank-simple";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        // the mock's username pattern wants a real-looking name; any password but its rejected one works
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// <summary>One sync followed through every job its walk becomes, collected with the same window; the finished view.</summary>
    public static async Task<JsonObject> SyncAsync(HttpClient client, object body, string bundle, string? until = null)
    {
        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", body);
        var view = (await sync.Content.ReadFromJsonAsync<JsonObject>())!;
        var status = sync.StatusCode;
        while (status == HttpStatusCode.Accepted)
        {
            var jobId = view["jobId"]!.GetValue<string>();
            await AwaitJobAsync(client, jobId);
            using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{jobId}/collect", new { bundle, until });
            view = (await collect.Content.ReadFromJsonAsync<JsonObject>())!;
            status = collect.StatusCode;
        }
        Assert.True(status == HttpStatusCode.OK, view.ToJsonString());
        return view;
    }

    /// <summary>The rows in every feed the person's connected accounts landed in (one per IBAN, one for the card).</summary>
    public static int Transactions(ConnectorApiFactory factory, string sub)
    {
        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var feeds = factory.Read(db => db.ConnectorAccountRefs.Where(a => a.UserId == user.Id).Select(a => a.FeedSpaceId).Distinct().ToList());
        return factory.Read(db => db.EntityRows.Count(r => feeds.Contains(r.SpaceId) && r.Entity == "transaction" && !r.Deleted));
    }

    /// <summary>The mock's rows inside its history limit on <paramref name="today"/> - the day the factory pinned its banks' clock to.</summary>
    public static int LedgerRowsInReach(DateOnly today)
    {
        var floor = today.AddDays(-MockBankLedger.HistoryDays);
        return MockBankLedger.Through(today).Entries.Count(e => e.BookedAt >= floor);
    }

    public static async Task<(string SessionId, string Bundle)> LoginAsync(HttpClient client, string connectionId)
    {
        using var response = await client.PostAsJsonAsync($"/connectors/{MockBank}/login", new { connectionId, inputs = Credentials });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
        var sessionId = view["sessionId"]!.GetValue<string>();
        var bundle = view["bundle"]?.GetValue<string>();
        var clock = Stopwatch.StartNew();
        while (bundle is null && clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            await Task.Delay(150);
            var session = await client.GetFromJsonAsync<JsonObject>($"/connectors/{MockBank}/login/{sessionId}");
            bundle = session!["bundle"]?.GetValue<string>();
            Assert.False(session["state"]?.GetValue<string>() is "failed" or "expired", session.ToJsonString());
        }
        Assert.NotNull(bundle);
        return (sessionId, bundle);
    }

    private static async Task AwaitJobAsync(HttpClient client, string jobId)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            using var response = await client.GetAsync($"/connectors/{MockBank}/jobs/{jobId}");
            view = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
            var state = view["state"]!.GetValue<string>();
            if (state == "succeeded") return;
            Assert.False(state is "failed" or "expired", view.ToJsonString());
            await Task.Delay(150);
        }
        throw new TimeoutException($"job never succeeded: {view?.ToJsonString()}");
    }
}
