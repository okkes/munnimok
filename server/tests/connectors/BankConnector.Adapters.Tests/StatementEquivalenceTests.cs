using BankConnector.Adapters.Parsing;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// the ASN camt.053 and both CSV fixtures are the SAME June statement: two independent parsers on different formats
// must agree
public sealed class StatementEquivalenceTests
{
    private const string SessionId = "ses_0123456789abcdef0123456789abcdef";
    private const string Account = "NL18ASNB0123456789";

    private static IReadOnlyList<Transaction> FromCamt() => Assert.Single(Camt053Parser.Parse(
        BankFixtures.Read(BankFixtures.Camt053AsnCurrent),
        new Camt053Options
        {
            SessionId = SessionId,
            ProviderId = "test-bank",
            AccountType = AccountType.Current,
        })).Transactions;

    private static IReadOnlyList<Transaction> FromCsv(string fixture) => BankStatementCsv.ReadTransactions(
        BankFixtures.Read(fixture),
        new BankStatementCsvOptions
        {
            SessionId = SessionId,
            ProviderId = "test-bank",
            AccountExternalId = Account,
        });

    [Fact]
    public void Every_format_agrees_on_the_amounts_and_their_signs()
    {
        long[] expected = [-142_500, -4_231, -1_890, 285_000, -1_240];

        Assert.Equal(expected, FromCamt().Select(t => t.Amount.Value));
        Assert.Equal(expected, FromCsv(BankFixtures.StatementCsvDutch).Select(t => t.Amount.Value));
        Assert.Equal(expected, FromCsv(BankFixtures.StatementCsvEnglish).Select(t => t.Amount.Value));
    }

    [Fact]
    public void Every_format_agrees_on_the_booking_dates()
    {
        DateOnly[] expected =
        [
            new(2026, 6, 2), new(2026, 6, 5), new(2026, 6, 11), new(2026, 6, 24), new(2026, 6, 28),
        ];

        Assert.Equal(expected, FromCamt().Select(t => t.BookedAt));
        Assert.Equal(expected, FromCsv(BankFixtures.StatementCsvDutch).Select(t => t.BookedAt));
        Assert.Equal(expected, FromCsv(BankFixtures.StatementCsvEnglish).Select(t => t.BookedAt));
    }

    [Fact]
    public void Every_format_agrees_on_the_transaction_kinds()
    {
        TransactionKind[] expected =
        [
            TransactionKind.DirectDebit, TransactionKind.CardPayment, TransactionKind.CardPayment,
            TransactionKind.Transfer, TransactionKind.CardPayment,
        ];

        // camt states proprietary Prtry codes, the CSVs a mutation-code column; both resolve to one classification
        Assert.Equal(expected, FromCamt().Select(t => t.Kind));
        Assert.Equal(expected, FromCsv(BankFixtures.StatementCsvDutch).Select(t => t.Kind));
    }

    [Fact]
    public void The_two_formats_attach_every_transaction_to_the_same_account()
    {
        var accountId = BankRecords.AccountId(SessionId, Account);

        // the id derives from (session, external_id), so camt and CSV of one account converge on one account id
        Assert.All(FromCamt(), t => Assert.Equal(accountId, t.AccountId));
        Assert.All(FromCsv(BankFixtures.StatementCsvDutch), t => Assert.Equal(accountId, t.AccountId));
    }

    [Fact]
    public void Only_the_batched_entry_differs_and_it_differs_honestly()
    {
        var camt = FromCamt();
        var csv = FromCsv(BankFixtures.StatementCsvDutch);

        // camt states the batch as two TxDtls under one entry: no single counterparty, and inventing one would be a
        // fabrication; the CSV has only a name column, so the bank's batch label lands in it
        Assert.Null(camt[2].Counterparty);
        Assert.Equal("VERZAMELBOEKING", csv[2].Counterparty?.Name);

        foreach (var index in (int[])[0, 1, 3, 4])
        {
            Assert.Equal(camt[index].Counterparty?.Name, csv[index].Counterparty?.Name);
            Assert.Equal(camt[index].Counterparty?.Iban, csv[index].Counterparty?.Iban);
        }
    }

    [Fact]
    public void The_csv_running_balance_lands_where_the_camt_closing_balance_does()
    {
        var statement = Assert.Single(Camt053Parser.Parse(
            BankFixtures.Read(BankFixtures.Camt053AsnCurrent),
            new Camt053Options { SessionId = SessionId, ProviderId = "test-bank", AccountType = AccountType.Current }));

        var csv = FromCsv(BankFixtures.StatementCsvDutch);

        Assert.NotNull(statement.Closing);
        Assert.Equal(319_369, statement.Closing.Amount.Value);
        Assert.Equal(statement.Closing.Amount.Value, csv[^1].ResultingBalance?.Value);

        Assert.NotNull(statement.Opening);
        Assert.Equal(
            csv[^1].ResultingBalance?.Value,
            statement.Opening.Amount.Value + csv.Sum(t => t.Amount.Value));
    }
}
