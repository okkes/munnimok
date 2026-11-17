using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Providers;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Endpoints;

/// the catalogue is the only contract a consumer codes against
/// its digest is the ETag so consumers revalidate instead of refetching
internal static class CatalogEndpoints
{
    public static void Map(
        IEndpointRouteBuilder api,
        IEndpointRouteBuilder admin,
        IEndpointRouteBuilder root,
        ConnectorPlatformOptions platform)
    {
        api.MapGet("/providers", async (
            HttpContext http,
            IProviderRegistry registry,
            ProviderStatusService statuses,
            CancellationToken ct) =>
        {
            // health is read before the ETag: it is part of the document, and hashing manifests alone
            // made a recovered provider answer 304 forever
            var health = await statuses.AllAsync(ct);

            var etag = $"\"{registry.CatalogDigest}:{HealthDigest(health.Values)}\"";
            if (NotModified(http, etag)) return Results.StatusCode(StatusCodes.Status304NotModified);

            http.Response.Headers.ETag = etag;

            // an operator-only provider (#441 L3) is left out: the catalogue is what a person may connect to
            var providers = registry.Manifests
                .Where(m => !m.OperatorOnly)
                .Select(m => Describe(m, health.GetValueOrDefault(m.Id)))
                .ToList();

            return ConnectorResults.Json(new CatalogResponse
            {
                Providers = providers,
                Service = Descriptor(platform, registry),
            });
        })
        // declared here: the handler also answers 304, so its inferred type is the bare IResult
        .Produces<CatalogResponse>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status304NotModified);

        api.MapGet("/providers/{id}", async (
            HttpContext http,
            string id,
            IProviderRegistry registry,
            ProviderStatusService statuses,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(id);
            RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

            // this document carries the provider's health too, so the ETag moves with it
            var status = await statuses.GetAsync(manifest.Id, ct);

            var etag = $"\"{registry.CatalogDigest}:{manifest.Id}:{HealthDigest([status])}\"";
            if (NotModified(http, etag)) return Results.StatusCode(StatusCodes.Status304NotModified);

            http.Response.Headers.ETag = etag;
            return ConnectorResults.Json(Describe(manifest, status));
        })
        // a free-form object, serialised through a node so the document's shape stays the spec's
        .Produces<JsonObject>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status304NotModified);

        // liveness needs no auth: a probe that needs a credential fails for the wrong reason
        root.MapGet("/v1/health", () => ConnectorResults.Json(new HealthResponse
        {
            Status = "ok",
            Version = platform.ServiceVersion,
        }));

        api.MapGet("/status", async (
            IProviderRegistry registry,
            ProviderStatusService statuses,
            ProviderQuotaService quotas,
            ConnectorDbContext db,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var health = await statuses.AllAsync(ct);
            var now = time.GetUtcNow();

            var agents = await db.Agents.AsNoTracking().ToListAsync(ct);
            var queued = await db.Jobs.CountAsync(j => j.State == JobState.Queued, ct);
            var running = await db.Jobs.CountAsync(j => j.State == JobState.Leased || j.State == JobState.Running, ct);
            var awaiting = await db.Jobs.CountAsync(j => j.State == JobState.AwaitingInput, ct);

            return ConnectorResults.Json(new StatusResponse
            {
                Service = Descriptor(platform, registry),
                Providers = [.. health.Values
                    .OrderBy(p => p.ProviderId, StringComparer.Ordinal)
                    .Select(p => p with
                    {
                        Quota = quotas.Get(p.ProviderId),
                        // asked of any other party the inventory is a 400 — the consoles offer it only where it exists (#561)
                        Inventory = registry.TryGetAdapter(p.ProviderId, out var adapter) && adapter is IRemoteInventory,
                    })],
                Agents = new AgentPoolView
                {
                    Total = agents.Count,
                    Online = agents.Count(a => AgentLiveness.IsOnline(a, now)),
                    Revoked = agents.Count(a => a.Revoked),
                },
                Queue = new QueueView { Queued = queued, Running = running, AwaitingInput = awaiting },
            });
        });

        // the kill switch: pausing stops new work for every user of the provider within one lease poll
        admin.MapPost("/providers/{id}/status", async (
            string id,
            ProviderStatusUpdate update,
            ProviderStatusService statuses,
            SessionService sessions,
            ConnectorDbContext db,
            CancellationToken ct) =>
        {
            var status = await statuses.SetAsync(id, update.State, update.ReasonKey, ct);

            if (update.State == ProviderState.Retired)
            {
                // Retired is for good: existing sessions are invalid, so expire them now rather than failing each later
                var live = await db.Sessions
                    .Where(s => s.ProviderId == id && s.State != SessionState.Disabled && s.State != SessionState.Expired)
                    .ToListAsync(ct);

                foreach (var session in live)
                {
                    await sessions.TransitionOrTerminateAsync(session, SessionState.Expired, ct);
                }
            }

            return ConnectorResults.Json(status);
        });

        MapCanaries(admin);
    }

    /// admin-only, under /admin: these routes write the single credential the platform keeps at rest (CanaryRow)
    private static void MapCanaries(IEndpointRouteBuilder admin)
    {
        admin.MapGet("/canaries", async (CanaryService canaries, CancellationToken ct) =>
        {
            var rows = await canaries.AllAsync(ct);

            return ConnectorResults.Json(new CanaryListResponse
            {
                Canaries =
                [
                    .. rows.Select(row => new CanaryView
                    {
                        ProviderId = row.ProviderId,
                        Resource = row.ResourceId,
                        IntervalMinutes = row.IntervalMinutes,
                        LastRunAt = row.LastRunAt,
                        LastJobId = row.LastJobId,
                        Intact = row.LastIntact,
                        Verdict = row.LastVerdict,
                    }),
                ],
            });
        });

        admin.MapPut("/providers/{id}/canary", async (
            string id,
            CanaryEnrolmentRequest request,
            CanaryService canaries,
            CancellationToken ct) =>
        {
            ArgumentNullException.ThrowIfNull(request);

            var row = await canaries.EnrolAsync(
                id, request.Subject, request.Bundle, request.Resource, request.IntervalMinutes, ct);

            // the bundle is never echoed: a live credential in the response would reach every proxy log
            return ConnectorResults.Json(new CanaryView
            {
                ProviderId = row.ProviderId,
                Resource = row.ResourceId,
                IntervalMinutes = row.IntervalMinutes,
                LastRunAt = null,
                LastJobId = null,
                Intact = null,
                Verdict = null,
            });
        });

        admin.MapDelete("/providers/{id}/canary", async (
            string id,
            CanaryService canaries,
            CancellationToken ct) =>
            await canaries.RemoveAsync(id, ct) ? Results.NoContent() : Results.NotFound());
    }

    /// the manifest as the kit defines it with health grafted on; a node, not a wrapper type, keeps the shape the spec's
    private static JsonObject Describe(ProviderManifest manifest, ProviderStatus? status)
    {
        var node = JsonSerializer.SerializeToNode(manifest, ConnectorJson.Options)!.AsObject();
        if (status is not null)
        {
            node["status"] = JsonSerializer.SerializeToNode(status, ConnectorJson.Options);
        }

        return node;
    }

    private static ServiceDescriptor Descriptor(ConnectorPlatformOptions platform, IProviderRegistry registry) => new()
    {
        Kinds = registry.Manifests.Where(m => !m.OperatorOnly).Select(m => m.Kind).Distinct().OrderBy(k => k.ToString(), StringComparer.Ordinal).ToList(),
        Version = platform.ServiceVersion,
        ManifestDigest = registry.CatalogDigest,
    };

    /// state and reason only, not Since: a never-incident provider reads healthy "as of now", so a timestamp
    /// would change every request and the ETag never match. Separator: a numeric escape, no invisible control characters
    private const char Separator = (char)0x1F;

    private static string HealthDigest(IEnumerable<ProviderStatus> statuses)
    {
        // ordered, so load-balanced servers with the same health agree on the tag
        var parts = statuses
            .OrderBy(s => s.ProviderId, StringComparer.Ordinal)
            .Select(s => $"{s.ProviderId}={s.State}:{s.ReasonKey ?? "-"}");

        var bytes = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(string.Join(Separator, parts)));

        return Convert.ToHexStringLower(bytes)[..16];
    }

    private static bool NotModified(HttpContext http, string etag)
    {
        var presented = http.Request.Headers.IfNoneMatch;
        foreach (var candidate in presented)
        {
            if (candidate is null) continue;
            if (candidate == "*" || candidate.Split(',').Any(c => c.Trim() == etag)) return true;
        }

        return false;
    }
}
