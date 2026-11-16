using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters;

/// Written out, not derived from the enum name: the wire form is snake_case public contract; a C# rename must not change it.
public static class AccountTypes
{
    /// loan is selectable: ING serves loans, and without it a caller could receive one but not ask for one.
    /// unknown stays out: it is the connector not recognising something, so a filter would select a different set per release.
    public static readonly IReadOnlyList<string> Selectable = ["current", "savings", "credit_card", "loan"];

    public static string Wire(AccountType type) => type switch
    {
        AccountType.Current => "current",
        AccountType.Savings => "savings",
        AccountType.CreditCard => "credit_card",
        AccountType.Loan => "loan",
        _ => "unknown",
    };

    public static bool TryParse(string? wire, out AccountType type)
    {
        switch (wire)
        {
            case "current": type = AccountType.Current; return true;
            case "savings": type = AccountType.Savings; return true;
            case "credit_card": type = AccountType.CreditCard; return true;
            case "loan": type = AccountType.Loan; return true;
            default: type = AccountType.Unknown; return false;
        }
    }
}

/// Filters by account type, not id: ids are minted per session and exist only after a login.
public static class BankAccountFilter
{
    /// Omitted accounts means everything reachable; an unreachable type is UnsupportedResource with the reachable set,
    /// never a silent empty result.
    public static IReadOnlyList<Account> Select(IReadOnlyList<Account> reachable, ResourceRequest request)
    {
        ArgumentNullException.ThrowIfNull(reachable);
        ArgumentNullException.ThrowIfNull(request);

        var wanted = request.Accounts;
        if (wanted.Count == 0) return reachable;

        var types = new HashSet<AccountType>();
        foreach (var wire in wanted)
        {
            if (!AccountTypes.TryParse(wire, out var type))
            {
                throw ConnectorException.Unsupported($"unknown account type '{wire}'; {Reachable(reachable)}");
            }

            if (!reachable.Any(a => a.Type == type))
            {
                throw ConnectorException.Unsupported($"account type '{wire}' is not reachable by this session; {Reachable(reachable)}");
            }

            types.Add(type);
        }

        // Filtering the reachable list rather than concatenating per type
        // keeps the provider's own account order and cannot emit a duplicate
        // when a caller names the same type twice.
        return [.. reachable.Where(a => types.Contains(a.Type))];
    }

    private static string Reachable(IReadOnlyList<Account> accounts) =>
        "reachable: " + string.Join(',', accounts.Select(a => AccountTypes.Wire(a.Type)).Distinct(StringComparer.Ordinal));
}
