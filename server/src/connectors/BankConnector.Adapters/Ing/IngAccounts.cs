using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Ing;

// AgreementId ties a transactions page to its account: ING repeats it in each transaction's links, while the id
// in the URL is encrypted per session. SelfPath: a card's balance is only on its self link, followed not composed
// (ING refused composed addresses). TransactionsPath: the history route for savings, cards and loans
internal readonly record struct IngAccount(
    Account Record,
    string? AgreementId,
    string? SelfPath = null,
    string? TransactionsPath = null);

// display names must be language-independent: a name that changes with the holder's language changes the content hash
// and republishes an unchanged account (savings productName is stable; credit-card creditCardProductName is translated)
// /global/agreements lists every account; the per-type readers are the fallback, confirmed against a live capture
internal static class IngAccounts
{
    // written from a schema, not a sample (the capture withheld this response); LOYALTY (ING Punten) is skipped: not money
    // status is NOT filtered: only ACTIVE was ever seen and dropping unknown words would drop accounts
    // note carries the account TYPE only, never balance or account: safe to log
    public static IReadOnlyList<IngAccount> ReadAgreements(
        JsonDocument payload, string sessionId, DateOnly asOf, Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("agreements", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the agreement list has no 'agreements' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray())
        {
            // a non-object entry is a shape change and is refused: a hole in the agreement list is a silently lost account
            // (elsewhere JsonRead.Objects() drops the hole, since stopping would cost the page)
            if (entry.ValueKind != JsonValueKind.Object)
            {
                throw ConnectorException.ProviderChanged(
                    $"{IngAdapter.ProviderId}: the agreement list holds a {entry.ValueKind} where an " +
                    "agreement was expected");
            }

            // type leads, group is the fallback: they agreed on every observed agreement, so ING's preference is not established
            var kind = entry.Text("type") ?? entry.Text("group");

            if (string.Equals(kind, "LOYALTY", StringComparison.OrdinalIgnoreCase)) continue;

            var commercial = entry.Child("commercialId");
            var balance = entry.Child("balance");

            var stated = commercial.Text("value");

            // an IBAN only when ING says so: a loan states its contract number in the same field
            var iban = string.Equals(commercial.Text("type"), "IBAN", StringComparison.OrdinalIgnoreCase)
                ? stated
                : null;

            var externalId = stated ?? entry.Text("accountId") ?? entry.Text("id")
                ?? throw ConnectorException.ProviderChanged(
                    $"{IngAdapter.ProviderId}: an agreement of type '{kind}' states no identifier of any kind");

            var type = Kind(kind);
            var currency = balance.Currency("currency");
            var figure = Stated(balance, currency, asOf);

            // speak only when ING sent a balance this reader could not use; a card states none here by design and is read
            // from its own resource afterwards
            if (figure is null && balance.ValueKind == JsonValueKind.Object)
            {
                note?.Invoke(
                    $"{IngAdapter.ProviderId}: a {AccountTypes.Wire(type)} agreement states a balance this " +
                    $"reader could not make a figure out of, so it is listed without one. ING stated it as " +
                    $"{Shape(balance)}");
            }

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = externalId,
                    Type = type,
                    DisplayName = Name(entry, type, iban) ?? externalId,
                    Currency = currency,
                    Iban = iban,
                    Balance = figure,
                }),
                Agreement(entry),
                Link(entry, "self"),
                Link(entry, "transactions")));
        }

        return accounts;
    }

    /// a string or a JSON number: ING sends both for a field of this name (/accounts/current "-1730.01", savings 8.2);
    /// accepting only one reports an account with no balance; both go through MoneyParser so no cent is lost
    private static Balance? Stated(JsonElement balance, string currency, DateOnly asOf)
    {
        if (balance.ValueKind != JsonValueKind.Object) return null;

        var value = balance.Child("value");

        return value.ValueKind switch
        {
            JsonValueKind.String => Balance(value.GetString(), currency, asOf),
            JsonValueKind.Number => Balance(balance.Decimal("value"), currency, asOf),
            _ => null,
        };
    }

    private static string Shape(JsonElement balance) => IngSchema.Describe(balance, maxChars: 120);

    /// first match wins: the card agreement stated self twice, pointing at the same resource
    private static string? Link(JsonElement entry, string relation) =>
        entry.Items("_links")
            .Where(link => string.Equals(link.Text("rel"), relation, StringComparison.OrdinalIgnoreCase))
            .Select(link => link.Text("href"))
            .FirstOrDefault();

    /// a card's balance is on its own screen (self link), not in any list; the root `balance` shape is a guess,
    /// not an observed one
    public static Balance? ReadDetailsBalance(JsonDocument payload, string currency, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        var balance = payload.RootElement.Child("balance");

        return Stated(balance, balance.Text("currency")?.ToUpperInvariant() ?? currency, asOf);
    }

    /// an unrecognised type becomes Unknown instead of vanishing: a misfiled account is easier to notice than a missing one
    private static AccountType Kind(string? stated) => stated?.ToUpperInvariant() switch
    {
        "CURRENT" => AccountType.Current,
        "SAVINGS" => AccountType.Savings,
        "CARD" => AccountType.CreditCard,
        "LOAN" => AccountType.Loan,
        _ => AccountType.Unknown,
    };

    /// the IBAN where there is one (language-independent); savings uses productName, identical in NL and EN;
    /// displayAlias is unused: it is the holder's to rename and would republish the account
    private static string? Name(JsonElement entry, AccountType type, string? iban) =>
        type == AccountType.Savings ? entry.Text("productName") ?? iban : iban;

    /// taken only when identifierType is UUID: a card's was LOCAL_ID, and a colliding local id would file
    /// transactions under the wrong account
    private static string? Agreement(JsonElement entry) =>
        string.Equals(entry.Text("identifierType"), "UUID", StringComparison.OrdinalIgnoreCase)
            ? entry.Text("id")
            : null;

    /// holderAccounts plus internetProxyAccounts (accounts others gave access to; empty on the capture) so none goes missing
    public static IReadOnlyList<IngAccount> ReadCurrent(JsonDocument payload, string sessionId, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("currentAccounts", out var wrapper))
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the current-accounts payload has no 'currentAccounts'");
        }

        var accounts = new List<IngAccount>();

        foreach (var list in new[] { "holderAccounts", "internetProxyAccounts" })
        {
            foreach (var entry in wrapper.Items(list).Objects())
            {
                var iban = entry.Text("accountNumber")
                           ?? throw ConnectorException.ProviderChanged(
                               $"{IngAdapter.ProviderId}: a current account states no accountNumber");

                accounts.Add(new IngAccount(
                    BankRecords.NewAccount(sessionId, new AccountDraft
                    {
                        ExternalId = iban,
                        Type = AccountType.Current,
                        // the IBAN: `name` is the holder's own name and `type.description` is a label ING may translate
                        DisplayName = iban,
                        Currency = entry.Currency("dynamicBalanceCurrency"),
                        Iban = iban,
                        Balance = Balance(
                            entry.Text("dynamicBalance"),
                            entry.Currency("dynamicBalanceCurrency"),
                            asOf),
                    }),
                    entry.Text("uuid")));
            }
        }

        return accounts;
    }

    /// a JSON number here, one decimal in the capture: via MoneyParser, since (long)(GetDouble() * 100) turns 8.2 into 819 cents
    public static IReadOnlyList<IngAccount> ReadSavings(JsonDocument payload, string sessionId, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("data", out var array) || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the savings payload has no 'data' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray().Objects())
        {
            var id = entry.Child("accountId");

            var iban = id.Text("iban")
                       ?? throw ConnectorException.ProviderChanged(
                           $"{IngAdapter.ProviderId}: a savings account states no iban");

            var currency = entry.Currency("currency");
            var stated = entry.Child("dynamicBalance");

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = iban,
                    Type = AccountType.Savings,
                    // productName is the same string in both languages; nickName is unused: the holder's to change, it would
                    // republish the account
                    DisplayName = entry.Text("productName") ?? iban,
                    Currency = currency,
                    Iban = iban,
                    Balance = Balance(
                        stated.Decimal("amount"),
                        stated.Text("currency")?.ToUpperInvariant() ?? currency,
                        asOf),
                }),
                id.Text("commercialId")));
        }

        return accounts;
    }

    /// no balance: nothing in the payload is an amount, and a zero would read as a settled card; named by the masked
    /// number because creditCardProductName is translated
    public static IReadOnlyList<IngAccount> ReadCreditCards(
        JsonDocument payload, string sessionId, string currency)
    {
        ArgumentNullException.ThrowIfNull(payload);

        if (!payload.RootElement.Has("creditCards", out var array) || array.ValueKind != JsonValueKind.Array)
        {
            throw ConnectorException.ProviderChanged(
                $"{IngAdapter.ProviderId}: the credit-card payload has no 'creditCards' array");
        }

        var accounts = new List<IngAccount>();

        foreach (var entry in array.EnumerateArray().Objects())
        {
            var id = entry.Text("arrangementId")
                     ?? throw ConnectorException.ProviderChanged(
                         $"{IngAdapter.ProviderId}: a credit card states no arrangementId");

            var masked = entry.Text("maskedCardNumber");

            accounts.Add(new IngAccount(
                BankRecords.NewAccount(sessionId, new AccountDraft
                {
                    ExternalId = id,
                    Type = AccountType.CreditCard,
                    DisplayName = masked ?? id,
                    Currency = currency,
                    MaskedNumber = masked,
                }),
                null));
        }

        return accounts;
    }

    /// dated by the caller's clock, not UtcNow: ING never says when a balance was true, and a live clock would
    /// change the test suite's content hashes at midnight
    private static Balance? Balance(string? stated, string currency, DateOnly asOf) =>
        string.IsNullOrWhiteSpace(stated)
            ? null
            : Stamp(MoneyParser.ToMinor(stated, MoneyUnit.MajorString, "balance"), currency, asOf);

    private static Balance? Balance(decimal? stated, string currency, DateOnly asOf) =>
        stated is not { } value
            ? null
            : Stamp(MoneyParser.ToMinor(value, MoneyUnit.MajorDecimal), currency, asOf);

    private static Balance Stamp(long minorUnits, string currency, DateOnly asOf) =>
        BankRecords.BalanceOn(new Money(minorUnits, currency), asOf);

    /// defaults to EUR: every captured account is in euros and several state no currency
    private static string Currency(this JsonElement parent, string name) =>
        parent.Text(name)?.ToUpperInvariant() ?? "EUR";
}
