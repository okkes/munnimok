using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;
using Munni.Api.GoCardless;

namespace Munni.Api.Social;

/// <summary>
/// Full account cleanup (account-deletion design, approved decisions:
/// shared spaces = leave-and-archive, immediate, Logto via M2M).
/// Order matters: external bank access first (most sensitive), then
/// server data, then the Logto identity, and the user row last.
/// Bank/Logto failures are logged and never block the deletion.
/// </summary>
public static class AccountDeletion
{
    public static async Task DeleteUserAsync(
        AppDbContext db,
        IGoCardlessApi? gc,
        IHttpClientFactory httpFactory,
        IConfiguration config,
        ILogger logger,
        User user)
    {
        // 1 · revoke bank consents at the provider (GoCardless supports
        //     deletion; Enable Banking sessions expire on their own)
        var requisitions = await db.GcRequisitions.Where(r => r.UserId == user.Id).ToListAsync();
        foreach (var requisition in requisitions.Where(r => r.Provider == "gocardless"))
        {
            try
            {
                if (gc is not null) await gc.DeleteRequisitionAsync(requisition.RequisitionId);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "account deletion: could not revoke requisition {Id}", requisition.RequisitionId);
            }
        }
        var requisitionIds = requisitions.Select(r => r.Id).ToList();
        db.GcLinkedAccounts.RemoveRange(await db.GcLinkedAccounts.Where(a => requisitionIds.Contains(a.RequisitionId)).ToListAsync());
        db.GcRequisitions.RemoveRange(requisitions);

        // 2 · push subscriptions — no notification survives its user
        db.PushSubscriptions.RemoveRange(await db.PushSubscriptions.Where(s => s.UserId == user.Id).ToListAsync());

        // 3 · spaces: sole member → hard delete; shared → leave-and-archive
        //     (decision ①: other members keep readable history)
        var memberships = await db.SpaceMembers.Where(m => m.UserId == user.Id).ToListAsync();
        var survivingSpaceIds = new List<string>();
        foreach (var membership in memberships)
        {
            var others = await db.SpaceMembers
                .Where(m => m.SpaceId == membership.SpaceId && m.UserId != user.Id)
                .ToListAsync();
            if (others.Count == 0)
            {
                await DeleteSpaceDataAsync(db, membership.SpaceId);
            }
            else
            {
                survivingSpaceIds.Add(membership.SpaceId);
                db.SpaceMembers.Remove(membership);
                await Accounts.AccountEndpoints.ArchiveLinksOnLeaveAsync(db, membership.SpaceId, user.Id);
                // never leave a space ownerless (same rule as a manual leave)
                if (SpaceRoles.IsOwner(membership.Role) && !others.Any(m => m.Role == SpaceRoles.Owner))
                {
                    var successor = others.OrderBy(m => m.UserId).First();
                    successor.Role = SpaceRoles.Owner;
                }
            }
        }

        // 4 · owned bank feeds: keep the ones surviving shared spaces still
        //     read (their archived history stays, decision ①); delete the rest
        var feedSpaces = await db.FeedSpaces.Where(f => f.OwnerUserId == user.Id).ToListAsync();
        foreach (var feed in feedSpaces)
        {
            var stillRead = await db.SpaceAccountLinks
                .AnyAsync(l => l.FeedSpaceId == feed.Id && survivingSpaceIds.Contains(l.SpaceId));
            if (stillRead) continue;
            db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.FeedSpaceId == feed.Id).ToListAsync());
            await DeleteSpaceDataAsync(db, feed.Id);
            db.FeedSpaces.Remove(feed);
        }

        // 5 · social graph + grants
        db.Friendships.RemoveRange(await db.Friendships.Where(f => f.UserAId == user.Id || f.UserBId == user.Id).ToListAsync());
        db.SpaceInvites.RemoveRange(await db.SpaceInvites.Where(i => i.ToUserId == user.Id || i.FromUserId == user.Id).ToListAsync());
        db.AdminGrants.RemoveRange(await db.AdminGrants.Where(g => g.Sub == user.Sub).ToListAsync());

        // 6 · the Logto identity (kills the login + other sessions). Optional:
        //     without the M2M credential the server data still disappears.
        await DeleteLogtoUserAsync(httpFactory, config, logger, user.Sub);

        // 7 · the user row last — a retry after any partial failure can re-enter
        db.Users.Remove(user);
        await db.SaveChangesAsync();
    }

    /// <summary>space/feed erasure: state, oplog, invites, links, cursor row</summary>
    private static async Task DeleteSpaceDataAsync(AppDbContext db, string spaceId)
    {
        db.EntityRows.RemoveRange(await db.EntityRows.Where(r => r.SpaceId == spaceId).ToListAsync());
        db.SyncOps.RemoveRange(await db.SyncOps.Where(o => o.SpaceId == spaceId).ToListAsync());
        db.SpaceInvites.RemoveRange(await db.SpaceInvites.Where(i => i.SpaceId == spaceId).ToListAsync());
        db.SpaceAccountLinks.RemoveRange(await db.SpaceAccountLinks.Where(l => l.SpaceId == spaceId).ToListAsync());
        db.SpaceMembers.RemoveRange(await db.SpaceMembers.Where(m => m.SpaceId == spaceId).ToListAsync());
        var space = await db.Spaces.FindAsync(spaceId);
        if (space is not null) db.Spaces.Remove(space);
    }

    /// <summary>
    /// Logto Management API: client-credentials token for the M2M app,
    /// then DELETE /api/users/{sub} (Logto's user id IS the OIDC sub).
    /// Config: Logto:M2mAppId + Logto:M2mAppSecret; the endpoint derives
    /// from Auth:Authority (…/oidc).
    /// </summary>
    private static async Task DeleteLogtoUserAsync(IHttpClientFactory httpFactory, IConfiguration config, ILogger logger, string sub)
    {
        var appId = config["Logto:M2mAppId"];
        var appSecret = config["Logto:M2mAppSecret"];
        var authority = config["Auth:Authority"]; // https://logto.…/oidc
        if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(appSecret) || string.IsNullOrEmpty(authority))
        {
            logger.LogInformation("account deletion: Logto M2M not configured — identity {Sub} left for manual cleanup", sub);
            return;
        }
        try
        {
            var endpoint = authority.TrimEnd('/');
            if (endpoint.EndsWith("/oidc")) endpoint = endpoint[..^"/oidc".Length];
            var http = httpFactory.CreateClient("logto-m2m");

            using var tokenRequest = new HttpRequestMessage(HttpMethod.Post, $"{endpoint}/oidc/token");
            tokenRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{appId}:{appSecret}")));
            tokenRequest.Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["resource"] = "https://default.logto.app/api",
                ["scope"] = "all",
            });
            var tokenResponse = await http.SendAsync(tokenRequest);
            tokenResponse.EnsureSuccessStatusCode();
            using var tokenJson = System.Text.Json.JsonDocument.Parse(await tokenResponse.Content.ReadAsStringAsync());
            var accessToken = tokenJson.RootElement.GetProperty("access_token").GetString();

            using var deleteRequest = new HttpRequestMessage(HttpMethod.Delete, $"{endpoint}/api/users/{Uri.EscapeDataString(sub)}");
            deleteRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
            var deleteResponse = await http.SendAsync(deleteRequest);
            if (!deleteResponse.IsSuccessStatusCode && deleteResponse.StatusCode != System.Net.HttpStatusCode.NotFound)
                logger.LogWarning("account deletion: Logto delete for {Sub} answered {Status}", sub, deleteResponse.StatusCode);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "account deletion: Logto delete failed for {Sub}", sub);
        }
    }
}
