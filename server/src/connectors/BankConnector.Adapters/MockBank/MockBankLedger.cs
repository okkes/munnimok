using System.Globalization;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

public sealed record MockBankAccount
{
    public required string ExternalId { get; init; }

    public required AccountType Type { get; init; }

    public required string DisplayName { get; init; }

    public required long OpeningBalance { get; init; }

    public string Currency { get; init; } = "EUR";

    public string? Iban { get; init; }

    public string? MaskedNumber { get; init; }
}

public sealed record MockBankEntry
{
    public required string AccountExternalId { get; init; }

    public required string ExternalId { get; init; }

    public required DateOnly BookedAt { get; init; }

    /// <summary>Minor units, signed. Negative means money left the account.</summary>
    public required long Amount { get; init; }

    /// <summary>Minor units. The whole point of the fixture: it must chain.</summary>
    public required long BalanceAfter { get; init; }

    public string? Description { get; init; }

    public Counterparty? Counterparty { get; init; }

    public TransactionKind Kind { get; init; } = TransactionKind.Other;
}

// starts on a fixed day: every row is a pure function of its day and the rows before, so ids, balances and
// ContentHash never move; the last day follows the clock, as a fixed one (2026-07-26) fell behind the history
// limit and every window emptied
public sealed class MockBankLedger
{
    // fixed for good: moving it moves every id and hash after it and duplicates the rows a dev database already holds
    public static readonly DateOnly Start = new(2026, 1, 27);

    /// <summary>Six months: enough to span several statement periods and a quarterly interest posting.</summary>
    public const int HistoryDays = 180;

    public const string CurrentIban = "NL18MOCK0123456789";
    public const string SavingsIban = "NL91MOCK0417164300";
    public const string CreditCardNumber = "5412 •••• •••• 4242";
    public const string SalaryIban = "NL44MOCK0009876543";
    public const string LandlordIban = "NL22MOCK0123409876";

    private static readonly MockBankAccount[] Definitions =
    [
        new()
        {
            ExternalId = CurrentIban,
            Type = AccountType.Current,
            DisplayName = "Betaalrekening",
            Iban = CurrentIban,
            OpeningBalance = 250_000,
        },
        new()
        {
            ExternalId = SavingsIban,
            Type = AccountType.Savings,
            DisplayName = "Oranje Spaarrekening",
            Iban = SavingsIban,
            OpeningBalance = 1_250_045,
        },
        new()
        {
            // A credit card has no IBAN, which is exactly why open banking
            // cannot see it and why this service exists.
            ExternalId = "mock-cc-4242",
            Type = AccountType.CreditCard,
            DisplayName = "Mock Card Gold",
            MaskedNumber = CreditCardNumber,
            OpeningBalance = -18_750,
        },
    ];

    private static readonly string[] Merchants =
    [
        "JUMBO 1234 UTRECHT",
        "ALBERT HEIJN 8891",
        "LIDL 0442 AMERSFOORT",
        "BAKKERIJ VAN DIJK",
        "NS REIZIGERS",
        "MOCK APOTHEEK",
        "COFFEE COMPANY CS",
    ];

    private MockBankLedger(IReadOnlyList<MockBankEntry> entries)
    {
        Entries = entries;
        Accounts = Definitions;
        Reachable =
        [
            .. Definitions.Select(a => new ReachableAccount
            {
                ExternalId = a.ExternalId,
                Type = AccountTypes.Wire(a.Type),
                DisplayName = a.DisplayName,
            }),
        ];
    }

    public static MockBankLedger Through(DateOnly lastDay) => new(Generate(lastDay));

    // one resulting balance nudged by five euros near lastDay, so the chain verifier and alert path have something to fire on
    public static MockBankLedger BrokenThrough(DateOnly lastDay) => new(Corrupt(Generate(lastDay)));

    public IReadOnlyList<MockBankAccount> Accounts { get; }

    /// <summary>Oldest-first within each account, accounts in declaration order.</summary>
    public IReadOnlyList<MockBankEntry> Entries { get; }

    public IReadOnlyList<ReachableAccount> Reachable { get; }

    public IReadOnlyList<Account> ToAccounts(string sessionId)
    {
        var accounts = new List<Account>(Accounts.Count);
        foreach (var definition in Accounts)
        {
            var last = Entries.LastOrDefault(e => string.Equals(e.AccountExternalId, definition.ExternalId, StringComparison.Ordinal));

            accounts.Add(BankRecords.NewAccount(sessionId, new AccountDraft
            {
                ExternalId = definition.ExternalId,
                Type = definition.Type,
                DisplayName = definition.DisplayName,
                Currency = definition.Currency,
                Iban = definition.Iban,
                MaskedNumber = definition.MaskedNumber,
                Balance = BankRecords.BalanceOn(
                    new Money(last?.BalanceAfter ?? definition.OpeningBalance, definition.Currency),
                    last?.BookedAt ?? Start),
            }));
        }

        return accounts;
    }

    // in the ledger's own order, which is the order the balance chain is checked in
    public IReadOnlyList<Transaction> ToTransactions(
        string sessionId,
        IReadOnlyList<Account> accounts,
        FetchWindow window)
    {
        ArgumentNullException.ThrowIfNull(accounts);

        var wanted = accounts.ToDictionary(a => a.ExternalId, a => a.Id, StringComparer.Ordinal);
        var transactions = new List<Transaction>();

        foreach (var entry in Entries)
        {
            if (!wanted.TryGetValue(entry.AccountExternalId, out var accountId)) continue;
            if (!window.Contains(entry.BookedAt)) continue;

            var currency = Accounts.First(a => string.Equals(a.ExternalId, entry.AccountExternalId, StringComparison.Ordinal)).Currency;

            transactions.Add(BankRecords.NewTransaction(sessionId, accountId, new TransactionDraft
            {
                ExternalId = entry.ExternalId,
                BookedAt = entry.BookedAt,
                Amount = new Money(entry.Amount, currency),
                ValueAt = entry.BookedAt,
                Counterparty = entry.Counterparty,
                Description = entry.Description,
                Kind = entry.Kind,
                ResultingBalance = new Money(entry.BalanceAfter, currency),
            }));
        }

        return transactions;
    }

    // always from Start: a later first day would restart balances and the id sequence, moving every day's rows
    private static List<MockBankEntry> Generate(DateOnly lastDay)
    {
        var entries = new List<MockBankEntry>(256);

        foreach (var account in Definitions)
        {
            var balance = account.OpeningBalance;
            var sequence = 0;

            for (var day = Start; day <= lastDay; day = day.AddDays(1))
            {
                foreach (var (amount, description, counterparty, kind) in EventsFor(account, day, balance))
                {
                    balance += amount;
                    sequence++;

                    entries.Add(new MockBankEntry
                    {
                        AccountExternalId = account.ExternalId,
                        ExternalId = string.Create(CultureInfo.InvariantCulture, $"{account.ExternalId}:{sequence:D5}"),
                        BookedAt = day,
                        Amount = amount,
                        BalanceAfter = balance,
                        Description = description,
                        Counterparty = counterparty,
                        Kind = kind,
                    });
                }
            }
        }

        return entries;
    }

    private static IEnumerable<(long Amount, string Description, Counterparty? Counterparty, TransactionKind Kind)> EventsFor(
        MockBankAccount account, DateOnly day, long balance)
    {
        // a pure function of the date, so the same day gives the same amount without a random source
        var jitter = (day.DayOfYear * 137) % 4_800;

        return account.Type switch
        {
            AccountType.Current => CurrentEvents(day, jitter),
            AccountType.Savings => SavingsEvents(day, balance),
            AccountType.CreditCard => CreditCardEvents(day, balance, jitter),
            _ => [],
        };
    }

    private static IEnumerable<(long Amount, string Description, Counterparty? Counterparty, TransactionKind Kind)> CurrentEvents(
        DateOnly day, int jitter)
    {
        if (day.Day == 1)
        {
            yield return (-142_500, "Huur", new Counterparty { Name = "WONINGSTICHTING DE KLEINE", Iban = LandlordIban }, TransactionKind.DirectDebit);
        }

        if (day.Day == 12)
        {
            yield return (-8_950, "Energie maandtermijn", new Counterparty { Name = "MOCK ENERGIE NV" }, TransactionKind.DirectDebit);
        }

        if (day.Day == 24)
        {
            yield return (285_000, "Salaris", new Counterparty { Name = "MOCK EMPLOYER BV", Iban = SalaryIban }, TransactionKind.Transfer);
        }

        if (day.Day == 25)
        {
            yield return (-50_000, "Naar Oranje Spaarrekening", new Counterparty { Name = "O DOKER", Iban = SavingsIban }, TransactionKind.Transfer);
        }

        if (day.DayOfWeek == DayOfWeek.Saturday)
        {
            yield return (-(3_200 + jitter), "Betaalautomaat", Merchant(day), TransactionKind.CardPayment);
        }

        if (day.DayOfWeek == DayOfWeek.Wednesday)
        {
            yield return (-(850 + (jitter % 1_400)), "Betaalautomaat", Merchant(day), TransactionKind.CardPayment);
        }
    }

    private static IEnumerable<(long Amount, string Description, Counterparty? Counterparty, TransactionKind Kind)> SavingsEvents(
        DateOnly day, long balance)
    {
        if (day.Day == 25)
        {
            yield return (50_000, "Van Betaalrekening", new Counterparty { Name = "O DOKER", Iban = CurrentIban }, TransactionKind.Transfer);
        }

        // quarter-end interest at 1.5% annual, integer arithmetic: a rounding fixture's chain drifts
        if (day.Month % 3 == 0 && day.Day == DateTime.DaysInMonth(day.Year, day.Month))
        {
            yield return (balance * 15 / 4_000, "Rente", null, TransactionKind.Interest);
        }
    }

    private static IEnumerable<(long Amount, string Description, Counterparty? Counterparty, TransactionKind Kind)> CreditCardEvents(
        DateOnly day, long balance, int jitter)
    {
        if (day.DayOfWeek is DayOfWeek.Monday or DayOfWeek.Thursday)
        {
            yield return (-(1_100 + (jitter % 3_900)), "Card purchase", Merchant(day), TransactionKind.CardPayment);
        }

        // the settlement clears whatever is outstanding, so the balance returns to zero like a real card
        if (day.Day == 5 && balance < 0)
        {
            yield return (-balance, "Automatische incasso creditcard", new Counterparty { Name = "O DOKER", Iban = CurrentIban }, TransactionKind.DirectDebit);
        }
    }

    private static Counterparty Merchant(DateOnly day) =>
        new() { Name = Merchants[day.DayOfYear % Merchants.Length] };

    // near the recent end: a fetch window is a suffix, so an older corruption would go unfetched and look healthy
    // not the last row: a break is a property of a pair, so the verifier needs a row after it
    private static List<MockBankEntry> Corrupt(List<MockBankEntry> entries)
    {
        var current = entries
            .Select((entry, index) => (entry, index))
            .Where(x => string.Equals(x.entry.AccountExternalId, CurrentIban, StringComparison.Ordinal))
            .Select(x => x.index)
            .ToList();

        var target = current[^3];
        entries[target] = entries[target] with { BalanceAfter = entries[target].BalanceAfter + 500 };
        return entries;
    }
}
