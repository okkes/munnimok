using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Providers;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// What a party lists at connect time, and what an operator's account at a
/// party holds (#414). The routes are thin: <see cref="LookupService"/>
/// holds the plumbing.
/// </summary>
internal static class LookupEndpoints
{
    private static readonly string[] Reserved = ["q"];

    public static void Map(IEndpointRouteBuilder api, IEndpointRouteBuilder admin)
    {
        api.MapGet("/{provider}/options/{field}", async (
            HttpContext http,
            string provider,
            string field,
            LookupService lookups,
            CancellationToken ct) =>
        {
            // every query parameter but the text is context: the step's other values (a country, say)
            var context = http.Request.Query
                .Where(kv => !Reserved.Contains(kv.Key, StringComparer.Ordinal))
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToString(), StringComparer.Ordinal);
            var query = new LookupQuery { Text = http.Request.Query["q"].ToString(), Context = context };
            var options = await lookups.OptionsAsync(provider, field, query, ct);
            return ConnectorResults.Json(new LookupResponse { Options = options });
        })
        .Produces<LookupResponse>(StatusCodes.Status200OK);

        api.MapGet("/{provider}/options/{field}/{value}/logo", async (
            HttpContext http,
            string provider,
            string field,
            string value,
            LookupService lookups,
            CancellationToken ct) =>
        {
            var logo = await lookups.LogoAsync(provider, field, value, ct);
            if (logo is null) return Results.NotFound();
            http.Response.Headers.CacheControl = "public, max-age=2592000, immutable";
            return Results.Bytes(logo.Bytes, logo.ContentType);
        })
        .Produces<byte[]>(StatusCodes.Status200OK, "image/png")
        .Produces(StatusCodes.Status404NotFound);

        admin.MapGet("/providers/{id}/remote-consents", async (string id, LookupService lookups, CancellationToken ct) =>
            ConnectorResults.Json(new RemoteConsentsResponse { Consents = await lookups.RemoteConsentsAsync(id, ct) }))
        .Produces<RemoteConsentsResponse>(StatusCodes.Status200OK);

        admin.MapDelete("/providers/{id}/remote-consents/{consentId}", async (string id, string consentId, LookupService lookups, CancellationToken ct) =>
        {
            await lookups.RevokeRemoteAsync(id, consentId, ct);
            return Results.NoContent();
        })
        .Produces(StatusCodes.Status204NoContent);
    }
}

public sealed record LookupResponse
{
    public required IReadOnlyList<LookupOption> Options { get; init; }
}

public sealed record RemoteConsentsResponse
{
    public required IReadOnlyList<RemoteConsent> Consents { get; init; }
}
