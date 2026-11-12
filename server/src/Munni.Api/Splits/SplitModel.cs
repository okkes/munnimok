using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Splits;

/// <summary>One member's part of an entry: the cents always, the percentage when that is how it was given.</summary>
public sealed record SplitShareDto(Guid UserId, long Cents, decimal? Pct = null);

public sealed record SplitMemberDto(Guid UserId, string Role, string State, string? DisplayName, string? Picture, bool IsMe);

public sealed record SplitEntryDto(
    string Id, string Kind, Guid PaidByUserId, string Description, long AmountCents, string Date, string ShareMode,
    List<SplitShareDto> Shares, string? OriginalCurrency, long? OriginalCents, bool HasReceipt,
    /// <summary>the adder's private backlink — only serialized for them</summary>
    string? SourceTxId, string? SourceSpaceId, Guid CreatedBy, bool CanEdit);

public sealed record SplitPaymentDto(Guid Id, Guid FromUserId, Guid ToUserId, long AmountCents, DateTimeOffset? PaidAt);

public sealed record SplitRequestDto(Guid Id, Guid UserId, string? DisplayName, string? Picture, DateTimeOffset CreatedAt);

public sealed record SplitFriendInviteDto(Guid Id, Guid ToUserId, string? DisplayName, string? Picture, string Status, DateTimeOffset CreatedAt);

public sealed record SplitLinkDto(string? Token, DateTimeOffset? ExpiresAt, int MaxUses, int Uses, bool NeedsApproval);

public sealed record SplitSummaryDto(
    string Id, string Name, string Currency, string Status, string Role, string State,
    string? Picture, string? StartDate, string? EndDate,
    string? AttachedSpaceId, string? AttachedEventId, int MemberCount, int EntryCount,
    /// <summary>what the event cost: its expenses together, in its currency</summary>
    long TotalCents,
    /// <summary>where the caller stands: owed (+) or owing (−)</summary>
    long MyBalanceCents,
    DateTimeOffset? DeleteAt);

public sealed record SplitDetailDto(
    SplitSummaryDto Split, List<SplitMemberDto> Members, List<SplitEntryDto> Entries, List<SplitPaymentDto> Payments,
    /// <summary>owners only: who waits to be let in, and whom they asked</summary>
    List<SplitRequestDto>? Requests, List<SplitFriendInviteDto>? FriendInvites);

public sealed record SplitFactsRequest(string Name, string Currency, string? Picture, string? StartDate, string? EndDate);

public sealed record CreateSplitRequest(string Id, string Name, string Currency, string? SpaceId, string? Picture = null, string? StartDate = null, string? EndDate = null)
{
    public SplitFactsRequest Facts => new(Name, Currency, Picture, StartDate, EndDate);
}

public sealed record AcceptInviteRequest(string? SpaceId);
public sealed record AttachRequest(string? SpaceId, string? EventId);
public sealed record NewLinkRequest(int? MaxUses, bool? NeedsApproval, int? ValidDays);
public sealed record FriendInviteRequest(Guid ToUserId);
public sealed record PaidRequest(bool Paid);

public sealed record EntryRequest(
    string Id, string Kind, Guid? PaidByUserId, string Description, long AmountCents, string Date,
    List<SplitShareDto>? Shares, string? SourceTxId, string? ShareMode = null, string? OriginalCurrency = null,
    long? OriginalCents = null, string? Receipt = null, string? SourceSpaceId = null);

/// <summary>The words the split tables store, and the questions every endpoint asks of a membership.</summary>
internal static class SplitWords
{
    public const string Owner = "owner";
    public const string Contributor = "contributor";
    public const string Active = "active";
    public const string Left = "left";
    public const string Removed = "removed";
    public const string Open = "open";
    public const string Settled = "settled";
    public const string Archived = "archived";
    public const string Pending = "pending";
    public const string Expense = "expense";
    public const string Payment = "settlement";

    public static bool IsActive(this SplitMember member) => member.State == Active;
    public static bool IsOwner(this SplitMember member) => member.State == Active && member.Role == Owner;
}

internal static class SplitRules
{
    /// <summary>A picture is one of the app's own covers (a path) or an uploaded one, downscaled, as a data URL; the cap keeps a list of events light.</summary>
    public const int MaxPictureLength = 600_000;

    private static bool IsPicture(string picture) =>
        picture.StartsWith("data:image/", StringComparison.Ordinal) || (picture.StartsWith("/events/", StringComparison.Ordinal) && picture.Length <= 64);
    /// <summary>A receipt photo is stored as the app took it (2048 px JPEG).</summary>
    public const int MaxReceiptLength = 3_000_000;
    public static readonly TimeSpan DeleteCountdown = TimeSpan.FromDays(7);

    public static bool IsDay(string? value) =>
        value is not null && DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    public static bool IsCurrency(string? value) => value is { Length: 3 } && value.All(c => c is >= 'A' and <= 'Z');

    /// <summary>What is wrong with an event's facts, or null.</summary>
    public static string? FactsError(SplitFactsRequest facts)
    {
        if (string.IsNullOrWhiteSpace(facts.Name) || facts.Name.Length > 60) return "invalid name";
        if (!IsCurrency(facts.Currency)) return "invalid currency";
        if (facts.Picture is { } picture && (picture.Length > MaxPictureLength || !IsPicture(picture))) return "invalid picture";
        if ((facts.StartDate is not null && !IsDay(facts.StartDate)) || (facts.EndDate is not null && !IsDay(facts.EndDate))) return "invalid dates";
        if (facts.StartDate is not null && facts.EndDate is not null && string.CompareOrdinal(facts.EndDate, facts.StartDate) < 0) return "ends before it starts";
        return null;
    }

    public static void Apply(Split split, SplitFactsRequest facts)
    {
        split.Name = facts.Name.Trim();
        split.Picture = facts.Picture;
        split.StartDate = facts.StartDate;
        split.EndDate = facts.EndDate;
    }

    public static List<SplitShareDto> SharesOf(SplitEntry entry) => JsonSerializer.Deserialize<List<SplitShareDto>>(entry.SharesJson) ?? [];

    /// <summary>equal division; remainder cents land on the lowest user ids (deterministic)</summary>
    public static List<SplitShareDto> EqualShares(long amountCents, IEnumerable<Guid> members)
    {
        var ordered = members.Distinct().OrderBy(m => m).ToList();
        var basis = amountCents / ordered.Count;
        var remainder = amountCents % ordered.Count;
        return [.. ordered.Select((userId, index) => new SplitShareDto(userId, basis + (index < remainder ? 1 : 0)))];
    }

    /// <summary>
    /// Percentages as cents: each share rounded down, the cents that leaves handed to the largest remainders —
    /// the shares add up to the amount whatever the percentages do to it.
    /// </summary>
    public static List<SplitShareDto> PercentShares(long amountCents, IReadOnlyList<SplitShareDto> given)
    {
        var exact = given.Select(s => amountCents * (s.Pct ?? 0m) / 100m).ToList();
        var cents = exact.Select(e => (long)Math.Floor(e)).ToList();
        var left = amountCents - cents.Sum();
        foreach (var index in Enumerable.Range(0, given.Count).OrderByDescending(i => exact[i] - cents[i]).ThenBy(i => given[i].UserId))
        {
            if (left <= 0) break;
            cents[index] += 1;
            left -= 1;
        }
        return [.. given.Select((s, i) => new SplitShareDto(s.UserId, cents[i], s.Pct))];
    }

    /// <summary>The shares an entry stores — frozen now, so who joins later never rewrites what was divided.</summary>
    public static (List<SplitShareDto> Shares, string Mode, string? Error) ResolveShares(EntryRequest request, IReadOnlyCollection<Guid> members)
    {
        var given = request.Shares ?? [];
        if (given.Any(s => !members.Contains(s.UserId))) return ([], "", "share holder not a member");
        if (given.Select(s => s.UserId).Distinct().Count() != given.Count) return ([], "", "a member twice");
        switch (request.ShareMode)
        {
            case "percent":
                if (given.Count == 0 || given.Any(s => s.Pct is null or < 0) || given.Sum(s => s.Pct ?? 0m) != 100m) return ([], "", "percentages must add up to 100");
                return (PercentShares(request.AmountCents, given), "percent", null);
            case "exact":
                if (given.Count == 0 || given.Any(s => s.Cents < 0) || given.Sum(s => s.Cents) != request.AmountCents) return ([], "", "shares must add up");
                return ([.. given.Select(s => new SplitShareDto(s.UserId, s.Cents))], "exact", null);
            default:
                // no mode named: exact amounts when cents were given (the old client), else equal among the named members — everybody when none is named
                if (given.Any(s => s.Cents != 0)) return ResolveShares(request with { ShareMode = "exact" }, members);
                return (EqualShares(request.AmountCents, given.Count > 0 ? given.Select(s => s.UserId) : members), "equal", null);
        }
    }

    /// <summary>What is wrong with an entry before its shares are looked at, or null.</summary>
    public static string? EntryError(EntryRequest request)
    {
        if (request.AmountCents <= 0 || string.IsNullOrWhiteSpace(request.Description) || request.Description.Length > 120) return "invalid entry";
        if (request.Kind is not (SplitWords.Expense or SplitWords.Payment)) return "invalid kind";
        if (!IsDay(request.Date)) return "invalid date";
        if (request.OriginalCurrency is not null && (!IsCurrency(request.OriginalCurrency) || request.OriginalCents is null or <= 0)) return "invalid original amount";
        // an empty text is the word for "take the photo off"
        if (request.Receipt is { Length: > 0 } photo && (photo.Length > MaxReceiptLength || !photo.StartsWith("data:image/", StringComparison.Ordinal))) return "invalid receipt";
        return null;
    }
}

/// <summary>What every split endpoint reads first: the event and the caller's place in it.</summary>
internal static class SplitStore
{
    /// <summary>
    /// The single authorization gate: an event exists only for those with a membership row (404 for everyone
    /// else, never 403). Someone who left or was removed still reads it — they may owe or be owed. An event
    /// whose deletion countdown ran out is gone the moment anyone looks.
    /// </summary>
    public static async Task<(Split? Split, SplitMember? Me)> GateAsync(AppDbContext db, string splitId, Guid userId, TimeProvider time, CancellationToken ct)
    {
        var me = await db.SplitMembers.FirstOrDefaultAsync(m => m.SplitId == splitId && m.UserId == userId, ct);
        if (me is null) return (null, null);
        var split = await db.Splits.FindAsync([splitId], ct);
        if (split is null) return (null, null);
        if (split.DeleteAt is { } due && due <= time.GetUtcNow())
        {
            await DeleteAsync(db, splitId, ct);
            return (null, null);
        }
        return (split, me);
    }

    /// <summary>Everything an event holds goes with it.</summary>
    public static async Task DeleteAsync(AppDbContext db, string splitId, CancellationToken ct)
    {
        db.SplitReceipts.RemoveRange(await db.SplitReceipts.Where(r => r.SplitId == splitId).ToListAsync(ct));
        db.SplitEntries.RemoveRange(await db.SplitEntries.Where(e => e.SplitId == splitId).ToListAsync(ct));
        db.SplitPayments.RemoveRange(await db.SplitPayments.Where(p => p.SplitId == splitId).ToListAsync(ct));
        db.SplitInvites.RemoveRange(await db.SplitInvites.Where(i => i.SplitId == splitId).ToListAsync(ct));
        db.SplitJoinRequests.RemoveRange(await db.SplitJoinRequests.Where(r => r.SplitId == splitId).ToListAsync(ct));
        db.SplitFriendInvites.RemoveRange(await db.SplitFriendInvites.Where(i => i.SplitId == splitId).ToListAsync(ct));
        db.SplitMembers.RemoveRange(await db.SplitMembers.Where(m => m.SplitId == splitId).ToListAsync(ct));
        if (await db.Splits.FindAsync([splitId], ct) is { } split) db.Splits.Remove(split);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Out of the event, as someone who left or was taken out: they stay in the arithmetic, without a role.</summary>
    public static void Gone(SplitMember member, string state, DateTimeOffset now)
    {
        member.State = state;
        member.Role = SplitWords.Contributor;
        member.LeftAt = now;
    }

    /// <summary>
    /// A member goes of their own accord. The last owner to go hands the event to everybody who stays, and the
    /// last member to go takes the event with them — true then.
    /// </summary>
    public static async Task<bool> LeaveAsync(AppDbContext db, SplitMember me, DateTimeOffset now, CancellationToken ct)
    {
        var others = await db.SplitMembers.Where(m => m.SplitId == me.SplitId && m.UserId != me.UserId && m.State == SplitWords.Active).ToListAsync(ct);
        if (others.Count == 0)
        {
            await DeleteAsync(db, me.SplitId, ct);
            return true;
        }
        if (me.Role == SplitWords.Owner && others.All(m => m.Role != SplitWords.Owner))
        {
            foreach (var member in others) member.Role = SplitWords.Owner;
        }
        Gone(me, SplitWords.Left, now);
        await db.SaveChangesAsync(ct);
        return false;
    }

    public static Task<List<Guid>> ActiveMemberIdsAsync(AppDbContext db, string splitId, CancellationToken ct) =>
        db.SplitMembers.Where(m => m.SplitId == splitId && m.State == SplitWords.Active).Select(m => m.UserId).ToListAsync(ct);

    public static async Task<string?> NameOfAsync(AppDbContext db, Guid userId, CancellationToken ct) =>
        (await db.Users.FindAsync([userId], ct))?.DisplayName;

    /// <summary>What everybody stands at, from the event's entries.</summary>
    public static Dictionary<Guid, long> Balances(IEnumerable<SplitEntry> entries) =>
        SplitSettlement.Balances(entries.Select(e => (e.PaidByUserId, e.AmountCents, (IReadOnlyList<SplitShareDto>)SplitRules.SharesOf(e))));

    public static SplitSummaryDto Summary(Split split, SplitMember me, int memberCount, IReadOnlyCollection<SplitEntry> entries) =>
        new(split.Id, split.Name, split.Currency, split.Status, me.Role, me.State, split.Picture,
            split.StartDate, split.EndDate, me.AttachedSpaceId, me.AttachedEventId, memberCount, entries.Count,
            entries.Where(e => e.Kind == SplitWords.Expense).Sum(e => e.AmountCents),
            Balances(entries).GetValueOrDefault(me.UserId), split.DeleteAt);
}
