using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Push;
using Munni.Api.Validation;

namespace Munni.Api.Splits;

/// <summary>
/// Split events (#538): a group ledger whose membership is INDEPENDENT of
/// spaces — a member sees the event and nothing else, a space membership
/// grants nothing here. Online-only and server-resident by design: roles,
/// "settled" and the count of a link's uses are rules one place must keep.
/// The event and its members live here; invitations, entries and settling
/// each have a file of their own.
/// </summary>
public static class SplitsEndpoints
{
    public static void MapSplits(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/splits").RequireAuthorization().WithSafeRouteParams();
        group.MapGet("", ListAsync);
        group.MapPost("", CreateAsync);
        group.MapGet("/{splitId}", GetAsync);
        group.MapPut("/{splitId}", UpdateAsync);
        // (re)wire MY OWN attachment — space and/or event
        group.MapPost("/{splitId}/attach", AttachAsync);
        group.MapPost("/{splitId}/leave", LeaveAsync);
        group.MapPost("/{splitId}/members/{userId:guid}/promote", PromoteAsync).RequireRateLimiting(Social.SocialEndpoints.MutationsPolicy);
        group.MapDelete("/{splitId}/members/{userId:guid}", RemoveMemberAsync).RequireRateLimiting(Social.SocialEndpoints.MutationsPolicy);
        group.MapSplitInvites();
        group.MapSplitEntries();
        group.MapSplitSettling();
    }

    private static async Task<IResult> ListAsync(AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var me = http.GetUserId();
        var mine = await db.SplitMembers.Where(m => m.UserId == me).ToListAsync(ct);
        var ids = mine.Select(m => m.SplitId).ToList();
        var splits = await db.Splits.Where(s => ids.Contains(s.Id)).ToListAsync(ct);
        // an event whose deletion countdown ran out is gone the moment anyone looks
        var now = time.GetUtcNow();
        foreach (var due in splits.Where(s => s.DeleteAt <= now).ToList())
        {
            await SplitStore.DeleteAsync(db, due.Id, ct);
            splits.Remove(due);
        }

        var live = splits.Select(s => s.Id).ToList();
        var memberCounts = await db.SplitMembers.Where(m => live.Contains(m.SplitId) && m.State == SplitWords.Active)
            .GroupBy(m => m.SplitId).Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        var entries = (await db.SplitEntries.Where(e => live.Contains(e.SplitId)).ToListAsync(ct)).ToLookup(e => e.SplitId);
        return Results.Ok(splits
            .OrderByDescending(s => s.CreatedAt)
            .Select(s => SplitStore.Summary(s, mine.First(m => m.SplitId == s.Id), memberCounts.GetValueOrDefault(s.Id), [.. entries[s.Id]]))
            .ToList());
    }

    private static async Task<IResult> CreateAsync(CreateSplitRequest request, AppDbContext db, HttpContext http, CancellationToken ct)
    {
        var me = http.GetUserId();
        if (!ConnectionIds.IsValid(request.Id)) return Results.BadRequest(new { error = "invalid id" });
        if (SplitRules.FactsError(request.Facts) is { } error) return Results.BadRequest(new { error });
        if (await db.Splits.AnyAsync(s => s.Id == request.Id, ct)) return Results.Ok(new { id = request.Id }); // idempotent

        var split = new Split { Id = request.Id, Name = request.Name, Currency = request.Currency, CreatedBy = me };
        SplitRules.Apply(split, request.Facts);
        db.Splits.Add(split);
        db.SplitMembers.Add(new SplitMember { SplitId = request.Id, UserId = me, Role = SplitWords.Owner, AttachedSpaceId = request.SpaceId });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = request.Id });
    }

    /// <summary>Owners change what the event is called and how it looks; its currency only while nothing was entered in it.</summary>
    private static async Task<IResult> UpdateAsync(string splitId, SplitFactsRequest request, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status == SplitWords.Archived) return Results.BadRequest(new { error = "split archived" });
        if (SplitRules.FactsError(request) is { } error) return Results.BadRequest(new { error });
        if (request.Currency != split.Currency)
        {
            if (await db.SplitEntries.AnyAsync(e => e.SplitId == splitId, ct)) return Results.BadRequest(new { error = "currency is fixed" });
            split.Currency = request.Currency;
        }
        SplitRules.Apply(split, request);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = splitId });
    }

    private static async Task<IResult> GetAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();

        var members = await db.SplitMembers.Where(m => m.SplitId == splitId).OrderBy(m => m.JoinedAt).ToListAsync(ct);
        var entries = await db.SplitEntries.Where(e => e.SplitId == splitId).OrderByDescending(e => e.Date).ThenByDescending(e => e.CreatedAt).ToListAsync(ct);
        var payments = await db.SplitPayments.Where(p => p.SplitId == splitId).OrderByDescending(p => p.AmountCents).ToListAsync(ct);
        var requests = me.IsOwner() ? await db.SplitJoinRequests.Where(r => r.SplitId == splitId && r.Status == SplitWords.Pending).OrderBy(r => r.CreatedAt).ToListAsync(ct) : null;
        var asked = me.IsOwner() ? await db.SplitFriendInvites.Where(i => i.SplitId == splitId && i.Status != "cancelled").OrderByDescending(i => i.CreatedAt).ToListAsync(ct) : null;

        var people = members.Select(m => m.UserId)
            .Concat(requests?.Select(r => r.UserId) ?? [])
            .Concat(asked?.Select(i => i.ToUserId) ?? [])
            .Distinct().ToList();
        var users = await db.Users.Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, ct);
        string? Name(Guid id) => users.GetValueOrDefault(id)?.DisplayName;
        string? Face(Guid id) => users.GetValueOrDefault(id)?.Picture;

        var open = split.Status == SplitWords.Open && me.IsActive();
        return Results.Ok(new SplitDetailDto(
            SplitStore.Summary(split, me, members.Count(m => m.IsActive()), entries),
            [.. members.Select(m => new SplitMemberDto(m.UserId, m.Role, m.State, Name(m.UserId), Face(m.UserId), m.UserId == me.UserId))],
            [.. entries.Select(e => SplitEntryEndpoints.View(e, me, open))],
            [.. payments.Select(p => new SplitPaymentDto(p.Id, p.FromUserId, p.ToUserId, p.AmountCents, p.PaidAt))],
            requests?.Select(r => new SplitRequestDto(r.Id, r.UserId, Name(r.UserId), Face(r.UserId), r.CreatedAt)).ToList(),
            asked?.Select(i => new SplitFriendInviteDto(i.Id, i.ToUserId, Name(i.ToUserId), Face(i.ToUserId), i.Status, i.CreatedAt)).ToList()));
    }

    /// <summary>per-member wiring: the caller updates only THEIR membership row; the server stores the ids blindly —
    /// they are meaningful only inside the member's own local database</summary>
    private static async Task<IResult> AttachAsync(string splitId, AttachRequest request, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (request.SpaceId is not null) me.AttachedSpaceId = request.SpaceId;
        me.AttachedEventId = request.EventId; // null clears the link
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { spaceId = me.AttachedSpaceId, eventId = me.AttachedEventId });
    }

    /// <summary>
    /// Anyone may leave, owing or not: they stay in the arithmetic as someone who left. The last owner to go
    /// hands the event to everybody who stays, and the last member to go takes the event with them.
    /// </summary>
    private static async Task<IResult> LeaveAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var deleted = me.IsActive() && await SplitStore.LeaveAsync(db, me, time.GetUtcNow(), ct);
        return Results.Ok(new { id = splitId, deleted });
    }

    private static async Task<IResult> PromoteAsync(string splitId, Guid userId, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        var member = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == splitId && m.UserId == userId && m.State == SplitWords.Active, ct);
        if (member is null) return Results.NotFound();
        if (member.Role != SplitWords.Owner)
        {
            member.Role = SplitWords.Owner;
            await db.SaveChangesAsync(ct);
            await push.NotifySplitAsync([userId], "made-owner", split, await SplitStore.NameOfAsync(db, me.UserId, ct), null, ct);
        }
        return Results.Ok(new { id = splitId });
    }

    /// <summary>An owner takes someone out — a contributor or another owner (user); oneself leaves instead.</summary>
    private static async Task<IResult> RemoveMemberAsync(string splitId, Guid userId, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (userId == me.UserId) return Results.BadRequest(new { error = "leave instead" });
        var member = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == splitId && m.UserId == userId && m.State == SplitWords.Active, ct);
        if (member is null) return Results.Ok(new { id = splitId });
        SplitStore.Gone(member, SplitWords.Removed, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        await push.NotifySplitAsync([userId], "removed", split, await SplitStore.NameOfAsync(db, me.UserId, ct), null, ct);
        return Results.Ok(new { id = splitId });
    }
}
