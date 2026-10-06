using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The new-service scaffold's door (#441 L5): a recorded run becomes a zip of
/// files at repo paths, named as the operator asked; the names are held to
/// their shapes, and a run without a recording is the control plane's refusal.
/// </summary>
public class ConnectorScaffoldTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";
    private const string Simple = "mock-store-simple";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task A_recorded_run_scaffolds_an_adapter_at_repo_paths_with_the_names_given()
    {
        using var operatorClient = factory.ClientFor("scaffold-operator", scope: Admin);

        using var login = await operatorClient.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials, record = true });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.IsSuccessStatusCode, started!.ToJsonString());
        var sessionId = started["sessionId"]!.GetValue<string>();
        await AwaitStateAsync(operatorClient, sessionId);

        var history = await operatorClient.GetFromJsonAsync<JsonObject>($"/lab/jobs?session={sessionId}");
        var jobId = Assert.Single(history!["jobs"]!.AsArray())!["jobId"]!.GetValue<string>();

        using var refused = await operatorClient.GetAsync($"/lab/jobs/{jobId}/scaffold?provider=Not%20Kebab&name=x&product=shop");
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

        using var zip = await operatorClient.GetAsync($"/lab/jobs/{jobId}/scaffold?provider=example-shop&name=ExampleShop&product=shop&country=nl");
        Assert.Equal(HttpStatusCode.OK, zip.StatusCode);
        Assert.Equal("application/zip", zip.Content.Headers.ContentType?.MediaType);
        Assert.Contains("example-shop-scaffold.zip", zip.Content.Headers.ContentDisposition?.FileName ?? string.Empty, StringComparison.Ordinal);

        using var archive = new ZipArchive(new MemoryStream(await zip.Content.ReadAsByteArrayAsync()), ZipArchiveMode.Read);
        var names = archive.Entries.Select(e => e.FullName).ToList();
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopManifest.cs", names);
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopOptions.cs", names);
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopAdapter.cs", names);
        Assert.Contains("server/tests/connectors/ShopConnector.Adapters.Tests/ExampleShopAdapterTests.cs", names);
        Assert.Contains("README.md", names);
        Assert.Contains("digest.md", names);

        using var reader = new StreamReader(archive.GetEntry("digest.md")!.Open());
        Assert.StartsWith($"# Recording of {Simple} · job {jobId}", await reader.ReadToEndAsync(), StringComparison.Ordinal);

        using var manifestReader = new StreamReader(archive.GetEntry("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopManifest.cs")!.Open());
        var manifest = await manifestReader.ReadToEndAsync();
        Assert.Contains("Country = \"NL\"", manifest, StringComparison.Ordinal);
        Assert.DoesNotContain("hunter2", manifest, StringComparison.Ordinal);

        // a run without a recording is the control plane's refusal, passed on
        var noRecording = await operatorClient.GetAsync("/lab/jobs/job_nobody/scaffold?provider=x-y&name=Xy&product=bank");
        Assert.Equal(HttpStatusCode.BadRequest, noRecording.StatusCode);

        using var user = factory.ClientFor("scaffold-plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync($"/lab/jobs/{jobId}/scaffold?provider=example-shop&name=ExampleShop&product=shop")).StatusCode);

        using var gone = await operatorClient.DeleteAsync($"/lab/bench/sessions/{sessionId}");
        Assert.True(gone.IsSuccessStatusCode, await gone.Content.ReadAsStringAsync());
    }

    private static async Task AwaitStateAsync(HttpClient client, string sessionId)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var view = await client.GetFromJsonAsync<JsonObject>($"/lab/bench/{Simple}/login/{sessionId}");
            if (view!["state"]!.GetValue<string>() == "active") return;
            await Task.Delay(100);
        }
        throw new TimeoutException("the lab session never became active");
    }
}
