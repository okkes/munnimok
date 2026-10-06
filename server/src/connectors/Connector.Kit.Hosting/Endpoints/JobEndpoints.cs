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

/// <summary>
/// Following a fetch that did not finish inside its window. Identical
/// contract to a login: poll, subscribe, answer - and, like a login, only
/// for the subject whose session the job belongs to.
/// </summary>
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
                    // Never the bundle over a stream: it can only be handed
                    // over once, and a stream cannot acknowledge receipt.
                    return row is null ? null : await views.JobAsync(row, deliverBundle: false, token);
                },
                view => JobStateMachine.IsTerminal(view.State),
                signals,
                ConnectorSignals.Job(job.Id),
                TimeSpan.FromMinutes(10),
                ct);

            return Results.Empty;
        })
        // The same view the poll returns, one per event - identical contract to
        // a login's stream, and named the same way.
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

        // What a failed run left behind is the person's to give (#441 L1):
        // yes retains the picture for the operator, no deletes it. Both go
        // through the same subject join as the view, so an id learned
        // elsewhere can neither share nor destroy somebody else's.
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

    /// <summary>
    /// The job, if it exists AND its session belongs to the caller. One
    /// answer for both misses, so a job id learned from somewhere else tells
    /// its holder nothing.
    /// </summary>
    private static async Task<JobRow> RequireAsync(
        ConnectorDbContext db, string providerId, string jobId, string subject, CancellationToken ct) =>
        await db.Jobs
            .Where(j => j.Id == jobId && j.ProviderId == providerId)
            .Join(db.Sessions.Where(s => s.Subject == subject), j => j.SessionId, s => s.Id, (j, _) => j)
            .FirstOrDefaultAsync(ct)
        ?? throw ConnectorException.Unsupported($"unknown job '{jobId}'");
}
