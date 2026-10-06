using System.Text.Json.Nodes;
using Munni.Api.Lab;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The new-service scaffold (#441 L5), as pure text from a recording: the
/// manifest stub, the OBSERVED options, the adapter stub, the fixtures, the
/// test skeleton and the README, every path a repo path, nothing in it a
/// value the recording did not already mask.
/// </summary>
public class LabScaffoldTests
{
    private static JsonObject Trace() => (JsonObject)JsonNode.Parse("""
        {
          "version": 1,
          "job_id": "job_rec1",
          "provider": "explore",
          "started_at": "2026-10-06T12:00:00+00:00",
          "ended_at": "2026-10-06T12:00:09+00:00",
          "truncated": false,
          "dropped": 0,
          "entries": [
            { "seq": 1, "at_ms": 0, "kind": "navigation", "via": "browser", "url": "https://shop.example.nl/login" },
            { "seq": 2, "at_ms": 5, "kind": "request", "via": "browser", "method": "GET", "url": "https://shop.example.nl/login", "resource_type": "document" },
            { "seq": 3, "at_ms": 40, "kind": "response", "via": "browser", "method": "GET", "url": "https://shop.example.nl/login", "status": 200, "resource_type": "document", "content_type": "text/html; charset=utf-8", "size": 2048, "body": "<html>login</html>" },
            { "seq": 4, "at_ms": 50, "kind": "response", "via": "browser", "method": "GET", "url": "https://cdn.example.nl/app.js", "status": 200, "resource_type": "script", "content_type": "application/javascript", "size": 90000 },
            { "seq": 5, "at_ms": 100, "kind": "request", "via": "browser", "method": "POST", "url": "https://api.example.nl/v2/session", "resource_type": "fetch", "content_type": "application/x-www-form-urlencoded", "body": "username=shopper&password=«redacted:7»&remember=1" },
            { "seq": 6, "at_ms": 140, "kind": "response", "via": "browser", "method": "POST", "url": "https://api.example.nl/v2/session", "status": 201, "resource_type": "fetch", "content_type": "application/json", "size": 80, "body": "{\"ok\":true,\"access_token\":\"«redacted:40»\",\"customer\":{\"name\":\"x\"}}" },
            { "seq": 7, "at_ms": 400, "kind": "response", "via": "browser", "method": "GET", "url": "https://api.example.nl/v2/orders?page=1", "status": 200, "resource_type": "xhr", "content_type": "application/json", "size": 300, "body": "{\"orders\":[{\"id\":\"o1\",\"total\":12.5,\"lines\":[{\"sku\":\"a\"}]}],\"next\":null}" },
            { "seq": 8, "at_ms": 500, "kind": "response", "via": "http", "method": "GET", "url": "https://api.example.nl/v2/orders/o1", "status": 200, "resource_type": "http", "content_type": "application/json", "size": 120, "body": "{\"id\":\"o1\",\"lines\":[{\"sku\":\"a\",\"qty\":2}]}" },
            { "seq": 9, "at_ms": 600, "kind": "console", "via": "browser", "level": "error", "text": "boom" },
            { "seq": 10, "at_ms": 700, "kind": "note", "text": "the run ended" }
          ],
          "cookies": [{ "name": "sid", "domain": "shop.example.nl", "path": "/", "http_only": true, "secure": true, "value_length": 32, "value_hash": "abcdef012345" }]
        }
        """)!;

    [Fact]
    public void A_recording_becomes_a_manifest_an_options_class_an_adapter_fixtures_tests_and_a_readme()
    {
        var files = LabScaffold.Files(new LabScaffoldRequest("example-shop", "ExampleShop", "shop"), Trace(), "# Recording of explore · job job_rec1\n");

        var paths = files.Select(f => f.Path).ToList();
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopManifest.cs", paths);
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopOptions.cs", paths);
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/ExampleShop/ExampleShopAdapter.cs", paths);
        Assert.Contains("server/tests/connectors/ShopConnector.Adapters.Tests/ExampleShopAdapterTests.cs", paths);
        Assert.Contains("server/src/connectors/ShopConnector.Adapters/Fixtures/example-shop/README.md", paths);
        Assert.Contains("README.md", paths);
        Assert.Contains("digest.md", paths);

        // the JSON answers worth reading become fixtures; the script and the HTML do not
        var fixtures = paths.Where(p => p.StartsWith("server/src/connectors/ShopConnector.Adapters/Fixtures/example-shop/", StringComparison.Ordinal) && p.EndsWith(".json", StringComparison.Ordinal)).ToList();
        Assert.Equal(3, fixtures.Count);
        Assert.Contains(fixtures, p => p.EndsWith("01-post-v2-session.json", StringComparison.Ordinal));
        Assert.Contains(fixtures, p => p.EndsWith("02-get-v2-orders.json", StringComparison.Ordinal));
        Assert.Contains(fixtures, p => p.EndsWith("03-get-v2-orders-o1.json", StringComparison.Ordinal));

        var manifest = Content(files, "ExampleShopManifest.cs");
        Assert.Contains("Id = ExampleShopAdapter.ProviderId", manifest, StringComparison.Ordinal);
        Assert.Contains("Kind = ProviderKind.Store", manifest, StringComparison.Ordinal);
        Assert.Contains("Runtime = ProviderRuntime.BrowserOnce", manifest, StringComparison.Ordinal);
        Assert.Contains("Key = \"username\"", manifest, StringComparison.Ordinal);
        Assert.Contains("Key = \"password\"", manifest, StringComparison.Ordinal);
        Assert.Contains("Type = FieldType.Password", manifest, StringComparison.Ordinal);
        Assert.Contains("LoginOrigins = [\"shop.example.nl\"]", manifest, StringComparison.Ordinal);
        Assert.Contains("Returns = ResourceShape.Receipt", manifest, StringComparison.Ordinal);

        var options = Content(files, "ExampleShopOptions.cs");
        Assert.Contains("public string LoginUrl { get; init; } = \"https://shop.example.nl/login\";", options, StringComparison.Ordinal);
        Assert.Contains("public string BaseUrl { get; init; } = \"https://api.example.nl\";", options, StringComparison.Ordinal);
        Assert.Contains("public string PostV2SessionPath { get; init; } = \"/v2/session\";", options, StringComparison.Ordinal);
        Assert.Contains("public string V2OrdersPath { get; init; } = \"/v2/orders\";", options, StringComparison.Ordinal);
        Assert.Contains("shape: {orders: [1 × {id: string, total: number, lines: [1 × …]}], next: null}", options, StringComparison.Ordinal);
        Assert.Contains("(http client)", options, StringComparison.Ordinal);
        Assert.DoesNotContain("app.js", options, StringComparison.Ordinal);

        var adapter = Content(files, "ExampleShopAdapter.cs");
        Assert.Contains("public const string ProviderId = \"example-shop\";", adapter, StringComparison.Ordinal);
        Assert.Contains("public const string ReceiptsResource = \"receipts\";", adapter, StringComparison.Ordinal);
        Assert.Contains("POST api.example.nl/v2/session → 201 (_options.PostV2SessionPath)", adapter, StringComparison.Ordinal);
        Assert.Contains("ConnectorException.Unsupported", adapter, StringComparison.Ordinal);

        var tests = Content(files, "ExampleShopAdapterTests.cs");
        Assert.Contains("ManifestValidator.Validate(manifest)", tests, StringComparison.Ordinal);
        Assert.Contains("[Fact(Skip = \"scaffolded from recording job_rec1: write the reader for GET /v2/orders first\")]", tests, StringComparison.Ordinal);
        Assert.Contains("Stub.Fixture(\"example-shop/02-get-v2-orders.json\", HttpStatusCode.OK)", tests, StringComparison.Ordinal);
        Assert.Contains("HttpStatusCode.Created", tests, StringComparison.Ordinal);

        var readme = Root(files, "README.md");
        Assert.Contains("ShopAdapters.Real", readme, StringComparison.Ordinal);
        Assert.Contains("Fields posted: `username`, `password`, `remember`", readme, StringComparison.Ordinal);
        Assert.Contains("Cookies at the end: 1", readme, StringComparison.Ordinal);

        // whatever the recorder masked stays masked; nothing a scaffold adds is a value
        var everything = string.Join('\n', files.Select(f => f.Content));
        Assert.Contains("«redacted:40»", everything, StringComparison.Ordinal);
        Assert.DoesNotContain("shopper@", everything, StringComparison.Ordinal);
    }

    [Fact]
    public void A_bank_and_a_registry_land_in_their_own_assemblies_with_their_own_resource()
    {
        var bank = LabScaffold.Files(new LabScaffoldRequest("some-bank", "SomeBank", "bank"), Trace(), "digest");
        Assert.Contains(bank, f => f.Path == "server/src/connectors/BankConnector.Adapters/SomeBank/SomeBankManifest.cs");
        Assert.Contains("Returns = ResourceShape.Transaction", Content(bank, "SomeBankManifest.cs"), StringComparison.Ordinal);
        Assert.Contains("BankAdapters.Real", Root(bank, "README.md"), StringComparison.Ordinal);

        var registry = LabScaffold.Files(new LabScaffoldRequest("some-registry", "SomeRegistry", "registry"), Trace(), "digest");
        Assert.Contains("Returns = ResourceShape.CreditRegistration", Content(registry, "SomeRegistryManifest.cs"), StringComparison.Ordinal);
        Assert.Contains("Kind = ProviderKind.Registry", Content(registry, "SomeRegistryManifest.cs"), StringComparison.Ordinal);
    }

    [Fact]
    public void An_empty_recording_still_scaffolds_and_says_so()
    {
        var empty = (JsonObject)JsonNode.Parse("""{"job_id":"job_empty","provider":"explore","started_at":"2026-10-06T12:00:00+00:00","entries":[],"cookies":[]}""")!;

        var files = LabScaffold.Files(new LabScaffoldRequest("blank", "Blank", "shop"), empty, "digest");

        Assert.DoesNotContain(files, f => f.Path.EndsWith(".json", StringComparison.Ordinal));
        Assert.Contains("Runtime = ProviderRuntime.Http", Content(files, "BlankManifest.cs"), StringComparison.Ordinal);
        Assert.Contains("the recording held no call worth reading", Content(files, "BlankOptions.cs"), StringComparison.Ordinal);
        Assert.Contains("The recording held no JSON answer worth keeping.", Content(files, "Fixtures/blank/README.md"), StringComparison.Ordinal);
    }

    /// <summary>The one file whose path ends so, under some folder; the root README is asked for by <see cref="Root"/>.</summary>
    private static string Content(IReadOnlyList<LabScaffold.ScaffoldFile> files, string pathEnd) =>
        Assert.Single(files, f => f.Path.EndsWith("/" + pathEnd, StringComparison.Ordinal)).Content;

    /// <summary>The one file at the archive's root with this very path.</summary>
    private static string Root(IReadOnlyList<LabScaffold.ScaffoldFile> files, string path) =>
        Assert.Single(files, f => f.Path == path).Content;
}
