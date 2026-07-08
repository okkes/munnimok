using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Social;

public sealed record MeResponse(Guid UserId, string? DisplayName, string? Picture);
public sealed record UpdateMeRequest(string DisplayName, string? Picture = null);
public sealed record FriendDto(Guid UserId, string? DisplayName);
public sealed record FriendRequestDto(Guid Id, Guid FromUserId, string? FromName, Guid ToUserId, string? ToName);
public sealed record FriendsResponse(List<FriendDto> Friends, List<FriendRequestDto> SentPending, List<FriendRequestDto> ReceivedPending);
public sealed record SendFriendRequest(Guid ToUserId);
public sealed record SendSpaceInvite(Guid ToUserId, string Role, string? SpaceName);
public sealed record ChangeRoleRequest(string Role);
public sealed record SpaceInviteDto(Guid Id, string SpaceId, string? SpaceName, Guid FromUserId, string? FromName, string Role);
public sealed record MemberDto(Guid UserId, string? DisplayName, string Role);

public static class SocialEndpoints
{
    /// <summary>Strict rate-limit policy for writes that reach other people.</summary>
    public const string MutationsPolicy = "social-mutations";

    private const string StatusAccepted = "accepted";
    private const string StatusPending = "pending";
    private const string StatusDeclined = "declined";

    public static void MapSocial(this IEndpointRouteBuilder app)
    {
        var authed = app.MapGroup("").RequireAuthorization().WithSafeRouteParams();

        authed.MapGet("/me", GetMe);
        authed.MapPut("/me", UpdateMe).WithValidation<UpdateMeRequest>();
        authed.MapGet("/friends", GetFriends);
        // writes that reach OTHER people get the stricter limiter (invite spam)
        authed.MapPost("/friends/requests", SendFriendRequestAsync).WithValidation<SendFriendRequest>().RequireRateLimiting(MutationsPolicy);
        authed.MapPost("/friends/requests/{id:guid}/accept", AcceptFriendRequest).RequireRateLimiting(MutationsPolicy);
        authed.MapDelete("/friends/{userId:guid}", RemoveFriend).RequireRateLimiting(MutationsPolicy);
        authed.MapPost("/spaces/{spaceId}/invites", SendSpaceInviteAsync).WithValidation<SendSpaceInvite>().RequireRateLimiting(MutationsPolicy);
        authed.MapGet("/me/invites", GetMyInvites);
        authed.MapPost("/spaces/invites/{id:guid}/{action}", RespondToInvite).RequireRateLimiting(MutationsPolicy);
        authed.MapGet("/spaces/{spaceId}/members", GetMembers);
        authed.MapPut("/spaces/{spaceId}/members/{userId:guid}/role", ChangeMemberRole).WithValidation<ChangeRoleRequest>().RequireRateLimiting(MutationsPolicy);
        authed.MapDelete("/spaces/{spaceId}/members/{userId:guid}", RemoveMember).RequireRateLimiting(MutationsPolicy);
    }

    // ── identity ────────────────────────────────────────────────────────
    private static async Task<IResult> GetMe(AppDbContext db, HttpContext http)
    {
        var user = await db.Users.FindAsync(http.GetUserId());
        return Results.Ok(new MeResponse(user!.Id, user.DisplayName, user.Picture));
    }

    private static async Task<IResult> UpdateMe(UpdateMeRequest request, AppDbContext db, HttpContext http)
    {
        var user = await db.Users.FindAsync(http.GetUserId());
        user!.DisplayName = request.DisplayName.Trim();
        if (request.Picture is not null) user.Picture = request.Picture;
        await db.SaveChangesAsync();
        return Results.Ok(new MeResponse(user.Id, user.DisplayName, user.Picture));
    }

    // ── friends ─────────────────────────────────────────────────────────
    private static async Task<IResult> GetFriends(AppDbContext db, HttpContext http)
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
            edges.Where(f => f.Status == StatusAccepted)
                .Select(f => f.UserAId == me ? f.UserBId : f.UserAId)
                .Select(id => new FriendDto(id, names.GetValueOrDefault(id))).ToList(),
            edges.Where(f => f.Status == StatusPending && f.RequestedBy == me).Select(Req).ToList(),
            edges.Where(f => f.Status == StatusPending && f.RequestedBy != me).Select(Req).ToList()));
    }

    private static async Task<IResult> SendFriendRequestAsync(SendFriendRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (request.ToUserId == me) return Results.BadRequest();
        if (await db.Users.FindAsync(request.ToUserId) is null) return Results.NotFound();

        var (a, b) = me < request.ToUserId ? (me, request.ToUserId) : (request.ToUserId, me);
        var existing = await db.Friendships.FirstOrDefaultAsync(f => f.UserAId == a && f.UserBId == b);
        if (existing is not null)
        {
            // their pending request to me? -> auto-accept (legacy behavior)
            if (existing.Status == StatusPending && existing.RequestedBy != me) existing.Status = StatusAccepted;
        }
        else
        {
            db.Friendships.Add(new Friendship { Id = Guid.NewGuid(), UserAId = a, UserBId = b, RequestedBy = me, Status = StatusPending });
        }
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static async Task<IResult> AcceptFriendRequest(Guid id, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var f = await db.Friendships.FindAsync(id);
        if (f is null || (f.UserAId != me && f.UserBId != me) || f.RequestedBy == me) return Results.NotFound();
        f.Status = StatusAccepted;
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static async Task<IResult> RemoveFriend(Guid userId, AppDbContext db, HttpContext http)
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
    }

    // ── space invites & members ────────────────────────────────────────
    private static async Task<IResult> SendSpaceInviteAsync(string spaceId, SendSpaceInvite request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var membership = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me);
        if (membership is null || !SpaceRoles.IsOwner(membership.Role)) return Results.Forbid();

        var (a, b) = me < request.ToUserId ? (me, request.ToUserId) : (request.ToUserId, me);
        var friends = await db.Friendships.AnyAsync(f => f.UserAId == a && f.UserBId == b && f.Status == StatusAccepted);
        if (!friends) return Results.BadRequest(new { error = "not friends" });
        if (await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == request.ToUserId))
            return Results.BadRequest(new { error = "already member" });

        var pending = await db.SpaceInvites.AnyAsync(i => i.SpaceId == spaceId && i.ToUserId == request.ToUserId && i.Status == StatusPending);
        if (!pending)
        {
            db.SpaceInvites.Add(new SpaceInvite
            {
                Id = Guid.NewGuid(),
                SpaceId = spaceId,
                FromUserId = me,
                ToUserId = request.ToUserId,
                Role = SpaceRoles.Assignable.Contains(request.Role) ? request.Role : SpaceRoles.Contributor,
                Status = StatusPending,
                SpaceName = request.SpaceName,
            });
            await db.SaveChangesAsync();
        }
        return Results.Ok();
    }

    private static async Task<IResult> GetMyInvites(AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var invites = await db.SpaceInvites.Where(i => i.ToUserId == me && i.Status == StatusPending).ToListAsync();
        var fromIds = invites.Select(i => i.FromUserId).Distinct().ToList();
        var names = await db.Users.Where(u => fromIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName);
        return Results.Ok(invites.Select(i =>
            new SpaceInviteDto(i.Id, i.SpaceId, i.SpaceName, i.FromUserId, names.GetValueOrDefault(i.FromUserId), i.Role)).ToList());
    }

    private static async Task<IResult> RespondToInvite(Guid id, string action, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var invite = await db.SpaceInvites.FindAsync(id);
        if (invite is null || invite.ToUserId != me || invite.Status != StatusPending) return Results.NotFound();
        if (action == "accept")
        {
            invite.Status = StatusAccepted;
            db.SpaceMembers.Add(new SpaceMember { SpaceId = invite.SpaceId, UserId = me, Role = invite.Role });
        }
        else invite.Status = StatusDeclined;
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static async Task<IResult> GetMembers(string spaceId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == me)) return Results.Forbid();
        var members = await db.SpaceMembers.Where(m => m.SpaceId == spaceId).ToListAsync();
        var ids = members.Select(m => m.UserId).ToList();
        var names = await db.Users.Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName);
        return Results.Ok(members.Select(m => new MemberDto(m.UserId, names.GetValueOrDefault(m.UserId), SpaceRoles.Normalize(m.Role))).ToList());
    }

    /// <summary>Owner-only. Also how ownership is transferred (promote to owner).</summary>
    private static async Task<IResult> ChangeMemberRole(string spaceId, Guid userId, ChangeRoleRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        if (myRole is null || !SpaceRoles.IsOwner(myRole)) return Results.Forbid();

        var member = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId);
        if (member is null) return Results.NotFound();

        // an owner may not demote themself while they are the only owner
        if (userId == me && request.Role != SpaceRoles.Owner && !await HasAnotherOwner(db, spaceId, me))
            return Results.BadRequest(new { error = "last owner" });

        member.Role = request.Role;
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static async Task<IResult> RemoveMember(string spaceId, Guid userId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        var removingSelf = userId == me;
        if (myRole is null || (!removingSelf && !SpaceRoles.IsOwner(myRole))) return Results.Forbid();
        var member = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId);
        if (member is not null)
        {
            db.SpaceMembers.Remove(member);
            // never leave a space ownerless: promote the longest-standing
            // remaining member (deterministic by user id) when the last
            // owner walks out
            if (SpaceRoles.IsOwner(member.Role) && !await HasAnotherOwner(db, spaceId, userId))
            {
                var successor = await db.SpaceMembers
                    .Where(m => m.SpaceId == spaceId && m.UserId != userId)
                    .OrderBy(m => m.UserId)
                    .FirstOrDefaultAsync();
                if (successor is not null) successor.Role = SpaceRoles.Owner;
            }
            await db.SaveChangesAsync();
        }
        return Results.Ok();
    }

    private static async Task<bool> HasAnotherOwner(AppDbContext db, string spaceId, Guid excludingUserId) =>
        await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId != excludingUserId && m.Role == SpaceRoles.Owner);
}
