using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Munni.Api.GoCardless;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// A sync the provider cannot finish inside the window, or that stops to
/// ask something, is a job the app follows: it polls the view, answers the
/// question, and collects the result with the bundle it holds — the relay
/// ingests the page and acknowledges it then, and hands back the bundle
/// the job rotated.
/// </summary>
public class ConnectorJobTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string SlowStore = "mock-store-slow";
    private const string TwoFactorRegistry = "mock-registry-2fa";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task A_fetch_that_outruns_the_window_becomes_a_job_the_app_collects()
    {
        const string sub = "slow-syncer";
        using var client = factory.ClientFor(sub);
        var bundle = await LoginAsync(client, SlowStore, "conn-slow");

        using var sync = await client.PostAsJsonAsync($"/connectors/{SlowStore}/sync", new { connectionId = "conn-slow", bundle, since = "2026-06-01" });
        var accepted = await sync.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(sync.StatusCode == HttpStatusCode.Accepted, accepted!.ToJsonString());
        var jobId = accepted["jobId"]!.GetValue<string>();
        Assert.NotNull(accepted["sessionId"]);
        Assert.Equal(0, accepted["ingested"]!["records"]!.GetValue<int>());

        // followed to its end: the view, in the app's casing, never carrying the page
        var job = await AwaitJobAsync(client, SlowStore, jobId, "succeeded");
        Assert.Null(job["data"]);
        Assert.NotNull(job["progress"]!["stepsDone"]);

        // collected with the bundle: the page lands, the rows are acknowledged
        using var collect = await client.PostAsJsonAsync($"/connectors/{SlowStore}/jobs/{jobId}/collect", new { bundle });
        var collected = await collect.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(collect.StatusCode == HttpStatusCode.OK, collected!.ToJsonString());
        Assert.Equal("succeeded", collected["state"]!.GetValue<string>());
        Assert.True(collected["ingested"]!["receipts"]!.GetValue<int>() > 0, collected.ToJsonString());

        var feedId = ImportIds.PersonalFeedSpaceId("STORES", sub);
        Assert.Equal(
            collected["ingested"]!["receipts"]!.GetValue<int>(),
            factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "receipt")));

        // collecting again re-reads the same job: nothing new lands
        using var again = await client.PostAsJsonAsync($"/connectors/{SlowStore}/jobs/{jobId}/collect", new { bundle });
        Assert.True(again.IsSuccessStatusCode, await again.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_fetch_that_asks_a_code_is_answered_through_the_job_and_then_collected()
    {
        const string sub = "two-factor-syncer";
        using var client = factory.ClientFor(sub);

        // the login itself asks the code once
        using var login = await client.PostAsJsonAsync($"/connectors/{TwoFactorRegistry}/login", new { connectionId = "conn-2fa", inputs = Credentials });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        var sessionId = started!["sessionId"]!.GetValue<string>();
        var asked = started["state"]!.GetValue<string>() == "awaiting_input"
            ? started
            : await AwaitSessionAsync(client, TwoFactorRegistry, sessionId, "awaiting_input");
        using var answered = await client.PostAsJsonAsync($"/connectors/{TwoFactorRegistry}/login/{sessionId}/answer",
            new { challengeId = asked["challenge"]!["id"]!.GetValue<string>(), value = "314159" });
        Assert.True(answered.IsSuccessStatusCode, await answered.Content.ReadAsStringAsync());
        var bundle = await AwaitBundleAsync(client, TwoFactorRegistry, sessionId);

        // and every sync asks it again: the fetch parks on the question
        using var sync = await client.PostAsJsonAsync($"/connectors/{TwoFactorRegistry}/sync", new { connectionId = "conn-2fa", bundle });
        var accepted = await sync.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(sync.StatusCode == HttpStatusCode.Accepted, accepted!.ToJsonString());
        var jobId = accepted["jobId"]!.GetValue<string>();

        var parked = await AwaitJobAsync(client, TwoFactorRegistry, jobId, "awaiting_input");
        var challenge = parked["challenge"]!.AsObject();
        Assert.Equal("mfa_code", challenge["type"]!.GetValue<string>());

        using var code = await client.PostAsJsonAsync($"/connectors/{TwoFactorRegistry}/jobs/{jobId}/answer",
            new { challengeId = challenge["id"]!.GetValue<string>(), value = "314159" });
        Assert.True(code.IsSuccessStatusCode, await code.Content.ReadAsStringAsync());

        await AwaitJobAsync(client, TwoFactorRegistry, jobId, "succeeded");
        using var collect = await client.PostAsJsonAsync($"/connectors/{TwoFactorRegistry}/jobs/{jobId}/collect", new { bundle });
        var collected = await collect.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(collect.StatusCode == HttpStatusCode.OK, collected!.ToJsonString());
        Assert.True(collected["ingested"]!["positions"]!.GetValue<int>() > 0, collected.ToJsonString());

        var feedId = ImportIds.PersonalFeedSpaceId("REG", sub);
        Assert.True(factory.Read(db => db.EntityRows.Any(r => r.SpaceId == feedId && r.Entity == "account")));
    }

    [Fact]
    public async Task A_stranger_learns_nothing_from_a_job_id()
    {
        using var owner = factory.ClientFor("job-owner");
        using var stranger = factory.ClientFor("job-stranger");
        var bundle = await LoginAsync(owner, SlowStore, "conn-job-owned");
        using var sync = await owner.PostAsJsonAsync($"/connectors/{SlowStore}/sync", new { connectionId = "conn-job-owned", bundle, since = "2026-06-01" });
        var jobId = (await sync.Content.ReadFromJsonAsync<JsonObject>())!["jobId"]!.GetValue<string>();

        using var peek = await stranger.GetAsync($"/connectors/{SlowStore}/jobs/{jobId}");
        Assert.Equal(HttpStatusCode.BadRequest, peek.StatusCode);
        Assert.Equal("unsupported_resource", (await peek.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]!.GetValue<string>());
        using var grab = await stranger.PostAsJsonAsync($"/connectors/{SlowStore}/jobs/{jobId}/collect", new { bundle });
        Assert.Equal(HttpStatusCode.BadRequest, grab.StatusCode);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static async Task<string> LoginAsync(HttpClient client, string provider, string connectionId)
    {
        using var response = await client.PostAsJsonAsync($"/connectors/{provider}/login", new { connectionId, inputs = Credentials });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
        return view["bundle"]?.GetValue<string>() ?? await AwaitBundleAsync(client, provider, view["sessionId"]!.GetValue<string>());
    }

    private static async Task<JsonObject> AwaitJobAsync(HttpClient client, string provider, string jobId, string state)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            using var response = await client.GetAsync($"/connectors/{provider}/jobs/{jobId}");
            view = await response.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(response.IsSuccessStatusCode, view!.ToJsonString());
            var current = view["state"]!.GetValue<string>();
            if (current == state) return view;
            Assert.False(current is "failed" or "expired", view.ToJsonString());
            await Task.Delay(150);
        }
        throw new TimeoutException($"job never reached {state}: {view?.ToJsonString()}");
    }

    private static async Task<JsonObject> AwaitSessionAsync(HttpClient client, string provider, string sessionId, string state)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(20))
        {
            view = await client.GetFromJsonAsync<JsonObject>($"/connectors/{provider}/login/{sessionId}");
            if (view!["state"]!.GetValue<string>() == state) return view;
            await Task.Delay(100);
        }
        throw new TimeoutException($"session never reached {state}: {view?.ToJsonString()}");
    }

    private static async Task<string> AwaitBundleAsync(HttpClient client, string provider, string sessionId)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(20))
        {
            view = await client.GetFromJsonAsync<JsonObject>($"/connectors/{provider}/login/{sessionId}");
            if (view!["bundle"]?.GetValue<string>() is { } bundle) return bundle;
            Assert.False(view["state"]!.GetValue<string>() is "failed" or "expired", view.ToJsonString());
            await Task.Delay(100);
        }
        throw new TimeoutException($"no bundle: {view?.ToJsonString()}");
    }
}
