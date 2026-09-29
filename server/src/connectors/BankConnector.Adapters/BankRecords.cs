using Connector.Kit;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters;

/// <summary>
/// An account as an adapter states it, before its id and content hash exist.
/// </summary>
/// <remarks>
/// Everything here is the provider's own fact about the account; nothing is
/// derived. <see cref="BankRecords.NewAccount"/> mints the rest, which is
/// what keeps an adapter from improvising an id or a hash - see
/// <see cref="BankRecords"/>.
/// </remarks>
public sealed record AccountDraft
{
    public required string ExternalId { get; init; }

    public required AccountType Type { get; init; }

    public required string DisplayName { get; init; }

    /// <summary>An ISO code. Upper-cased by the factory, so any case will do here.</summary>
    public required string Currency { get; init; }

    public string? Iban { get; init; }

    public string? MaskedNumber { get; init; }

    public Balance? Balance { get; init; }
}

/// <summary>
/// A transaction as an adapter states it, before its id and content hash
/// exist.
/// </summary>
/// <remarks>
/// The account it belongs to is named to
/// <see cref="BankRecords.NewTransaction"/> rather than here, because that id
/// is the factory's own product - see <see cref="BankRecords.AccountId"/>.
/// </remarks>
public sealed record TransactionDraft
{
    public required string ExternalId { get; init; }

    public required DateOnly BookedAt { get; init; }

    public required Money Amount { get; init; }

    public DateOnly? ValueAt { get; init; }

    public Counterparty? Counterparty { get; init; }

    public string? Description { get; init; }

    public TransactionKind Kind { get; init; } = TransactionKind.Other;

    public Money? ResultingBalance { get; init; }
}

/// <summary>
/// Builds normalised records for bank adapters.
///
/// Ids and content hashes are minted here rather than in each adapter
/// because together they ARE the idempotency contract: the id must be
/// derivable from <c>(session, external_id)</c> so a re-run produces the
/// same ids, and the hash must cover exactly the fields that make a record
/// what it is. An adapter that improvises either one breaks re-fetch
/// overlap - and re-fetch overlap is what lets every adapter widen its
/// window to catch late-settling rows (see <see cref="BankWindow"/>).
/// </summary>
public static class BankRecords
{
    /// <summary>
    /// The id a transaction must reference. Exposed so an adapter that
    /// parses transactions before it has built the account record still
    /// produces a matching <see cref="Transaction.AccountId"/>.
    /// </summary>
    public static string AccountId(string sessionId, string externalId) =>
        Ids.ForRecord(Ids.Account, sessionId, externalId);

    public static Account NewAccount(string sessionId, AccountDraft stated)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentNullException.ThrowIfNull(stated);
        ArgumentException.ThrowIfNullOrWhiteSpace(stated.ExternalId);
        ArgumentException.ThrowIfNullOrWhiteSpace(stated.DisplayName);
        ArgumentException.ThrowIfNullOrWhiteSpace(stated.Currency);

        var account = new Account
        {
            Id = AccountId(sessionId, stated.ExternalId),
            ExternalId = stated.ExternalId,
            Type = stated.Type,
            DisplayName = stated.DisplayName,
            Currency = stated.Currency.ToUpperInvariant(),
            Iban = stated.Iban,
            MaskedNumber = stated.MaskedNumber,
            Balance = stated.Balance,
        };

        return account with { ContentHash = ContentHash.Of(account) };
    }

    public static Transaction NewTransaction(string sessionId, string accountId, TransactionDraft stated)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(accountId);
        ArgumentNullException.ThrowIfNull(stated);
        ArgumentException.ThrowIfNullOrWhiteSpace(stated.ExternalId);

        var transaction = new Transaction
        {
            Id = Ids.ForRecord(Ids.Transaction, sessionId, stated.ExternalId),
            ExternalId = stated.ExternalId,
            AccountId = accountId,
            BookedAt = stated.BookedAt,
            ValueAt = stated.ValueAt,
            Amount = stated.Amount,
            Counterparty = stated.Counterparty,
            Description = stated.Description,
            Kind = stated.Kind,
            ResultingBalance = stated.ResultingBalance,
        };

        return transaction with { ContentHash = ContentHash.Of(transaction) };
    }

    /// <summary>
    /// A balance stamped at a stated moment. Bank exports date balances to a
    /// day, not an instant, so the offset is made explicit here rather than
    /// left to whatever local time zone the agent happens to run in.
    /// </summary>
    public static Balance BalanceOn(Money amount, DateOnly asOf) =>
        new() { Amount = amount, AsOf = new DateTimeOffset(asOf.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero) };
}
