using Connector.Kit.Manifests;

namespace BankConnector.Adapters;

// one spec for every bank: per-provider copies could spell a parameter differently and break the generic route handler
public static class BankResources
{
    public const string Accounts = "accounts";
    public const string Transactions = "transactions";

    /// cheap discovery: served from the bundle's reachable set while fresh, so seconds rather than a browser login
    public static ResourceSpec AccountsSpec() => new()
    {
        Id = Accounts,
        Returns = ResourceShape.Account,
        TypicalDurationSeconds = 5,
        MaxRecordsPerFetch = 50,
    };

    // accountTypes: only the types the provider can TELL APART. ASN states no type, so all its accounts are Current;
    // defaulting to all four let callers tick credit_card and loan on a connection that has neither
    public static ResourceSpec TransactionsSpec(
        int maxHistoryDays = 540,
        int typicalDurationSeconds = 90,
        int maxRecordsPerFetch = 200,
        IReadOnlyList<string>? accountTypes = null,
        string? notesKey = null) => new()
    {
        Id = Transactions,
        Returns = ResourceShape.Transaction,
        MaxHistoryDays = maxHistoryDays,
        TypicalDurationSeconds = typicalDurationSeconds,
        MaxRecordsPerFetch = maxRecordsPerFetch,
        NotesKey = notesKey,
        Params =
        [
            // filtered by TYPE, not id: ids are minted per session, so the caller has not seen them yet
            new ParamSpec
            {
                Key = "accounts",
                Type = ParamType.Enum,
                Multi = true,
                Required = false,
                Values = accountTypes ?? AccountTypes.Selectable,
            },
            new ParamSpec { Key = "since", Type = ParamType.Date, Required = false },
            new ParamSpec { Key = "until", Type = ParamType.Date, Required = false },
        ],
    };
}

public static class BankLimits
{
    /// card payments settle late (bought on the 19th, shown on the 21st still dated the 19th); 14 days covers the worst
    /// case seen, and the extra overlap is deduplicated by content hash
    public const int DutchCardSettlementLagDays = 14;

    /// platform default is 6h; a mock touches no network, so a short floor keeps demos and integration tests usable
    public const int MockMinIntervalSeconds = 60;

    public static ProviderLimits ForBank(
        int minIntervalSeconds = 21_600,
        int maxHistoryDays = 540,
        int settlementLagDays = DutchCardSettlementLagDays) => new()
    {
        MinIntervalSeconds = minIntervalSeconds,
        Concurrency = 1,
        MaxHistoryDays = maxHistoryDays,
        SettlementLagDays = settlementLagDays,
    };
}
