using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

// FeedCount (IBAN-keyed feed spaces from bank connections) is counted apart from SpaceCount:
// "3 spaces" would read as three duplicates of one personal space
public sealed record AdminUserDto(Guid Id, string Sub, string? DisplayName, string? Email, DateTimeOffset CreatedAt, int SpaceCount, int FeedCount = 0);

/// <summary>Every route requires the token's `admin` scope; who is an admin is decided in Logto, never here.</summary>
public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/admin").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        // the console probes this first: 200 = admin, 403 = signed in without the scope
        group.MapGet("/ping", () => Results.Ok(new { admin = true }));

        group.MapGet("/users", ListUsers);
        group.MapDelete("/users/{sub}", DeleteUser);
        group.MapGet("/users/{sub}/diagnosis", UserDiagnosis);

        // invitation-only sign-up: the portal's invitations ride the group's scope gate and route guard
        AdminInvitationEndpoints.Map(group);
        AdminBankConnectionEndpoints.Map(group);
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

    private static async Task<IResult> UserDiagnosis(string sub, AppDbContext db)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (user is null) return Results.NotFound();
        return Results.Ok(await AdminDiagnosis.BuildAsync(db, user));
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
