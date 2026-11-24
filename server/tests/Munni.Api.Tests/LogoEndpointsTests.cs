using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Logos;

namespace Munni.Api.Tests;

internal sealed class FakeLogoHandler : HttpMessageHandler
{
    public int Searches;
    public string? LastAuthorization;

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Searches++;
        LastAuthorization = request.Headers.Authorization?.ToString();
        const string body = """[{"name":"Streamo","domain":"streamo.example"},{"name":"No domain","domain":null}]""";
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
    }
}

public class LogoApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databaseName = $"logo-tests-{Guid.NewGuid():N}";
    internal FakeLogoHandler Logos { get; } = new();
    public string? SecretKey { get; init; } = "sk_test_secret";
    public string? PublicToken { get; init; } = "pk_test_public";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("Logos:SecretKey", SecretKey);
        builder.UseSetting("Logos:PublicToken", PublicToken);
        builder.ConfigureServices(services =>
        {
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
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
            services.AddHttpClient(LogoEndpoints.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => Logos);
        });
    }
}

// #678: the search runs on the server with the secret key; a client only ever sees the publishable token
public class LogoEndpointsTests
{
    private static HttpClient ClientFor(LogoApiFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", "logo-user");
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    [Fact]
    public async Task A_search_is_made_with_the_secret_key_and_answers_with_addresses_that_hold_only_the_publishable_token()
    {
        await using var factory = new LogoApiFactory();
        var client = ClientFor(factory);

        var body = await client.GetStringAsync("/logos/search?q=streamo");

        Assert.Equal("Bearer sk_test_secret", factory.Logos.LastAuthorization);
        Assert.DoesNotContain("sk_test_secret", body);
        var hits = JsonSerializer.Deserialize<JsonElement>(body);
        Assert.Equal(1, hits.GetArrayLength());
        Assert.Equal("https://img.logo.dev/streamo.example?token=pk_test_public&size=64&format=png&retina=true", hits[0].GetProperty("logoUrl").GetString());

        var health = await client.GetFromJsonAsync<JsonElement>("/health");
        Assert.True(health.GetProperty("capabilities").GetProperty("logos").GetBoolean());
        var verdict = await client.GetStringAsync("/logos/health");
        Assert.DoesNotContain("sk_test_secret", verdict);
        Assert.DoesNotContain("pk_test_public", verdict);
        Assert.Equal("ok", JsonSerializer.Deserialize<JsonElement>(verdict).GetProperty("search").GetString());
    }

    [Fact]
    public async Task A_secret_key_in_the_publishable_slot_is_never_served_the_search_stays_off_and_says_why()
    {
        await using var factory = new LogoApiFactory { SecretKey = "pk_swapped_public", PublicToken = "sk_swapped_secret" };
        var client = ClientFor(factory);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/logos/search?q=streamo")).StatusCode);
        Assert.Equal(0, factory.Logos.Searches);
        var health = await client.GetFromJsonAsync<JsonElement>("/health");
        Assert.False(health.GetProperty("capabilities").GetProperty("logos").GetBoolean());

        var verdict = await client.GetStringAsync("/logos/health");
        Assert.DoesNotContain("sk_swapped_secret", verdict);
        var read = JsonSerializer.Deserialize<JsonElement>(verdict);
        Assert.True(read.GetProperty("publicLooksSwapped").GetBoolean());
        Assert.True(read.GetProperty("secretLooksSwapped").GetBoolean());
        Assert.StartsWith("refused", read.GetProperty("search").GetString());
    }

    [Fact]
    public async Task Without_keys_there_is_no_search_and_the_verdict_says_unconfigured()
    {
        await using var factory = new LogoApiFactory { SecretKey = "", PublicToken = "" };
        var client = ClientFor(factory);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/logos/search?q=streamo")).StatusCode);
        var read = await client.GetFromJsonAsync<JsonElement>("/logos/health");
        Assert.False(read.GetProperty("configured").GetBoolean());
        Assert.StartsWith("unconfigured", read.GetProperty("search").GetString());
    }

    [Theory]
    [InlineData("sk_a", "pk_b", true)]
    [InlineData("sk_a", "sk_b", false)]
    [InlineData("", "pk_b", false)]
    [InlineData("sk_a", null, false)]
    public void Usable_needs_both_keys_and_no_secret_in_the_publishable_slot(string? secretKey, string? publicToken, bool usable) =>
        Assert.Equal(usable, LogoEndpoints.Usable(secretKey, publicToken));
}
