using Connector.Kit.Adapters;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace BankConnector.Adapters;

// every adapter ends here: the running-balance chain is the only check that catches misordered, misread,
// inverted or dropped rows, all of which look believable
public static class BankEmission
{
    // rows stay in the provider's order (oldest first per account), NOT sorted: wrong order is a failure the chain
    // check exists to catch
    public static FetchResult Verified(
        string providerId,
        IReadOnlyList<Account> accounts,
        IReadOnlyList<Transaction> transactions,
        bool complete = true,
        string? via = null,
        SessionMaterial? refreshedMaterial = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);
        ArgumentNullException.ThrowIfNull(accounts);
        ArgumentNullException.ThrowIfNull(transactions);

        VerifyPerAccount(providerId, transactions);

        return new FetchResult
        {
            Accounts = accounts,
            Transactions = transactions,
            Complete = complete,
            Via = via,
            RefreshedMaterial = refreshedMaterial,
        };
    }

    // per account: a concatenation would break the chain at every seam; each account's relative order is preserved
    public static void VerifyPerAccount(string providerId, IReadOnlyList<Transaction> transactions)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);
        ArgumentNullException.ThrowIfNull(transactions);

        var byAccount = new Dictionary<string, List<Transaction>>(StringComparer.Ordinal);
        foreach (var tx in transactions)
        {
            if (!byAccount.TryGetValue(tx.AccountId, out var rows))
            {
                rows = [];
                byAccount[tx.AccountId] = rows;
            }

            rows.Add(tx);
        }

        foreach (var rows in byAccount.Values)
        {
            BalanceChain.Verify(rows, providerId);
        }
    }

    // keeps the OLDEST rows as a contiguous prefix: the chain stays intact and the caller gets no hidden gap; the
    // control plane owns cursors
    public static (IReadOnlyList<Transaction> Page, bool Complete) Page(
        IReadOnlyList<Transaction> ordered, int maxRecords)
    {
        ArgumentNullException.ThrowIfNull(ordered);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxRecords);

        return ordered.Count <= maxRecords
            ? (ordered, true)
            : ([.. ordered.Take(maxRecords)], false);
    }
}
