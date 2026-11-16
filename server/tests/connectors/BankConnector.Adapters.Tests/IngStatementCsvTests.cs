using BankConnector.Adapters.Parsing;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// the language is not ours to choose (it changes on the holder's other devices): Dutch and English exports must
// mean the same
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

    // the English header for the counterparty IBAN is the bare "Counterparty", which was not an alias: zero IBANs
    // against 564 in Dutch
    [Theory]
    [InlineData("ing-current-nl.csv")]
    [InlineData("ing-current-en.csv")]
    public void A_current_account_export_states_counterparty_ibans_in_either_language(string fixture)
    {
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnCounterpartyIban));

        var withIban = Read(fixture).Count(t => t.Counterparty?.Iban is not null);

        Assert.Equal(3, withIban);
    }

    // "Rekening naam" / "Account name" is the account's OWN name: the containment pass once gave it to
    // counterparty_name via the alias "naam", naming the holder as every counterparty
    [Theory]
    [InlineData("ing-savings-nl.csv", "Spaarrekening V. Oorbeeld")]
    [InlineData("ing-savings-en.csv", "Savings V. Oorbeeld")]
    public void A_savings_export_never_reports_the_account_holder_as_a_counterparty(
        string fixture, string ownName)
    {
        var transactions = Read(fixture);

        Assert.NotEmpty(transactions);
        Assert.All(transactions, t => Assert.NotEqual(ownName, t.Counterparty?.Name));

        // claimed, not merely unread, so nothing else can pick it up later
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnAccountName));
    }

    // the savings export states a currency, current-account and credit-card exports do not: both paths are live
    [Theory]
    [InlineData("ing-savings-nl.csv")]
    [InlineData("ing-savings-en.csv")]
    public void A_stated_currency_is_read_from_the_export(string fixture)
    {
        Assert.True(Table(fixture).HasColumn(BankStatementCsv.ColumnCurrency));
        Assert.All(Read(fixture), t => Assert.Equal("EUR", t.Amount.Currency));
    }

    // inline, not a fixture: every ING account seen is EUR, so a fixture passes against a parser that hard-codes the
    // default
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

    // ING states rows newest first and BalanceChain is oldest-first; reversed it held across all 926 real rows, which
    // proves the direction column and amount signs
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

    // "Resulting balance" was not an alias, so English exports had no balance for the chain to verify
    [Fact]
    public void An_english_export_states_a_balance_that_can_be_checked()
    {
        Assert.True(Table("ing-current-en.csv").HasColumn(BankStatementCsv.ColumnBalanceAfter));
    }

    // the two-letter Code is identical across languages, the localised Mutatiesoort / Transaction type is not: the
    // code must win
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

    // the localised word is one the parser does not know, so only the code can give the kind; a new word then degrades
    // to Other in both
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

    // the credit card has no code column, only a localised word; both vocabularies are known
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
