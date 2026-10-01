using System.Reflection;

namespace BankConnector.Adapters.Parsing;

/// <summary>
/// The recorded bank exports this assembly ships, for offline tests.
///
/// Every adapter is required to ship its provider's export shape as a
/// fixture, because that is what catches a bank changing its export without
/// anyone holding a live account. These two are the reference dialects: a
/// bank that populates almost every optional element, and one that
/// populates almost none.
/// </summary>
public static class BankFixtures
{
    /// <summary>camt.053.001.02, ISO transaction codes, RmtInf, full RltdPties.</summary>
    public const string Camt053IngSavings = "camt053-ing-savings.xml";

    /// <summary>camt.053.001.08, proprietary codes, AddtlNtryInf, a batched entry.</summary>
    public const string Camt053AsnCurrent = "camt053-asn-current.xml";

    /// <summary>Semicolon-delimited, Dutch headers, comma decimals, separate Af/Bij column.</summary>
    public const string StatementCsvDutch = "bank-statement-nl.csv";

    /// <summary>
    /// Comma-delimited, English headers, dot decimals, signed amounts, and a
    /// quoted description containing a comma. Same statement as the Dutch
    /// one, which is what makes the two comparable in a test.
    /// </summary>
    public const string StatementCsvEnglish = "bank-statement-en.csv";

    /// <summary>
    /// ING's own API payloads, in both of the languages it serves them in.
    /// </summary>
    /// <remarks>
    /// The shapes are copied field-for-field off a capture of a real account on
    /// 2026-08-12; every value is invented. The Dutch and English pages are
    /// generated from one table, so they differ ONLY where ING itself differs -
    /// which is what makes "the two languages mean the same thing" testable
    /// rather than merely asserted.
    /// </remarks>
    public const string IngTransactionsDutch = "ing-transactions-nl.json";

    public const string IngTransactionsEnglish = "ing-transactions-en.json";

    /// <summary>The cursor page behind the first, whose balance chain continues it.</summary>
    public const string IngTransactionsPageTwo = "ing-transactions-page2.json";

    public const string IngCurrentAccounts = "ing-accounts-current.json";

    public const string IngSavingsAccounts = "ing-accounts-savings.json";

    public const string IngCreditCards = "ing-credit-cards.json";

    /// <summary>
    /// The one payload that names every account, and the ONLY ING fixture here
    /// whose shape came from a schema rather than from a capture.
    /// </summary>
    /// <remarks>
    /// The recorder withheld this response - it ran against an account with real
    /// money in it - so its structure was recovered from a live run through
    /// <see cref="Ing.IngSchema"/>, which reports keys, nesting, string lengths
    /// and the product taxonomy while refusing every value. The keys, the
    /// nesting and the five type words below are therefore evidence; every
    /// string in it is invented, and the IBANs match the other ING fixtures so
    /// that the two routes to the same account can be compared in a test.
    /// </remarks>
    public const string IngAgreements = "ing-agreements.json";

    /// <summary>
    /// A credit card's and a loan's own transaction feeds, which are NOT shaped
    /// like a current account's.
    /// </summary>
    /// <remarks>
    /// Both shapes came back from live runs through <see cref="Ing.IngSchema"/>
    /// - keys, nesting and string lengths, with the product taxonomy quoted -
    /// so the structure here is evidence and every value is invented. What that
    /// evidence established is the whole reason these exist: a card states
    /// <c>id</c> as an EMPTY STRING on every row and a loan omits it entirely,
    /// neither carries a running balance, and a card names a merchant where a
    /// current account names a counter account.
    /// </remarks>
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
