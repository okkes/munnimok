using System.Net;
using System.Text.Json;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// api-spec §2.6 kill switch: the check runs before any adapter, so a paused provider refuses work with provider_unavailable
[Collection(ShopApiCollection.Name)]
public sealed class ProviderStatusTests(ShopApiFactory factory)
{
    // the broken mock: nothing else connects to it, and pausing is global state on a shared host
    private const string Provider = MockStoreAdapters.Broken;

    private const string ReasonKey = "connect.provider.paused_for_maintenance";

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task A_paused_provider_refuses_work_and_says_so_in_the_catalogue()
    {
        using var http = factory.CreateAuthorizedClient();

        // connect while healthy: this mock only breaks on fetch, so the refusal below is the kill switch, not the adapter
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("paused"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        try
        {
            using (var paused = await SetStatusAsync(http, "paused", ReasonKey))
            {
                Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
                var status = await paused.JsonAsync();
                Assert.Equal("paused", status.Text("state"));
                Assert.Equal(ReasonKey, status.Text("reason_key"));
            }

            var catalogued = await StatusInCatalogueAsync(http);
            Assert.Equal("paused", catalogued.Text("state"));
            Assert.Equal(ReasonKey, catalogued.Text("reason_key"));

            using (var fetch = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since=2026-06-01", ticket))
            {
                // provider_unavailable, not provider_changed: the adapter never ran.
                await ErrorEnvelope.AssertAsync(fetch, HttpStatusCode.ServiceUnavailable, "provider_unavailable");
            }

            using var request = Wire.Post($"/v1/{Provider}/login",
                new { Subject = Flows.NewSubject("paused-login"), Inputs = Credentials });

            using var login = await http.SendAsync(request);
            await ErrorEnvelope.AssertAsync(login, HttpStatusCode.ServiceUnavailable, "provider_unavailable");
        }
        finally
        {
            using var restored = await SetStatusAsync(http, "healthy", reasonKey: null);
            Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        }

        using var resumed = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since=2026-06-01", ticket);

        await ErrorEnvelope.AssertAsync(resumed, HttpStatusCode.BadGateway, "provider_changed");
    }

    private static async Task<HttpResponseMessage> SetStatusAsync(HttpClient http, string state, string? reasonKey)
    {
        using var request = Wire.Post($"/v1/admin/providers/{Provider}/status",
            new { State = state, ReasonKey = reasonKey });

        return await http.SendAsync(request);
    }

    private static async Task<JsonElement> StatusInCatalogueAsync(HttpClient http)
    {
        using var response = await http.GetAsync($"/v1/providers/{Provider}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.JsonAsync()).GetProperty("status");
    }
}
