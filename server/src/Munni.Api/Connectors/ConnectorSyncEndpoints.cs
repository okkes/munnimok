using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

// a run the provider cannot finish inside the window is a job the app follows and collects with the bundle
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

    // relayed under their subject (the control plane holds it to the session's owner).
    // closes the hub's open question on the binding
    private static async Task<IResult> ShareArtifacts(string provider, string jobId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.PostAsync($"v1/{provider}/jobs/{jobId}/artifacts/share", new ConnectorCall { Subject = relay.SubjectOf(http) }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        await CloseQuestionAsync(relay, http.GetUserId(), provider, jobId, ct);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

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
