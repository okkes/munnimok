using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Banking;
using Munni.Api.Data;
using Munni.Api.GoCardless;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

public sealed record AdminUserDto(Guid Id, string Sub, string? DisplayName, string? Email, DateTimeOffset CreatedAt, int SpaceCount);
public sealed record BankProviderChoice(string Provider);
public sealed record AdminRequisitionDto(
    string RequisitionId,
    string Status,
    string InstitutionId,
    DateTimeOffset? Created,
    int AccountCount,
    /// <summary>true when munni has no local record — a stale leftover at GoCardless</summary>
    bool Stale,
    string? OwnerSub);

/// <summary>
/// Admin area: user overview + GoCardless requisition management (list
/// everything GC knows about, delete selected ones to free the free-tier
/// connection quota). Gated on Admin:Subs (comma-separated OIDC subs).
/// </summary>
public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app, bool goCardlessEnabled, bool bankingEnabled)
    {
        var group = app.MapGroup("/admin").RequireAuthorization().WithSafeRouteParams();

        group.MapGet("/ping", async (HttpContext http, AppDbContext db, IConfiguration config) =>
            await IsAdminAsync(http, db, config)
                ? Results.Ok(new { admin = true, gocardless = goCardlessEnabled, banking = bankingEnabled })
                : Results.Forbid());

        if (bankingEnabled) MapBankProvider(group);

        group.MapGet("/users", async (HttpContext http, AppDbContext db, IConfiguration config) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            var users = await db.Users.ToListAsync();
            var counts = await db.SpaceMembers.GroupBy(m => m.UserId)
                .Select(g => new { g.Key, Count = g.Count() }).ToDictionaryAsync(x => x.Key, x => x.Count);
            return Results.Ok(users
                .OrderBy(u => u.CreatedAt)
                .Select(u => new AdminUserDto(u.Id, u.Sub, u.DisplayName, u.Email, u.CreatedAt, counts.GetValueOrDefault(u.Id)))
                .ToList());
        });

        if (!goCardlessEnabled) return;

        group.MapGet("/gocardless/requisitions", async (HttpContext http, AppDbContext db, IConfiguration config, IGoCardlessApi gc) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            var remote = await gc.ListRequisitionsAsync();
            var local = await db.GcRequisitions.ToListAsync();
            var owners = await db.Users.ToDictionaryAsync(u => u.Id, u => u.Sub);
            var localByRemoteId = local.ToDictionary(l => l.RequisitionId);
            return Results.Ok(remote
                .OrderByDescending(r => r.Created)
                .Select(r =>
                {
                    var known = localByRemoteId.GetValueOrDefault(r.Id);
                    return new AdminRequisitionDto(
                        r.Id, r.Status, r.InstitutionId, r.Created, r.Accounts.Count,
                        Stale: known is null,
                        OwnerSub: known is null ? null : owners.GetValueOrDefault(known.UserId));
                })
                .ToList());
        });

        group.MapDelete("/gocardless/requisitions/{requisitionId}", async (string requisitionId, HttpContext http, AppDbContext db, IConfiguration config, IGoCardlessApi gc) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            await gc.DeleteRequisitionAsync(requisitionId); // frees the GC connection slot
            var local = await db.GcRequisitions.FirstOrDefaultAsync(r => r.RequisitionId == requisitionId);
            if (local is not null)
            {
                var linked = await db.GcLinkedAccounts.Where(a => a.RequisitionId == local.Id).ToListAsync();
                db.GcLinkedAccounts.RemoveRange(linked); // stops scheduled fetching
                db.GcRequisitions.Remove(local);
                await db.SaveChangesAsync();
            }
            return Results.Ok();
        });
    }

    /// <summary>which provider serves NEW bank consents (user request) —
    /// existing accounts keep the provider that created them</summary>
    private static void MapBankProvider(IEndpointRouteBuilder group)
    {
        group.MapGet("/bank-provider", async (HttpContext http, AppDbContext db, IConfiguration config, BankProviderRegistry registry) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            return Results.Ok(new { active = await registry.ActiveIdAsync(db), configured = registry.ConfiguredIds });
        });

        group.MapPut("/bank-provider", async (BankProviderChoice choice, HttpContext http, AppDbContext db, IConfiguration config, BankProviderRegistry registry) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            return await registry.SetActiveAsync(db, choice.Provider)
                ? Results.Ok(new { active = choice.Provider })
                : Results.BadRequest(new { error = "provider not configured" });
        });
    }

    private static async Task<bool> IsAdminAsync(HttpContext http, AppDbContext db, IConfiguration config)
    {
        var adminSubs = (config["Admin:Subs"] ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (adminSubs.Length == 0) return false;
        var user = await db.Users.FindAsync(http.GetUserId());
        return user is not null && adminSubs.Contains(user.Sub);
    }
}
