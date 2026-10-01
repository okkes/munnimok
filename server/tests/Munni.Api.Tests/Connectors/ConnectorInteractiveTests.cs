using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The relay when a party asks the human something (docs/connector-
/// integration-plan.md §5.2, §5.4): the challenge reaches the app in its own
/// casing, the picture comes through, the answer goes back, and every
/// change of the session's view rides the app's own event stream as a
/// <c>connector</c> frame — never with a bundle on it.
/// </summary>
public class ConnectorInteractiveTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Captcha = "mock-store-captcha";
    private const string Sms = "mock-store-sms";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task A_captcha_login_relays_the_picture_the_answer_and_the_events()
    {
        const string sub = "captcha-solver";
        using var client = factory.ClientFor(sub);

        // the app already holds the event stream when it starts a login
        using var stream = await client.GetAsync("/sync/events", HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, stream.StatusCode);
        var reader = new StreamReader(await stream.Content.ReadAsStreamAsync());
        Assert.Equal(": connected", await reader.ReadLineAsync());

        using var login = await client.PostAsJsonAsync($"/connectors/{Captcha}/login", new { connectionId = "conn-captcha", inputs = Credentials });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        var sessionId = started!["sessionId"]!.GetValue<string>();

        // the run stops to ask: 202 now, or a poll that lands on the question
        var awaiting = started["state"]!.GetValue<string>() == "awaiting_input"
            ? started
            : await AwaitStateAsync(client, Captcha, sessionId, "awaiting_input");
        var challenge = awaiting["challenge"]!.AsObject();
        Assert.Equal("image", challenge["type"]!.GetValue<string>());
        Assert.NotNull(challenge["promptKey"]);
        Assert.NotNull(challenge["expiresAt"]);
        Assert.Null(challenge["prompt_key"]);
        var challengeId = challenge["id"]!.GetValue<string>();
        Assert.Equal("awaiting_input", factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId).State));

        // the picture, through the relay, for the owner
        using var image = await client.GetAsync($"/connectors/{Captcha}/login/{sessionId}/challenges/{challengeId}/image");
        Assert.Equal(HttpStatusCode.OK, image.StatusCode);
        Assert.Equal("image/png", image.Content.Headers.ContentType?.MediaType);
        Assert.True((await image.Content.ReadAsByteArrayAsync()).Length > 0);

        // the answer, and the session settles with its bundle
        using var answered = await client.PostAsJsonAsync($"/connectors/{Captcha}/login/{sessionId}/answer", new { challengeId, value = "MOCK1" });
        Assert.True(answered.IsSuccessStatusCode, await answered.Content.ReadAsStringAsync());
        var settled = await AwaitBundleAsync(client, Captcha, sessionId);
        Assert.StartsWith("sb_v1.", settled, StringComparison.Ordinal);
        Assert.Equal("active", factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId).State));

        // and the app heard the run through its own stream, without a bundle
        var frames = await DrainFramesAsync(reader, TimeSpan.FromSeconds(10), f => f["sessionId"]?.GetValue<string>() == sessionId);
        Assert.NotEmpty(frames);
        Assert.All(frames, frame =>
        {
            Assert.Equal(ConnectorEventBridge.Kind, frame["kind"]!.GetValue<string>());
            Assert.Equal(Captcha, frame["provider"]!.GetValue<string>());
            Assert.DoesNotContain("sb_v1.", frame.ToJsonString(), StringComparison.Ordinal);
            Assert.Null(frame["bundle"]);
        });
        Assert.Contains(frames, f => f["state"]!.GetValue<string>() == "awaiting_input" && f["challenge"] is not null);
    }

    [Fact]
    public async Task An_sms_code_login_settles_after_the_code()
    {
        using var client = factory.ClientFor("sms-reader");
        using var login = await client.PostAsJsonAsync($"/connectors/{Sms}/login", new { connectionId = "conn-sms", inputs = Credentials });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        var sessionId = started!["sessionId"]!.GetValue<string>();
        var awaiting = started["state"]!.GetValue<string>() == "awaiting_input"
            ? started
            : await AwaitStateAsync(client, Sms, sessionId, "awaiting_input");
        var challenge = awaiting["challenge"]!.AsObject();
        Assert.Equal("mfa_code", challenge["type"]!.GetValue<string>());

        using var answered = await client.PostAsJsonAsync($"/connectors/{Sms}/login/{sessionId}/answer", new { challengeId = challenge["id"]!.GetValue<string>(), value = "123456" });
        Assert.True(answered.IsSuccessStatusCode, await answered.Content.ReadAsStringAsync());
        Assert.StartsWith("sb_v1.", await AwaitBundleAsync(client, Sms, sessionId), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_cancelled_login_is_failed_and_its_row_says_so()
    {
        using var client = factory.ClientFor("cancel-owner");
        using var login = await client.PostAsJsonAsync($"/connectors/{Captcha}/login", new { connectionId = "conn-cancel", inputs = Credentials });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        var sessionId = started!["sessionId"]!.GetValue<string>();
        await AwaitStateAsync(client, Captcha, sessionId, "awaiting_input");

        using var cancel = await client.PostAsync($"/connectors/{Captcha}/login/{sessionId}/cancel", null);
        Assert.True(cancel.IsSuccessStatusCode, await cancel.Content.ReadAsStringAsync());
        var view = await cancel.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal("failed", view!["state"]!.GetValue<string>());
        Assert.Equal("failed", factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId).State));
    }

    [Fact]
    public async Task The_login_budget_is_a_429_with_the_connectors_envelope()
    {
        using var tight = factory.WithWebHostBuilder(builder => builder.UseSetting("Connectors:LoginsPerHour", "1"));
        using var client = tight.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", "budget-user");
        client.DefaultRequestHeaders.Add("X-Munni-Device", "device-budget");

        using var first = await client.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId = "conn-b1", inputs = Credentials });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using var second = await client.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId = "conn-b2", inputs = Credentials });
        Assert.Equal(HttpStatusCode.TooManyRequests, second.StatusCode);
        Assert.NotNull(second.Headers.RetryAfter);
        var error = (await second.Content.ReadFromJsonAsync<JsonObject>())!["error"]!;
        Assert.Equal("rate_limited", error["code"]!.GetValue<string>());
        Assert.Equal("wait", error["userAction"]!.GetValue<string>());
        Assert.True(error["retryAfterSeconds"]!.GetValue<int>() > 0);
    }

    [Fact]
    public async Task A_web_client_gets_an_ephemeral_session()
    {
        using var client = factory.ClientFor("web-shopper", platform: "web");
        using var login = await client.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId = "conn-web", inputs = Credentials });
        var view = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Equal("ephemeral", view!["custody"]!.GetValue<string>());
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static async Task<JsonObject> AwaitStateAsync(HttpClient client, string provider, string sessionId, string state)
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

    /// <summary>The bundle is handed over exactly once — the first poll that sees it takes it.</summary>
    private static async Task<string> AwaitBundleAsync(HttpClient client, string provider, string sessionId)
    {
        var clock = Stopwatch.StartNew();
        JsonObject? view = null;
        while (clock.Elapsed < TimeSpan.FromSeconds(20))
        {
            view = await client.GetFromJsonAsync<JsonObject>($"/connectors/{provider}/login/{sessionId}");
            if (view!["bundle"]?.GetValue<string>() is { } bundle) return bundle;
            var state = view["state"]!.GetValue<string>();
            if (state is "failed" or "expired") throw new InvalidOperationException($"login ended {state}: {view.ToJsonString()}");
            await Task.Delay(100);
        }
        throw new TimeoutException($"no bundle: {view?.ToJsonString()}");
    }

    private static async Task<List<JsonObject>> DrainFramesAsync(StreamReader reader, TimeSpan patience, Func<JsonObject, bool> wanted)
    {
        var frames = new List<JsonObject>();
        using var cts = new CancellationTokenSource(patience);
        try
        {
            while (await reader.ReadLineAsync(cts.Token) is { } line)
            {
                if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                var frame = JsonNode.Parse(line[5..].Trim()) as JsonObject;
                if (frame is null || frame["kind"]?.GetValue<string>() != ConnectorEventBridge.Kind || !wanted(frame)) continue;
                frames.Add(frame);
                if (frame["state"]?.GetValue<string>() == "active") break;
            }
        }
        catch (OperationCanceledException)
        {
            // patience ran out — whatever arrived is what the assertion sees
        }
        return frames;
    }
}
