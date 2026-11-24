using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Validation;

namespace Munni.Api.Accounts;

public sealed record AttachStoreRequest(string FeedSpaceId);
public sealed record StoreLinkDto(string SpaceId, string FeedSpaceId, Guid AttachedBy);

/// #648: a shop connection's receipts (and a person's own scans) live once, in a feed of their own; a space that
/// includes the feed lets its members READ it, the way an attached bank account does. Nothing is copied into the space
public static class StoreLinkEndpoints
{
    public static void MapStoreLinks(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/spaces/{spaceId}/stores").RequireAuthorization().WithSafeRouteParams();
        group.MapGet("", List);
        group.MapPost("", Attach).WithValidation<AttachStoreRequest>();
        group.MapDelete("{feedSpaceId}", Detach);
    }

    private static async Task<string?> RoleAsync(AppDbContext db, string spaceId, Guid userId) =>
        (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == userId))?.Role;

    private static async Task<IResult> List(string spaceId, AppDbContext db, HttpContext http)
    {
        if (await RoleAsync(db, spaceId, http.GetUserId()) is null) return Results.Forbid();
        var links = await db.SpaceStoreLinks.Where(l => l.SpaceId == spaceId).ToListAsync();
        return Results.Ok(links.Select(ToDto).ToList());
    }

    private static async Task<IResult> Attach(string spaceId, AttachStoreRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var role = await RoleAsync(db, spaceId, me);
        if (role is null) return Results.Forbid();
        if (!SpaceRoles.CanWrite(role)) return SpaceRoles.ReadOnly();
        // only its owner shares a feed: an attachment is what lets the other members read it
        if (!await FeedAccess.IsFeedOwner(db, me, request.FeedSpaceId)) return Results.Forbid();

        var link = await db.SpaceStoreLinks.FirstOrDefaultAsync(l => l.SpaceId == spaceId && l.FeedSpaceId == request.FeedSpaceId);
        if (link is not null) return Results.Ok(ToDto(link));

        link = new SpaceStoreLink { Id = Guid.NewGuid(), SpaceId = spaceId, FeedSpaceId = request.FeedSpaceId, AttachedBy = me };
        db.SpaceStoreLinks.Add(link);
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            // two attaches raced the check-then-insert: the winner's row is the answer
            db.Entry(link).State = EntityState.Detached;
            link = await db.SpaceStoreLinks.FirstAsync(l => l.SpaceId == spaceId && l.FeedSpaceId == request.FeedSpaceId);
        }
        return Results.Ok(ToDto(link));
    }

    private static async Task<IResult> Detach(string spaceId, string feedSpaceId, AppDbContext db, HttpContext http)
    {
        var role = await RoleAsync(db, spaceId, http.GetUserId());
        if (role is null) return Results.Forbid();
        if (!SpaceRoles.CanWrite(role)) return SpaceRoles.ReadOnly();

        var link = await db.SpaceStoreLinks.FirstOrDefaultAsync(l => l.SpaceId == spaceId && l.FeedSpaceId == feedSpaceId);
        if (link is not null)
        {
            db.SpaceStoreLinks.Remove(link);
            await db.SaveChangesAsync();
        }
        return Results.Ok();
    }

    /// a member who leaves takes the feeds they shared along: the space no longer reads their receipts
    public static async Task RemoveOnLeaveAsync(AppDbContext db, string spaceId, Guid leavingUserId) =>
        db.SpaceStoreLinks.RemoveRange(await db.SpaceStoreLinks.Where(l => l.SpaceId == spaceId && l.AttachedBy == leavingUserId).ToListAsync());

    public static async Task RemoveForSpaceAsync(AppDbContext db, string spaceId, CancellationToken ct = default) =>
        db.SpaceStoreLinks.RemoveRange(await db.SpaceStoreLinks.Where(l => l.SpaceId == spaceId).ToListAsync(ct));

    public static async Task RemoveForFeedAsync(AppDbContext db, string feedSpaceId) =>
        db.SpaceStoreLinks.RemoveRange(await db.SpaceStoreLinks.Where(l => l.FeedSpaceId == feedSpaceId).ToListAsync());

    private static StoreLinkDto ToDto(SpaceStoreLink link) => new(link.SpaceId, link.FeedSpaceId, link.AttachedBy);
}
