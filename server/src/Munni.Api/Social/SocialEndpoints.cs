using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Social;

public sealed record MeResponse(Guid UserId, string? DisplayName);
public sealed record UpdateMeRequest(string DisplayName);
public sealed record FriendDto(Guid UserId, string? DisplayName);
public sealed record FriendRequestDto(Guid Id, Guid FromUserId, string? FromName, Guid ToUserId, string? ToName);
public sealed record FriendsResponse(List<FriendDto> Friends, List<FriendRequestDto> SentPending, List<FriendRequestDto> ReceivedPending);
public sealed record SendFriendRequest(Guid ToUserId);
public sealed record SendSpaceInvite(Guid ToUserId, string Role, string? SpaceName);
public sealed record SpaceInviteDto(Guid Id, string SpaceId, string? SpaceName, Guid FromUserId, string? FromName, string Role);
public sealed record MemberDto(Guid UserId, string? DisplayName, string Role);

public static class SocialEndpoints
{
    public static void MapSocial(this IEndpointRouteBuilder app)
    {
        var authed = app.MapGroup("").RequireAuthorization();

        // ── identity ────────────────────────────────────────────────────────
        authed.MapGet("/me", async (AppDbContext db, HttpContext http) =>
        {
            var user = await db.Users.FindAsync(http.GetUserId());
            return Results.Ok(new MeResponse(user!.Id, user.DisplayName));
        });

        authed.MapPut("/me", async (UpdateMeRequest request, AppDbContext db, HttpContext http) =>
        {
            var user = await db.Users.FindAsync(http.GetUserId());
            user!.DisplayName = request.DisplayName.Trim();
            await db.SaveChangesAsync();
            return Results.Ok(new MeResponse(user.Id, user.DisplayName));
        }).WithValidation<UpdateMeRequest>();

        // ── friends ─────────────────────────────────────────────────────────
        authed.MapGet("/friends", async (AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var edges = await db.Friendships.Where(f => f.UserAId == me || f.UserBId == me).ToListAsync();
            var otherIds = edges.Select(f => f.UserAId == me ? f.UserBId : f.UserAId).Distinct().ToList();
            var names = await db.Users.Where(u => otherIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.DisplayName);

            FriendRequestDto Req(Friendship f)
            {
                var other = f.UserAId == me ? f.UserBId : f.UserAId;
                var (from, to) = f.RequestedBy == me ? (me, other) : (other, me);
                return new FriendRequestDto(f.Id, from, from == me ? null : names.GetValueOrDefault(from), to,
                    to == me ? null : names.GetValueOrDefault(to));
            }

            return Results.Ok(new FriendsResponse(
                edges.Where(f => f.Status == "accepted")
                    .Select(f => f.UserAId == me ? f.UserBId : f.UserAId)
                    .Select(id => new FriendDto(id, names.GetValueOrDefault(id))).ToList(),
                edges.Where(f => f.Status == "pending" && f.RequestedBy == me).Select(Req).ToList(),
                edges.Where(f => f.Status == "pending" && f.RequestedBy != me).Select(Req).ToList()));
        });

        authed.MapPost("/friends/requests", async (SendFriendRequest request, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            if (request.ToUserId == me) return Results.BadRequest();
            if (await db.Users.FindAsync(request.ToUserId) is null) return Results.NotFound();

            var (a, b) = me < request.ToUserId ? (me, request.ToUserId) : (request.ToUserId, me);
            var existing = await db.Friendships.FirstOrDefaultAsync(f => f.UserAId == a && f.UserBId == b);
            if (existing is not null)
            {
                // their pending request to me? -> auto-accept (legacy behavior)
                if (existing.Status == "pending" && existing.RequestedBy != me) existing.Status = "accepted";
            }
            else
            {
                db.Friendships.Add(new Friendship { Id = Guid.NewGuid(), UserAId = a, UserBId = b, RequestedBy = me, Status = "pending" });
            }
            await db.SaveChangesAsync();
            return Results.Ok();
        }).WithValidation<SendFriendRequest>();

        authed.MapPost("/friends/requests/{id:guid}/accept", async (Guid id, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var f = await db.Friendships.FindAsync(id);
            if (f is null || (f.UserAId != me && f.UserBId != me) || f.RequestedBy == me) return Results.NotFound();
            f.Status = "accepted";
            await db.SaveChangesAsync();
            return Results.Ok();
        });

        authed.MapDelete("/friends/{userId:guid}", async (Guid userId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var (a, b) = me < userId ? (me, userId) : (userId, me);
            // also used to decline a pending request
            var edge = await db.Friendships.FirstOrDefaultAsync(f => f.UserAId == a && f.UserBId == b);
            if (edge is not null)
            {
                db.Friendships.Remove(edge);
                await db.SaveChangesAsync();
            }
            return Results.Ok();
        });

        // ── space invites & members ────────────────────────────────────────
        authed.MapPost("/spaces/{spaceId}/invites", async (string spaceId, SendSpaceInvite request, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var membership = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me);
            if (membership is null || membership.Role != "owner") return Results.Forbid();

            var (a, b) = me < request.ToUserId ? (me, request.ToUserId) : (request.ToUserId, me);
            var friends = await db.Friendships.AnyAsync(f => f.UserAId == a && f.UserBId == b && f.Status == "accepted");
            if (!friends) return Results.BadRequest(new { error = "not friends" });
            if (await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == request.ToUserId))
                return Results.BadRequest(new { error = "already member" });

            var pending = await db.SpaceInvites.AnyAsync(i => i.SpaceId == spaceId && i.ToUserId == request.ToUserId && i.Status == "pending");
            if (!pending)
            {
                db.SpaceInvites.Add(new SpaceInvite
                {
                    Id = Guid.NewGuid(),
                    SpaceId = spaceId,
                    FromUserId = me,
                    ToUserId = request.ToUserId,
                    Role = request.Role == "owner" ? "owner" : "member",
                    Status = "pending",
                    SpaceName = request.SpaceName,
                });
                await db.SaveChangesAsync();
            }
            return Results.Ok();
        }).WithValidation<SendSpaceInvite>();

        authed.MapGet("/me/invites", async (AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var invites = await db.SpaceInvites.Where(i => i.ToUserId == me && i.Status == "pending").ToListAsync();
            var fromIds = invites.Select(i => i.FromUserId).Distinct().ToList();
            var names = await db.Users.Where(u => fromIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName);
            return Results.Ok(invites.Select(i =>
                new SpaceInviteDto(i.Id, i.SpaceId, i.SpaceName, i.FromUserId, names.GetValueOrDefault(i.FromUserId), i.Role)).ToList());
        });

        authed.MapPost("/spaces/invites/{id:guid}/{action}", async (Guid id, string action, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var invite = await db.SpaceInvites.FindAsync(id);
            if (invite is null || invite.ToUserId != me || invite.Status != "pending") return Results.NotFound();
            if (action == "accept")
            {
                invite.Status = "accepted";
                db.SpaceMembers.Add(new SpaceMember { SpaceId = invite.SpaceId, UserId = me, Role = invite.Role });
            }
            else invite.Status = "declined";
            await db.SaveChangesAsync();
            return Results.Ok();
        });

        authed.MapGet("/spaces/{spaceId}/members", async (string spaceId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == me)) return Results.Forbid();
            var members = await db.SpaceMembers.Where(m => m.SpaceId == spaceId).ToListAsync();
            var ids = members.Select(m => m.UserId).ToList();
            var names = await db.Users.Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName);
            return Results.Ok(members.Select(m => new MemberDto(m.UserId, names.GetValueOrDefault(m.UserId), m.Role)).ToList());
        });

        authed.MapDelete("/spaces/{spaceId}/members/{userId:guid}", async (string spaceId, Guid userId, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
            var removingSelf = userId == me;
            if (myRole is null || (!removingSelf && myRole != "owner")) return Results.Forbid();
            var member = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId);
            if (member is not null)
            {
                db.SpaceMembers.Remove(member);
                await db.SaveChangesAsync();
            }
            return Results.Ok();
        });
    }
}
