using Microsoft.EntityFrameworkCore;
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
        // what a failed run left behind is the person's to give (#441 L1): yes keeps the picture for the operator, no deletes it
        group.MapPost("/{provider}/jobs/{jobId}/artifacts/share", ShareArtifacts);
        group.MapDelete("/{provider}/jobs/{jobId}/artifacts", DeclineArtifacts);
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
        var outcome = await sync.CollectAsync(http.GetUserId(), relay.SubjectOf(http), provider, jobId, new ConnectorCollectCall(request, DeviceClass: DeviceClassOf(http)), ct);
        return Results.Json(outcome.Body, statusCode: outcome.Status);
    }

    /// <summary>
    /// The person says the operator may see the picture a failed run left
    /// behind: relayed under their subject (the control plane holds it to
    /// the session's owner), and the hub's open question — a scheduled
    /// run's — is closed on the binding.
    /// </summary>
    private static async Task<IResult> ShareArtifacts(string provider, string jobId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/jobs/{jobId}/artifacts/share", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        await CloseQuestionAsync(relay, http.GetUserId(), provider, jobId, ct);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>The person says no: the control plane deletes the picture, and the hub's question is closed the same way.</summary>
    private static async Task<IResult> DeclineArtifacts(string provider, string jobId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.DeleteAsync($"v1/{provider}/jobs/{jobId}/artifacts", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        await CloseQuestionAsync(relay, http.GetUserId(), provider, jobId, ct);
        return Results.NoContent();
    }

    private static async Task CloseQuestionAsync(ConnectorRelay relay, Guid userId, string provider, string jobId, CancellationToken ct)
    {
        var rows = await relay.Db.ConnectorSessions
            .Where(s => s.UserId == userId && s.Provider == provider && s.PendingArtifactsJobId == jobId)
            .ToListAsync(ct);
        if (rows.Count == 0) return;
        foreach (var row in rows) row.PendingArtifactsJobId = null;
        await relay.Db.SaveChangesAsync(ct);
    }
}
