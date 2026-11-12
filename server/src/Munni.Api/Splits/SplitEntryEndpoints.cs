using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Splits;

/// <summary>
/// What a split event is made of (#538): expenses somebody paid and the
/// others share in, and payments one member made to another. Every active
/// member adds; an entry is changed or taken back by its author, by the
/// member named as its payer, or by an owner — and by nobody once the
/// event is settled, until an owner reopens it.
/// </summary>
internal static class SplitEntryEndpoints
{
    public static void MapSplitEntries(this RouteGroupBuilder group)
    {
        group.MapPost("/{splitId}/entries", AddAsync);
        group.MapPut("/{splitId}/entries/{entryId}", ChangeAsync);
        group.MapDelete("/{splitId}/entries/{entryId}", DeleteAsync);
        group.MapGet("/{splitId}/entries/{entryId}/receipt", ReceiptAsync);
    }

    private static bool MayChange(SplitEntry entry, SplitMember me) => entry.CreatedBy == me.UserId || entry.PaidByUserId == me.UserId || me.IsOwner();

    /// <summary>An entry as one member sees it: where it came from is its adder's alone to know.</summary>
    public static SplitEntryDto View(SplitEntry entry, SplitMember me, bool open)
    {
        var mine = entry.CreatedBy == me.UserId;
        return new SplitEntryDto(
            entry.Id, entry.Kind, entry.PaidByUserId, entry.Description, entry.AmountCents, entry.Date, entry.ShareMode,
            SplitRules.SharesOf(entry), entry.OriginalCurrency, entry.OriginalCents, entry.HasReceipt,
            mine ? entry.SourceTxId : null, mine ? entry.SourceSpaceId : null, entry.CreatedBy, open && MayChange(entry, me));
    }

    /// <summary>What a request makes of an entry, or why it cannot be one.</summary>
    private static async Task<(SplitEntry? Entry, string? Error)> BuildAsync(AppDbContext db, string splitId, EntryRequest request, SplitMember me, SplitEntry? existing, CancellationToken ct)
    {
        if (SplitRules.EntryError(request) is { } error) return (null, error);
        var members = await SplitStore.ActiveMemberIdsAsync(db, splitId, ct);
        var paidBy = request.PaidByUserId ?? me.UserId;
        if (!members.Contains(paidBy)) return (null, "payer not a member");
        // shares are FROZEN now: who joins later never rewrites what was divided
        var (shares, mode, shareError) = SplitRules.ResolveShares(request, members);
        if (shareError is not null) return (null, shareError);

        var entry = existing ?? new SplitEntry { Id = request.Id, SplitId = splitId, Description = "", Date = "", SharesJson = "[]", CreatedBy = me.UserId };
        entry.Kind = request.Kind;
        entry.PaidByUserId = paidBy;
        entry.Description = request.Description.Trim();
        entry.AmountCents = request.AmountCents;
        entry.Date = request.Date;
        entry.ShareMode = mode;
        entry.SharesJson = JsonSerializer.Serialize(shares);
        entry.OriginalCurrency = request.OriginalCurrency;
        entry.OriginalCents = request.OriginalCurrency is null ? null : request.OriginalCents;
        // the backlink is its author's: somebody else's change of the entry leaves it be
        if (entry.CreatedBy == me.UserId)
        {
            entry.SourceTxId = request.SourceTxId;
            entry.SourceSpaceId = request.SourceTxId is null ? null : request.SourceSpaceId;
        }
        return (entry, null);
    }

    /// <summary>The photo: a picture sets or replaces it, an empty text takes it off, nothing said leaves it.</summary>
    private static async Task KeepReceiptAsync(AppDbContext db, SplitEntry entry, string? receipt, CancellationToken ct)
    {
        if (receipt is null) return;
        var stored = await db.SplitReceipts.FindAsync([entry.Id], ct);
        if (receipt.Length == 0)
        {
            if (stored is not null) db.SplitReceipts.Remove(stored);
            entry.HasReceipt = false;
            return;
        }
        if (stored is null) db.SplitReceipts.Add(new SplitReceipt { EntryId = entry.Id, SplitId = entry.SplitId, Image = receipt });
        else stored.Image = receipt;
        entry.HasReceipt = true;
    }

    private static async Task<IResult> AddAsync(string splitId, EntryRequest request, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        if (!me.IsActive()) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.BadRequest(new { error = "split settled" });
        if (!Validation.ConnectionIds.IsValid(request.Id)) return Results.BadRequest(new { error = "invalid id" });
        if (await db.SplitEntries.AnyAsync(e => e.Id == request.Id, ct)) return Results.Ok(new { id = request.Id }); // idempotent

        var (entry, error) = await BuildAsync(db, splitId, request, me, null, ct);
        if (entry is null) return Results.BadRequest(new { error });
        entry.CreatedAt = time.GetUtcNow();
        db.SplitEntries.Add(entry);
        await KeepReceiptAsync(db, entry, string.IsNullOrEmpty(request.Receipt) ? null : request.Receipt, ct);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = request.Id });
    }

    private static async Task<IResult> ChangeAsync(string splitId, string entryId, EntryRequest request, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var existing = await db.SplitEntries.FirstOrDefaultAsync(e => e.SplitId == splitId && e.Id == entryId, ct);
        if (existing is null) return Results.NotFound();
        if (!me.IsActive() || !MayChange(existing, me)) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.BadRequest(new { error = "split settled" });

        var (entry, error) = await BuildAsync(db, splitId, request with { Id = entryId }, me, existing, ct);
        if (entry is null) return Results.BadRequest(new { error });
        await KeepReceiptAsync(db, entry, request.Receipt, ct);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { id = entryId });
    }

    private static async Task<IResult> DeleteAsync(string splitId, string entryId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var entry = await db.SplitEntries.FirstOrDefaultAsync(e => e.SplitId == splitId && e.Id == entryId, ct);
        if (entry is null) return Results.Ok(); // idempotent
        if (!me.IsActive() || !MayChange(entry, me)) return Results.Forbid();
        if (split.Status != SplitWords.Open) return Results.BadRequest(new { error = "split settled" });
        if (await db.SplitReceipts.FindAsync([entryId], ct) is { } receipt) db.SplitReceipts.Remove(receipt);
        db.SplitEntries.Remove(entry);
        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> ReceiptAsync(string splitId, string entryId, AppDbContext db, HttpContext http, TimeProvider time, CancellationToken ct)
    {
        var (split, me) = await SplitStore.GateAsync(db, splitId, http.GetUserId(), time, ct);
        if (split is null || me is null) return Results.NotFound();
        var receipt = await db.SplitReceipts.FirstOrDefaultAsync(r => r.EntryId == entryId && r.SplitId == splitId, ct);
        return receipt is null ? Results.NotFound() : Results.Ok(new { image = receipt.Image });
    }
}
