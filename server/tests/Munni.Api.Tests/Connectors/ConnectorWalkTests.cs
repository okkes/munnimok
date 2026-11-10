using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Sync;

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

    /// <summary>
    /// #508: a transactions pass that outran the window and was collected as
    /// a job never settled the pending mirror - its page always carries an
    /// ack cursor - so a reserved row the bank had since booked stayed beside
    /// its booked twin. A complete pass collected as a job settles like any.
    /// </summary>
    [Fact]
    public async Task A_transactions_pass_collected_as_a_job_settles_the_reserved_rows_the_bank_no_longer_reports()
    {
        const string sub = "walker-reserved";
        using var client = factory.ClientFor(sub);
        var (_, bundle) = await LoginAsync(client, "conn-walk-reserved");

        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", new { connectionId = "conn-walk-reserved", bundle });
        var first = (await sync.Content.ReadFromJsonAsync<JsonObject>())!["jobId"]!.GetValue<string>();
        await AwaitJobAsync(client, first, "succeeded");
        using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{first}/collect", new { bundle });
        var second = (await collect.Content.ReadFromJsonAsync<JsonObject>())!["jobId"]!.GetValue<string>();

        // the accounts landed; a row an earlier pass mirrored as reserved, which this bank no longer reports
        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var reference = factory.Read(db => db.ConnectorAccountRefs.First(a => a.UserId == user.Id && !a.AccountRef.StartsWith("CONN:")));
        var reservedId = await ReserveAsync(reference, "pending:WALK-1");

        await AwaitJobAsync(client, second, "succeeded");
        using var last = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{second}/collect", new { bundle });
        Assert.Equal(HttpStatusCode.OK, last.StatusCode);

        Assert.True(factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.EntityId == reservedId).Deleted));
        Assert.Equal(0, factory.Read(db => db.ConnectorPendingTxs.Count(p => p.EntityId == reservedId)));
    }

    /// <summary>
    /// A job's page is gone once it was acknowledged, swept or taken over by a later job: collecting the
    /// job again (a lost answer, a second caller handed the same job) must not read that as "nothing reserved".
    /// </summary>
    [Fact]
    public async Task Collecting_a_job_whose_page_is_gone_leaves_the_reserved_rows_alone()
    {
        const string sub = "walker-recollect";
        using var client = factory.ClientFor(sub);
        var (_, bundle) = await LoginAsync(client, "conn-walk-recollect");

        using var sync = await client.PostAsJsonAsync($"/connectors/{MockBank}/sync", new { connectionId = "conn-walk-recollect", bundle });
        var first = (await sync.Content.ReadFromJsonAsync<JsonObject>())!["jobId"]!.GetValue<string>();
        await AwaitJobAsync(client, first, "succeeded");
        using var collect = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{first}/collect", new { bundle });
        var second = (await collect.Content.ReadFromJsonAsync<JsonObject>())!["jobId"]!.GetValue<string>();
        await AwaitJobAsync(client, second, "succeeded");
        using var last = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{second}/collect", new { bundle });
        Assert.Equal(HttpStatusCode.OK, last.StatusCode);

        // a reserved row another pass mirrors after this page was acknowledged
        var user = factory.Read(db => db.Users.Single(u => u.Sub == sub));
        var reference = factory.Read(db => db.ConnectorAccountRefs.First(a => a.UserId == user.Id && !a.AccountRef.StartsWith("CONN:")));
        var reservedId = await ReserveAsync(reference, "pending:WALK-2");

        using var again = await client.PostAsJsonAsync($"/connectors/{MockBank}/jobs/{second}/collect", new { bundle });
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);

        Assert.False(factory.Read(db => db.EntityRows.Single(r => r.SpaceId == reference.FeedSpaceId && r.EntityId == reservedId).Deleted));
        Assert.Equal(1, factory.Read(db => db.ConnectorPendingTxs.Count(p => p.EntityId == reservedId)));
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

    /// <summary>A reserved row in the account's feed, tracked by the reference as a pass that mirrored it leaves it; its entity id.</summary>
    private async Task<string> ReserveAsync(ConnectorAccountRef reference, string externalId)
    {
        var reservedId = ImportIds.TransactionId(reference.AccountRef, externalId);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var feed = (await db.Spaces.FindAsync(reference.FeedSpaceId))!;
        var fields = new Dictionary<string, JsonElement>
        {
            ["accountId"] = JsonSerializer.SerializeToElement(reference.AccountEntityId),
            ["date"] = JsonSerializer.SerializeToElement("2026-10-06"),
            ["amountCents"] = JsonSerializer.SerializeToElement(-1300),
            ["pending"] = JsonSerializer.SerializeToElement(1),
        };
        await new SyncWriter(db).ApplyAsync(feed, null, [new SyncOpDto(Guid.NewGuid().ToString("N"), feed.Id, "transaction", reservedId, fields, ServerHlc.Now())]);
        db.ConnectorPendingTxs.Add(new ConnectorPendingTx { AccountRefId = reference.Id, EntityId = reservedId });
        await db.SaveChangesAsync();
        return reservedId;
    }

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
