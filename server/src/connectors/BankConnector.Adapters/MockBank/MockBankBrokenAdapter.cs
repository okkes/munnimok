using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// always broken, to exercise the operator alert path: ProviderChanged is non-retriable, pages an operator, degrades it
// T1/inline so the alert path is testable in the control plane alone, with no agent or browser image
public sealed class MockBankBrokenAdapter : MockBankAdapter
{
    public const string ProviderId = "mock-bank-broken";

    private const int TtlSeconds = 3_600;

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (broken)",
        Kind = ProviderKind.Bank,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = false,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.notes",
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps = [MockBankManifests.Credentials],
            Challenges = [],
            Session = new SessionSpec { TtlSeconds = TtlSeconds, Refreshable = false, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = false },
        },
        Resources = MockBankManifests.Resources(typicalDurationSeconds: 2),
        Limits = MockBankManifests.Limits(),
    };

    public MockBankBrokenAdapter(TimeProvider? time = null) : base(time)
    {
    }

    // inconsistent fixture: the failure comes from the real chain verifier on real data, not a hand-thrown exception
    protected override MockBankLedger LedgerThrough(DateOnly today) => MockBankLedger.BrokenThrough(today);

    public override ProviderManifest Describe() => Instance;

    public override Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();

        ctx.Progress(JobStep.OpeningProvider);

        // no credential is submitted: the shape moved before the password, like a real adapter whose login selector vanished
        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: login form selector '#logon-form' is no longer present");
    }

    public override Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();

        // Serve's chain verifier raises provider_changed for transactions; this throw only covers accounts, which have no chain
        var result = Serve(ctx, request);

        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: served {result.Count} records whose shape no longer matches the adapter");
    }
}
