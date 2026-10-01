using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Connectors;

/// <summary>The kill switch: <c>healthy</c>, <c>degraded</c>, <c>paused</c> or <c>retired</c>, with a copy key the app shows.</summary>
public sealed record ConnectorProviderStatusRequest(string State, string? ReasonKey = null);

/// <summary>A user's connector session as the operator's diagnosis lists it.</summary>
public sealed record AdminConnectorSessionDto(string SessionId, string Provider, string ConnectionId, string State, DateTimeOffset LastSeenAt);

/// <summary>
/// The operator's side of the relay (docs/connector-integration-plan.md §9,
/// D10: the admin panel IS munni's admin portal): the fleet's status, the
/// kill switch per party, every household agent, the canaries — all under
/// the same <c>admin</c> scope as the rest of <c>/admin</c>, relayed to the
/// control plane's own admin routes. The cockpit reads the same status
/// under <c>/control</c>, read-only, exactly as it reads consents.
/// </summary>
public static class ConnectorAdminEndpoints
{
    /// <summary>The control plane's own vocabulary (<c>ProviderState</c>): healthy is the working state, not "active".</summary>
    private static readonly string[] States = ["healthy", "degraded", "paused", "retired"];

    public static void MapConnectorAdmin(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/admin/connectors")
            .RequireAuthorization(AdminScope.Policy)
            .WithSafeRouteParams()
            .AddEndpointFilter<ConnectorReplyFilter>();

        admin.MapGet("/status", Status);
        admin.MapPost("/providers/{providerId}/status", SetProviderStatus).WithValidation<ConnectorProviderStatusRequest>();
        admin.MapGet("/agents", Fleet);
        admin.MapDelete("/agents/{agentId}", RevokeAny);
        admin.MapGet("/canaries", Canaries);
        admin.MapGet("/providers/{providerId}/remote-consents", RemoteConsents);
        admin.MapDelete("/providers/{providerId}/remote-consents/{consentId}", RevokeRemote);
        admin.MapGet("/users/{sub}/sessions", UserSessions);

        // the cockpit's read-only view of the designated environment (§15.6): the
        // parties with their quota, and an aggregator's inventory of consents —
        // never a revocation, which stays in the environment's own portal
        var control = app.MapGroup("/control/connectors")
            .RequireAuthorization(AdminScope.Policy)
            .WithSafeRouteParams()
            .AddEndpointFilter<ConnectorReplyFilter>();

        control.MapGet("/status", Status);
        control.MapGet("/providers/{providerId}/remote-consents", RemoteConsents);
    }

    /// <summary>Providers with their health, agents online, the queue — the control plane's own status line.</summary>
    private static async Task<IResult> Status(ConnectorClient client, ConnectorEventBridge bridge, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/status", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var status = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;
        status["relay"] = new JsonObject { ["openStreams"] = bridge.Open };
        return Results.Json(status);
    }

    /// <summary>
    /// The kill switch. Retiring a party expires every session of it at the
    /// control plane; pausing stops new work and the catalogue says so;
    /// healthy is the way back (degraded keeps work flowing with a warning). The
    /// operator and the reason go to the server log: munni's activity log
    /// is the members' own per space, and an operator's act belongs where
    /// the operator reads.
    /// </summary>
    private static async Task<IResult> SetProviderStatus(
        string providerId,
        ConnectorProviderStatusRequest request,
        HttpContext http,
        ConnectorClient client,
        ILogger<ConnectorClient> logger,
        CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/providers/{providerId}/status", new ConnectorCall
        {
            Body = new WireProviderStatus(request.State, request.ReasonKey),
        }, ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} set connector provider {Provider} to {State} ({Reason})",
                OperatorOf(http), providerId, request.State, request.ReasonKey ?? "-");
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static string OperatorOf(HttpContext http) => http.User.FindFirst("sub")?.Value ?? "-";

    private static async Task<IResult> Fleet(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/admin/agents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> RevokeAny(string agentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.DeleteAsync($"v1/admin/agents/{agentId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} revoked connector agent {Agent}", OperatorOf(http), agentId);
        }
        return Results.NoContent();
    }

    private static async Task<IResult> Canaries(ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync("v1/admin/canaries", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    /// <summary>One user's bindings — ids and state, the same rows the diagnosis carries.</summary>
    /// <summary>What the operator's account at the party holds (§15): every consent, foreign and legacy ones included, with the environment that made it.</summary>
    private static async Task<IResult> RemoteConsents(string providerId, ConnectorClient client, CancellationToken ct)
    {
        var reply = await client.GetAsync($"v1/admin/providers/{providerId}/remote-consents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> RevokeRemote(
        string providerId, string consentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.DeleteAsync($"v1/admin/providers/{providerId}/remote-consents/{consentId}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} revoked consent {Consent} at connector provider {Provider}", OperatorOf(http), consentId, providerId);
        }
        return Results.NoContent();
    }

    private static async Task<IResult> UserSessions(string sub, AppDbContext db)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (user is null) return Results.NotFound();
        return Results.Ok(await SessionsOfAsync(db, user.Id));
    }

    internal static Task<List<AdminConnectorSessionDto>> SessionsOfAsync(AppDbContext db, Guid userId) =>
        db.ConnectorSessions
            .Where(s => s.UserId == userId)
            .OrderBy(s => s.CreatedAt)
            .Select(s => new AdminConnectorSessionDto(s.Id, s.Provider, s.ConnectionId, s.State, s.LastSeenAt))
            .ToListAsync();

    internal static bool IsState(string? state) => state is not null && States.Contains(state);
}

internal sealed record WireProviderStatus(string State, string? ReasonKey);
