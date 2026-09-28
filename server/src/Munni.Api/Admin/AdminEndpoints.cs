using Munni.Api.Banking;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.GoCardless;
using Munni.Api.Validation;

namespace Munni.Api.Admin;

/// <summary>SpaceCount = the spaces the user is a member of; FeedCount = the IBAN-keyed feed spaces a bank connection
/// adds — counted apart, or "3 spaces" reads as three duplicates of one personal space (user report 2026-09-28)</summary>
public sealed record AdminUserDto(Guid Id, string Sub, string? DisplayName, string? Email, DateTimeOffset CreatedAt, int SpaceCount, int FeedCount = 0);
public sealed record AdminFeedDto(string FeedSpaceId, long MaxSeq);
public sealed record AdminAttachmentDto(string SpaceId, string FeedSpaceId, string AccountId);
public sealed record AdminGcLinkDto(string GcAccountId, string SpaceId, string AccountEntityId, string Iban, string Provider, DateTimeOffset? LastFetchAt, string RequisitionId);
public sealed record AdminUserDiagnosisDto(
    Guid UserId,
    List<string> MemberSpaces,
    List<AdminFeedDto> OwnedFeeds,
    List<AdminAttachmentDto> Attachments,
    List<AdminGcLinkDto> GcLinks);
public sealed record ProviderQuotaDto(string Provider, string Scope, int? Limit, int? Remaining, DateTimeOffset? ResetAtUtc, DateTimeOffset CapturedAtUtc);
public sealed record AdminRequisitionDto(
    string RequisitionId,
    string Status,
    string InstitutionId,
    DateTimeOffset? Created,
    int AccountCount,
    /// <summary>true when the consent is dead at GoCardless (gone or expired) while THIS environment still records it</summary>
    bool Stale,
    string? OwnerSub,
    /// <summary>another environment's consent on the shared account — the all-environments view only</summary>
    bool Foreign = false,
    /// <summary>origin of the consent's redirect: the environment it was started from</summary>
    string? EnvironmentOrigin = null);

/// <summary>
/// THIS environment's connections only. The GoCardless account is shared
/// by every munni environment (prod/staging/twins), so the remote listing
/// contains foreign consents — they are counted, never listed and never
/// deletable from here (a staging admin once saw prod's healthy consents
/// flagged "stale" with a working delete button — a cross-environment
/// foot-gun, 2026-08-27).
/// </summary>
public sealed record AdminRequisitionListDto(List<AdminRequisitionDto> Requisitions, int ForeignCount);

/// <summary>
/// Admin area: user overview + GoCardless requisition management (list
/// everything GC knows about, delete selected ones to free the free-tier
/// connection quota). Every route requires the token's `admin` scope
/// (AdminScope) — who is an admin is decided in Logto, never here.
/// </summary>
public static class AdminEndpoints
{
    public static void MapAdmin(this IEndpointRouteBuilder app, bool goCardlessEnabled, bool bankingEnabled)
    {
        var group = app.MapGroup("/admin").RequireAuthorization(AdminScope.Policy).WithSafeRouteParams();

        // the console probes this first: 200 = admin, 403 = signed in without the scope
        group.MapGet("/ping", () => Results.Ok(new { admin = true, gocardless = goCardlessEnabled, banking = bankingEnabled }));

        group.MapGet("/users", ListUsers);
        // operator-initiated removal, same pipeline as the user's own
        // DELETE /me (account-deletion design)
        group.MapDelete("/users/{sub}", DeleteUser);
        group.MapGet("/users/{sub}/diagnosis", UserDiagnosis);
        group.MapGet("/quota", GetQuota);

        if (!goCardlessEnabled) return;
        group.MapGet("/gocardless/requisitions", ListRequisitions);
        group.MapDelete("/gocardless/requisitions/{requisitionId}", DeleteRequisition);
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
    /// owned feeds (+ op high-water mark), attachments, gc links —
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
        var gcLinks = await db.GcRequisitions
            .Where(r => r.UserId == user.Id)
            .Join(db.GcLinkedAccounts, r => r.Id, a => a.RequisitionId,
                // RequisitionId = the PROVIDER's consent id, matching what
                // the Bank connections panel lists — names the consent that
                // actually carries this account (safe-to-delete question)
                (r, a) => new AdminGcLinkDto(a.GcAccountId, a.SpaceId, a.AccountEntityId, a.Iban, a.Provider, a.LastFetchAt, r.RequisitionId))
            .ToListAsync();
        return Results.Ok(new AdminUserDiagnosisDto(
            user.Id,
            memberSpaces,
            ownedFeedIds.Select(id => new AdminFeedDto(id, maxSeqs.GetValueOrDefault(id))).ToList(),
            attachments,
            gcLinks));
    }

    private static async Task<IResult> DeleteUser(
        string sub,
        HttpContext http,
        AppDbContext db,
        IConfiguration config,
        IHttpClientFactory httpFactory,
        ILoggerFactory loggerFactory)
    {
        var target = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (target is null) return Results.NotFound();
        var self = await db.Users.FindAsync(http.GetUserId());
        if (self?.Sub == sub) return Results.BadRequest(new { error = "cannot delete yourself here" });
        var gc = http.RequestServices.GetService<IGoCardlessApi>();
        await Social.AccountDeletion.DeleteUserAsync(db, gc, httpFactory, config, loggerFactory.CreateLogger("AccountDeletion"), target);
        return Results.Ok(new { deleted = sub });
    }

    /// <summary>this environment's consents, each asked at ITS provider; with all=true every other environment's
    /// consent on the shared GoCardless account joins the list, attributed by its redirect origin — so leftovers of
    /// removed environments can be cleaned up from any admin (user 2026-09-28)</summary>
    private static async Task<IResult> ListRequisitions(AppDbContext db, IGoCardlessApi gc, BankProviderRegistry registry, bool all = false)
    {
        var remote = await gc.ListRequisitionsAsync();
        var local = await db.GcRequisitions.ToListAsync();
        var owners = await db.Users.ToDictionaryAsync(u => u.Id, u => u.Sub);
        var remoteById = remote.ToDictionary(r => r.Id);
        var localIds = local.Select(l => l.RequisitionId).ToHashSet();
        var eb = registry.Find(EnableBankingApi.Id);
        var requisitions = new List<AdminRequisitionDto>();
        // interrupted journeys can re-use a consent — one row per consent
        foreach (var l in local.GroupBy(l => l.RequisitionId).Select(g => g.OrderByDescending(l => l.CreatedAt).First()))
        {
            requisitions.Add(l.Provider == EnableBankingApi.Id
                ? await EnableBankingRowAsync(l, eb, owners)
                : GoCardlessRow(l, remoteById.GetValueOrDefault(l.RequisitionId), owners));
        }
        if (all)
        {
            requisitions.AddRange(remote.Where(r => !localIds.Contains(r.Id)).Select(r => new AdminRequisitionDto(
                r.Id, r.Status, r.InstitutionId, r.Created, r.Accounts.Count, Stale: r.Status == "EX", OwnerSub: null,
                Foreign: true, EnvironmentOrigin: OriginOf(r.Redirect))));
        }
        return Results.Ok(new AdminRequisitionListDto(
            requisitions.OrderByDescending(d => d.Created).ToList(),
            ForeignCount: remote.Count(r => !localIds.Contains(r.Id))));
    }

    private static AdminRequisitionDto GoCardlessRow(GcRequisition l, GcRequisitionListItem? r, Dictionary<Guid, string> owners) =>
        new(l.RequisitionId, r?.Status ?? "gone", l.InstitutionId, r?.Created ?? l.CreatedAt, r?.Accounts.Count ?? 0,
            // dead at the provider while we still track it
            Stale: r is null || r.Status == "EX",
            OwnerSub: owners.GetValueOrDefault(l.UserId));

    /// <summary>an Enable Banking session is asked at Enable Banking — the GoCardless listing knows nothing of it, and
    /// looking it up there showed every EB connection as "gone" and stale (user report, nas prod 2026-09-28)</summary>
    private static async Task<AdminRequisitionDto> EnableBankingRowAsync(GcRequisition l, IBankDataApi? eb, Dictionary<Guid, string> owners)
    {
        var status = "gone";
        var accounts = 0;
        if (eb is not null)
        {
            try
            {
                var session = await eb.CompleteAuthAsync(l.RequisitionId, null);
                status = session.Status;
                accounts = session.Accounts.Count;
            }
            catch (HttpRequestException)
            {
                // the session is unknown or refused at the provider: dead, like a GoCardless requisition it no longer lists
            }
        }
        return new AdminRequisitionDto(l.RequisitionId, status, l.InstitutionId, l.CreatedAt, accounts,
            Stale: status is "gone" or "EX" or "EXPIRED" or "REVOKED" or "CLOSED",
            OwnerSub: owners.GetValueOrDefault(l.UserId));
    }

    private static string? OriginOf(string? redirect) =>
        Uri.TryCreate(redirect, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Authority) : null;

    private static async Task<IResult> DeleteRequisition(string requisitionId, AppDbContext db, IGoCardlessApi gc, BankProviderRegistry registry, bool foreign = false)
    {
        var local = await db.GcRequisitions.FirstOrDefaultAsync(r => r.RequisitionId == requisitionId);
        if (local is null)
        {
            // NEVER touch a consent this environment doesn't own by accident — the GC account is shared, and deleting
            // here would revoke another environment's live bank connection. Only an EXPLICIT foreign=true (the portal's
            // all-environments view, confirmed by the operator) removes the leftover of a removed environment.
            if (!foreign) return Results.NotFound(new { error = "not this environment's connection — manage it from its own admin, or from the all-environments view here" });
            await gc.DeleteRequisitionAsync(requisitionId);
            return Results.Ok(new { deleted = requisitionId, foreign = true });
        }
        // the provider that created the consent revokes it — an Enable Banking session is not a GoCardless requisition
        var provider = registry.Find(local.Provider);
        if (provider is not null) await provider.DeleteRequisitionAsync(requisitionId); // frees the provider's connection slot
        var linked = await db.GcLinkedAccounts.Where(a => a.RequisitionId == local.Id).ToListAsync();
        db.GcLinkedAccounts.RemoveRange(linked); // stops scheduled fetching
        db.GcRequisitions.RemoveRange(await db.GcRequisitions.Where(r => r.RequisitionId == requisitionId).ToListAsync());
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    // /admin/bank-provider retired (#175): the END USER picks the
    // provider at connect time, so there is no admin-selected "active"
    // provider anymore — existing accounts keep the one that created them.

    /// <summary>latest provider rate-limit snapshots (AD3), captured from
    /// normal sync traffic — the console shows remaining/reset per scope.
    /// Shared with /control/quota: the snapshots describe the SHARED
    /// provider account, so both consoles serve the identical payload</summary>
    internal static async Task<IResult> GetQuota(AppDbContext db)
    {
        var rows = await db.ProviderQuotas.OrderBy(q => q.Provider).ThenBy(q => q.Scope).ToListAsync();
        return Results.Ok(rows
            .Select(q => new ProviderQuotaDto(q.Provider, q.Scope, q.Limit, q.Remaining, q.ResetAtUtc, q.CapturedAtUtc))
            .ToList());
    }
}
