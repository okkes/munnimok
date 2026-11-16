using Connector.Kit;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters;

// the provider's own facts only; BankRecords.NewAccount mints the id and hash so an adapter cannot improvise them
public sealed record AccountDraft
{
    public required string ExternalId { get; init; }

    public required AccountType Type { get; init; }

    public required string DisplayName { get; init; }

    public required string Currency { get; init; }

    public string? Iban { get; init; }

    public string? MaskedNumber { get; init; }

    public Balance? Balance { get; init; }

    /// <summary>The institution as the party's lookup names it (an aggregator); null where the party is the bank.</summary>
    public string? Institution { get; init; }

    /// <summary>The party's identity for the account across consents, where its external id is per session.</summary>
    public string? Identity { get; init; }
}

// the account is named to NewTransaction, not here: that id is the factory's product (see AccountId)
public sealed record TransactionDraft
{
    public required string ExternalId { get; init; }

    /// true when the adapter built ExternalId itself because the bank states none
    public bool IdIsDerived { get; init; }

    public required DateOnly BookedAt { get; init; }

    public required Money Amount { get; init; }

    public DateOnly? ValueAt { get; init; }

    public Counterparty? Counterparty { get; init; }

    public string? Description { get; init; }

    public TransactionKind Kind { get; init; } = TransactionKind.Other;

    public Money? ResultingBalance { get; init; }
}

// ids and hashes are minted here, not per adapter: together they ARE the idempotency contract (id from
// (session, external_id); hash over exactly the identity fields), and the re-fetch overlap of BankWindow rests on it
public static class BankRecords
{
    /// exposed so an adapter parsing transactions before the account record still gets a matching AccountId
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
            Institution = stated.Institution,
            Identity = stated.Identity,
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
            IdIsDerived = stated.IdIsDerived,
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

    /// bank exports date balances to a day, so the offset is explicit rather than the agent's local zone
    public static Balance BalanceOn(Money amount, DateOnly asOf) =>
        new() { Amount = amount, AsOf = new DateTimeOffset(asOf.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero) };
}
