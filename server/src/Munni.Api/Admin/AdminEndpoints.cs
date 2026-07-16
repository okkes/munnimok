using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Banking;
using Munni.Api.Data;
using Munni.Api.GoCardless;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

public sealed record AdminUserDto(Guid Id, string Sub, string? DisplayName, string? Email, DateTimeOffset CreatedAt, int SpaceCount, bool IsAdmin, bool Bootstrap);
public sealed record BankProviderChoice(string Provider);
public sealed record AdminGrantDto(string Sub, string GrantedBySub, DateTimeOffset GrantedAtUtc, bool Bootstrap);
public sealed record ProviderQuotaDto(string Provider, string Scope, int? Limit, int? Remaining, DateTimeOffset? ResetAtUtc, DateTimeOffset CapturedAtUtc);
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
            var bootstrap = BootstrapSubs(config);
            var granted = (await db.AdminGrants.Select(g => g.Sub).ToListAsync()).ToHashSet();
            return Results.Ok(users
                .OrderBy(u => u.CreatedAt)
                .Select(u => new AdminUserDto(
                    u.Id, u.Sub, u.DisplayName, u.Email, u.CreatedAt, counts.GetValueOrDefault(u.Id),
                    IsAdmin: bootstrap.Contains(u.Sub) || granted.Contains(u.Sub),
                    Bootstrap: bootstrap.Contains(u.Sub)))
                .ToList());
        });

        MapAdminGrants(group);
        MapQuota(group);

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

    /// <summary>grant/revoke admin from the console (AD2): the env list
    /// stays as un-demotable bootstrap; grants live in the database</summary>
    private static void MapAdminGrants(IEndpointRouteBuilder group)
    {
        group.MapGet("/admins", async (HttpContext http, AppDbContext db, IConfiguration config) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            var grants = await db.AdminGrants.OrderBy(g => g.GrantedAtUtc).ToListAsync();
            var list = BootstrapSubs(config)
                .Select(sub => new AdminGrantDto(sub, "env", DateTimeOffset.MinValue, Bootstrap: true))
                .Concat(grants.Select(g => new AdminGrantDto(g.Sub, g.GrantedBySub, g.GrantedAtUtc, Bootstrap: false)))
                .ToList();
            return Results.Ok(list);
        });

        group.MapPost("/admins/{sub}", async (string sub, HttpContext http, AppDbContext db, IConfiguration config) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            if (!await db.Users.AnyAsync(u => u.Sub == sub)) return Results.NotFound(new { error = "no such user" });
            if (BootstrapSubs(config).Contains(sub) || await db.AdminGrants.AnyAsync(g => g.Sub == sub))
                return Results.Ok(new { granted = sub }); // idempotent
            var granter = await db.Users.FindAsync(http.GetUserId());
            db.AdminGrants.Add(new AdminGrant { Id = Guid.NewGuid(), Sub = sub, GrantedBySub = granter?.Sub ?? "unknown" });
            await db.SaveChangesAsync();
            return Results.Ok(new { granted = sub });
        });

        group.MapDelete("/admins/{sub}", async (string sub, HttpContext http, AppDbContext db, IConfiguration config) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            // env-bootstrap admins are the emergency access — not demotable here
            if (BootstrapSubs(config).Contains(sub)) return Results.BadRequest(new { error = "bootstrap admin" });
            var self = await db.Users.FindAsync(http.GetUserId());
            // you cannot demote yourself: guards against locking the last admin out
            if (self?.Sub == sub) return Results.BadRequest(new { error = "cannot demote yourself" });
            var grant = await db.AdminGrants.FirstOrDefaultAsync(g => g.Sub == sub);
            if (grant is not null)
            {
                db.AdminGrants.Remove(grant);
                await db.SaveChangesAsync();
            }
            return Results.Ok(new { revoked = sub });
        });
    }

    /// <summary>latest provider rate-limit snapshots (AD3), captured from
    /// normal sync traffic — the console shows remaining/reset per scope</summary>
    private static void MapQuota(IEndpointRouteBuilder group)
    {
        group.MapGet("/quota", async (HttpContext http, AppDbContext db, IConfiguration config) =>
        {
            if (!await IsAdminAsync(http, db, config)) return Results.Forbid();
            var rows = await db.ProviderQuotas.OrderBy(q => q.Provider).ThenBy(q => q.Scope).ToListAsync();
            return Results.Ok(rows
                .Select(q => new ProviderQuotaDto(q.Provider, q.Scope, q.Limit, q.Remaining, q.ResetAtUtc, q.CapturedAtUtc))
                .ToList());
        });
    }

    private static HashSet<string> BootstrapSubs(IConfiguration config) =>
        (config["Admin:Subs"] ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToHashSet();

    private static async Task<bool> IsAdminAsync(HttpContext http, AppDbContext db, IConfiguration config)
    {
        var user = await db.Users.FindAsync(http.GetUserId());
        if (user is null) return false;
        if (BootstrapSubs(config).Contains(user.Sub)) return true;
        return await db.AdminGrants.AnyAsync(g => g.Sub == user.Sub);
    }
}
