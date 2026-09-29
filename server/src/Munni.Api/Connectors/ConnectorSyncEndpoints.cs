using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

/// <summary>
/// The sync half of the relay: one call with the bundle, the data lands
/// through the feeds, the rotated bundle comes back. A run the provider
/// could not finish inside the window is a job the app follows through
/// <c>/sync/events</c> or by polling, answers when it asks, and collects
/// with the bundle once it has succeeded.
/// </summary>
public static partial class ConnectorRelayEndpoints
{
    private static void MapSync(RouteGroupBuilder group)
    {
        group.MapPost("/{provider}/sync", Sync).WithValidation<ConnectorSyncRequest>();
        group.MapGet("/{provider}/jobs/{jobId}", Job);
        group.MapPost("/{provider}/jobs/{jobId}/answer", AnswerJob).WithValidation<ConnectorAnswerRequest>();
        group.MapPost("/{provider}/jobs/{jobId}/collect", CollectJob).WithValidation<ConnectorCollectRequest>();
    }

    private static async Task<IResult> Sync(
        string provider, ConnectorSyncRequest request, HttpContext http, ConnectorRelay relay, ConnectorSyncService sync, CancellationToken ct)
    {
        var userId = http.GetUserId();
        if (!relay.Budget.TrySpend(userId, ConnectorBudget.Sync, out var retryAfter)) return BudgetExceeded(http, retryAfter);

        var outcome = await sync.SyncAsync(userId, relay.SubjectOf(http), provider, request, DeviceClassOf(http), ct);
        return Results.Json(outcome.Body, statusCode: outcome.Status);
    }

    private static async Task<IResult> Job(string provider, string jobId, HttpContext http, ConnectorRelay relay, ConnectorSyncService sync, CancellationToken ct)
    {
        var outcome = await sync.JobAsync(http.GetUserId(), relay.SubjectOf(http), provider, jobId, ct);
        return Results.Json(outcome.Body, statusCode: outcome.Status);
    }

    private static async Task<IResult> AnswerJob(
        string provider, string jobId, ConnectorAnswerRequest request, HttpContext http, ConnectorRelay relay, ConnectorSyncService sync, CancellationToken ct)
    {
        var outcome = await sync.AnswerJobAsync(http.GetUserId(), relay.SubjectOf(http), provider, jobId, request, ct);
        return Results.Json(outcome.Body, statusCode: outcome.Status);
    }

    private static async Task<IResult> CollectJob(
        string provider, string jobId, ConnectorCollectRequest request, HttpContext http, ConnectorRelay relay, ConnectorSyncService sync, CancellationToken ct)
    {
        var outcome = await sync.CollectAsync(http.GetUserId(), relay.SubjectOf(http), provider, jobId, request, ct);
        return Results.Json(outcome.Body, statusCode: outcome.Status);
    }
}
