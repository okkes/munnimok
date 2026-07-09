using System.Text.Json;
using System.Text.Json.Serialization;

namespace Munni.Api.Logos;

public sealed record LogoResult(string Name, string Domain, string LogoUrl);

/// <summary>
/// Brand-logo search for recurring costs, proxied through the API so the
/// logo.dev secret key never reaches a client. Images are served straight
/// from img.logo.dev with the publishable token baked into the returned
/// URLs. Only mapped when both keys are configured; the vendored
/// simpleicons set remains the offline fallback either way.
/// </summary>
public static class LogoEndpoints
{
    public const string HttpClientName = "logodev";

    private sealed record SearchHit(
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("domain")] string? Domain);

    public static void MapLogos(this IEndpointRouteBuilder app, IConfiguration config)
    {
        var publicToken = config["Logos:PublicToken"];
        if (string.IsNullOrEmpty(config["Logos:SecretKey"]) || string.IsNullOrEmpty(publicToken)) return;

        app.MapGet("/logos/search", async (string q, IHttpClientFactory http, CancellationToken ct) =>
        {
            var query = q.Trim();
            if (query.Length < 2 || query.Length > 50) return Results.BadRequest();

            using var client = http.CreateClient(HttpClientName);
            using var response = await client.GetAsync($"search?q={Uri.EscapeDataString(query)}", ct);
            if (!response.IsSuccessStatusCode) return Results.Ok(Array.Empty<LogoResult>());

            var hits = await JsonSerializer.DeserializeAsync<List<SearchHit>>(
                await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct) ?? [];
            var results = hits
                .Where(h => !string.IsNullOrEmpty(h.Domain))
                .Take(12)
                .Select(h => new LogoResult(
                    h.Name ?? h.Domain!,
                    h.Domain!,
                    $"https://img.logo.dev/{h.Domain}?token={publicToken}&size=64&format=png&retina=true"))
                .ToList();
            return Results.Ok(results);
        }).RequireAuthorization();
    }
}
