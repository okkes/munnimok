using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using BankConnector.Adapters.MockBank;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>Every fetch a job; the mock cap is a third of the rows in reach (that count moves with weekdays and month ends).
/// The day is pinned at suite start so a run across midnight cannot move the window without the expectation.</summary>
public sealed class BackfillWalkApiFactory : ConnectorApiFactory
{
    private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;

    public DateOnly Today => DateOnly.FromDateTime(_started.UtcDateTime);

    public int Cap => Math.Max(1, BackfillFlows.LedgerRowsInReach(Today) / 3);

    protected override int FetchWaitSeconds => 0;

    protected override int? MockRecordCap => Cap;

    protected override TimeProvider? MockBankClock => new PinnedClock(_started);
}

/// <summary>A clock that stays on the instant it was given (its timers stay the system's).</summary>
file sealed class PinnedClock(DateTimeOffset at) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => at;
}

/// <summary>#460: a partial pass says how far back it reached; a pass with <c>until</c> fetches older history
/// through jobs until one comes back whole. Own database per class: the mock's IBAN feeds are shared,
/// so two connections would mix.</summary>
public class ConnectorBackfillTests(BackfillWalkApiFactory factory) : IClassFixture<BackfillWalkApiFactory>
{
    [Fact]
    public async Task Passes_with_until_fetch_the_older_history_a_partial_pass_left_until_one_comes_back_whole()
    {
        const string sub = "backfiller";
        using var client = factory.ClientFor(sub);
        var (_, bundle) = await BackfillFlows.LoginAsync(client, "conn-backfill");

        var walked = new List<string>();
        var first = await BackfillFlows.SyncAsync(client, new { connectionId = "conn-backfill", bundle }, bundle, asked: walked);
        Assert.Equal(["accounts", "transactions"], walked);
        Assert.False(first["complete"]!.GetValue<bool>(), first.ToJsonString());
        var reached = first["oldest"]!.GetValue<string>();
        Assert.Equal(factory.Cap, BackfillFlows.Transactions(factory, sub));

        var passes = 0;
        JsonObject pass;
        do
        {
            passes++;
            var asked = new List<string>();
            pass = await BackfillFlows.SyncAsync(client, new { connectionId = "conn-backfill", bundle, until = reached }, bundle, until: reached, asked);
            Assert.Equal(["transactions"], asked);
            if (pass["complete"]!.GetValue<bool>()) break;
            var next = pass["oldest"]!.GetValue<string>();
            Assert.True(string.CompareOrdinal(next, reached) < 0, $"{next} did not reach below {reached}");
            reached = next;
        }
        while (passes < 10);

        Assert.True(pass["complete"]!.GetValue<bool>(), pass.ToJsonString());
        Assert.True(passes >= 2, "the history should take more than one older pass at a third of it each");
        Assert.Equal(BackfillFlows.LedgerRowsInReach(factory.Today), BackfillFlows.Transactions(factory, sub));
    }
}

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
        Assert.True(BackfillFlows.Transactions(factory, sub) > factory.Cap);
        Assert.True(BackfillFlows.Transactions(factory, sub) <= 2 * factory.Cap);
        Assert.NotNull(after.BackfillUntil);
    }
}

internal static class BackfillFlows
{
    private const string MockBank = "mock-bank-simple";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        // the mock's username pattern wants a real-looking name; any password but its rejected one works
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// <summary>Every fetch is a job here, so <paramref name="asked"/> receives the resources the pass asked for.</summary>
    public static async Task<JsonObject> SyncAsync(HttpClient client, object body, string bundle, string? until = null, List<string>? asked = null)
    {
        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", body);
        var view = (await sync.Content.ReadFromJsonAsync<JsonObject>())!;
        var status = sync.StatusCode;
        while (status == HttpStatusCode.Accepted)
        {
            var jobId = view["jobId"]!.GetValue<string>();
            asked?.Add((await AwaitJobAsync(client, jobId))["resource"]!.GetValue<string>());
            using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{jobId}/collect", new { bundle, until });
            view = (await collect.Content.ReadFromJsonAsync<JsonObject>())!;
            status = collect.StatusCode;
        }
        Assert.True(status == HttpStatusCode.OK, view.ToJsonString());
        return view;
    }

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

    private static async Task<JsonObject> AwaitJobAsync(HttpClient client, string jobId)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            using var response = await client.GetAsync($"/connectors/{MockBank}/jobs/{jobId}");
            view = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
            var state = view["state"]!.GetValue<string>();
            if (state == "succeeded") return view;
            Assert.False(state is "failed" or "expired", view.ToJsonString());
            await Task.Delay(150);
        }
        throw new TimeoutException($"job never succeeded: {view?.ToJsonString()}");
    }
}
