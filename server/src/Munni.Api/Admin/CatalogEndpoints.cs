using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Munni.Api.Auth;
using Munni.Api.Data;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Munni.Api.Admin;

/// <summary>
/// The versioned catalog document (admin-catalog design AC1): builtin
/// categories + prediction keywords + store merchant patterns as
/// operator-editable content. One JSON document in AppSettings, version
/// bumped on every publish; clients fetch opportunistically at sync time
/// and fall back to the bundled copy when they have never fetched one.
/// </summary>
public static class CatalogEndpoints
{
    private const string SettingKey = "catalog";

    /// <summary>one publish = the whole document: all three sections, each an array</summary>
    public sealed record CatalogPublishDto(
        [property: JsonPropertyName("categories")] JsonElement Categories,
        [property: JsonPropertyName("keywords")] JsonElement Keywords,
        [property: JsonPropertyName("stores")] JsonElement Stores);

    public static void MapCatalog(this IEndpointRouteBuilder app)
    {
        // public + cacheable: the catalog is content, not user data
        app.MapGet("/catalog", ReadCatalog).AllowAnonymous();
        // publish (admin console): the server owns the version counter
        app.MapPut("/admin/catalog", PublishCatalog).RequireAuthorization(AdminScope.Policy);
    }

    private static int VersionOf(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("version", out var v) ? v.GetInt32() : 0;
    }

    /// <summary>What a read answers with: the document and its ETag, or neither before the first publish.</summary>
    private sealed record Served(string? Json, string? ETag);

    private const string ServedKey = "catalog:served";

    private static async Task<IResult> ReadCatalog(HttpContext http, AppDbContext db, IMemoryCache cache)
    {
        // every app start asks and the answer changes only on a publish: the row is read and parsed once, not per question
        var served = await cache.GetOrCreateAsync(ServedKey, async entry =>
        {
            // a row that changed behind the api's back (a restore) is picked up without a restart
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            var json = await db.AppSettings.AsNoTracking().Where(s => s.Key == SettingKey).Select(s => s.Value).FirstOrDefaultAsync();
            return json is null ? new Served(null, null) : new Served(json, $"\"catalog-v{VersionOf(json)}\"");
        });
        if (served?.Json is null) return Results.NoContent(); // clients keep the bundled baseline
        if (http.Request.Headers.IfNoneMatch.ToString() == served.ETag) return Results.StatusCode(304);
        http.Response.Headers.ETag = served.ETag;
        return Results.Content(served.Json, "application/json");
    }

    private static async Task<IResult> PublishCatalog(CatalogPublishDto body, AppDbContext db, IMemoryCache cache)
    {
        if (body.Categories.ValueKind != JsonValueKind.Array
            || body.Keywords.ValueKind != JsonValueKind.Array
            || body.Stores.ValueKind != JsonValueKind.Array)
            return Results.BadRequest(new { error = "categories, keywords and stores must be arrays" });

        var setting = await db.AppSettings.FindAsync(SettingKey);
        var version = setting is null ? 0 : VersionOf(setting.Value);
        var next = JsonSerializer.Serialize(new
        {
            version = version + 1,
            categories = body.Categories,
            keywords = body.Keywords,
            stores = body.Stores,
        });
        if (setting is null) db.AppSettings.Add(new AppSetting { Key = SettingKey, Value = next });
        else setting.Value = next;
        await db.SaveChangesAsync();
        cache.Remove(ServedKey);
        return Results.Ok(new { version = version + 1 });
    }
}
