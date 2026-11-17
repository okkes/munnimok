using System.Globalization;
using BankConnector.Adapters.MockBank;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// a bank's running balance is a redundancy worth checking: the consistent ledger must pass and the broken one must
// fail with ProviderChanged; both halves, or the check could be inert with every test green
public sealed class MockBankLedgerTests
{
    private const string SessionId = "ses_0123456789abcdef0123456789abcdef";
    private const string ProviderId = "mock-bank-simple";

    // pinned so a window is a fixed range: a day's rows are the same on every later day
    private static readonly DateOnly Today = new(2026, 7, 26);

    private static MockBankLedger Consistent => MockBankLedger.Through(Today);

    private static MockBankLedger Broken => MockBankLedger.BrokenThrough(Today);

    private static FetchWindow WholeHistory =>
        new(Today.AddDays(-MockBankLedger.HistoryDays), Today);

    private static IReadOnlyList<Transaction> Rows(MockBankLedger ledger, FetchWindow? window = null)
    {
        var accounts = ledger.ToAccounts(SessionId);
        return ledger.ToTransactions(SessionId, accounts, window ?? WholeHistory);
    }

    [Fact]
    public void The_consistent_ledger_s_balance_chain_holds_for_every_account()
    {
        var rows = Rows(Consistent);

        Assert.NotEmpty(rows);
        BankEmission.VerifyPerAccount(ProviderId, rows);
    }

    [Fact]
    public void The_broken_ledger_fails_the_chain_and_names_the_offending_row()
    {
        var rows = Rows(Broken);

        var error = Assert.Throws<ConnectorException>(
            () => BankEmission.VerifyPerAccount("mock-bank-broken", rows));

        // provider_changed degrades the provider, pages an operator and is never retried: a broken chain is what a changed
        // export looks like
        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
        Assert.False(error.Retriable);
        Assert.Contains("balance chain broken", error.Detail, StringComparison.Ordinal);
        Assert.Contains(MockBankLedger.CurrentIban, error.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void The_two_ledgers_differ_in_exactly_one_stated_balance()
    {
        var consistent = Consistent.Entries;
        var broken = Broken.Entries;

        Assert.Equal(consistent.Count, broken.Count);

        var differences = consistent.Zip(broken).Where(pair => pair.First != pair.Second).ToList();

        // one nudged balance only: the check fires on a realistic corruption, not a mangled file
        var difference = Assert.Single(differences);
        Assert.Equal(difference.First.Amount, difference.Second.Amount);
        Assert.Equal(difference.First.BalanceAfter + 500, difference.Second.BalanceAfter);
    }

    [Fact]
    public void The_corruption_sits_inside_a_realistic_fetch_window()
    {
        var recent = new FetchWindow(Today.AddDays(-104), Today);

        // the default 90-day window plus the 14-day settlement lag: an older corruption would not be fetched and the
        // provider would look healthy
        Assert.Throws<ConnectorException>(
            () => BankEmission.VerifyPerAccount("mock-bank-broken", Rows(Broken, recent)));
    }

    [Fact]
    public void The_chain_must_be_verified_per_account_and_not_over_the_concatenation()
    {
        var rows = Rows(Consistent);

        // verified per account: concatenated, the balance jumps at every seam, and whoever "fixed" that would delete the
        // check
        BankEmission.VerifyPerAccount(ProviderId, rows);
        Assert.Throws<ConnectorException>(() => BalanceChain.Verify(rows, ProviderId));
    }

    [Fact]
    public void Every_account_the_fixture_reaches_has_transactions_and_a_stated_balance()
    {
        var accounts = Consistent.ToAccounts(SessionId);
        var rows = Rows(Consistent);

        Assert.Equal(3, accounts.Count);
        Assert.All(accounts, account =>
        {
            Assert.NotNull(account.Balance);
            Assert.Equal("EUR", account.Currency);
            Assert.Contains(rows, t => t.AccountId == account.Id);
        });

        // a credit card has no IBAN, which is why open banking cannot see it
        var card = Assert.Single(accounts, a => a.Type == AccountType.CreditCard);
        Assert.Null(card.Iban);
        Assert.Equal(MockBankLedger.CreditCardNumber, card.MaskedNumber);
    }

    [Fact]
    public void The_last_row_of_each_account_matches_the_balance_the_account_reports()
    {
        var accounts = Consistent.ToAccounts(SessionId);
        var rows = Rows(Consistent);

        foreach (var account in accounts)
        {
            var last = rows.Last(t => t.AccountId == account.Id);
            Assert.Equal(account.Balance?.Amount.Value, last.ResultingBalance?.Value);
        }
    }

    [Fact]
    public void A_days_rows_never_move_as_the_ledger_grows()
    {
        var then = Rows(Consistent);
        var yearLater = Rows(MockBankLedger.Through(Today.AddDays(365)), WholeHistory);

        // a day's rows depend only on the days before it, so a ledger read a year later has the same ids and hashes; rows
        // that moved with the clock would make idempotency assertions flaky or vacuous
        Assert.Equal(then.Select(t => t.Id), yearLater.Select(t => t.Id));
        Assert.Equal(then.Select(t => t.ContentHash), yearLater.Select(t => t.ContentHash));
        Assert.Equal(new DateOnly(2026, 1, 27), MockBankLedger.Start);
    }

    // whatever day it is read through, rows reach from the limit's first week to the last; a fixed end day held
    // nothing in reach from 2027-01-23 on
    [Theory]
    [InlineData("2026-07-26")]
    [InlineData("2027-01-23")]
    [InlineData("2036-11-08")]
    public void The_history_reaches_back_its_limit_on_any_day(string day)
    {
        var today = DateOnly.Parse(day, CultureInfo.InvariantCulture);
        var floor = today.AddDays(-MockBankLedger.HistoryDays);

        var rows = Rows(MockBankLedger.Through(today), new FetchWindow(floor, today));

        Assert.InRange(rows.Min(t => t.BookedAt), floor, floor.AddDays(7));
        Assert.InRange(rows.Max(t => t.BookedAt), today.AddDays(-7), today);
        BankEmission.VerifyPerAccount(ProviderId, rows);
    }

    [Fact]
    public void The_window_is_inclusive_at_both_ends_and_excludes_everything_outside_it()
    {
        var window = new FetchWindow(new DateOnly(2026, 6, 1), new DateOnly(2026, 6, 30));

        var rows = Rows(Consistent, window);

        Assert.NotEmpty(rows);
        Assert.All(rows, t => Assert.True(window.Contains(t.BookedAt), $"{t.BookedAt} is outside the window"));
        Assert.Contains(rows, t => t.BookedAt == new DateOnly(2026, 6, 1));
    }

    [Fact]
    public void Paging_keeps_a_contiguous_oldest_first_prefix_so_the_chain_survives()
    {
        var rows = Rows(Consistent);

        var (page, complete) = BankEmission.Page(rows, 10);

        // dropping from the middle breaks the chain, dropping the oldest leaves a gap the caller never discovers
        Assert.Equal(10, page.Count);
        Assert.False(complete);
        Assert.Equal(rows.Take(10).Select(t => t.ExternalId), page.Select(t => t.ExternalId));
        BankEmission.VerifyPerAccount(ProviderId, page);

        var (whole, everything) = BankEmission.Page(rows, rows.Count);
        Assert.True(everything);
        Assert.Equal(rows.Count, whole.Count);
    }

    /// <summary>
    /// A capped mock pass cuts each account by itself, as ING's share of a page and Enable Banking's
    /// page limit do: the accounts stop on different days, which is what an older pass has to cope with.
    /// </summary>
    [Fact]
    public void A_capped_pass_keeps_each_accounts_newest_rows_and_their_chain()
    {
        var rows = Rows(Consistent);

        var (page, complete) = MockBankAdapter.Newest(rows, 10);

        Assert.Equal(10, page.Count);
        Assert.False(complete);
        var cuts = page.GroupBy(t => t.AccountId).ToDictionary(g => g.Key, g => g.Min(t => t.BookedAt));
        Assert.Equal(3, cuts.Count);
        Assert.All(rows.Where(t => t.BookedAt > cuts[t.AccountId]), t => Assert.Contains(t, page));
        Assert.True(cuts.Values.Distinct().Count() > 1, "every account was cut on the same day");
        BankEmission.VerifyPerAccount(ProviderId, page);

        var (whole, everything) = MockBankAdapter.Newest(rows, rows.Count);
        Assert.True(everything);
        Assert.Same(rows, whole);
    }

    [Fact]
    public void The_reachable_set_names_the_account_types_a_caller_may_filter_on()
    {
        var reachable = Consistent.Reachable;

        // sealed into the bundle for discovery without a provider round trip, in the wire form the accounts parameter
        // takes
        Assert.Equal(["current", "savings", "credit_card"], reachable.Select(a => a.Type));
        Assert.All(reachable, a => Assert.Contains(a.Type, AccountTypes.Selectable));
    }
}
