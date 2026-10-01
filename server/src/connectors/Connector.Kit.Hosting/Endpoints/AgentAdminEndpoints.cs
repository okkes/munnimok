using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// Bring-your-own agents, from the consumer's side: a user's own machines,
/// named by the subject header like every other thing a user owns here.
/// Listing, enrolling and revoking are theirs; what they cannot see is
/// anybody else's agent, or the pooled fleet, which is the operator's and
/// sits under <c>/admin</c>.
///
/// Health is visible on purpose: "your ASN sync is stale because your VM has
/// been off for three days" is a real message, and it is the difference
/// between a feature a user trusts and one that quietly stops working.
/// </summary>
internal static class AgentAdminEndpoints
{
    public static void Map(IEndpointRouteBuilder api, IEndpointRouteBuilder admin)
    {
        api.MapGet("/agents", async (
            HttpContext http,
            ConnectorDbContext db,
            IProviderRegistry registry,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var subject = RequestContext.RequireSubject(http);

            var agents = await db.Agents.AsNoTracking()
                .Where(a => a.OwnerSubject == subject)
                .OrderBy(a => a.CreatedAt)
                .ToListAsync(ct);

            return ConnectorResults.Json(await ListAsync(db, agents, registry, time, ct));
        });

        api.MapPost("/agents/enrollment", async (
            HttpContext http,
            AgentEnrollmentRequest request,
            AgentAuth auth,
            CancellationToken ct) =>
        {
            RequestContext.RequireSubjectAgreement(http, request.Subject);

            var minted = await auth.MintEnrollmentAsync(request.Subject, request.Name, ct);
            return ConnectorResults.Json(new AgentEnrollmentResponse
            {
                Code = minted.Code,
                ExpiresAt = minted.ExpiresAt,
            });
        });

        api.MapDelete("/agents/{agentId}", async (
            HttpContext http,
            string agentId,
            ConnectorDbContext db,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var subject = RequestContext.RequireSubject(http);

            var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == agentId && a.OwnerSubject == subject, ct)
                        ?? throw ConnectorException.Unsupported($"unknown agent '{agentId}'");

            // A hosted slot is munni's container (#420 A2): the person gives
            // it back and it goes to the next one clean, rather than dying.
            if (agent.Hosted)
            {
                await PrivateAgentEndpoints.ReleaseAsync(db, agent, time.GetUtcNow(), ct);
                return Results.NoContent();
            }

            await RevokeAsync(db, agent, ct);
            return Results.NoContent();
        })
        .Produces(StatusCodes.Status204NoContent);

        api.MapGet("/agents/{agentId}/profiles", async (
            HttpContext http,
            string agentId,
            ConnectorDbContext db,
            CancellationToken ct) =>
        {
            var subject = RequestContext.RequireSubject(http);

            _ = await db.Agents.AsNoTracking().FirstOrDefaultAsync(a => a.Id == agentId && a.OwnerSubject == subject, ct)
                ?? throw ConnectorException.Unsupported($"unknown agent '{agentId}'");

            var profiles = await db.Profiles.AsNoTracking().Where(p => p.AgentId == agentId).ToListAsync(ct);
            return ConnectorResults.Json(profiles.Select(Profile).ToList());
        });

        // The operator: every agent this control plane knows, whoever owns it.
        admin.MapGet("/agents", async (
            ConnectorDbContext db,
            IProviderRegistry registry,
            TimeProvider time,
            CancellationToken ct) =>
        {
            var agents = await db.Agents.AsNoTracking().OrderBy(a => a.CreatedAt).ToListAsync(ct);
            return ConnectorResults.Json(await ListAsync(db, agents, registry, time, ct));
        });

        admin.MapDelete("/agents/{agentId}", async (
            string agentId,
            ConnectorDbContext db,
            CancellationToken ct) =>
        {
            var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == agentId, ct)
                        ?? throw ConnectorException.Unsupported($"unknown agent '{agentId}'");

            await RevokeAsync(db, agent, ct);
            return Results.NoContent();
        })
        .Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<AgentListResponse> ListAsync(
        ConnectorDbContext db,
        IReadOnlyList<AgentRow> agents,
        IProviderRegistry registry,
        TimeProvider time,
        CancellationToken ct)
    {
        var ids = agents.Select(a => a.Id).ToList();
        var profiles = await db.Profiles.AsNoTracking()
            .Where(p => ids.Contains(p.AgentId))
            .ToListAsync(ct);

        // Online by the platform's one rule, not a copy of it: a login that
        // names an agent is refused by the same window, and this list is
        // what a consumer offers to pick from.
        var now = time.GetUtcNow();

        return new AgentListResponse
        {
            Agents = [.. agents.Select(a => View(a, profiles, registry, now))],
        };
    }

    private static async Task RevokeAsync(ConnectorDbContext db, AgentRow agent, CancellationToken ct)
    {
        agent.Revoked = true;
        // The token is dead the moment it cannot match anything, and an
        // agent that learns it is revoked stops and wipes its profiles.
        agent.TokenHash = "revoked:" + agent.Id;

        // Orphan rather than delete: a profile row is how a user is told
        // which connections just stopped working, and deleting it deletes
        // the explanation.
        await db.Profiles.Where(p => p.AgentId == agent.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(p => p.Healthy, false), ct);

        await db.SaveChangesAsync(ct);
    }

    internal static AgentView View(
        AgentRow agent, IReadOnlyList<ProfileRow> profiles, IProviderRegistry registry, DateTimeOffset now) => new()
    {
        Id = agent.Id,
        Name = agent.Name,
        Class = agent.Class,
        Revoked = agent.Revoked,
        LastHeartbeatAt = agent.LastHeartbeatAt,
        Online = AgentLiveness.IsOnline(agent, now),
        Stale = AgentCatalogue.IsStale(ConnectorJson.DeserializeOr(agent.CapabilitiesJson, new AgentCapabilities()), registry),
        Profiles = [.. profiles.Where(p => p.AgentId == agent.Id).Select(Profile)],
        Hosted = agent.Hosted,
        Bound = PrivateAgentEndpoints.IsBound(agent),
        BoundAt = agent.BoundAt,
        Resetting = agent.ResetRequestedAt is not null,
    };

    internal static ProfileView Profile(ProfileRow profile) => new()
    {
        Id = profile.Id,
        Provider = profile.ProviderId,
        Healthy = profile.Healthy,
        LastOkAt = profile.LastOkAt,
    };
}
