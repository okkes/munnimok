using System.Globalization;
using BankConnector.Adapters.MockBank;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// The mock fleet's data, held to the invariant it exists to demonstrate.
///
/// A bank hands us a redundant fact - the running balance after each row -
/// and an unchecked redundancy is a redundancy wasted. The consistent ledger
/// must pass the chain check; the deliberately broken one must fail it with
/// <see cref="ErrorCode.ProviderChanged"/>. Without both halves the check
/// could be silently inert and every test would still be green.
/// </summary>
public sealed class MockBankLedgerTests
{
    private const string SessionId = "ses_0123456789abcdef0123456789abcdef";
    private const string ProviderId = "mock-bank-simple";

    /// <summary>
    /// The day these tests read the ledger through - the adapters read it
    /// through their clock's today. Pinned, so a window is a fixed range: a
    /// day's rows are the same on every later day (see the test below).
    /// </summary>
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

        // provider_changed degrades the provider and pages an operator, and
        // is never retried - a broken chain is what a bank changing its
        // export looks like from here.
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

        // One nudged balance and nothing else: the fixture proves the check
        // fires on a realistic corruption rather than on a mangled file.
        var difference = Assert.Single(differences);
        Assert.Equal(difference.First.Amount, difference.Second.Amount);
        Assert.Equal(difference.First.BalanceAfter + 500, difference.Second.BalanceAfter);
    }

    [Fact]
    public void The_corruption_sits_inside_a_realistic_fetch_window()
    {
        var recent = new FetchWindow(Today.AddDays(-104), Today);

        // A default 90-day window widened by the 14-day settlement lag. A
        // corruption older than that would simply not be fetched, and the
        // provider would look healthy - which would defeat the fixture.
        Assert.Throws<ConnectorException>(
            () => BankEmission.VerifyPerAccount("mock-bank-broken", Rows(Broken, recent)));
    }

    [Fact]
    public void The_chain_must_be_verified_per_account_and_not_over_the_concatenation()
    {
        var rows = Rows(Consistent);

        // Grouped, it holds. Concatenated, the balance jumps from one
        // account's closing figure to another's at every seam - so a naive
        // whole-list check would fail on data that is perfectly correct, and
        // whoever "fixed" that would probably delete the check.
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

        // A credit card has no IBAN, which is exactly why open banking cannot
        // see it and why this service exists.
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

        // The first day is fixed and the last one follows the clock: a day's
        // rows are a function of the days before it alone, so a ledger read a
        // year later carries the same ids and content hashes for the days both
        // cover. A fixture whose rows moved with the clock would make every
        // idempotency assertion in the suite either flaky or vacuous.
        Assert.Equal(then.Select(t => t.Id), yearLater.Select(t => t.Id));
        Assert.Equal(then.Select(t => t.ContentHash), yearLater.Select(t => t.ContentHash));
        Assert.Equal(new DateOnly(2026, 1, 27), MockBankLedger.Start);
    }

    /// <summary>
    /// The history limit is always filled: whatever day the ledger is read
    /// through, its rows reach from the limit's first week to the last week.
    /// A ledger that ended on a fixed day held nothing in reach from
    /// 2027-01-23 on, and every test expecting mock transactions turned red.
    /// </summary>
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

        // Dropping rows out of the middle would break the chain, and dropping
        // the oldest would leave the caller with a gap it can never discover.
        Assert.Equal(10, page.Count);
        Assert.False(complete);
        Assert.Equal(rows.Take(10).Select(t => t.ExternalId), page.Select(t => t.ExternalId));
        BankEmission.VerifyPerAccount(ProviderId, page);

        var (whole, everything) = BankEmission.Page(rows, rows.Count);
        Assert.True(everything);
        Assert.Equal(rows.Count, whole.Count);
    }

    /// <summary>
    /// #460: a capped mock pass walks the way a live party does - newest first -
    /// so what it leaves behind is older history, which a pass with until asks
    /// for; each account keeps a contiguous run of its newest rows and its chain.
    /// </summary>
    [Fact]
    public void A_capped_pass_keeps_each_accounts_newest_rows_and_their_chain()
    {
        var rows = Rows(Consistent);

        var (page, complete) = MockBankAdapter.Newest(rows, 10);

        Assert.Equal(10, page.Count);
        Assert.False(complete);
        var cut = page.Min(t => t.BookedAt);
        Assert.All(rows.Where(t => t.BookedAt > cut), t => Assert.Contains(t, page));
        BankEmission.VerifyPerAccount(ProviderId, page);

        var (whole, everything) = MockBankAdapter.Newest(rows, rows.Count);
        Assert.True(everything);
        Assert.Same(rows, whole);
    }

    [Fact]
    public void The_reachable_set_names_the_account_types_a_caller_may_filter_on()
    {
        var reachable = Consistent.Reachable;

        // Sealed into the bundle for cheap discovery without a provider round
        // trip, and spelled in the wire form the accounts parameter takes.
        Assert.Equal(["current", "savings", "credit_card"], reachable.Select(a => a.Type));
        Assert.All(reachable, a => Assert.Contains(a.Type, AccountTypes.Selectable));
    }
}
