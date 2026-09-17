namespace Munni.Api.Accounts;

/// <summary>
/// Registry of feed spaces (shared-accounts design): a feed holds ONE
/// bank account's raw data and its id is deterministic —
/// uuidv5("feed:" + account ref). Deterministic ids are guessable, so
/// feeds are NEVER created by the generic first-push rule (security
/// review S1); they exist only through this registry, written by the
/// owning flows (bank connect / statement import).
/// </summary>
public class FeedSpace
{
    /// <summary>The feed space id (uuidv5, version-5 shaped).</summary>
    public required string Id { get; set; }

    /// <summary>Who connected/imported this account first.</summary>
    public Guid OwnerUserId { get; set; }

    /// <summary>Normalized account reference (IBAN / savings ref / card ref).</summary>
    public required string AccountRef { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Server-authoritative attachment of a feed's account to a space.
/// Members of the space derive read access to the feed through this
/// row; the client mirrors it into the space as a synced accountLink
/// row for offline rendering. The row is complete from the start: it
/// always carries the history gate and the space's account type, so a
/// mirror the server emits never leaves a device guessing either.
/// </summary>
public class SpaceAccountLink
{
    public Guid Id { get; set; }
    public required string SpaceId { get; set; }
    public required string FeedSpaceId { get; set; }

    /// <summary>Account row id inside the feed space.</summary>
    public required string AccountId { get; set; }

    public Guid AttachedBy { get; set; }

    /// <summary>Only transactions from this date onward are visible in the
    /// space (yyyy-mm-dd) — every attachment has one, never silently unlimited.</summary>
    public required string HistoryFrom { get; set; }

    /// <summary>#212 r2: what the account IS to this space (AccountTypes) —
    /// the caller's pick at attach time, else the account row's own type.</summary>
    public required string Type { get; set; }

    /// <summary>Set when the attaching member left the space: history stays, new data stops.</summary>
    public bool Archived { get; set; }

    /// <summary>Feed-space cursor frozen at archive time — pulls are capped here while archived.</summary>
    public long? ArchivedAtSeq { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>The account types the apps know (apps/web/src/db/types.ts
/// AccountType) — an attachment's Type is always one of these.</summary>
public static class AccountTypes
{
    public const string Default = "checking";
    public static readonly string[] All = ["checking", "savings", "cash", "brokerage", "credit", "mortgage", "loan", "funding"];
}

/// <summary>
/// #240 (user ruling 2026-08-15): CO-ownership. Anyone who completes
/// their OWN bank consent covering an account owns it exactly like the
/// first connector — the IBAN proves it is the same account. "Shared
/// with me" is only for accounts reached through someone else's
/// attachment. The row remembers WHICH consent proved it, so a leaving
/// owner's fetch binding can hand over to a survivor's consent.
/// </summary>
public class FeedOwner
{
    public required string FeedSpaceId { get; set; }
    public Guid UserId { get; set; }

    /// <summary>the consent that proved ownership (fetch hand-off)</summary>
    public Guid? RequisitionId { get; set; }

    /// <summary>the provider's account id under THAT consent (EB ids are per-session)</summary>
    public string? GcAccountId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
