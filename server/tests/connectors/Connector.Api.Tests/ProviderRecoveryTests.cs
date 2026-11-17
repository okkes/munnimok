using System.Diagnostics;
using System.Net;
using Connector.Api.Tests.Infrastructure;
using Xunit;

namespace Connector.Api.Tests;

// provider status is global: join the shared collection (a lone IClassFixture class runs concurrently on a second host)
// and restore every changed status in a finally, or an unrelated later test fails
[Collection(ShopApiCollection.Name)]
public sealed class ProviderRecoveryTests(ShopApiFactory factory)
{
    // status is written by the finished job, not the request that started it: poll until it settles
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(15);

    [Fact]
    public async Task A_provider_whose_shape_moved_is_degraded()
    {
        var http = factory.CreateAuthorizedClient();
        try
        {
            // mock-store-broken signs in fine and reports the shape change on the FETCH
            var connection = await Flows.ConnectAsync(http, "mock-store-broken", Flows.NewSubject("degrade"),
                new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });

            var ticket = await Flows.ResumeAsync(http, "mock-store-broken", connection);
            using var fetch = await Flows.FetchAsync(
                http, "/v1/mock-store-broken/receipts?since=2026-01-01", ticket);

            Assert.NotEqual(HttpStatusCode.OK, fetch.StatusCode);
            await AwaitStatusAsync(http, "mock-store-broken", "degraded");
        }
        finally
        {
            await ResetAsync(http, "mock-store-broken");
        }
    }

    [Fact]
    public async Task A_successful_job_clears_degraded_without_being_asked()
    {
        var http = factory.CreateAuthorizedClient();
        try
        {
            await SetAsync(http, "mock-store-simple", "degraded", "connect.provider.changed");
            await AwaitStatusAsync(http, "mock-store-simple", "degraded");

            await Flows.ConnectAsync(http, "mock-store-simple", Flows.NewSubject("recover"),
                new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });

            await AwaitStatusAsync(http, "mock-store-simple", "healthy");
        }
        finally
        {
            await ResetAsync(http, "mock-store-simple");
        }
    }

    [Fact]
    public async Task A_paused_provider_stays_paused_and_refuses_work()
    {
        var http = factory.CreateAuthorizedClient();
        try
        {
            await SetAsync(http, "mock-store-sms", "paused", "connect.provider.paused");

            using var request = Wire.Post("/v1/mock-store-sms/login", new
            {
                subject = Flows.NewSubject("paused"),
                inputs = new { username = "u", password = "p" },
            });
            using var response = await http.SendAsync(request);

            Assert.True(response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Accepted),
                $"a paused provider accepted work: {(int)response.StatusCode}");
            Assert.Equal("paused", await StateOfAsync(http, "mock-store-sms"));
        }
        finally
        {
            await ResetAsync(http, "mock-store-sms");
        }
    }

    private static async Task SetAsync(HttpClient http, string providerId, string state, string? reasonKey)
    {
        using var request = Wire.Post($"/v1/admin/providers/{providerId}/status", new { state, reasonKey });
        using var response = await http.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static Task ResetAsync(HttpClient http, string providerId) =>
        SetAsync(http, providerId, "healthy", null);

    private static async Task AwaitStatusAsync(HttpClient http, string providerId, string expected)
    {
        var clock = Stopwatch.StartNew();
        var seen = "unknown";

        while (clock.Elapsed < Settle)
        {
            seen = await StateOfAsync(http, providerId);
            if (string.Equals(seen, expected, StringComparison.Ordinal)) return;
            await Task.Delay(100);
        }

        Assert.Fail($"{providerId} was still '{seen}' after {Settle.TotalSeconds:0}s, expected '{expected}'");
    }

    private static async Task<string> StateOfAsync(HttpClient http, string providerId)
    {
        using var response = await http.GetAsync("/v1/status");
        var body = await response.JsonAsync();

        foreach (var provider in body.GetProperty("providers").EnumerateArray())
        {
            if (provider.GetProperty("provider_id").GetString() == providerId)
            {
                return provider.GetProperty("state").GetString()!;
            }
        }

        throw new InvalidOperationException($"no status row for '{providerId}'");
    }
}
