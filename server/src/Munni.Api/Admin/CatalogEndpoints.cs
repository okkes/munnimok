using Microsoft.EntityFrameworkCore;
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

    private static async Task<IResult> ReadCatalog(HttpContext http, AppDbContext db)
    {
        var setting = await db.AppSettings.FindAsync(SettingKey);
        if (setting is null) return Results.NoContent(); // clients keep the bundled baseline
        var etag = $"\"catalog-v{VersionOf(setting.Value)}\"";
        if (http.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(304);
        http.Response.Headers.ETag = etag;
        return Results.Content(setting.Value, "application/json");
    }

    private static async Task<IResult> PublishCatalog(CatalogPublishDto body, AppDbContext db)
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
        return Results.Ok(new { version = version + 1 });
    }
}
