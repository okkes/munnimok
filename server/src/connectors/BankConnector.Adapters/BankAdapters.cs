using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Ing;
using BankConnector.Adapters.MockBank;
using Connector.Kit.Adapters;

namespace BankConnector.Adapters;

/// <summary>
/// The bank connector's provider set.
///
/// Providers are code, not rows: the registry is built at startup from this
/// list and only a provider's HEALTH is ever state. A host composes the
/// fleet it wants - the control plane registers only inline-class providers
/// it can actually run, an agent registers everything it has binaries for.
/// </summary>
public static class BankAdapters
{
    /// <summary>
    /// Real banks plus the mock set. The mocks are registered in every
    /// environment on purpose: they are the only providers that can be
    /// exercised end to end without somebody's real account, and an
    /// environment that cannot demonstrate its own protocol is one nobody can
    /// debug.
    /// </summary>
    public static IReadOnlyList<IProviderAdapter> All(
        BankAdapterOptions? options = null, TimeProvider? time = null) =>
        [.. Real(options, time), .. MockFleet(time)];

    /// <summary>
    /// The banks with somebody's money behind them.
    /// </summary>
    /// <remarks>
    /// ASN IS HERE NOW, and it took two discovery sessions to earn the line.
    /// The first adapter of that name was written from a design document and
    /// deleted when a live run showed a bank of a different shape - a cookie
    /// wall, three methods named by their own products, a QR with no handle at
    /// all. Everything it does now comes from <c>AsnOptions</c>, where each
    /// value is marked OBSERVED or not.
    /// <para>
    /// <c>AsnDiscoveryAdapter</c> is NOT registered, and its code is kept.
    /// It is the instrument that produced every fact in <c>AsnOptions</c>,
    /// and de Volksbank serves SNS, RegioBank and BLG Wonen from these same
    /// pages - so the next three banks are one run each away. What it is not
    /// is a provider: it connects to nothing and fetches nothing, and a
    /// catalogue is a list of things somebody can use. Register it again to
    /// map a screen, then take it back out.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<IProviderAdapter> Real(
        BankAdapterOptions? options = null, TimeProvider? time = null)
    {
        var settings = options ?? new BankAdapterOptions();

        return
        [
            new IngAdapter(settings.Ing, time),
            new AsnAdapter(settings.Asn, time),

            // ASN AGAIN, ON THE ACCOUNT HOLDER'S OWN MACHINE.
            //
            // Registered now, and the objection it waited on is worth
            // recording as spent rather than deleted. It was: a permanently
            // authenticated bank session built against screens nobody had
            // driven is the worst available combination of consequential and
            // unverified. Every one of those screens has since been walked on
            // a live account - the QR sign-in, the account picker, the CAMT.053
            // modal, the download, the balance chain - by the adapter this one
            // composes rather than copies.
            //
            // What is still unmeasured is whether ASN's session survives in a
            // persistent profile at all, and the adapter is built so that being
            // wrong about it costs a re-scan and says so, rather than being
            // assumed anywhere.
            new AsnPersistentAdapter(settings.Asn, time),

        ];
    }

    /// <summary>
    /// The complete mock fleet. Kept forever, not deleted once real
    /// providers land: it is what a demo user connects to, what CI runs
    /// against, and the only way to exercise every runtime tier and
    /// challenge type without five live bank accounts.
    /// </summary>
    public static IReadOnlyList<IProviderAdapter> MockFleet(TimeProvider? time = null) =>
    [
        new MockBankSimpleAdapter(time),
        new MockBankScaAdapter(time),
        new MockBankSlowAdapter(time),
        new MockBankBrokenAdapter(time),
        new MockBankPersistentAdapter(time),
    ];

    /// <summary>
    /// The subset a browserless host can run: the providers whose manifest
    /// declares <c>agent.required: false</c>. Registering more than this in
    /// the control plane would mean leasing a job no local process can
    /// serve.
    /// </summary>
    public static IReadOnlyList<IProviderAdapter> InlineOnly(TimeProvider? time = null) =>
        [.. All(time: time).Where(a => !a.Describe().Agent.Required)];

    public static IProviderRegistry MockRegistry(TimeProvider? time = null) =>
        new ProviderRegistry(MockFleet(time));
}

/// <summary>
/// The binding target for a host's configuration section. Every real bank's
/// unconfirmed values - endpoints, selectors, page sizes, timeouts - are
/// reachable from here, so correcting one after a bank changes its site is a
/// deploy-time edit rather than a release.
/// </summary>
public sealed record BankAdapterOptions
{
    public IngOptions Ing { get; init; } = new();

    /// <summary>
    /// ASN's unconfirmed values. Only the login URL is read today - the
    /// discovery run needs somewhere to start and nothing else - and the rest
    /// are what a session fills in.
    /// </summary>
    public AsnOptions Asn { get; init; } = new();
}
