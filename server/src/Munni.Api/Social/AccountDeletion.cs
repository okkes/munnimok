using System.Net;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Social;

/// Order matters: external bank access first (most sensitive), then server data, then the Logto identity, the user row last.
/// Party/Logto failures are logged and never block the deletion; the connector service is optional.
public sealed class AccountDeletion(
    AppDbContext db,
    ILogtoManagement logto,
    IConfiguration config,
    ILogger<AccountDeletion> logger,
    Connectors.ConnectorDisconnector? connectors = null)
{
    public async Task DeleteUserAsync(User user, bool deleteIdentity = true)
    {
        // a scheduled fetch can never resurrect the rows mid-delete
        if (connectors is not null) await connectors.DisconnectAllAsync(user.Id);

        db.PushSubscriptions.RemoveRange(await db.PushSubscriptions.Where(s => s.UserId == user.Id).ToListAsync());

        // shared spaces leave-and-archive, so other members keep readable history
        var survivingSpaceIds = await LeaveOrDeleteSpacesAsync(db, user.Id);

        // 4 · bank feeds: one someone else still covers lives on — a co-owner's own
        //     consent, or a surviving shared space that reads it (decision ①); the rest go
        await LeaveFeedsAsync(db, user.Id, survivingSpaceIds);

        db.Friendships.RemoveRange(await db.Friendships.Where(f => f.UserAId == user.Id || f.UserBId == user.Id).ToListAsync());
        db.SpaceInvites.RemoveRange(await db.SpaceInvites.Where(i => i.ToUserId == user.Id || i.FromUserId == user.Id).ToListAsync());

        // the person leaves each split but stays in its arithmetic
        await LeaveSplitsAsync(db, user.Id);

        // optional: without the M2M credential the server data still disappears. Go-offline conversions (deleteIdentity=false)
        // keep the identity in every environment: the login survives, a later online sign-in provisions a fresh account
        if (deleteIdentity) await DeleteLogtoUserAsync(logto, config, logger, user.Sub);

        // the user row last: a retry after any partial failure can re-enter
        db.Users.Remove(user);
        await db.SaveChangesAsync();
    }

    private static async Task LeaveSplitsAsync(AppDbContext db, Guid userId)
    {
        db.SplitJoinRequests.RemoveRange(await db.SplitJoinRequests.Where(r => r.UserId == userId).ToListAsync());
        db.SplitFriendInvites.RemoveRange(await db.SplitFriendInvites.Where(i => i.ToUserId == userId || i.FromUserId == userId).ToListAsync());
        var now = DateTimeOffset.UtcNow;
        foreach (var mine in await db.SplitMembers.Where(m => m.UserId == userId && m.State == Splits.SplitWords.Active).ToListAsync())
        {
            await Splits.SplitStore.LeaveAsync(db, mine, now, CancellationToken.None);
        }
    }

    private static async Task<List<string>> LeaveOrDeleteSpacesAsync(AppDbContext db, Guid userId)
    {
        var memberships = await db.SpaceMembers.Where(m => m.UserId == userId).ToListAsync();
        var memberOf = memberships.Select(m => m.SpaceId).ToList();
        var feedIds = (await db.FeedSpaces.Where(f => memberOf.Contains(f.Id)).Select(f => f.Id).ToListAsync()).ToHashSet();
        var survivingSpaceIds = new List<string>();
        foreach (var membership in memberships)
        {
            // a feed's owner is its member too, often its only one: who else uses the feed decides in LeaveFeedsAsync
            if (feedIds.Contains(membership.SpaceId)) continue;
            var others = await db.SpaceMembers
                .Where(m => m.SpaceId == membership.SpaceId && m.UserId != userId)
                .ToListAsync();
            if (others.Count == 0)
            {
                await DeleteSpaceDataAsync(db, membership.SpaceId);
                continue;
            }
            survivingSpaceIds.Add(membership.SpaceId);
            db.SpaceMembers.Remove(membership);
            await Accounts.AccountEndpoints.ArchiveLinksOnLeaveAsync(db, membership.SpaceId, userId);
            await Accounts.StoreLinkEndpoints.RemoveOnLeaveAsync(db, membership.SpaceId, userId);
            // never leave a space ownerless (same rule as a manual leave)
            if (SpaceRoles.IsOwner(membership.Role) && !others.Any(m => m.Role == SpaceRoles.Owner))
            {
                var successor = others.OrderBy(m => m.UserId).First();
                successor.Role = SpaceRoles.Owner;
            }
        }
        return survivingSpaceIds;
    }

    private static async Task LeaveFeedsAsync(AppDbContext db, Guid userId, List<string> survivingSpaceIds)
    {
        var coOwned = await db.FeedOwners.Where(o => o.UserId == userId).Select(o => o.FeedSpaceId).ToListAsync();
        var feeds = await db.FeedSpaces.Where(f => f.OwnerUserId == userId || coOwned.Contains(f.Id)).ToListAsync();
        foreach (var feed in feeds)
        {
            var successor = (await db.FeedOwners.FirstOrDefaultAsync(o => o.FeedSpaceId == feed.Id && o.UserId != userId))?.UserId;
            var stillRead = await db.SpaceAccountLinks
                .AnyAsync(l => l.FeedSpaceId == feed.Id && survivingSpaceIds.Contains(l.SpaceId));
            if (feed.OwnerUserId == userId && successor is null && !stillRead)
            {
                await EraseFeedAsync(db, feed);
                continue;
            }

            db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == userId).ToListAsync());
            db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == feed.Id && m.UserId == userId).ToListAsync());
            if (feed.OwnerUserId == userId && successor is Guid next) await HandFeedOverAsync(db, feed, next);
        }
    }

    private static async Task EraseFeedAsync(AppDbContext db, Accounts.FeedSpace feed)
    {
        db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.FeedSpaceId == feed.Id).ToListAsync());
        await Accounts.StoreLinkEndpoints.RemoveForFeedAsync(db, feed.Id);
        await DeleteSpaceDataAsync(db, feed.Id);
        db.FeedSpaces.Remove(feed);
    }

    /// <summary>the co-owner's own consent keeps fetching: the feed is theirs to write from here on</summary>
    private static async Task HandFeedOverAsync(AppDbContext db, Accounts.FeedSpace feed, Guid next)
    {
        feed.OwnerUserId = next;
        db.FeedOwners.RemoveRange(await db.FeedOwners.Where(o => o.FeedSpaceId == feed.Id && o.UserId == next).ToListAsync());
        var member = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == feed.Id && m.UserId == next);
        if (member is null) db.SpaceMembers.Add(new SpaceMember { SpaceId = feed.Id, UserId = next, Role = SpaceRoles.Owner });
        else member.Role = SpaceRoles.Owner;
    }

    private static async Task DeleteSpaceDataAsync(AppDbContext db, string spaceId)
    {
        db.EntityRows.RemoveRange(await db.EntityRows.Where(r => r.SpaceId == spaceId).ToListAsync());
        db.SyncOps.RemoveRange(await db.SyncOps.Where(o => o.SpaceId == spaceId).ToListAsync());
        db.SpaceInvites.RemoveRange(await db.SpaceInvites.Where(i => i.SpaceId == spaceId).ToListAsync());
        db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.SpaceId == spaceId).ToListAsync());
        await Accounts.StoreLinkEndpoints.RemoveForSpaceAsync(db, spaceId);
        db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == spaceId).ToListAsync());
        var space = await db.Spaces.FindAsync(spaceId);
        if (space is not null) db.Spaces.Remove(space);
    }

    /// Logto's user id IS the OIDC sub; one minting path (ILogtoManagement) shared with the admin portal's invitations.
    /// Config: Logto:M2mAppId + Logto:M2mAppSecret; the endpoint derives from Auth:Authority.
    internal static async Task DeleteLogtoUserAsync(ILogtoManagement logto, IConfiguration config, ILogger logger, string sub)
    {
        // staging shares the Logto instance with production: deleting the identity there would lock the person out of production too
        if (!config.GetValue("Logto:DeleteIdentityOnAccountDeletion", true))
        {
            if (logger.IsEnabled(LogLevel.Information))
                logger.LogInformation("account deletion: identity deletion disabled in this environment — {Sub} kept at Logto", sub);
            return;
        }
        try
        {
            var session = await logto.ConnectAsync(CancellationToken.None);
            if (session is null)
            {
                if (logger.IsEnabled(LogLevel.Information))
                    logger.LogInformation("account deletion: Logto M2M not configured — identity {Sub} left for manual cleanup", sub);
                return;
            }

            using var deleteRequest = session.Request(HttpMethod.Delete, $"/api/users/{Uri.EscapeDataString(sub)}");
            using var deleteResponse = await session.Http.SendAsync(deleteRequest);
            if (!deleteResponse.IsSuccessStatusCode && deleteResponse.StatusCode != HttpStatusCode.NotFound)
                logger.LogWarning("account deletion: Logto delete for {Sub} answered {Status}", sub, deleteResponse.StatusCode);
        }
        catch (Exception ex)
        {
            // never blocks the deletion: the server data is gone either way, the identity is cleaned up by hand
            logger.LogWarning(ex, "account deletion: Logto delete failed for {Sub}", sub);
        }
    }
}
