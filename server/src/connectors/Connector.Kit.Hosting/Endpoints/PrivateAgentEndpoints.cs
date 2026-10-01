using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Connector.Kit.Hosting.Endpoints;

/// <summary>
/// Hosted private agents (#420, slice A2): munni's own browser containers
/// that serve ONE person at a time.
///
/// A slot enrolls with the platform's private-slot code under the subject
/// <see cref="ConnectorOptions.PrivateSlotSubject"/>, which is nobody and is
/// not the fleet: free, it is leased nothing and counts for nobody's
/// "machine of my own". A person asks for one; the operator approves, which
/// binds the oldest free slot to that person - their subject becomes its
/// owner, and every rule that looks for a machine of theirs (the own-machine
/// profile, the egress check, the agent list) finds it exactly as it would
/// find a container in their house. Giving it back, or the operator taking
/// it back, returns it to the slot subject and asks the agent to wipe every
/// browser profile; the slot is free to the next person only once the agent
/// has said on a heartbeat that it did.
///
/// The operator decides, not the platform: a slot is a browser with
/// somebody's bank signed into it, on munni's hardware, and handing those out
/// is a judgement call the platform should not make on its own (user ruling
/// 2026-10-01: "user can request and admin approves").
/// </summary>
internal static class PrivateAgentEndpoints
{
    public static void Map(IEndpointRouteBuilder api, IEndpointRouteBuilder admin)
    {
        api.MapGet("/private-agents/mine", MineAsync);
        api.MapPost("/private-agents/requests", RequestAsync);
        api.MapDelete("/private-agents/requests/{requestId}", WithdrawAsync)
            .Produces(StatusCodes.Status204NoContent);
        api.MapDelete("/private-agents/mine", GiveBackAsync)
            .Produces(StatusCodes.Status204NoContent);

        admin.MapGet("/private-agents", OverviewAsync);
        admin.MapPost("/private-agents/requests/{requestId}/approve", ApproveAsync);
        admin.MapPost("/private-agents/requests/{requestId}/deny", DenyAsync);
        admin.MapPost("/private-agents/{agentId}/release", TakeBackAsync)
            .Produces(StatusCodes.Status204NoContent);
    }

    /// <summary>A hosted slot somebody holds: its owner is a person, not the slot subject.</summary>
    internal static bool IsBound(AgentRow agent) =>
        agent.Hosted && !string.Equals(agent.OwnerSubject, ConnectorOptions.PrivateSlotSubject, StringComparison.Ordinal);

    /// <summary>What an approval can hand out: enrolled as a slot, alive, unbound, and clean.</summary>
    private static bool IsFree(AgentRow agent, DateTimeOffset now) =>
        agent.Hosted && !IsBound(agent) && agent.ResetRequestedAt is null && AgentLiveness.IsOnline(agent, now);

    private static async Task<ConnectorJsonResult<PrivateAgentStatusResponse>> MineAsync(
        HttpContext http,
        ConnectorDbContext db,
        IProviderRegistry registry,
        TimeProvider time,
        CancellationToken ct)
    {
        var subject = RequestContext.RequireSubject(http);
        var now = time.GetUtcNow();

        var hosted = await db.Agents.AsNoTracking().Where(a => a.Hosted && !a.Revoked).ToListAsync(ct);
        var mine = hosted.Find(a => a.OwnerSubject == subject);
        var profiles = mine is null
            ? []
            : await db.Profiles.AsNoTracking().Where(p => p.AgentId == mine.Id).ToListAsync(ct);
        var request = await db.PrivateAgentRequests.AsNoTracking()
            .Where(r => r.Subject == subject)
            .OrderByDescending(r => r.CreatedAt)
            .FirstOrDefaultAsync(ct);

        return ConnectorResults.Json(new PrivateAgentStatusResponse
        {
            // Offered is "a slot exists", bound or not, online or not: an
            // environment with no private slots shows no door at all, and one
            // whose slots are all taken shows the door with nothing free.
            Offered = hosted.Count > 0,
            Free = hosted.Count(a => IsFree(a, now)),
            Request = request is null ? null : View(request),
            Agent = mine is null ? null : AgentAdminEndpoints.View(mine, profiles, registry, now),
        });
    }

    private static async Task<ConnectorJsonResult<PrivateAgentRequestView>> RequestAsync(
        HttpContext http,
        PrivateAgentRequestBody body,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        RequestContext.RequireSubjectAgreement(http, body.Subject);
        var subject = body.Subject;

        if (!await db.Agents.AnyAsync(a => a.Hosted && !a.Revoked, ct))
        {
            throw ConnectorException.InvalidRequest("this connector hosts no private agents");
        }

        if (await db.Agents.AnyAsync(a => a.Hosted && !a.Revoked && a.OwnerSubject == subject, ct))
        {
            throw ConnectorException.InvalidRequest("a hosted agent is already bound to this subject");
        }

        // Asking twice is one request: the person reloading the screen must
        // not queue a second decision for the operator.
        var pending = await db.PrivateAgentRequests
            .FirstOrDefaultAsync(r => r.Subject == subject && r.State == PrivateAgentRequestState.Pending, ct);
        if (pending is not null) return ConnectorResults.Json(View(pending));

        var row = new PrivateAgentRequestRow
        {
            Id = Ids.New(Ids.PrivateAgentRequest),
            Subject = subject,
            CreatedAt = time.GetUtcNow(),
        };
        db.PrivateAgentRequests.Add(row);
        await db.SaveChangesAsync(ct);

        return ConnectorResults.Json(View(row));
    }

    private static async Task<IResult> WithdrawAsync(
        HttpContext http,
        string requestId,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var subject = RequestContext.RequireSubject(http);

        var row = await db.PrivateAgentRequests.FirstOrDefaultAsync(r => r.Id == requestId && r.Subject == subject, ct)
                  ?? throw ConnectorException.Unsupported($"unknown request '{requestId}'");

        if (row.State == PrivateAgentRequestState.Pending)
        {
            row.State = PrivateAgentRequestState.Withdrawn;
            row.DecidedAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
        }

        return Results.NoContent();
    }

    private static async Task<IResult> GiveBackAsync(
        HttpContext http,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var subject = RequestContext.RequireSubject(http);

        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Hosted && !a.Revoked && a.OwnerSubject == subject, ct)
                    ?? throw ConnectorException.Unsupported("no hosted agent is bound to this subject");

        await ReleaseAsync(db, agent, time.GetUtcNow(), ct);
        return Results.NoContent();
    }

    private static async Task<ConnectorJsonResult<PrivateAgentAdminResponse>> OverviewAsync(
        ConnectorDbContext db,
        IProviderRegistry registry,
        TimeProvider time,
        CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var slots = await db.Agents.AsNoTracking()
            .Where(a => a.Hosted && !a.Revoked)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);
        var ids = slots.Select(a => a.Id).ToList();
        var profiles = await db.Profiles.AsNoTracking().Where(p => ids.Contains(p.AgentId)).ToListAsync(ct);

        // Every open request, and the recent decisions so the operator sees
        // what they did: thirty days is history enough for a household.
        var since = now.AddDays(-30);
        var requests = await db.PrivateAgentRequests.AsNoTracking()
            .Where(r => r.State == PrivateAgentRequestState.Pending || r.CreatedAt > since)
            .OrderBy(r => r.State == PrivateAgentRequestState.Pending ? 0 : 1)
            .ThenByDescending(r => r.CreatedAt)
            .ToListAsync(ct);

        return ConnectorResults.Json(new PrivateAgentAdminResponse
        {
            Total = slots.Count,
            Free = slots.Count(a => IsFree(a, now)),
            Slots =
            [
                .. slots.Select(a => new PrivateAgentSlotView
                {
                    Agent = AgentAdminEndpoints.View(a, profiles, registry, now),
                    Subject = IsBound(a) ? a.OwnerSubject : null,
                }),
            ],
            Requests = [.. requests.Select(View)],
        });
    }

    private static async Task<ConnectorJsonResult<PrivateAgentRequestView>> ApproveAsync(
        string requestId,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var request = await RequirePendingAsync(db, requestId, ct);
        var now = time.GetUtcNow();

        // Somebody already holding a slot is not handed a second one; the
        // approval records the one they have.
        var held = await db.Agents.FirstOrDefaultAsync(a => a.Hosted && !a.Revoked && a.OwnerSubject == request.Subject, ct);
        if (held is null)
        {
            var live = AgentLiveness.OnlineSince(now);
            held = await db.Agents
                .Where(a => a.Hosted
                            && !a.Revoked
                            && a.OwnerSubject == ConnectorOptions.PrivateSlotSubject
                            && a.ResetRequestedAt == null
                            && a.LastHeartbeatAt > live)
                .OrderBy(a => a.CreatedAt)
                .FirstOrDefaultAsync(ct)
                   ?? throw new ConnectorException(
                       ErrorCode.AgentUnavailable,
                       "no free hosted agent: every private slot is bound, offline or still wiping; add private slots "
                       + "to the environment in the wizard, or release one");

            held.OwnerSubject = request.Subject;
            held.BoundAt = now;
        }

        request.State = PrivateAgentRequestState.Approved;
        request.DecidedAt = now;
        request.AgentId = held.Id;
        await db.SaveChangesAsync(ct);

        return ConnectorResults.Json(View(request));
    }

    private static async Task<ConnectorJsonResult<PrivateAgentRequestView>> DenyAsync(
        string requestId,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var request = await RequirePendingAsync(db, requestId, ct);

        request.State = PrivateAgentRequestState.Denied;
        request.DecidedAt = time.GetUtcNow();
        await db.SaveChangesAsync(ct);

        return ConnectorResults.Json(View(request));
    }

    private static async Task<IResult> TakeBackAsync(
        string agentId,
        ConnectorDbContext db,
        TimeProvider time,
        CancellationToken ct)
    {
        var agent = await db.Agents.FirstOrDefaultAsync(a => a.Id == agentId && a.Hosted && !a.Revoked, ct)
                    ?? throw ConnectorException.Unsupported($"unknown hosted agent '{agentId}'");

        await ReleaseAsync(db, agent, time.GetUtcNow(), ct);
        return Results.NoContent();
    }

    /// <summary>
    /// The slot goes back to the slot subject and is asked to wipe. The
    /// previous person's profile rows go now - they are how the next
    /// person would be shown somebody else's sign-ins - and the sessions
    /// pinned to them expire, because a job pinned to a profile nobody holds
    /// would wait half an hour to fail; "reconnect" is the honest answer at
    /// once. Idempotent: a slot already free is asked again and nothing else.
    /// </summary>
    internal static async Task ReleaseAsync(ConnectorDbContext db, AgentRow agent, DateTimeOffset now, CancellationToken ct)
    {
        var profileIds = await db.Profiles.Where(p => p.AgentId == agent.Id).Select(p => p.Id).ToListAsync(ct);

        if (profileIds.Count > 0)
        {
            await db.Sessions
                .Where(s => s.ProfileId != null && profileIds.Contains(s.ProfileId) && s.State != SessionState.Expired)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(x => x.State, SessionState.Expired)
                    .SetProperty(x => x.UpdatedAt, now), ct);
            await db.Profiles.Where(p => p.AgentId == agent.Id).ExecuteDeleteAsync(ct);
        }

        await db.PrivateAgentRequests
            .Where(r => r.AgentId == agent.Id && r.State == PrivateAgentRequestState.Approved)
            .ExecuteUpdateAsync(r => r.SetProperty(x => x.State, PrivateAgentRequestState.Released), ct);

        agent.OwnerSubject = ConnectorOptions.PrivateSlotSubject;
        agent.BoundAt = null;
        agent.ResetRequestedAt = now;
        await db.SaveChangesAsync(ct);
    }

    private static async Task<PrivateAgentRequestRow> RequirePendingAsync(ConnectorDbContext db, string requestId, CancellationToken ct)
    {
        var request = await db.PrivateAgentRequests.FirstOrDefaultAsync(r => r.Id == requestId, ct)
                      ?? throw ConnectorException.Unsupported($"unknown request '{requestId}'");

        return request.State == PrivateAgentRequestState.Pending
            ? request
            : throw ConnectorException.InvalidRequest($"request '{requestId}' is {Wire(request.State)}, not pending");
    }

    private static string Wire(PrivateAgentRequestState state) => state.ToString().ToLowerInvariant();

    private static PrivateAgentRequestView View(PrivateAgentRequestRow row) => new()
    {
        Id = row.Id,
        Subject = row.Subject,
        State = Wire(row.State),
        CreatedAt = row.CreatedAt,
        DecidedAt = row.DecidedAt,
        AgentId = row.AgentId,
    };
}
