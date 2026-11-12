using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Push;

namespace Munni.Api.Splits;

/// <summary>
/// How a split event ends (#538). Anyone in it may look at what settling
/// would ask of everybody. An owner SETTLES: the fewest payments that bring
/// everyone to zero become the plan, nothing can be added any more, and
/// everybody is told what they pay or get. The payments happen outside
/// munni; payer, receiver or an owner mark them paid, and the last one
/// archives the event. An owner may reopen (what was marked paid stays as
/// payments made), archive at any time, or delete — with a countdown while
/// others are still in it.
/// </summary>
internal static class SplitSettleEndpoints
{
    public static void MapSplitSettling(this RouteGroupBuilder group)
    {
        group.MapGet("/{splitId}/settlement", PreviewAsync);
        group.MapPost("/{splitId}/settle", SettleAsync).RequireRateLimiting(Social.SocialEndpoints.MutationsPolicy);
        group.MapPost("/{splitId}/reopen", ReopenAsync);
        group.MapPost("/{splitId}/payments/{paymentId:guid}/paid", PaidAsync);
        group.MapPost("/{splitId}/archive", ArchiveAsync);
        group.MapPost("/{splitId}/delete", DeleteAsync).RequireRateLimiting(Social.SocialEndpoints.MutationsPolicy);
        group.MapDelete("/{splitId}/delete", KeepAsync);
    }

    private static async Task<List<SettlementPayment>> PlanAsync(AppDbContext db, string splitId, CancellationToken ct) =>
        SplitSettlement.Plan(SplitStore.Balances(await db.SplitEntries.Where(e => e.SplitId == splitId).ToListAsync(ct)));

    /// <summary>The look ahead: who would pay whom if the event were settled as it stands.</summary>
    private static async Task<IResult> PreviewAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var plan = await PlanAsync(db, splitId, ct);
        return Results.Ok(plan.Select(p => new { fromUserId = p.From, toUserId = p.To, amountCents = p.Cents }).ToList());
    }

    /// <summary>Nobody gets in any more: the link, the queue and the unanswered invitations end with the event's running.</summary>
    private static async Task CloseDoorsAsync(AppDbContext db, string splitId, TimeProvider time, CancellationToken ct)
    {
        db.SplitInvites.RemoveRange(await db.SplitInvites.Where(i => i.SplitId == splitId).ToListAsync(ct));
        foreach (var waiting in await db.SplitJoinRequests.Where(r => r.SplitId == splitId && r.Status == SplitWords.Pending).ToListAsync(ct))
        {
            waiting.Status = "refused";
            waiting.AnsweredAt = time.GetUtcNow();
        }
        foreach (var asked in await db.SplitFriendInvites.Where(i => i.SplitId == splitId && i.Status == SplitWords.Pending).ToListAsync(ct))
        {
            asked.Status = "cancelled";
            asked.AnsweredAt = time.GetUtcNow();
        }
    }

    private static void Archive(Split split, TimeProvider time)
    {
        split.Status = SplitWords.Archived;
        split.ArchivedAt = time.GetUtcNow();
    }

    private static async Task<IResult> SettleAsync(string splitId, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.Ok(new { id = splitId, status = split.Status });

        var entries = await db.SplitEntries.Where(e => e.SplitId == splitId).ToListAsync(ct);
        var balances = SplitStore.Balances(entries);
        var plan = SplitSettlement.Plan(balances);
        split.SettledAt = time.GetUtcNow();
        split.Status = SplitWords.Settled;
        // everybody already at zero: there is nothing to pay, so nothing to wait for
        if (plan.Count == 0) Archive(split, time);
        db.SplitPayments.AddRange(plan.Select(p => new SplitPayment { Id = Guid.NewGuid(), SplitId = splitId, FromUserId = p.From, ToUserId = p.To, AmountCents = p.Cents }));
        await CloseDoorsAsync(db, splitId, time, ct);
        await db.SaveChangesAsync(ct);

        // each is told their own figure: what they get (+) or pay (−); someone who left is told too
        var owner = await SplitStore.NameOfAsync(db, me.UserId, ct);
        foreach (var member in await db.SplitMembers.Where(m => m.SplitId == splitId && m.UserId != me.UserId).Select(m => m.UserId).ToListAsync(ct))
        {
            await push.NotifySplitAsync([member], "settled", split, owner, balances.GetValueOrDefault(member), ct);
        }
        return Results.Ok(new { id = splitId, status = split.Status });
    }

    /// <summary>
    /// Back to running: what was marked paid stays as payments the members made to each other, the rest of the
    /// plan is dropped — settling again works out what is left.
    /// </summary>
    private static async Task<IResult> ReopenAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Settled) return Results.BadRequest(new { error = "not settled" });

        var payments = await db.SplitPayments.Where(p => p.SplitId == splitId).ToListAsync(ct);
        foreach (var paid in payments.Where(p => p.PaidAt is not null))
        {
            db.SplitEntries.Add(new SplitEntry
            {
                Id = $"pay_{paid.Id:N}",
                SplitId = splitId,
                Kind = SplitWords.Payment,
                PaidByUserId = paid.FromUserId,
                Description = "settlement",
                AmountCents = paid.AmountCents,
                Date = paid.PaidAt!.Value.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                ShareMode = "exact",
                SharesJson = JsonSerializer.Serialize(new List<SplitShareDto> { new(paid.ToUserId, paid.AmountCents) }),
                CreatedBy = paid.FromUserId,
                CreatedAt = time.GetUtcNow(),
            });
        }
        db.SplitPayments.RemoveRange(payments);
        split.Status = SplitWords.Open;
        split.SettledAt = null;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = splitId, status = split.Status });
    }

    /// <summary>The payer, the receiver or an owner says a payment was made (or was not after all); the last one paid archives the event.</summary>
    private static async Task<IResult> PaidAsync(string splitId, Guid paymentId, PaidRequest request, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time)
    {
        var ct = http.RequestAborted;
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var payment = await db.SplitPayments.FirstOrDefaultAsync(p => p.Id == paymentId && p.SplitId == splitId, ct);
        if (payment is null) return Results.NotFound();
        if (payment.FromUserId != me.UserId && payment.ToUserId != me.UserId && !me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Settled) return Results.BadRequest(new { error = "not settled" });
        if (request.Paid == (payment.PaidAt is not null)) return Results.Ok(new { id = splitId, status = split.Status });

        payment.PaidAt = request.Paid ? time.GetUtcNow() : null;
        var open = await db.SplitPayments.CountAsync(p => p.SplitId == splitId && p.Id != paymentId && p.PaidAt == null, ct);
        if (request.Paid && open == 0) Archive(split, time);
        await db.SaveChangesAsync(ct);
        if (request.Paid)
        {
            var others = new[] { payment.FromUserId, payment.ToUserId }.Where(id => id != me.UserId).ToList();
            await push.NotifySplitAsync(others, "payment-paid", split, await SplitStore.NameOfAsync(db, me.UserId, ct), payment.AmountCents, ct);
        }
        return Results.Ok(new { id = splitId, status = split.Status });
    }

    private static async Task<IResult> ArchiveAsync(string splitId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.Status != SplitWords.Archived)
        {
            Archive(split, time);
            await CloseDoorsAsync(db, splitId, time, ct);
            await db.SaveChangesAsync(ct);
        }
        return Results.Ok(new { id = splitId, status = split.Status });
    }

    /// <summary>
    /// Deleting: alone in the event it goes at once; with others in it a week's countdown starts that any owner
    /// can stop, and everybody is told.
    /// </summary>
    private static async Task<IResult> DeleteAsync(string splitId, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        var others = await db.SplitMembers.Where(m => m.SplitId == splitId && m.UserId != me.UserId && m.State == SplitWords.Active).Select(m => m.UserId).ToListAsync(ct);
        if (others.Count == 0)
        {
            await SplitStore.DeleteAsync(db, splitId, ct);
            return Results.Ok(new { id = splitId, deleted = true, deleteAt = (DateTimeOffset?)null });
        }
        if (split.DeleteAt is null)
        {
            split.DeleteAt = time.GetUtcNow().Add(SplitRules.DeleteCountdown);
            split.DeleteBy = me.UserId;
            await db.SaveChangesAsync(ct);
            await push.NotifySplitAsync(others, "delete-planned", split, await SplitStore.NameOfAsync(db, me.UserId, ct), null, ct);
        }
        return Results.Ok(new { id = splitId, deleted = false, deleteAt = split.DeleteAt });
    }

    private static async Task<IResult> KeepAsync(string splitId, AppDbContext db, PushNotifier push, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsOwner()) return Results.Forbid();
        if (split.DeleteAt is not null)
        {
            split.DeleteAt = null;
            split.DeleteBy = null;
            await db.SaveChangesAsync(ct);
            var others = await db.SplitMembers.Where(m => m.SplitId == splitId && m.UserId != me.UserId && m.State == SplitWords.Active).Select(m => m.UserId).ToListAsync(ct);
            await push.NotifySplitAsync(others, "delete-stopped", split, await SplitStore.NameOfAsync(db, me.UserId, ct), null, ct);
        }
        return Results.Ok(new { id = splitId });
    }
}
