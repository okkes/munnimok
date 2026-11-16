using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Ing;
using BankConnector.Adapters.MockBank;
using BankConnector.Adapters.OpenBanking;
using Connector.Kit.Adapters;

namespace BankConnector.Adapters;

/// Providers are code, not rows: the registry is built at startup and only a provider's HEALTH is state.
/// The control plane registers only inline-class providers; an agent registers everything it has binaries for.
public static class BankAdapters
{
    /// The mocks are registered in every environment: the only providers exercisable end to end without a real account.
    public static IReadOnlyList<IProviderAdapter> All(
        BankAdapterOptions? options = null, TimeProvider? time = null) =>
        [.. Real(options, time), .. MockFleet(time, options?.MockRecordCap)];

    /// AsnDiscoveryAdapter is NOT registered but kept: it produced every fact in AsnOptions and is not a provider.
    /// Register it again to map a screen; de Volksbank serves SNS, RegioBank and BLG Wonen from the same pages.
    public static IReadOnlyList<IProviderAdapter> Real(
        BankAdapterOptions? options = null, TimeProvider? time = null)
    {
        var settings = options ?? new BankAdapterOptions();

        return
        [
            new IngAdapter(settings.Ing, time),
            new AsnAdapter(settings.Asn, time),

            // ASN on the holder's own machine; unmeasured: whether the session survives in a persistent profile (a miss costs a re-scan)
            new AsnPersistentAdapter(settings.Asn, time),

            // aggregators only when the operator holds an account there: absent keys mean absent from the catalogue (#414)
            .. settings.GoCardless.Configured ? [new GoCardlessAdapter(settings.GoCardless, time)] : Array.Empty<IProviderAdapter>(),
            .. settings.EnableBanking.Configured ? [new EnableBankingAdapter(settings.EnableBanking, time)] : Array.Empty<IProviderAdapter>(),
        ];
    }

    /// Kept forever: what a demo user connects to, what CI runs against, the only way to exercise every runtime tier.
    /// <param name="recordCap">ceiling below the manifest's, so a test can make a pass partial (#460); else null</param>
    public static IReadOnlyList<IProviderAdapter> MockFleet(TimeProvider? time = null, int? recordCap = null) =>
    [
        new MockBankSimpleAdapter(time) { RecordCap = recordCap },
        new MockBankScaAdapter(time) { RecordCap = recordCap },
        new MockBankSlowAdapter(time) { RecordCap = recordCap },
        new MockBankBrokenAdapter(time) { RecordCap = recordCap },
        new MockBankPersistentAdapter(time) { RecordCap = recordCap },
        // the aggregator shape with nothing behind it (#414): lookup, redirect, server custody, quota, inventory
        new MockBankConsentAdapter(time) { RecordCap = recordCap },
    ];

    /// Only providers with agent.required false: more in the control plane would lease jobs no local process can serve.
    public static IReadOnlyList<IProviderAdapter> InlineOnly(TimeProvider? time = null) =>
        [.. All(time: time).Where(a => !a.Describe().Agent.Required)];

    public static IProviderRegistry MockRegistry(TimeProvider? time = null) =>
        new ProviderRegistry(MockFleet(time));
}

/// Every real bank's unconfirmed value is reachable from here, so a site change is a deploy-time edit rather than a release.
public sealed record BankAdapterOptions
{
    public IngOptions Ing { get; init; } = new();

    public AsnOptions Asn { get; init; } = new();

    /// <summary>The operator's aggregator accounts (#414): a party exists when its keys do.</summary>
    public GoCardlessOptions GoCardless { get; init; } = new();

    public EnableBankingOptions EnableBanking { get; init; } = new();

    /// <summary>Test-only: the mock banks' per-fetch ceiling, so their passes come back partial (#460). Null in every environment.</summary>
    public int? MockRecordCap { get; init; }
}
