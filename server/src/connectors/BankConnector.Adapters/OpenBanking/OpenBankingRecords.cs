using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// A transaction as either aggregator hands it over, before it becomes a
/// draft: signed amount as text, the two parties, the remittance line, and
/// whether the bank has booked it yet.
/// </summary>
public sealed record AggregatorTransaction
{
    /// <summary>The bank's own reference (GoCardless <c>transactionId</c>, Enable Banking <c>entry_reference</c>).</summary>
    public string? Reference { get; init; }

    /// <summary>GoCardless's fallback when the bank gives no reference.</summary>
    public string? InternalReference { get; init; }

    public string? BookingDate { get; init; }

    public string? ValueDate { get; init; }

    /// <summary>Signed, major units, as text ("-12.34").</summary>
    public required string Amount { get; init; }

    public required string Currency { get; init; }

    public string? CreditorName { get; init; }

    public string? DebtorName { get; init; }

    public string? CreditorIban { get; init; }

    public string? DebtorIban { get; init; }

    public string? Remittance { get; init; }

    public bool Pending { get; init; }
}

internal static partial class OpenBankingRecords
{
    /// <summary>
    /// The identity the consumer's ingest keys on: the reference the old
    /// integration keyed on (<c>transactionId ?? internalTransactionId</c>),
    /// a pending row under a <c>pending:</c> prefix. Keeping these exact is
    /// what lets a reconnected bank continue its history without a duplicate.
    /// </summary>
    public static string? ExternalId(AggregatorTransaction tx)
    {
        ArgumentNullException.ThrowIfNull(tx);
        var reference = FirstNonBlank(tx.Reference, tx.InternalReference);
        if (reference is null) return null;
        return tx.Pending ? $"pending:{reference}" : reference;
    }

    public static TransactionDraft? ToDraft(AggregatorTransaction tx)
    {
        ArgumentNullException.ThrowIfNull(tx);
        var externalId = ExternalId(tx);
        var booked = ParseDay(tx.BookingDate) ?? ParseDay(tx.ValueDate);
        // a row without an identity or a day cannot be keyed nor placed; the
        // old ingest dropped and counted them, and so does the consumer's
        if (externalId is null || booked is null) return null;
        var amount = new Money(MoneyParser.ToMinor(tx.Amount, MoneyUnit.MajorString), tx.Currency.ToUpperInvariant());
        var outgoing = amount.Value < 0;
        var counterName = outgoing ? tx.CreditorName : tx.DebtorName;
        var counterIban = outgoing ? tx.CreditorIban : tx.DebtorIban;
        var description = CleanBankText(tx.Remittance);
        return new TransactionDraft
        {
            ExternalId = externalId,
            BookedAt = booked.Value,
            ValueAt = ParseDay(tx.ValueDate),
            Amount = amount,
            Counterparty = counterName is null && counterIban is null ? null : new Counterparty { Name = counterName, Iban = counterIban },
            Description = description ?? counterName,
            Kind = TransactionKind.Other,
        };
    }

    public static AccountDraft ToAccount(ConsentAccount account, string institutionName, Balance? balance)
    {
        ArgumentNullException.ThrowIfNull(account);
        var iban = string.IsNullOrWhiteSpace(account.Iban) ? null : account.Iban.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        return new AccountDraft
        {
            ExternalId = account.Id,
            // an aggregator says nothing about the type; an IBAN is a current
            // account until the person says otherwise, a wallet is unknown
            Type = iban is null ? AccountType.Unknown : AccountType.Current,
            DisplayName = FirstNonBlank(account.Name, institutionName) ?? account.Id,
            Currency = FirstNonBlank(account.Currency, "EUR")!,
            Iban = iban,
            MaskedNumber = iban is { Length: > 4 } ? iban[^4..] : null,
            Balance = balance,
        };
    }

    /// <summary>closingBooked first, interimBooked next, then whatever the bank offered.</summary>
    public static Balance? PickBalance(IReadOnlyList<(string Type, string Amount, string Currency, string? Date)> balances, DateOnly today)
    {
        ArgumentNullException.ThrowIfNull(balances);
        if (balances.Count == 0) return null;
        var picked = balances.FirstOrDefault(b => b.Type == "closingBooked");
        if (picked == default) picked = balances.FirstOrDefault(b => b.Type == "interimBooked");
        if (picked == default) picked = balances[0];
        var money = new Money(MoneyParser.ToMinor(picked.Amount, MoneyUnit.MajorString, "balance"), picked.Currency.ToUpperInvariant());
        return BankRecords.BalanceOn(money, ParseDay(picked.Date) ?? today);
    }

    public static DateOnly? ParseDay(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var day = text.Length > 10 ? text[..10] : text;   // a timestamp's date part is the day
        return DateOnly.TryParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) ? parsed : null;
    }

    /// <summary>ING hands remittance lines over with literal <c>&lt;br&gt;</c> tags; nobody wants them in a description.</summary>
    public static string? CleanBankText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var cleaned = Whitespace().Replace(BreakTag().Replace(text, " "), " ").Trim();
        return cleaned.Length == 0 ? null : cleaned;
    }

    private static string? FirstNonBlank(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

    [GeneratedRegex("<br\\s*/?>", RegexOptions.IgnoreCase)]
    private static partial Regex BreakTag();

    [GeneratedRegex("\\s+")]
    private static partial Regex Whitespace();
}
