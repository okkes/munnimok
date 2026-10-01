using BankConnector.Adapters.Parsing;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// ING's three export layouts, in both of the languages it serves them in.
///
/// THE LANGUAGE IS NOT OURS TO CHOOSE. Switching it in the web session changes
/// it on the account holder's other devices too, so a connector has to take
/// whatever it is handed. That makes "the Dutch and English exports of one
/// account mean the same thing" a correctness requirement rather than a
/// nicety, and it is what most of this file checks.
///
/// The column sets are copied header-for-header from a real export on
/// 2026-08-12; every value is invented. Each defect below was found by running
/// this parser over that export, not by reading the code.
/// </summary>
public sealed class IngStatementCsvTests
{
    private static BankStatementCsvOptions Options(string account = "acct") => new()
    {
        SessionId = "ses_00000000000000000000000000000000",
        ProviderId = "ing",
        AccountExternalId = account,
    };

    private static IReadOnlyList<Transaction> Read(string fixture) =>
        BankStatementCsv.ReadTransactions(BankFixtures.Read(fixture), Options());

    private static CsvTable Table(string fixture) =>
        LocaleTolerantCsv.Read(BankFixtures.Read(fixture), BankStatementCsv.Schema());

    // ---- the English export used to lose its counterparties ----------------

    /// <summary>
    /// ING's English header for the counterparty IBAN is the bare word
    /// "Counterparty". The alias list carried "counterparty iban" and not that,
    /// so the same account exported in English produced ZERO counterparty
    /// IBANs where the Dutch export produced 564.
    /// </summary>
    [Theory]
    [InlineData("ing-current-nl.csv")]
    [InlineData("ing-current-en.csv")]
    public void A_current_account_export_states_counterparty_ibans_in_either_language(string fixture)
    {
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnCounterpartyIban));

        var withIban = Read(fixture).Count(t => t.Counterparty?.Iban is not null);

        Assert.Equal(3, withIban);
    }

    // ---- the savings export used to name the account holder ----------------

    /// <summary>
    /// The one that corrupts data rather than losing it.
    ///
    /// ING's savings export carries "Rekening naam" / "Account name" - the
    /// account's OWN name. With no spec of its own, the schema's containment
    /// pass handed it to counterparty_name, because the alias "naam" is
    /// contained in "rekening naam" and it was the only unclaimed candidate.
    /// Every savings transaction then named the account holder as its own
    /// counterparty, which reads perfectly plausibly and is entirely wrong.
    /// </summary>
    [Theory]
    [InlineData("ing-savings-nl.csv", "Spaarrekening V. Oorbeeld")]
    [InlineData("ing-savings-en.csv", "Savings V. Oorbeeld")]
    public void A_savings_export_never_reports_the_account_holder_as_a_counterparty(
        string fixture, string ownName)
    {
        var transactions = Read(fixture);

        Assert.NotEmpty(transactions);
        Assert.All(transactions, t => Assert.NotEqual(ownName, t.Counterparty?.Name));

        // And the column is claimed rather than merely unread, so nothing else
        // can pick it up later.
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnAccountName));
    }

    // ---- the currency ING does state ---------------------------------------

    /// <summary>
    /// The file's own comment said Dutch retail exports carry no currency
    /// column at all. ING's savings export states one; its current-account and
    /// credit-card exports do not, so both paths are live on one provider.
    /// </summary>
    [Theory]
    [InlineData("ing-savings-nl.csv")]
    [InlineData("ing-savings-en.csv")]
    public void A_stated_currency_is_read_from_the_export(string fixture)
    {
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnCurrency));
        Assert.All(Read(fixture), t => Assert.Equal("EUR", t.Amount.Currency));
    }

    /// <summary>
    /// The currency column, PROVED to be read rather than assumed.
    ///
    /// Every ING account seen is in euros, so a fixture-based check passes just
    /// as happily against a parser that ignores the column and hard-codes the
    /// default - which is what the first version of this test did. An inline
    /// export states a different currency, so the only way to satisfy it is to
    /// read the column.
    /// <para>
    /// Written inline rather than as a fixture on purpose: ING has never been
    /// seen to export anything but EUR, and a fixture would look like evidence
    /// that it does.
    /// </para>
    /// </summary>
    [Fact]
    public void The_currency_column_is_actually_read_and_not_merely_present()
    {
        const string Export = """
        "Datum";"Omschrijving";"Rekening";"Af Bij";"Bedrag";"Valuta";"Saldo na mutatie"
        "01-03-2026";"Rente";"V00000001";"Bij";"10,00";"SEK";"1.010,00"
        """;

        var transaction = Assert.Single(BankStatementCsv.ReadTransactions(Export, Options()));

        Assert.Equal("SEK", transaction.Amount.Currency);
        Assert.Equal("SEK", transaction.ResultingBalance?.Currency);
    }

    [Fact]
    public void An_export_with_no_currency_column_falls_back_to_the_declared_one()
    {
        var table = Table("ing-current-nl.csv");

        Assert.False(table.HasColumn(BankStatementCsv.ColumnCurrency));
        Assert.All(Read("ing-current-nl.csv"), t => Assert.Equal("EUR", t.Amount.Currency));
    }

    // ---- the balance chain, which is the free integrity check --------------

    /// <summary>
    /// ING states its rows NEWEST FIRST, and BalanceChain is defined on
    /// oldest-first. As stated the chain breaks at the first pair; reversed it
    /// holds - which on the real export held across all 926 rows and is what
    /// proves the direction column and the amount signs are read correctly.
    /// </summary>
    [Theory]
    [InlineData("ing-current-nl.csv")]
    [InlineData("ing-current-en.csv")]
    [InlineData("ing-savings-nl.csv")]
    [InlineData("ing-savings-en.csv")]
    public void The_running_balance_chain_holds_once_the_rows_are_put_oldest_first(string fixture)
    {
        var stated = Read(fixture);

        Assert.All(stated, t => Assert.NotNull(t.ResultingBalance));
        Assert.True(stated[0].BookedAt > stated[^1].BookedAt, "ING states its exports newest-first");

        Assert.Null(BalanceChain.FindBreak([.. stated.Reverse()]));
    }

    /// <summary>
    /// English exports could not be checked at all before: "Resulting balance"
    /// was not an alias, so balance_after never resolved and the chain had
    /// nothing to verify.
    /// </summary>
    [Fact]
    public void An_english_export_states_a_balance_that_can_be_checked()
    {
        Assert.True(Table("ing-current-en.csv").HasColumn(BankStatementCsv.ColumnBalanceAfter));
    }

    // ---- the language-independent code column ------------------------------

    /// <summary>
    /// ING's current-account export carries BOTH a two-letter <c>Code</c>
    /// column and a localised <c>Mutatiesoort</c> / <c>Transaction type</c>
    /// one. The codes are byte-identical between languages; the words are not.
    /// Alias order decides which is claimed, so the stable one has to win or a
    /// transaction's kind depends on the language somebody banks in.
    /// </summary>
    [Fact]
    public void The_transaction_kinds_of_a_current_account_do_not_depend_on_the_language()
    {
        var nl = Read("ing-current-nl.csv").Select(t => t.Kind).ToList();
        var en = Read("ing-current-en.csv").Select(t => t.Kind).ToList();

        Assert.Equal(nl, en);
        Assert.Equal(
            [TransactionKind.Transfer, TransactionKind.Transfer, TransactionKind.DirectDebit, TransactionKind.CardPayment],
            nl);
    }

    /// <summary>
    /// That the CODE column is the one being read, proved by disagreeing with
    /// the word beside it.
    /// </summary>
    /// <remarks>
    /// The fixture-based test above passes whichever column wins, because both
    /// vocabularies are known well enough to agree - which is reassuring and
    /// proves nothing about the alias order. Here the localised word is one
    /// nobody has taught the parser, so the kind can only come out right if the
    /// two-letter code was claimed.
    /// <para>
    /// This is the property that matters when ING adds a transaction type: the
    /// codes are stable and shared between languages, so a new word degrades to
    /// Other in both rather than in only one.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_two_letter_code_wins_over_the_localised_word_beside_it()
    {
        const string Export = """
        "Datum";"Naam / Omschrijving";"Rekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort"
        "01-03-2026";"VOORBEELD";"NL01TEST0123456789";"BA";"Af";"10,00";"Iets Onbekends"
        """;

        var transaction = Assert.Single(BankStatementCsv.ReadTransactions(Export, Options()));

        Assert.Equal(TransactionKind.CardPayment, transaction.Kind);
    }

    /// <summary>
    /// And where ING offers no code column - the credit card states only a
    /// localised word - both vocabularies are known, so the kinds still agree.
    /// </summary>
    [Fact]
    public void The_transaction_kinds_of_a_credit_card_agree_across_languages()
    {
        var nl = Read("ing-creditcard-nl.csv").Select(t => t.Kind).ToList();
        var en = Read("ing-creditcard-en.csv").Select(t => t.Kind).ToList();

        Assert.Equal(nl, en);
        Assert.Equal([TransactionKind.Fee, TransactionKind.CardPayment], nl);
    }

    [Fact]
    public void A_credit_card_export_has_no_account_column_and_takes_the_adapters()
    {
        var table = Table("ing-creditcard-nl.csv");

        Assert.False(table.HasColumn(BankStatementCsv.ColumnAccount));

        var transactions = BankStatementCsv.ReadTransactions(
            BankFixtures.Read("ing-creditcard-nl.csv"), Options("card-0001"));

        Assert.All(transactions, t => Assert.Equal(
            BankRecords.AccountId("ses_00000000000000000000000000000000", "card-0001"), t.AccountId));
    }

    // ---- amounts -----------------------------------------------------------

    [Theory]
    [InlineData("ing-current-nl.csv")]
    [InlineData("ing-current-en.csv")]
    public void Debits_are_negative_and_credits_are_positive_in_either_language(string fixture)
    {
        var transactions = Read(fixture);

        // Newest first: iDEAL 18,49 out, then 250,00 in, then 120,00 out, then 42,31 out.
        Assert.Equal([-1_849, 25_000, -12_000, -4_231], transactions.Select(t => t.Amount.Value));
    }
}
