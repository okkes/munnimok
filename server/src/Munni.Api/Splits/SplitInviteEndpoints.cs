using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Push;

namespace Munni.Api.Splits;

/// <summary>
/// The ways into a split event (#538). A LINK lets in whoever holds it —
/// no friendship needed, no space access granted — within what its owner
/// set: how many people, until when, and whether they wait for an owner's
/// word first. A FRIEND an owner asks gets a notice like a space
/// invitation and is in the moment they say yes. Only owners open either
/// door, and both close when the event is settled.
/// </summary>
internal static class SplitInviteEndpoints
{
    private const string Mutations = Social.SocialEndpoints.MutationsPolicy;
    private const string Accepted = "accepted";

    public static void MapSplitInvites(this RouteGroupBuilder group)
    {
        group.MapGet("/{splitId}/invites", ActiveLinkAsync);
        group.MapPost("/{splitId}/invites", NewLinkAsync).RequireRateLimiting(Mutations);
        group.MapDelete("/{splitId}/invites", EndLinkAsync);
        group.MapGet("/invites/{token}", PeekAsync);
        group.MapPost("/invites/{token}/accept", AcceptAsync).RequireRateLimiting(Mutations);
        group.MapPost("/{splitId}/requests/{requestId:guid}/{answer}", AnswerRequestAsync).RequireRateLimiting(Mutations);
        group.MapPost("/{splitId}/friend-invites", InviteFriendAsync).RequireRateLimiting(Mutations);
        group.MapDelete("/{splitId}/friend-invites/{inviteId:guid}", CancelFriendInviteAsync);
        group.MapGet("/friend-invites", MyFriendInvitesAsync);
        group.MapPost("/friend-invites/{inviteId:guid}/{answer}", AnswerFriendInviteAsync).RequireRateLimiting(Mutations);
    }

    /// <summary>A link works until its date passes or its uses are spent.</summary>
    private static bool Works(SplitInvite link, DateTimeOffset now) =>
        (link.ExpiresAt is null || link.ExpiresAt >= now) && (link.MaxUses == 0 || link.Uses < link.MaxUses);

    private static SplitLinkDto LinkView(SplitInvite? link) =>
        link is null ? new SplitLinkDto(null, null, 0, 0, false) : new SplitLinkDto(link.Token, link.ExpiresAt, link.MaxUses, link.Uses, link.NeedsApproval);

    /// <summary>the event's link as it stands: reading never replaces it, so a link already sent out keeps working</summary>
    private static async Task<IResult> ActiveLinkAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        var now = time.GetUtcNow();
        var links = split.Status == SplitWords.Open ? await db.SplitInvites.Where(i => i.SplitId == splitId).OrderByDescending(i => i.CreatedAt).ToListAsync(ct) : [];
        return Results.Ok(LinkView(links.FirstOrDefault(l => Works(l, now))));
    }

    /// <summary>a new link is an owner's explicit act and ends the one before it: one link per event keeps "who can
    /// still get in" a question with one answer</summary>
    private static async Task<IResult> NewLinkAsync(string splitId, NewLinkRequest? request, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.BadRequest(new { error = "split settled" });
        if (request?.MaxUses is < 0 or > 1000 || request?.ValidDays is < 0 or > 365) return Results.BadRequest(new { error = "invalid link" });

        db.SplitInvites.RemoveRange(await db.SplitInvites.Where(i => i.SplitId == splitId).ToListAsync(ct));
        var link = new SplitInvite
        {
            Token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('='),
            SplitId = splitId,
            CreatedBy = me.UserId,
            CreatedAt = time.GetUtcNow(),
            MaxUses = request?.MaxUses ?? 0,
            NeedsApproval = request?.NeedsApproval ?? false,
            ExpiresAt = request?.ValidDays is > 0 ? time.GetUtcNow().AddDays(request.ValidDays.Value) : null,
        };
        db.SplitInvites.Add(link);
        await db.SaveChangesAsync(ct);
        return Results.Ok(LinkView(link));
    }

    private static async Task<IResult> EndLinkAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        db.SplitInvites.RemoveRange(await db.SplitInvites.Where(i => i.SplitId == splitId).ToListAsync(ct));
        await db.SaveChangesAsync(ct);
        return Results.Ok(LinkView(null));
    }

    /// <summary>The link with its event, and whether it still lets anyone in — someone already in is told so by a link that no longer does.</summary>
    private static async Task<(SplitInvite Link, Split Split, bool Works)?> LinkAsync(AppDbContext db, string token, TimeProvider time, CancellationToken ct)
    {
        var link = await db.SplitInvites.FindAsync([token], ct);
        if (link is null) return null;
        var split = await db.Splits.FindAsync([link.SplitId], ct);
        return split is null ? null : (link, split, Works(link, time.GetUtcNow()) && split.Status == SplitWords.Open);
    }

    /// <summary>the join screen shows the event's name, look and inviter and nothing else — and where the caller
    /// stands: the link's own maker, already in, waiting for an owner, or taken out before; a link that does not
    /// work 404s whatever the reason</summary>
    private static async Task<IResult> PeekAsync(string token, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var me = http.GetUserId();
        var found = await LinkAsync(db, token, time, ct);
        if (found is null) return Results.NotFound();
        var (link, split, works) = found.Value;
        var membership = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == split.Id && m.UserId == me, ct);
        var member = membership?.IsActive() == true;
        if (!works && !member) return Results.NotFound();
        return Results.Ok(new
        {
            splitName = split.Name,
            currency = split.Currency,
            picture = split.Picture,
            inviterName = await SplitStore.NameOfAsync(db, link.CreatedBy, ct),
            mine = link.CreatedBy == me,
            member,
            // the id opens the event: only for someone who is already in it
            splitId = member ? split.Id : null,
            needsApproval = link.NeedsApproval,
            waiting = await db.SplitJoinRequests.AnyAsync(r => r.SplitId == split.Id && r.UserId == me && r.Status == SplitWords.Pending, ct),
            removed = membership?.State == SplitWords.Removed,
        });
    }

    /// <summary>
    /// Using the link: someone already in stays as they are and spends no use; someone an owner took out does not
    /// come back through a link; a link that asks for approval puts its user in the queue; any other lets them in.
    /// </summary>
    private static async Task<IResult> AcceptAsync(string token, AcceptInviteRequest? request, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var me = http.GetUserId();
        var found = await LinkAsync(db, token, time, ct);
        if (found is null) return Results.NotFound();
        var (link, split, works) = found.Value;
        var membership = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == split.Id && m.UserId == me, ct);
        if (membership?.IsActive() == true) return Results.Ok(new { splitId = split.Id, state = "member" });
        if (!works) return Results.NotFound();
        if (membership?.State == SplitWords.Removed) return Results.Json(new { error = "removed" }, statusCode: StatusCodes.Status403Forbidden);

        if (!link.NeedsApproval)
        {
            link.Uses += 1;
            Join(db, split.Id, me, membership, request?.SpaceId, time);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { splitId = split.Id, state = "joined" });
        }

        if (!await db.SplitJoinRequests.AnyAsync(r => r.SplitId == split.Id && r.UserId == me && r.Status == SplitWords.Pending, ct))
        {
            link.Uses += 1;
            db.SplitJoinRequests.Add(new SplitJoinRequest { Id = Guid.NewGuid(), SplitId = split.Id, UserId = me, CreatedAt = time.GetUtcNow() });
            await db.SaveChangesAsync(ct);
            var owners = await db.SplitMembers.Where(m => m.SplitId == split.Id && m.State == SplitWords.Active && m.Role == SplitWords.Owner).Select(m => m.UserId).ToListAsync(ct);
            await push.NotifySplitAsync(owners, "join-request", split, await SplitStore.NameOfAsync(db, me, ct), null, ct);
        }
        return Results.Ok(new { splitId = (string?)null, state = "waiting" });
    }

    /// <summary>In, as a contributor: a first time, or back after having left.</summary>
    private static void Join(AppDbContext db, string splitId, Guid userId, SplitMember? membership, string? spaceId, TimeProvider time)
    {
        if (membership is null)
        {
            // per-member attachment: THEIR space, never validated against anyone else's — personal wiring the server just stores
            db.SplitMembers.Add(new SplitMember { SplitId = splitId, UserId = userId, Role = SplitWords.Contributor, AttachedSpaceId = spaceId, JoinedAt = time.GetUtcNow() });
            return;
        }
        membership.State = SplitWords.Active;
        membership.Role = SplitWords.Contributor;
        membership.LeftAt = null;
    }

    /// <summary>An owner's word on someone waiting: `approve` lets them in, anything else turns them away.</summary>
    private static async Task<IResult> AnswerRequestAsync(string splitId, Guid requestId, string answer, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time)
    {
        var ct = http.RequestAborted;
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        var waiting = await db.SplitJoinRequests.FirstOrDefaultAsync(r => r.Id == requestId && r.SplitId == splitId && r.Status == SplitWords.Pending, ct);
        if (waiting is null) return Results.Ok(new { id = splitId });

        var approved = answer == "approve" && split.Status == SplitWords.Open;
        waiting.Status = approved ? "approved" : "refused";
        waiting.AnsweredAt = time.GetUtcNow();
        if (approved)
        {
            var membership = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == splitId && m.UserId == waiting.UserId, ct);
            Join(db, splitId, waiting.UserId, membership, null, time);
        }
        await db.SaveChangesAsync(ct);
        await push.NotifySplitAsync([waiting.UserId], approved ? "approved" : "refused", split, null, null, ct);
        return Results.Ok(new { id = splitId });
    }

    private static async Task<IResult> InviteFriendAsync(string splitId, FriendInviteRequest request, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.BadRequest(new { error = "split settled" });

        var (a, b) = me.UserId < request.ToUserId ? (me.UserId, request.ToUserId) : (request.ToUserId, me.UserId);
        if (!await db.Friendships.AnyAsync(f => f.UserAId == a && f.UserBId == b && f.Status == Accepted, ct)) return Results.BadRequest(new { error = "not friends" });
        if (await db.SplitMembers.AnyAsync(m => m.SplitId == splitId && m.UserId == request.ToUserId && m.State == SplitWords.Active, ct)) return Results.BadRequest(new { error = "already member" });

        if (!await db.SplitFriendInvites.AnyAsync(i => i.SplitId == splitId && i.ToUserId == request.ToUserId && i.Status == SplitWords.Pending, ct))
        {
            db.SplitFriendInvites.Add(new SplitFriendInvite { Id = Guid.NewGuid(), SplitId = splitId, FromUserId = me.UserId, ToUserId = request.ToUserId, CreatedAt = time.GetUtcNow() });
            await db.SaveChangesAsync(ct);
            await push.NotifySplitAsync([request.ToUserId], "invited", split, await SplitStore.NameOfAsync(db, me.UserId, ct), null, ct);
        }
        return Results.Ok(new { id = splitId });
    }

    /// <summary>An invitation nobody answered yet can be taken back by any owner.</summary>
    private static async Task<IResult> CancelFriendInviteAsync(string splitId, Guid inviteId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        var invite = await db.SplitFriendInvites.FirstOrDefaultAsync(i => i.Id == inviteId && i.SplitId == splitId && i.Status == SplitWords.Pending, ct);
        if (invite is not null)
        {
            invite.Status = "cancelled";
            invite.AnsweredAt = time.GetUtcNow();
            await db.SaveChangesAsync(ct);
        }
        return Results.Ok(new { id = splitId });
    }

    /// <summary>The invitations waiting for the caller's answer, with what an invitee may know: the event's name and look, and who asked.</summary>
    private static async Task<IResult> MyFriendInvitesAsync(AppDbContext db, HttpContext http, CancellationToken ct)
    {
        var me = http.GetUserId();
        var invites = await db.SplitFriendInvites.Where(i => i.ToUserId == me && i.Status == SplitWords.Pending).OrderByDescending(i => i.CreatedAt).ToListAsync(ct);
        var splitIds = invites.Select(i => i.SplitId).Distinct().ToList();
        var splits = await db.Splits.Where(s => splitIds.Contains(s.Id) && s.Status == SplitWords.Open).ToDictionaryAsync(s => s.Id, ct);
        var fromIds = invites.Select(i => i.FromUserId).Distinct().ToList();
        var names = await db.Users.Where(u => fromIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        return Results.Ok(invites
            .Where(i => splits.ContainsKey(i.SplitId))
            .Select(i => new
            {
                id = i.Id,
                splitId = i.SplitId,
                splitName = splits[i.SplitId].Name,
                picture = splits[i.SplitId].Picture,
                fromName = names.GetValueOrDefault(i.FromUserId),
                createdAt = i.CreatedAt,
            })
            .ToList());
    }

    /// <summary>The invitee's word: `accept` puts them in at once — no queue, an owner asked for them — anything else declines.</summary>
    private static async Task<IResult> AnswerFriendInviteAsync(Guid inviteId, string answer, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var me = http.GetUserId();
        var invite = await db.SplitFriendInvites.FirstOrDefaultAsync(i => i.Id == inviteId && i.ToUserId == me && i.Status == SplitWords.Pending, ct);
        if (invite is null) return Results.NotFound();
        var split = await db.Splits.FindAsync([invite.SplitId], ct);
        var accepted = answer == "accept" && split?.Status == SplitWords.Open;
        invite.Status = accepted ? Accepted : "declined";
        invite.AnsweredAt = time.GetUtcNow();
        if (accepted)
        {
            var membership = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == invite.SplitId && m.UserId == me, ct);
            Join(db, invite.SplitId, me, membership, null, time);
        }
        await db.SaveChangesAsync(ct);
        if (split is not null) await push.NotifySplitAsync([invite.FromUserId], accepted ? "invite-accepted" : "invite-declined", split, await SplitStore.NameOfAsync(db, me, ct), null, ct);
        return Results.Ok(new { splitId = accepted ? invite.SplitId : null });
    }
}
