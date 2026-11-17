using System.Reflection;

namespace BankConnector.Adapters.Parsing;

// every adapter ships its provider's export shape as a fixture: it catches a bank changing its export without a live account
public static class BankFixtures
{
    public const string Camt053IngSavings = "camt053-ing-savings.xml";

    public const string Camt053AsnCurrent = "camt053-asn-current.xml";

    public const string StatementCsvDutch = "bank-statement-nl.csv";

    // same statement as the Dutch one, so the two are comparable in a test
    public const string StatementCsvEnglish = "bank-statement-en.csv";

    // shapes copied from a capture of a real account (2026-08-12), values invented; nl and en pages come from one table,
    // so they differ only where ING does
    public const string IngTransactionsDutch = "ing-transactions-nl.json";

    public const string IngTransactionsEnglish = "ing-transactions-en.json";

    public const string IngTransactionsPageTwo = "ing-transactions-page2.json";

    public const string IngCurrentAccounts = "ing-accounts-current.json";

    public const string IngSavingsAccounts = "ing-accounts-savings.json";

    public const string IngCreditCards = "ing-credit-cards.json";

    // shape recovered through Ing.IngSchema (keys, nesting, lengths, no values) because the recorder withheld the response.
    // strings invented, IBANs match the other ING fixtures so both routes to one account can be compared
    public const string IngAgreements = "ing-agreements.json";

    // card and loan feeds are not shaped like a current account's: a card states id as "" on every row, a loan omits it,
    // neither has a running balance, a card names a merchant; shapes from IngSchema runs, values invented
    public const string IngCardTransactions = "ing-transactions-card.json";

    public const string IngLoanTransactions = "ing-transactions-loan.json";

    public static IReadOnlyList<string> All =>
    [
        Camt053IngSavings, Camt053AsnCurrent, StatementCsvDutch, StatementCsvEnglish,
        IngTransactionsDutch, IngTransactionsEnglish, IngTransactionsPageTwo,
        IngCurrentAccounts, IngSavingsAccounts, IngCreditCards, IngAgreements,
        IngCardTransactions, IngLoanTransactions,
    ];

    public static string Read(string fixtureName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fixtureName);

        var assembly = typeof(BankFixtures).Assembly;
        var resource = Array.Find(
            assembly.GetManifestResourceNames(),
            name => name.EndsWith('.' + fixtureName, StringComparison.Ordinal));

        if (resource is null)
        {
            throw new FileNotFoundException(
                $"fixture '{fixtureName}' is not embedded in {assembly.GetName().Name}", fixtureName);
        }

        using var stream = assembly.GetManifestResourceStream(resource)!;
        using var reader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }
}
