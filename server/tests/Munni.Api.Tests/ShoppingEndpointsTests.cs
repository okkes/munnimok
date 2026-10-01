using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Shopping;

namespace Munni.Api.Tests;

file sealed class FakeTesseractHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
        Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"data":{"exit":{"code":0},"stdout":"AH BANANEN 1,89\nTOTAAL 1,89"}}""", Encoding.UTF8, "application/json"),
        });
}

public class ShoppingApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("Ocr:BaseUrl", "http://ocr:8884");
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
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("shopping-endpoint-tests"));
            services.AddHttpClient(OcrEndpoints.HttpClientName)
                .ConfigurePrimaryHttpMessageHandler(() => new FakeTesseractHandler());
        });
    }
}

public class ShoppingEndpointsTests : IClassFixture<ShoppingApiFactory>
{
    private readonly ShoppingApiFactory _factory;

    public ShoppingEndpointsTests(ShoppingApiFactory factory) => _factory = factory;

    private HttpClient Client()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", "shopper");
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    [Fact]
    public async Task Ocr_validates_the_image_and_returns_the_text()
    {
        var client = Client();
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/ocr/receipt", new { image = "not-a-data-url" })).StatusCode);

        var fake = "data:image/jpeg;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes("jpg"));
        var response = await client.PostAsJsonAsync("/ocr/receipt", new { image = fake });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Contains("BANANEN", payload.GetProperty("text").GetString());
    }

    [Fact]
    public async Task Health_advertises_the_shopping_capabilities()
    {
        var health = await _factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
        var capabilities = health.GetProperty("capabilities");
        Assert.True(capabilities.GetProperty("ocr").GetBoolean());
    }
}
