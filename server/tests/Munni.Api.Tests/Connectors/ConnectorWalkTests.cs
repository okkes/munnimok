using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;
using Munni.Api.Data;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The relay with a control plane that waits for no fetch at all: every pass
/// becomes a job, so a two-resource party has to chain through the job path.
/// </summary>
public sealed class JobWalkApiFactory : ConnectorApiFactory
{
    protected override int FetchWaitSeconds => 0;
}

/// <summary>
/// A sync walks the manifest's resources in order. A pass that becomes a job
/// pauses the walk; collecting the job resumes it from the resource after,
/// and that pass may become a job of its own. Prod, 2026-10-04: a bank's
/// accounts pass took a second longer than its window and the transactions
/// were never asked for - the balance moved, the list did not, sync after
/// sync. Here every fetch becomes a job (a zero window), so the mock bank's
/// two resources - accounts, then transactions - have to chain.
/// </summary>
public class ConnectorWalkTests(JobWalkApiFactory factory) : IClassFixture<JobWalkApiFactory>
{
    private const string MockBank = "mock-bank-simple";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        // the mock's username pattern wants a real-looking name; any password but its rejected one works
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task Collecting_a_job_walks_on_to_the_resources_after_it_until_the_walk_is_done()
    {
        const string sub = "walker";
        using var client = factory.ClientFor(sub);
        var (_, bundle) = await LoginAsync(client, "conn-walk");

        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", new { connectionId = "conn-walk", bundle });
        var accepted = await sync.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(sync.StatusCode == HttpStatusCode.Accepted, accepted!.ToJsonString());
        var first = accepted["jobId"]!.GetValue<string>();

        // the accounts pass landed, and the walk went on: the transactions
        // pass became the next job, answered with ITS view
        await AwaitJobAsync(client, first, "succeeded");
        using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{first}/collect", new { bundle });
        var next = await collect.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(collect.StatusCode == HttpStatusCode.Accepted, next!.ToJsonString());
        var second = next["jobId"]!.GetValue<string>();
        Assert.NotEqual(first, second);
        Assert.True(next["ingested"]!["accounts"]!.GetValue<int>() > 0, next.ToJsonString());
        Assert.Equal(0, next["ingested"]!["transactions"]!.GetValue<int>());

        // the last pass collected: the walk is done, and the sum is the walk's
        await AwaitJobAsync(client, second, "succeeded");
        using var last = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{second}/collect", new { bundle });
        var done = await last.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(last.StatusCode == HttpStatusCode.OK, done!.ToJsonString());
        Assert.Equal("succeeded", done["state"]!.GetValue<string>());
        Assert.True(done["ingested"]!["transactions"]!.GetValue<int>() > 0, done.ToJsonString());
        Assert.True(done["complete"]!.GetValue<bool>(), done.ToJsonString());

        // and the rows are there: the feed holds the bank's transactions
        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var feedId = factory.Read(db => db.ConnectorAccountRefs.First(a => a.UserId == user.Id).FeedSpaceId);
        Assert.True(factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "transaction")) > 0);

        // the session is active again, as after any finished sync
        var sessionId = accepted["sessionId"]!.GetValue<string>();
        Assert.Equal("active", factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId).State));
    }

    [Fact]
    public async Task The_scheduler_follows_every_job_of_the_walk_and_lands_the_transactions()
    {
        const string sub = "walker-scheduled";
        using var client = factory.ClientFor(sub);
        var (sessionId, bundle) = await LoginAsync(client, "conn-walk-scheduled");

        // kept custody, modelled as the schedule suite models it
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var row = db.ConnectorSessions.Single(s => s.Id == sessionId);
            row.KeptBundle = bundle;
            await db.SaveChangesAsync();
        }

        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));

        var after = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Null(after.LastScheduleError);
        Assert.Equal("active", after.State);
        Assert.NotNull(after.KeptBundle);

        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var feedId = factory.Read(db => db.ConnectorAccountRefs.First(a => a.UserId == user.Id).FeedSpaceId);
        Assert.True(factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "transaction")) > 0);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static async Task<(string SessionId, string Bundle)> LoginAsync(HttpClient client, string connectionId)
    {
        using var response = await client.PostAsJsonAsync($"/connectors/{MockBank}/login", new { connectionId, inputs = Credentials });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
        var sessionId = view["sessionId"]!.GetValue<string>();
        var bundle = view["bundle"]?.GetValue<string>();
        if (bundle is null)
        {
            var clock = Stopwatch.StartNew();
            while (bundle is null && clock.Elapsed < TimeSpan.FromSeconds(30))
            {
                await Task.Delay(150);
                var session = await client.GetFromJsonAsync<JsonObject>($"/connectors/{MockBank}/login/{sessionId}");
                bundle = session!["bundle"]?.GetValue<string>();
                Assert.False(session["state"]?.GetValue<string>() is "failed" or "expired", session.ToJsonString());
            }
        }
        Assert.NotNull(bundle);
        return (sessionId, bundle);
    }

    private static async Task<JsonObject> AwaitJobAsync(HttpClient client, string jobId, string state)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            using var response = await client.GetAsync($"/connectors/{MockBank}/jobs/{jobId}");
            view = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
            var current = view["state"]!.GetValue<string>();
            if (current == state) return view;
            Assert.False(current is "failed" or "expired", view.ToJsonString());
            await Task.Delay(150);
        }
        throw new TimeoutException($"job never reached {state}: {view?.ToJsonString()}");
    }
}
