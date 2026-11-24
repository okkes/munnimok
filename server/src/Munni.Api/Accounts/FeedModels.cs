namespace Munni.Api.Accounts;

/// one bank account's raw data; the id uuidv5("feed:" + account ref) is guessable, so feeds are NEVER created
/// by the generic first-push rule (security S1), only through this registry
public class FeedSpace
{
    public required string Id { get; set; }

    public Guid OwnerUserId { get; set; }

    /// <summary>Normalized account reference (IBAN / savings ref / card ref).</summary>
    public required string AccountRef { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// the client mirrors it as a synced accountLink row for offline rendering; always complete:
/// it carries the history gate and the space's type
public class SpaceAccountLink
{
    public Guid Id { get; set; }
    public required string SpaceId { get; set; }
    public required string FeedSpaceId { get; set; }

    public required string AccountId { get; set; }

    public Guid AttachedBy { get; set; }

    /// transactions from this date onward are visible (yyyy-mm-dd); never silently unlimited
    public required string HistoryFrom { get; set; }

    /// #212: what the account IS to this space: the caller's pick at attach time, else the account row's own type
    public required string Type { get; set; }

    /// <summary>Set when the attaching member left the space: history stays, new data stops.</summary>
    public bool Archived { get; set; }

    /// <summary>Feed-space cursor frozen at archive time — pulls are capped here while archived.</summary>
    public long? ArchivedAtSeq { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// #648: a space includes a receipt feed (a shop connection's, or a person's own scans): its members read that feed.
/// No history gate and no archive: the receipts are there while the attachment is, and gone with it
public class SpaceStoreLink
{
    public Guid Id { get; set; }
    public required string SpaceId { get; set; }
    public required string FeedSpaceId { get; set; }

    public Guid AttachedBy { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// mirrors apps/web/src/db/types.ts AccountType
public static class AccountTypes
{
    public const string Default = "checking";
    public static readonly string[] All = ["checking", "savings", "cash", "brokerage", "credit", "mortgage", "loan", "funding"];
}

/// #240: CO-ownership: anyone completing their OWN bank consent for an account owns it like the first connector
/// (the IBAN proves it); "shared with me" is only for accounts reached through someone else's attachment
public class FeedOwner
{
    public required string FeedSpaceId { get; set; }
    public Guid UserId { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
