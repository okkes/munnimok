using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Munni.Api.Tests;

/// <summary>
/// Admin catalog (AC1): a versioned content document — public read with
/// ETag caching, admin-gated publish, server-owned version counter.
/// </summary>
public class CatalogEndpointsTests : IClassFixture<AdminApiFactory>
{
    private readonly AdminApiFactory _factory;

    public CatalogEndpointsTests(AdminApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string? sub, string? scope = null)
    {
        var client = _factory.CreateClient();
        if (sub is not null)
        {
            client.DefaultRequestHeaders.Add("X-User-Sub", sub);
            client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        }
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    private static readonly string[] AhPatterns = ["albert heijn", "AH to go"];

    private static object Payload(string keyword = "padel") => new
    {
        categories = new[] { new { id = "groceries", en = "Groceries", nl = "Boodschappen", tr = "Market" } },
        keywords = new[] { new { keyword, catId = "hobby" } },
        stores = new[] { new { id = "ah", patterns = AhPatterns } },
    };

    [Fact]
    public async Task NoDocumentYet_ReadIsNoContent()
    {
        var response = await ClientFor(null).GetAsync("/catalog");
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    [Fact]
    public async Task NonAdmin_CannotPublish()
    {
        var client = ClientFor("plain-user");
        await client.GetAsync("/me"); // materialize the user row
        var response = await client.PutAsJsonAsync("/admin/catalog", Payload());
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Publish_BumpsVersion_AndServesWithEtag()
    {
        var admin = ClientFor("the-admin", "admin");
        var first = await admin.PutAsJsonAsync("/admin/catalog", Payload());
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var second = await admin.PutAsJsonAsync("/admin/catalog", Payload("tennis"));
        var v2 = JsonDocument.Parse(await second.Content.ReadAsStringAsync()).RootElement.GetProperty("version").GetInt32();

        var read = await ClientFor(null).GetAsync("/catalog");
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        var etag = read.Headers.ETag!.Tag;
        Assert.Contains($"catalog-v{v2}", etag);
        var doc = JsonDocument.Parse(await read.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal(v2, doc.GetProperty("version").GetInt32());
        Assert.Equal("tennis", doc.GetProperty("keywords")[0].GetProperty("keyword").GetString());
        // receipts v3 R9: store merchant patterns publish and serve verbatim
        var store = doc.GetProperty("stores")[0];
        Assert.Equal("ah", store.GetProperty("id").GetString());
        Assert.Equal(2, store.GetProperty("patterns").GetArrayLength());

        // a fresh device revalidates for free
        var cached = ClientFor(null);
        cached.DefaultRequestHeaders.TryAddWithoutValidation("If-None-Match", etag);
        var revalidated = await cached.GetAsync("/catalog");
        Assert.Equal(HttpStatusCode.NotModified, revalidated.StatusCode);
    }

    [Fact]
    public async Task Publish_IsTheWholeDocument_EverySectionAnArray()
    {
        var admin = ClientFor("the-admin", "admin");
        var empty = Array.Empty<object>();
        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PutAsJsonAsync("/admin/catalog", new { categories = "nope", keywords = empty, stores = empty })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PutAsJsonAsync("/admin/catalog", new { categories = empty, keywords = empty, stores = "ah" })).StatusCode);
        // a publish that leaves a section out would silently erase it
        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PutAsJsonAsync("/admin/catalog", new { categories = empty, keywords = empty })).StatusCode);
        Assert.Equal(HttpStatusCode.OK,
            (await admin.PutAsJsonAsync("/admin/catalog", new { categories = empty, keywords = empty, stores = empty })).StatusCode);
    }
}
