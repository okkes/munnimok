using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>SpaceCount = the spaces the user is a member of; FeedCount = the IBAN-keyed feed spaces a bank connection
/// adds — counted apart, or "3 spaces" reads as three duplicates of one personal space (user report 2026-09-28)</summary>
public sealed record AdminUserDto(Guid Id, string Sub, string? DisplayName, string? Email, DateTimeOffset CreatedAt, int SpaceCount, int FeedCount = 0);
public sealed record AdminFeedDto(string FeedSpaceId, long MaxSeq);
public sealed record AdminAttachmentDto(string SpaceId, string FeedSpaceId, string AccountId);
public sealed record AdminUserDiagnosisDto(
    Guid UserId,
    List<string> MemberSpaces,
    List<AdminFeedDto> OwnedFeeds,
    List<AdminAttachmentDto> Attachments,
    /// <summary>#367: the user's connector sessions as the relay binds them — ids and state, never a bundle;
    /// a bank's consent is one of them (§15)</summary>
    List<Connectors.AdminConnectorSessionDto>? ConnectorSessions = null);

/// <summary>
/// Admin area: user overview, operator-initiated deletion and the per-user
/// sync-chain diagnosis. Every route requires the token's `admin` scope
/// (AdminScope) — who is an admin is decided in Logto, never here. The
/// parties (banks included, §15) are managed under /admin/connectors.
/// </summary>
public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/admin").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        // the console probes this first: 200 = admin, 403 = signed in without the scope
        group.MapGet("/ping", () => Results.Ok(new { admin = true }));

        group.MapGet("/users", ListUsers);
        // operator-initiated removal, same pipeline as the user's own
        // DELETE /me (account-deletion design)
        group.MapDelete("/users/{sub}", DeleteUser);
        group.MapGet("/users/{sub}/diagnosis", UserDiagnosis);
    }

    private static async Task<IResult> ListUsers(AppDbContext db)
    {
        var users = await db.Users.ToListAsync();
        var feedIds = (await db.FeedSpaces.Select(f => f.Id).ToListAsync()).ToHashSet();
        var memberships = await db.SpaceMembers.Select(m => new { m.UserId, m.SpaceId }).ToListAsync();
        var spaces = memberships.Where(m => !feedIds.Contains(m.SpaceId)).GroupBy(m => m.UserId).ToDictionary(g => g.Key, g => g.Count());
        var feeds = memberships.Where(m => feedIds.Contains(m.SpaceId)).GroupBy(m => m.UserId).ToDictionary(g => g.Key, g => g.Count());
        return Results.Ok(users
            .OrderBy(u => u.CreatedAt)
            .Select(u => new AdminUserDto(u.Id, u.Sub, u.DisplayName, u.Email, u.CreatedAt, spaces.GetValueOrDefault(u.Id), feeds.GetValueOrDefault(u.Id)))
            .ToList());
    }

    /// <summary>the whole account→app chain for one user: memberships,
    /// owned feeds (+ op high-water mark), attachments, connector sessions —
    /// diagnosing "the consent linked but the app shows nothing"</summary>
    private static async Task<IResult> UserDiagnosis(string sub, AppDbContext db)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (user is null) return Results.NotFound();
        var memberSpaces = await db.SpaceMembers.Where(m => m.UserId == user.Id).Select(m => m.SpaceId).ToListAsync();
        var ownedFeedIds = await db.FeedSpaces.Where(f => f.OwnerUserId == user.Id).Select(f => f.Id).ToListAsync();
        var maxSeqs = await db.SyncOps
            .Where(o => ownedFeedIds.Contains(o.SpaceId))
            .GroupBy(o => o.SpaceId)
            .Select(g => new { g.Key, Max = g.Max(o => o.Seq) })
            .ToDictionaryAsync(g => g.Key, g => g.Max);
        var attachments = await db.SpaceAccountLinks
            .Where(l => memberSpaces.Contains(l.SpaceId))
            .Select(l => new AdminAttachmentDto(l.SpaceId, l.FeedSpaceId, l.AccountId))
            .ToListAsync();
        return Results.Ok(new AdminUserDiagnosisDto(
            user.Id,
            memberSpaces,
            ownedFeedIds.Select(id => new AdminFeedDto(id, maxSeqs.GetValueOrDefault(id))).ToList(),
            attachments,
            await Connectors.ConnectorAdminEndpoints.SessionsOfAsync(db, user.Id)));
    }

    private static async Task<IResult> DeleteUser(string sub, HttpContext http, AppDbContext db, Social.AccountDeletion deletion)
    {
        var target = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (target is null) return Results.NotFound();
        var self = await db.Users.FindAsync(http.GetUserId());
        if (self?.Sub == sub) return Results.BadRequest(new { error = "cannot delete yourself here" });
        await deletion.DeleteUserAsync(target);
        return Results.Ok(new { deleted = sub });
    }
}
