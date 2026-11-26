using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Sync;
using Munni.Api.Validation;

namespace Munni.Api.Accounts;

public sealed record RegisterFeedRequest(string FeedSpaceId, string AccountRef);
public sealed record RegisterFeedResponse(string FeedSpaceId, bool Owned);
/// HistoryFrom is required, never silently unlimited; Type is the space's pick, else the account row's own type
public sealed record AttachAccountRequest(string FeedSpaceId, string AccountId, string HistoryFrom, string? Type = null);
public sealed record AccountLinkDto(
    Guid Id,
    string SpaceId,
    string FeedSpaceId,
    string AccountId,
    Guid AttachedBy,
    string HistoryFrom,
    string Type,
    bool Archived,
    string? AttachedByName = null);
public sealed record MyFeedDto(string FeedSpaceId, string AccountRef);

/// the ONLY way a feed space is born (closes deterministic-id squatting, security S1);
/// attachments derive members' read access
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
        // delete one financial account: my consent always, the feed itself
        // only when nobody else covers it (FeedDeletion has the ruling)
        group.MapDelete("/me/feeds/{feedSpaceId}", FeedDeletion.DeleteFeedAccount);
    }

    private static async Task<IResult> RegisterFeed(RegisterFeedRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (!FeedAccess.IsFeedShaped(request.FeedSpaceId))
            return Results.BadRequest(new { error = "not a feed-shaped id" });

        var existing = await db.FeedSpaces.FindAsync(request.FeedSpaceId);
        if (existing is not null)
        {
            if (existing.OwnerUserId == me)
                return Results.Ok(new RegisterFeedResponse(existing.Id, true));

            // an ORPHANED feed (owner row gone) is claimable, else re-importing after a wipe 409s forever on one's own IBAN.
            // a feed with a LIVING other owner stays a conflict, so a squatter never observes another user's data
            var ownerAlive = await db.Users.AnyAsync(u => u.Id == existing.OwnerUserId);
            if (ownerAlive)
                return Results.Conflict(new { error = "feed registered by another user" });

            existing.OwnerUserId = me;
            if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == existing.Id && m.UserId == me))
                db.SpaceMembers.Add(new SpaceMember { SpaceId = existing.Id, UserId = me, Role = SpaceRoles.Owner });
            await db.SaveChangesAsync();
            return Results.Ok(new RegisterFeedResponse(existing.Id, true));
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
        // #240: co-owned feeds are MINE too — the client sorts everything
        // in this list under "assets", never "shared with me"
        var coOwnedIds = db.FeedOwners.Where(o => o.UserId == me).Select(o => o.FeedSpaceId);
        var known = feeds.Select(f => f.FeedSpaceId).ToHashSet();
        var coOwned = await db.FeedSpaces.Where(f => coOwnedIds.Contains(f.Id))
            .Select(f => new MyFeedDto(f.Id, f.AccountRef))
            .ToListAsync();
        feeds.AddRange(coOwned.Where(f => !known.Contains(f.FeedSpaceId)));
        return Results.Ok(feeds);
    }

    private static async Task<IResult> ListLinks(string spaceId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        if (!await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == me)) return Results.Forbid();
        var links = await db.SpaceAccountLinks.Where(l => l.SpaceId == spaceId).ToListAsync();
        var attacherIds = links.Select(l => l.AttachedBy).Distinct().ToList();
        var names = await db.Users.Where(u => attacherIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName);
        return Results.Ok(links.Select(l => ToDto(l, names.GetValueOrDefault(l.AttachedBy))).ToList());
    }

    private static async Task<IResult> Attach(string spaceId, AttachAccountRequest request, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        if (myRole is null) return Results.Forbid();
        if (!SpaceRoles.CanWrite(myRole)) return SpaceRoles.ReadOnly();
        if (!await FeedAccess.IsFeedOwner(db, me, request.FeedSpaceId))
            return Results.Forbid();

        // #212: the link's type is the SPACE's fact about the account: the caller's pick, else the row's own,
        // decided once so every copy of the link carries it; #536: a type the feeding party states is nobody's to pick
        var stated = await PartyTypeRepair.StatedTypeAsync(db, request.FeedSpaceId, request.AccountId);
        var type = stated ?? request.Type ?? await AccountTypeAsync(db, request.FeedSpaceId, request.AccountId);

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
                Type = type,
            };
            db.SpaceAccountLinks.Add(link);
        }
        else
        {
            // re-attach: the owner reconnecting revives an archived link
            // and re-states its gate; the type moves only on an explicit pick
            link.Archived = false;
            link.ArchivedAtSeq = null;
            link.AttachedBy = me;
            link.HistoryFrom = request.HistoryFrom;
            if ((stated ?? request.Type) is { } wanted) link.Type = wanted;
        }
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            // two attaches raced the check-then-insert (double-tapped import, 23505): adopt the winner's row instead of a 500
            db.Entry(link).State = Microsoft.EntityFrameworkCore.EntityState.Detached;
            link = await db.SpaceAccountLinks.FirstAsync(l =>
                l.SpaceId == spaceId && l.FeedSpaceId == request.FeedSpaceId && l.AccountId == request.AccountId);
        }
        return Results.Ok(ToDto(link));
    }

    private static AccountLinkDto ToDto(SpaceAccountLink link, string? attachedByName = null) =>
        new(link.Id, link.SpaceId, link.FeedSpaceId, link.AccountId, link.AttachedBy, link.HistoryFrom, link.Type, link.Archived, attachedByName);

    private static async Task<string> AccountTypeAsync(AppDbContext db, string feedSpaceId, string accountId)
    {
        var row = await db.EntityRows.FirstOrDefaultAsync(r =>
            r.SpaceId == feedSpaceId && r.Entity == "account" && r.EntityId == accountId && !r.Deleted);
        if (row is null) return AccountTypes.Default;
        using var data = JsonDocument.Parse(row.DataJson);
        return data.RootElement.TryGetProperty("type", out var type)
               && type.ValueKind == JsonValueKind.String
               && type.GetString() is { } known
               && AccountTypes.All.Contains(known)
            ? known
            : AccountTypes.Default;
    }

    private static async Task<IResult> Detach(string spaceId, Guid linkId, AppDbContext db, HttpContext http)
    {
        var me = http.GetUserId();
        var myRole = (await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me))?.Role;
        if (myRole is null) return Results.Forbid();
        if (!SpaceRoles.CanWrite(myRole)) return SpaceRoles.ReadOnly();

        var link = await db.SpaceAccountLinks.FirstOrDefaultAsync(l => l.Id == linkId && l.SpaceId == spaceId);
        if (link is not null)
        {
            db.SpaceAccountLinks.Remove(link);
            await db.SaveChangesAsync();
        }
        return Results.Ok();
    }

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
        // remaining members' devices learn the state through the synced mirror row; without this op the archived badge never renders
        await WriteMirrorOpsAsync(db, spaceId, links, archived: true);
    }

    public static async Task ReviveLinksOnJoinAsync(AppDbContext db, string spaceId, Guid joiningUserId)
    {
        var ownedFeeds = db.FeedSpaces.Where(f => f.OwnerUserId == joiningUserId).Select(f => f.Id);
        var links = await db.SpaceAccountLinks
            .Where(l => l.SpaceId == spaceId && l.Archived && l.AttachedBy == joiningUserId && ownedFeeds.Contains(l.FeedSpaceId))
            .ToListAsync();
        if (links.Count == 0) return;
        foreach (var link in links)
        {
            link.Archived = false;
            link.ArchivedAtSeq = null;
        }
        await WriteMirrorOpsAsync(db, spaceId, links, archived: false);
    }

    /// completes the mirror with the link's gate and type when it lacks them, but never re-asserts a held fact
    /// (#305: a re-minted historyFrom out-HLC'd the real one and ratcheted the gate forward, hiding shared history)
    private static async Task WriteMirrorOpsAsync(AppDbContext db, string spaceId, List<SpaceAccountLink> links, bool archived)
    {
        var space = await db.Spaces.FindAsync(spaceId);
        if (space is null) return;
        var mirrorIds = links.Select(l => ImportIds.AccountLinkId(spaceId, l.FeedSpaceId)).ToList();
        var mirrors = await db.EntityRows
            .Where(r => r.SpaceId == spaceId && r.Entity == "accountLink" && mirrorIds.Contains(r.EntityId))
            .ToDictionaryAsync(r => r.EntityId);
        var counter = 0;
        var ops = new List<SyncOpDto>();
        foreach (var link in links)
        {
            var entityId = ImportIds.AccountLinkId(spaceId, link.FeedSpaceId);
            var fields = new Dictionary<string, JsonElement>
            {
                ["feedSpaceId"] = Json(link.FeedSpaceId),
                ["accountId"] = Json(link.AccountId),
                ["archived"] = Json(archived ? 1 : 0),
            };
            var present = MirrorFields(mirrors.GetValueOrDefault(entityId));
            if (!present.Contains("historyFrom")) fields["historyFrom"] = Json(link.HistoryFrom);
            if (!present.Contains("type")) fields["type"] = Json(link.Type);
            ops.Add(new SyncOpDto(
                ImportIds.OpId($"linkstate:{spaceId}:{link.FeedSpaceId}:{archived}:{DateTime.UtcNow.Ticks}"),
                spaceId,
                "accountLink",
                entityId,
                fields,
                ServerHlc.Now(counter++)));
        }
        await new SyncWriter(db).ApplyAsync(space, null, ops);
    }

    private static HashSet<string> MirrorFields(EntityRow? mirror)
    {
        if (mirror is null || mirror.Deleted) return [];
        using var data = JsonDocument.Parse(mirror.DataJson);
        if (data.RootElement.ValueKind != JsonValueKind.Object) return [];
        return data.RootElement.EnumerateObject()
            .Where(p => p.Value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined)
            .Select(p => p.Name)
            .ToHashSet();
    }

    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
}
