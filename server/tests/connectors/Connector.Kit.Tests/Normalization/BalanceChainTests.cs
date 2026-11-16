using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests;

// a bank's running balances restate its own arithmetic; the check catches reordered rows, a misread separator,
// an inverted debit flag and a dropped row
public sealed class BalanceChainTests
{
    /// <summary>Oldest first, as the contract requires. 100.00 -> 90.00 -> 140.00.</summary>
    private static List<Transaction> Consistent() =>
    [
        Make.Tx("t1", -2_500, resultingBalance: 10_000),
        Make.Tx("t2", -1_000, resultingBalance: 9_000),
        Make.Tx("t3", 5_000, resultingBalance: 14_000),
    ];

    [Fact]
    public void A_consistent_chain_passes()
    {
        Assert.Null(BalanceChain.FindBreak(Consistent()));
        BalanceChain.Verify(Consistent(), "ing");
    }

    [Fact]
    public void An_inverted_sign_is_detected()
    {
        var rows = Consistent();
        rows[2] = rows[2] with { Amount = Money.Eur(-5_000) };

        Assert.Equal(2, BalanceChain.FindBreak(rows));
    }

    [Fact]
    public void A_reordered_row_is_detected()
    {
        var rows = Consistent();
        (rows[1], rows[2]) = (rows[2], rows[1]);

        // newest-first output handed to an oldest-first check is a common adapter mistake
        Assert.Equal(1, BalanceChain.FindBreak(rows));
    }

    [Fact]
    public void A_dropped_row_is_detected()
    {
        var rows = Consistent();
        rows.RemoveAt(1);

        // what a paginating fetch produces when a page boundary eats a row
        Assert.Equal(1, BalanceChain.FindBreak(rows));
    }

    [Fact]
    public void A_misread_decimal_separator_is_detected()
    {
        var rows = Consistent();
        rows[1] = rows[1] with { Amount = Money.Eur(-100_000) };   // "1.000,00" read as 1000.00 euro

        Assert.Equal(1, BalanceChain.FindBreak(rows));
    }

    [Theory]
    [InlineData(0, null)]
    [InlineData(1, null)]        // the provider's own rounding, tolerated
    [InlineData(-1, null)]
    [InlineData(2, 1)]
    [InlineData(-2, 1)]
    public void Tolerates_exactly_one_cent(long drift, int? expectedBreak)
    {
        var rows = Consistent();
        rows[1] = rows[1] with { ResultingBalance = Money.Eur(9_000 + drift) };

        // a two-cent drift after a one-cent drift would cascade, so only the first break is reported
        var actual = BalanceChain.FindBreak(rows);
        Assert.Equal(expectedBreak, actual);
    }

    [Fact]
    public void A_missing_balance_is_skipped_and_never_carried_forward()
    {
        var rows = Consistent();
        rows[1] = rows[1] with { ResultingBalance = null };
        rows[2] = rows[2] with { ResultingBalance = Money.Eur(999_999) };

        // carrying row 0's balance across would prove row 2 wrong with a number the provider never stated; unchecked is not failed
        Assert.Null(BalanceChain.FindBreak(rows));
    }

    [Fact]
    public void A_chain_that_states_no_balances_at_all_is_simply_unchecked()
    {
        // CAMT.053 states no per-entry balance; that must not fail every bank whose export is an ISO statement
        List<Transaction> rows =
        [
            Make.Tx("t1", -2_500),
            Make.Tx("t2", -1_000),
            Make.Tx("t3", 5_000),
        ];

        Assert.Null(BalanceChain.FindBreak(rows));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void A_chain_with_fewer_than_two_rows_has_no_pair_to_check(int count)
    {
        var rows = Consistent().Take(count).ToList();

        Assert.Null(BalanceChain.FindBreak(rows));
        BalanceChain.Verify(rows, "ing");
    }

    [Fact]
    public void Verify_refuses_to_emit_data_it_cannot_vouch_for()
    {
        var rows = Consistent();
        rows.RemoveAt(1);

        var ex = Assert.Throws<ConnectorException>(() => BalanceChain.Verify(rows, "asn"));

        // ProviderChanged, not Internal: the export's shape or ordering moved;
        // it also degrades the provider, so the next user avoids the bad data
        Assert.Equal(ErrorCode.ProviderChanged, ex.Code);
        Assert.False(ex.Retriable);
        Assert.Contains("asn", ex.Message, StringComparison.Ordinal);
        Assert.Contains("t3", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rejects_a_null_list_rather_than_reporting_success()
    {
        Assert.Throws<ArgumentNullException>(() => BalanceChain.FindBreak(null!));
    }

    [Fact]
    public void The_first_row_is_never_checked_against_an_opening_balance_we_do_not_have()
    {
        // row 0 has no opening balance; inventing one would check our own arithmetic
        var rows = Consistent();
        rows[0] = rows[0] with { Amount = Money.Eur(-999_999) };

        Assert.Null(BalanceChain.FindBreak(rows));
    }
}
