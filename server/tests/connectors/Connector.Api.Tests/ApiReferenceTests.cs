using System.Net;
using Connector.Kit.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// the reference is absent in production on purpose: /v1/* there demands a client certificate and an M2M token,
/// so a browser-reachable page would describe an API the browser cannot call
[Collection(ShopApiCollection.Name)]
public sealed class ApiReferenceTests(ShopApiFactory factory)
{
    [Theory]
    [InlineData("/scalar")]
    [InlineData("/openapi/v1.json")]
    public async Task Development_serves_the_reference(string path)
    {
        using var http = factory.CreateClient();

        // no X-Connector-Key: the reference is outside the consumer filter, a browser has no consumer credential
        using var response = await http.GetAsync(path);

        Assert.True(
            response.IsSuccessStatusCode,
            $"expected {path} to be served in development, got {(int)response.StatusCode}");
    }

    /// a generator silently emitting `{"paths":{}}` would pass a status-code check while documenting nothing
    [Fact]
    public async Task The_document_describes_the_routes_this_service_actually_has()
    {
        using var http = factory.CreateClient();

        var document = await http.GetStringAsync("/openapi/v1.json");

        Assert.Contains("/v1/health", document, StringComparison.Ordinal);
        Assert.Contains("/v1/providers", document, StringComparison.Ordinal);
    }

    /// built the way the real host builds itself, so it asserts the wiring rather than a copy
    [Theory]
    [InlineData("/scalar")]
    [InlineData("/openapi/v1.json")]
    public async Task Production_serves_no_reference_at_all(string path)
    {
        await using var app = BuildProductionHost();
        await app.StartAsync();

        using var http = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        using var response = await http.GetAsync(path);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    /// a production host minus real infrastructure: enough config to pass ConnectorPlatform's start-up refusals
    private static WebApplication BuildProductionHost()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");

        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Connector:Mode"] = "Production",
            ["Connector:Database:Provider"] = "Postgres",
            ["Connector:Database:ConnectionString"] = "Host=127.0.0.1;Database=unused",
            ["Connector:Bundle:CurrentKid"] = "k1",
            ["Connector:Bundle:Keys:k1"] = Convert.ToBase64String(new byte[32]),
            ["Connector:EnrollmentHmacKey"] = "test-enrollment-hmac",
            ["Connector:Auth:Authority"] = "https://issuer.invalid",
            ["Connector:Auth:Audience"] = "connector.shop",
        });

        builder.Services.AddConnectorPlatform(builder.Configuration, platform =>
            platform.AddAdapter(new RotatingStoreAdapter()));

        var app = builder.Build();

        // deliberately NOT UseConnectorPlatform(): it migrates a database
        app.MapConnectorReference();
        app.MapConnectorApi();

        return app;
    }
}
