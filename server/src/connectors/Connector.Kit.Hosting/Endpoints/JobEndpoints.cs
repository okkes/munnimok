#pragma warning disable S107 // minimal-API handlers and DI constructors take their collaborators as parameters
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Endpoints;

/// follows a fetch that outlived its window: the same contract as a login, only for the session's subject
internal static class JobEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/{provider}/jobs/{jobId}", async (
            HttpContext http,
            string provider,
            string jobId,
            IProviderRegistry registry,
            ConnectorDbContext db,
            ViewBuilder views,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            RequestContext.StampManifestVersion(http, manifest.ManifestVersion);

            var job = await RequireAsync(db, manifest.Id, jobId, RequestContext.RequireSubject(http), ct);
            return ConnectorResults.Json(await views.JobAsync(job, deliverBundle: true, ct));
        });

        api.MapGet("/{provider}/jobs/{jobId}/events", async (
            HttpContext http,
            string provider,
            string jobId,
            IProviderRegistry registry,
            ConnectorDbContext db,
            ViewBuilder views,
            ConnectorSignals signals,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            var job = await RequireAsync(db, manifest.Id, jobId, RequestContext.RequireSubject(http), ct);

            await EventStream.WriteAsync(
                http,
                async token =>
                {
                    db.ChangeTracker.Clear();
                    var row = await db.Jobs.FirstOrDefaultAsync(j => j.Id == job.Id, token);
                    // never the bundle over a stream: it is handed over once and a stream cannot acknowledge receipt
                    return row is null ? null : await views.JobAsync(row, deliverBundle: false, token);
                },
                view => JobStateMachine.IsTerminal(view.State),
                signals,
                ConnectorSignals.Job(job.Id),
                TimeSpan.FromMinutes(10),
                ct);

            return Results.Empty;
        })
        .Produces<JobResponse>(StatusCodes.Status200OK, "text/event-stream");

        api.MapPost("/{provider}/jobs/{jobId}/answer", async (
            HttpContext http,
            string provider,
            string jobId,
            AnswerRequest request,
            IProviderRegistry registry,
            ConnectorDbContext db,
            ChallengeService challenges,
            ViewBuilder views,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            var job = await RequireAsync(db, manifest.Id, jobId, RequestContext.RequireSubject(http), ct);

            await challenges.AnswerAsync(request.ChallengeId, job.Id, request.Value, ct);
            return ConnectorResults.Json(await views.JobAsync(job, deliverBundle: false, ct));
        });

        // a failed run's picture is the person's to give (#441 L1): yes retains it for the operator, no deletes it
        // both join through the subject, so an id learned elsewhere can neither share nor destroy another's
        api.MapPost("/{provider}/jobs/{jobId}/artifacts/share", async (
            HttpContext http,
            string provider,
            string jobId,
            IProviderRegistry registry,
            ConnectorDbContext db,
            JobArtifactService artifacts,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            var job = await RequireAsync(db, manifest.Id, jobId, RequestContext.RequireSubject(http), ct);

            var kept = await artifacts.ShareAsync(job.Id, ct)
                       ?? throw ConnectorException.Unsupported($"job '{jobId}' left nothing to report");

            return ConnectorResults.Json(new ArtifactShareResponse { JobId = job.Id, ExpiresAt = kept.ExpiresAt });
        });

        api.MapDelete("/{provider}/jobs/{jobId}/artifacts", async (
            HttpContext http,
            string provider,
            string jobId,
            IProviderRegistry registry,
            ConnectorDbContext db,
            JobArtifactService artifacts,
            CancellationToken ct) =>
        {
            var manifest = registry.RequireManifest(provider);
            var job = await RequireAsync(db, manifest.Id, jobId, RequestContext.RequireSubject(http), ct);

            await artifacts.DeclineAsync(job.Id, ct);
            return Results.NoContent();
        });
    }

    /// one answer for both misses, so a job id learned elsewhere tells its holder nothing
    private static async Task<JobRow> RequireAsync(
        ConnectorDbContext db, string providerId, string jobId, string subject, CancellationToken ct) =>
        await db.Jobs
            .Where(j => j.Id == jobId && j.ProviderId == providerId)
            .Join(db.Sessions.Where(s => s.Subject == subject), j => j.SessionId, s => s.Id, (j, _) => j)
            .FirstOrDefaultAsync(ct)
        ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");
}
