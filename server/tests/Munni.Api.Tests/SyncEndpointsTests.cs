using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Sync;

namespace Munni.Api.Tests;

public class SyncEndpointsTests : IClassFixture<SyncApiFactory>
{
    private readonly SyncApiFactory _factory;

    public SyncEndpointsTests(SyncApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static SyncOpDto Op(string spaceId, string entityId, string field, string value, string hlc) =>
        new(Guid.NewGuid().ToString(), spaceId, "category", entityId,
            new() { [field] = JsonSerializer.SerializeToElement(value) }, hlc);

    [Fact]
    public async Task PushCreatesSpace_PullReturnsOps_RetryIsIdempotent()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor("alice");

        var op = Op(spaceId, "c1", "name", "Food", "000000100-0000-devA");
        var push = await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [op]));
        Assert.True(push.IsSuccessStatusCode, await push.Content.ReadAsStringAsync());
        var result = await push.Content.ReadFromJsonAsync<PushResponse>();
        Assert.Equal(1, result!.Accepted);

        // retrying the same op is a no-op
        var retry = await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [op]));
        var retryResult = await retry.Content.ReadFromJsonAsync<PushResponse>();
        Assert.Equal(0, retryResult!.Accepted);
        Assert.Equal(1, retryResult.Duplicates);
        Assert.Equal(result.LastSeq, retryResult.LastSeq);

        var pull = await alice.GetFromJsonAsync<PullResponse>($"/sync/{spaceId}/pull?since=0");
        Assert.Single(pull!.Ops);
        Assert.Equal("c1", pull.Ops[0].EntityId);
    }

    [Fact]
    public async Task NonMemberIsForbidden()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor("alice");
        var mallory = ClientFor("mallory");

        await alice.PostAsJsonAsync($"/sync/{spaceId}/push",
            new PushRequest("dev1", [Op(spaceId, "c1", "name", "Food", "000000100-0000-devA")]));

        Assert.Equal(HttpStatusCode.Forbidden, (await mallory.GetAsync($"/sync/{spaceId}/pull?since=0")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await mallory.GetAsync($"/sync/{spaceId}/bootstrap")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await mallory.PostAsJsonAsync($"/sync/{spaceId}/push",
            new PushRequest("dev2", [Op(spaceId, "c1", "name", "Hijack", "000000999-0000-devM")]))).StatusCode);
    }

    [Fact]
    public async Task TwoDevicesConvergeThroughServer_StaleFieldRejected()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor("alice");

        // device A: create with name+color at t=100
        await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("devA",
            [new SyncOpDto(Guid.NewGuid().ToString(), spaceId, "category", "c1",
                new() { ["name"] = JsonSerializer.SerializeToElement("A"), ["color"] = JsonSerializer.SerializeToElement("red") },
                "000000100-0000-devA")]));
        // device B (later clock): rename at t=200
        await alice.PostAsJsonAsync($"/sync/{spaceId}/push",
            new PushRequest("devB", [Op(spaceId, "c1", "name", "B", "000000200-0000-devB")]));
        // device A: stale rename at t=150 arrives last
        await alice.PostAsJsonAsync($"/sync/{spaceId}/push",
            new PushRequest("devA", [Op(spaceId, "c1", "name", "stale", "000000150-0000-devA")]));

        var bootstrap = await alice.GetFromJsonAsync<BootstrapResponse>($"/sync/{spaceId}/bootstrap");
        var row = Assert.Single(bootstrap!.Rows);
        var data = row.Data.Deserialize<Dictionary<string, string>>()!;
        Assert.Equal("B", data["name"]);      // t=200 wins over stale t=150
        Assert.Equal("red", data["color"]);   // untouched field survives
        Assert.Equal(3, bootstrap.LatestSeq); // all ops recorded for pull replay
    }

    [Fact]
    public async Task NoAuthHeaderIsUnauthorized()
    {
        var anon = _factory.CreateClient();
        var response = await anon.GetAsync($"/sync/space_x/pull?since=0");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public void UniqueViolationPredicate_MatchesOnlyPostgresDuplicateKey()
    {
        // #281: the push retry keys on exactly the concurrent-insert
        // signal — anything else must keep surfacing
        var dup = new DbUpdateException("save failed",
            new Npgsql.PostgresException("duplicate key", "ERROR", "ERROR", "23505"));
        Assert.True(SyncWriter.IsUniqueViolation(dup));
        Assert.False(SyncWriter.IsUniqueViolation(new DbUpdateException("save failed",
            new Npgsql.PostgresException("deadlock", "ERROR", "ERROR", "40P01"))));
        Assert.False(SyncWriter.IsUniqueViolation(new DbUpdateException("save failed", new InvalidOperationException())));
    }

    /// <summary>#606: a device without the space takes its rows as they stand, a page at a time, and pulls from the first page's head.</summary>
    [Fact]
    public async Task A_snapshot_comes_in_pages_and_names_where_the_history_continues()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor("alice");
        var total = SyncEndpoints.SnapshotPageRows + 500;
        foreach (var chunk in Enumerable.Range(0, total).Chunk(1000))
        {
            var push = await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
                [.. chunk.Select(i => Op(spaceId, $"c{i:D5}", "name", $"Category {i}", $"{100 + i:D9}-0000-devA"))]));
            Assert.True(push.IsSuccessStatusCode, await push.Content.ReadAsStringAsync());
        }

        var first = await alice.GetFromJsonAsync<BootstrapResponse>($"/sync/{spaceId}/bootstrap");
        Assert.Equal(SyncEndpoints.SnapshotPageRows, first!.Rows.Count);
        Assert.Equal(total, first.LatestSeq);
        Assert.NotNull(first.Next);

        // a change made between two pages lies after the first page's head: the pull that follows the snapshot brings it
        await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [Op(spaceId, "c00000", "name", "Renamed", "000900000-0000-devA")]));

        var second = await alice.GetFromJsonAsync<BootstrapResponse>($"/sync/{spaceId}/bootstrap?after={Uri.EscapeDataString(first.Next!)}");
        Assert.Equal(500, second!.Rows.Count);
        Assert.Null(second.Next);
        Assert.Equal(total, first.Rows.Concat(second.Rows).Select(r => r.EntityId).Distinct().Count());
        var since = await alice.GetFromJsonAsync<PullResponse>($"/sync/{spaceId}/pull?since={first.LatestSeq}");
        Assert.Equal("Renamed", Assert.Single(since!.Ops).Fields["name"].GetString());

        Assert.Equal(HttpStatusCode.BadRequest, (await alice.GetAsync($"/sync/{spaceId}/bootstrap?after=nocolon")).StatusCode);
    }

    /// <summary>The in-memory database of these tests runs any expression; Postgres must be able to run the page as SQL.</summary>
    [Fact]
    public void A_snapshot_page_is_a_query_the_database_itself_runs()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql("Host=munni-db.invalid;Database=munni;Username=munni;Password=x").Options;
        using var db = new AppDbContext(options);

        var sql = SyncEndpoints.SnapshotRowsAfter(db, "space_1", ("category", "c1")).Take(SyncEndpoints.SnapshotPageRows + 1).ToQueryString();

        Assert.Contains("\"Entity\" > ", sql);
        Assert.Contains("\"EntityId\" > ", sql);
        Assert.Matches(@"ORDER BY \w+\.""Entity"", \w+\.""EntityId""", sql);
        Assert.Contains("LIMIT", sql);
    }

    [Fact]
    public async Task A_snapshot_page_ends_before_it_outgrows_one_download()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor("alice");
        // three rows, each holding close to half a page's worth of data (a picture): two fit, the third starts the next page
        var heavy = new string('x', SyncEndpoints.SnapshotPageChars * 45 / 100);
        foreach (var id in new[] { "p1", "p2", "p3" })
        {
            var push = await alice.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [Op(spaceId, id, "picture", heavy, "000000100-0000-devA")]));
            Assert.True(push.IsSuccessStatusCode, await push.Content.ReadAsStringAsync());
        }

        var first = await alice.GetFromJsonAsync<BootstrapResponse>($"/sync/{spaceId}/bootstrap");
        Assert.Equal(["p1", "p2"], first!.Rows.Select(r => r.EntityId));
        var second = await alice.GetFromJsonAsync<BootstrapResponse>($"/sync/{spaceId}/bootstrap?after={Uri.EscapeDataString(first.Next!)}");
        Assert.Equal(["p3"], second!.Rows.Select(r => r.EntityId));
        Assert.Null(second.Next);
    }
}

public class SyncApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("environment", "Development");
        builder.ConfigureServices(services =>
        {
            // strip the Npgsql registration entirely (EF 10 also registers
            // IDbContextOptionsConfiguration) before adding InMemory
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("sync-tests"));
            // /geo must never reach the real ip-api.com from tests
            services.AddHttpClient("geo").ConfigurePrimaryHttpMessageHandler(() => new FakeGeoLookupHandler());
        });
    }
}

/// <summary>ipwho.is stand-in: every public IP resolves to NL</summary>
internal sealed class FakeGeoLookupHandler : HttpMessageHandler
{
    public static int Calls;

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Interlocked.Increment(ref Calls);
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent("""{"success":true,"country_code":"NL"}""", System.Text.Encoding.UTF8, "application/json"),
        });
    }
}
