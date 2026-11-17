using Connector.Kit.Manifests;

namespace BankConnector.Adapters.MockBank;

internal static class MockBankManifests
{
    public const string LogoRef = "mock-bank";

    public static readonly FieldSpec Username = new()
    {
        Key = "username",
        Type = FieldType.Text,
        Secret = false,
        LabelKey = "connect.field.username",
        Pattern = "^.{3,64}$",
        Autofill = "username",
    };

    public static readonly FieldSpec Password = new()
    {
        Key = "password",
        Type = FieldType.Password,
        Secret = true,
        LabelKey = "connect.field.password",
        Pattern = "^.{4,128}$",
        Autofill = "current-password",
    };

    public static readonly AuthStep Credentials = new()
    {
        Id = "credentials",
        LabelKey = "connect.mock_bank.step.credentials",
        Fields = [Username, Password],
    };

    // residential Dutch line: a datacenter range is a fraud signal for banks, so even the mocks declare it to exercise routing
    public static readonly AgentRequirement ResidentialPooled = new()
    {
        Required = true,
        Class = AgentClass.Pooled,
        Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
    };

    public static IReadOnlyList<ResourceSpec> Resources(int typicalDurationSeconds = 10) =>
    [
        BankResources.AccountsSpec(),
        BankResources.TransactionsSpec(
            maxHistoryDays: MockBankLedger.HistoryDays,
            typicalDurationSeconds: typicalDurationSeconds),
    ];

    // every mock set has a credit card, so every manifest declares the settlement lag: a purchase can surface 14 days late
    // dated to its day, and a since that is not widened loses it
    public static ProviderLimits Limits() => BankLimits.ForBank(
        minIntervalSeconds: BankLimits.MockMinIntervalSeconds,
        maxHistoryDays: MockBankLedger.HistoryDays,
        settlementLagDays: BankLimits.DutchCardSettlementLagDays);
}
