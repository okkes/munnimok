using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Parsing;

public sealed record BankStatementCsvOptions
{
    public required string SessionId { get; init; }

    public required string ProviderId { get; init; }

    // used when the export has no account column (a single-account export often does not repeat it)
    public string? AccountExternalId { get; init; }

    // Dutch bank CSV exports carry no currency column; declared so a non-euro export is a one-line change
    public string Currency { get; init; } = "EUR";

    public CsvDateOrder DateOrder { get; init; } = CsvDateOrder.DayFirst;
}

// the alias lists are the accumulated knowledge of how banks spell columns; extending one is the normal repair
// when a bank changes its export
public static class BankStatementCsv
{
    public const string ColumnDate = "date";
    public const string ColumnValueDate = "value_date";
    public const string ColumnAccount = "account";
    public const string ColumnCounterpartyIban = "counterparty_iban";
    public const string ColumnCounterpartyName = "counterparty_name";
    public const string ColumnAmount = "amount";
    public const string ColumnDirection = "direction";
    public const string ColumnDescription = "description";
    public const string ColumnCode = "code";
    public const string ColumnBalanceAfter = "balance_after";

    /// <summary>Claimed so that nothing else can - see the schema.</summary>
    public const string ColumnAccountName = "account_name";

    public const string ColumnCurrency = "currency";

    public static CsvSchema Schema(CsvDateOrder dateOrder = CsvDateOrder.DayFirst) => new()
    {
        Name = "bank-statement-csv",
        DateOrder = dateOrder,
        Columns =
        [
            new CsvColumnSpec
            {
                Key = ColumnDate,
                Aliases = ["datum", "boekingsdatum", "transactiedatum", "date", "booking date", "transaction date"],
            },
            new CsvColumnSpec
            {
                Key = ColumnAmount,
                Aliases = ["bedrag (eur)", "bedrag eur", "bedrag", "transactiebedrag", "amount (eur)", "amount eur", "amount"],
            },
            // optional because at least one Dutch bank omits each; a missing description must not refuse a statement
            new CsvColumnSpec
            {
                Key = ColumnDirection,
                Required = false,
                Aliases = ["af bij", "af/bij", "bij/af", "debet/credit", "debit/credit", "debit credit", "bij af"],
            },
            new CsvColumnSpec
            {
                Key = ColumnValueDate,
                Required = false,
                Aliases = ["rentedatum", "valutadatum", "interest date", "value date"],
            },
            new CsvColumnSpec
            {
                Key = ColumnAccount,
                Required = false,
                Aliases = ["rekening", "rekeningnummer", "iban/bban", "eigen rekening", "account", "account number", "own account"],
            },
            // never emitted: claims ING savings' "Rekening naam"/"Account name" in the exact pass, else containment handed it to
            // counterparty_name ("naam") and every savings row named the account holder as its own counterparty
            new CsvColumnSpec
            {
                Key = ColumnAccountName,
                Required = false,
                Aliases = ["rekening naam", "rekeningnaam", "naam rekening", "account name", "name of account"],
            },
            new CsvColumnSpec
            {
                Key = ColumnCounterpartyIban,
                Required = false,
                // bare "counterparty" is ING's English header for the counterparty IBAN; without it an English export lost every one
                Aliases = ["tegenrekening", "tegenrekening iban/bban", "tegenrekening iban", "iban tegenpartij", "counterparty iban", "counterparty account", "counterparty", "opposing account", "contra account"],
            },
            new CsvColumnSpec
            {
                Key = ColumnCounterpartyName,
                Required = false,
                Aliases = ["naam tegenpartij", "naam / omschrijving", "naam tegenrekening", "naam", "counterparty name", "name / description", "name"],
            },
            new CsvColumnSpec
            {
                Key = ColumnDescription,
                Required = false,
                Aliases = ["mededelingen", "omschrijving", "omschrijving-1", "description", "remarks", "notifications"],
            },
            new CsvColumnSpec
            {
                Key = ColumnCode,
                Required = false,
                // "code" first: the two-letter codes are identical in the Dutch and English exports, the words beside them are not.
                // alias order decides which header is claimed, so kinds must not depend on the export's language
                Aliases = ["code", "mutatiesoort", "transactiesoort", "transaction type", "mutation type"],
            },
            new CsvColumnSpec
            {
                Key = ColumnCurrency,
                Required = false,
                // ING's savings export states a currency ("Valuta"/"Currency"); its current-account and card exports do not
                Aliases = ["valuta", "currency", "valutacode", "currency code", "munt"],
            },
            new CsvColumnSpec
            {
                Key = ColumnBalanceAfter,
                Required = false,
                // redundant with the containment pass (it already claims "resulting balance"); listed so the English export resolves exactly
                Aliases = ["saldo na mutatie", "saldo na boeking", "saldo na transactie", "saldo", "resulting balance", "balance after mutation", "balance after", "balance"],
            },
        ],
    };

    // order is preserved, not sorted: sorting would hide the reordering that BalanceChain exists to catch
    public static IReadOnlyList<Transaction> ReadTransactions(string text, BankStatementCsvOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var schema = Schema(options.DateOrder);
        var table = LocaleTolerantCsv.Read(text, schema);

        var signed = !table.HasColumn(ColumnDirection);
        var hasBalance = table.HasColumn(ColumnBalanceAfter);
        var transactions = new List<Transaction>(table.Count);
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var row in table)
        {
            var accountExternalId = row.Text(ColumnAccount) ?? options.AccountExternalId
                ?? throw ConnectorException.ProviderChanged(
                    $"{options.ProviderId}: the export has no '{ColumnAccount}' column and no account was supplied by the adapter");

            var bookedAt = row.Date(ColumnDate);

            // ING states a currency on savings and omits it on current accounts and cards: both paths are live
            var currency = row.Text(ColumnCurrency) is { Length: 3 } stated
                ? stated.ToUpperInvariant()
                : options.Currency;

            var amount = new Money(
                signed ? row.MinorUnits(ColumnAmount) : row.SignedMinorUnits(ColumnAmount, ColumnDirection),
                currency);

            var name = row.Text(ColumnCounterpartyName);
            var iban = row.Text(ColumnCounterpartyIban);
            var description = row.Text(ColumnDescription);

            var accountId = BankRecords.AccountId(options.SessionId, accountExternalId);

            transactions.Add(BankRecords.NewTransaction(options.SessionId, accountId, new TransactionDraft
            {
                // CSV rows carry no reference: the id is a content hash plus an occurrence counter,
                // so identical same-day purchases stay distinct
                ExternalId = ExternalId(accountExternalId, bookedAt, amount, name, description, seen),
                BookedAt = bookedAt,
                Amount = amount,
                ValueAt = row.DateOrNull(ColumnValueDate),
                Counterparty = name is null && iban is null ? null : new Counterparty { Name = name, Iban = iban },
                Description = description,
                Kind = Kind(row.Text(ColumnCode)),
                ResultingBalance = hasBalance
                    ? new Money(row.MinorUnits(ColumnBalanceAfter), currency)
                    : null,
            }));
        }

        return transactions;
    }

    private static string ExternalId(
        string accountExternalId,
        DateOnly bookedAt,
        Money amount,
        string? counterparty,
        string? description,
        Dictionary<string, int> seen)
    {
        var seed = string.Create(CultureInfo.InvariantCulture,
            $"{accountExternalId}|{bookedAt:yyyy-MM-dd}|{amount.Value}|{counterparty}|{description}");

        seen.TryGetValue(seed, out var occurrence);
        seen[seed] = occurrence + 1;

        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Create(CultureInfo.InvariantCulture, $"{seed}|{occurrence}")));
        return "csv-" + Convert.ToHexStringLower(digest.AsSpan(0, 10));
    }

    // the table lives in BankTransactionKinds: ING's web API states the same codes,
    // and classifying one row two ways would go unseen
    private static TransactionKind Kind(string? code) => BankTransactionKinds.FromCode(code);
}
