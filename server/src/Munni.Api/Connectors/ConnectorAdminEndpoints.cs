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
        // hosted private agents (#420 A2): the slots and the requests, the decisions, taking a slot back
        admin.MapGet("/private-agents", PrivateAgents);
        admin.MapPost("/private-agents/requests/{requestId}/approve", ApprovePrivateAgent);
        admin.MapPost("/private-agents/requests/{requestId}/deny", DenyPrivateAgent);
        admin.MapPost("/private-agents/{agentId}/release", ReleasePrivateAgent);
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

    /// <summary>
    /// The hosted private slots and the requests for them (#420 A2), with WHO
    /// each pseudonymous subject is. The control plane knows subjects and
    /// nothing else; an operator deciding a request needs a name. The relay
    /// mints every user's subject the way it mints the caller's, so the map
    /// is computed here per call and stored nowhere.
    /// </summary>
    private static async Task<IResult> PrivateAgents(ConnectorRelay relay, CancellationToken ct)
    {
        var reply = await relay.Client.GetAsync("v1/admin/private-agents", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        var view = (JsonObject)ConnectorJson.ToCamel(reply.Object)!;

        var users = await relay.Db.Users.Select(u => new { u.Id, u.Email, u.DisplayName }).ToListAsync(ct);
        var who = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var user in users) who[relay.Minter.For(user.Id)] = user.DisplayName ?? user.Email ?? user.Id.ToString();

        foreach (var node in (view["requests"] as JsonArray ?? []).Concat(view["slots"] as JsonArray ?? []))
        {
            if (node is not JsonObject row) continue;
            row["who"] = row["subject"]?.GetValue<string>() is { } subject && who.TryGetValue(subject, out var name) ? name : null;
        }

        return Results.Json(view);
    }

    private static Task<IResult> ApprovePrivateAgent(string requestId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct) =>
        DecidePrivateAgent(requestId, "approve", http, client, logger, ct);

    private static Task<IResult> DenyPrivateAgent(string requestId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct) =>
        DecidePrivateAgent(requestId, "deny", http, client, logger, ct);

    private static async Task<IResult> DecidePrivateAgent(
        string requestId, string decision, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/private-agents/requests/{requestId}/{decision}", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} decided private-agent request {Request}: {Decision}", OperatorOf(http), requestId, decision);
        }
        return Results.Json(ConnectorJson.ToCamel(reply.Object));
    }

    private static async Task<IResult> ReleasePrivateAgent(string agentId, HttpContext http, ConnectorClient client, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var reply = await client.PostAsync($"v1/admin/private-agents/{agentId}/release", new ConnectorCall(), ct);
        if (!reply.IsSuccess) throw new ConnectorReplyException(reply);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("operator {Operator} took hosted agent {Agent} back", OperatorOf(http), agentId);
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
