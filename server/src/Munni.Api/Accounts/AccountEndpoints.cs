using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Validation;

namespace Munni.Api.Accounts;

public sealed record RegisterFeedRequest(string FeedSpaceId, string AccountRef);
public sealed record RegisterFeedResponse(string FeedSpaceId, bool Owned);
public sealed record AttachAccountRequest(string FeedSpaceId, string AccountId, string? HistoryFrom = null);
public sealed record AccountLinkDto(
    Guid Id,
    string SpaceId,
    string FeedSpaceId,
    string AccountId,
    Guid AttachedBy,
    string? HistoryFrom,
    bool Archived);
public sealed record MyFeedDto(string FeedSpaceId, string AccountRef);

/// <summary>
/// Shared-accounts P2: feed registration (the ONLY way a feed space is
/// born — closes the deterministic-id squatting hole, security S1) and
/// server-authoritative account attachments that derive members' read
/// access to feeds.
/// </summary>
public static class AccountEndpoints
{
    public static void MapAccounts(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("").RequireAuthorization().WithSafeRouteParams();

        // owning flows (bank connect / statement import) call this before
        // the first push into a feed space
        group.MapPost("/feeds", RegisterFeed).WithValidation<RegisterFeedRequest>();
        group.MapGet("/me/feeds", MyFeeds);

        group.MapGet("/spaces/{spaceId}/accounts", ListLinks);
        group.MapPost("/spaces/{spaceId}/accounts", Attach).WithValidation<AttachAccountRequest>();
        group.MapDelete("/spaces/{spaceId}/accounts/{linkId:guid}", Detach);
    }

    private static async Task<IResult> RegisterFeed(RegisterFeedRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (!FeedAccess.IsFeedShaped(request.FeedSpaceId))
            return Results.BadRequest(new { error = "not a feed-shaped id" });

        var existing = await db.FeedSpaces.FindAsync(request.FeedSpaceId);
        if (existing is not null)
        {
            // idempotent for the owner (reconnect); a CONFLICT for anyone
            // else — the caller falls back to a personal feed id, so a
            // squatter can never observe another user's data
            return existing.OwnerUserId == me
                ? Results.Ok(new RegisterFeedResponse(existing.Id, true))
                : Results.Conflict(new { error = "feed registered by another user" });
        }

        db.FeedSpaces.Add(new FeedSpace { Id = request.FeedSpaceId, OwnerUserId = me, AccountRef = request.AccountRef });
        if (await db.Spaces.FindAsync(request.FeedSpaceId) is null)
            db.Spaces.Add(new Space { Id = request.FeedSpaceId });
        // owner membership lets the existing push path accept raw writes
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == request.FeedSpaceId && m.UserId == me))
            db.SpaceMembers.Add(new SpaceMember { SpaceId = request.FeedSpaceId, UserId = me, Role = SpaceRoles.Owner });
        await db.SaveChangesAsync();
        return Results.Ok(new RegisterFeedResponse(request.FeedSpaceId, true));
    }

    private static async Task<IResult> MyFeeds(AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var feeds = await db.FeedSpaces.Where(f => f.OwnerUserId == me)
            .Select(f => new MyFeedDto(f.Id, f.AccountRef))
            .ToListAsync();
        return Results.Ok(feeds);
    }

    private static async Task<IResult> ListLinks(string spaceId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == me)) return Results.Forbid();
        var links = await db.SpaceAccountLinks.Where(l => l.SpaceId == spaceId)
            .Select(l => new AccountLinkDto(l.Id, l.SpaceId, l.FeedSpaceId, l.AccountId, l.AttachedBy, l.HistoryFrom, l.Archived))
            .ToListAsync();
        return Results.Ok(links);
    }

    private static async Task<IResult> Attach(string spaceId, AttachAccountRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        if (myRole is null || !SpaceRoles.CanWrite(myRole)) return Results.Forbid();
        // you can only attach accounts you actually have: your own feed
        if (!await FeedAccess.IsFeedOwner(db, me, request.FeedSpaceId))
            return Results.Forbid();

        var link = await db.SpaceAccountLinks.FirstOrDefaultAsync(l =>
            l.SpaceId == spaceId && l.FeedSpaceId == request.FeedSpaceId && l.AccountId == request.AccountId);
        if (link is null)
        {
            link = new SpaceAccountLink
            {
                Id = Guid.NewGuid(),
                SpaceId = spaceId,
                FeedSpaceId = request.FeedSpaceId,
                AccountId = request.AccountId,
                AttachedBy = me,
                HistoryFrom = request.HistoryFrom,
            };
            db.SpaceAccountLinks.Add(link);
        }
        else
        {
            // re-attach: the owner reconnecting revives an archived link
            link.Archived = false;
            link.ArchivedAtSeq = null;
            link.AttachedBy = me;
            if (request.HistoryFrom is not null) link.HistoryFrom = request.HistoryFrom;
        }
        await db.SaveChangesAsync();
        return Results.Ok(new AccountLinkDto(link.Id, link.SpaceId, link.FeedSpaceId, link.AccountId, link.AttachedBy, link.HistoryFrom, link.Archived));
    }

    private static async Task<IResult> Detach(string spaceId, Guid linkId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        if (myRole is null || !SpaceRoles.CanWrite(myRole)) return Results.Forbid();

        var link = await db.SpaceAccountLinks.FirstOrDefaultAsync(l => l.Id == linkId && l.SpaceId == spaceId);
        if (link is not null)
        {
            db.SpaceAccountLinks.Remove(link);
            await db.SaveChangesAsync();
        }
        return Results.Ok();
    }

    /// <summary>Archive the leaver's attachments in a space (member removal / leave).</summary>
    public static async Task ArchiveLinksOnLeaveAsync(AppDbContext db, string spaceId, Guid leavingUserId)
    {
        var links = await db.SpaceAccountLinks
            .Where(l => l.SpaceId == spaceId && l.AttachedBy == leavingUserId && !l.Archived)
            .ToListAsync();
        if (links.Count == 0) return;
        var feedIds = links.Select(l => l.FeedSpaceId).Distinct().ToList();
        var cursors = await db.Spaces.Where(s => feedIds.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, s => s.LastSeq);
        foreach (var link in links)
        {
            link.Archived = true;
            link.ArchivedAtSeq = cursors.GetValueOrDefault(link.FeedSpaceId);
        }
    }

    /// <summary>Un-archive on rejoin: a returning member's still-owned feeds reconnect automatically.</summary>
    public static async Task ReviveLinksOnJoinAsync(AppDbContext db, string spaceId, Guid joiningUserId)
    {
        var ownedFeeds = db.FeedSpaces.Where(f => f.OwnerUserId == joiningUserId).Select(f => f.Id);
        var links = await db.SpaceAccountLinks
            .Where(l => l.SpaceId == spaceId && l.Archived && l.AttachedBy == joiningUserId && ownedFeeds.Contains(l.FeedSpaceId))
            .ToListAsync();
        foreach (var link in links)
        {
            link.Archived = false;
            link.ArchivedAtSeq = null;
        }
    }
}
