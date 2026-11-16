using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// T1: munni's demo identity, the only provider running inline in the control plane,
// so connect-fetch-ack works with no agent, browser or network
public sealed class MockBankSimpleAdapter : MockBankAdapter
{
    public const string ProviderId = "mock-bank-simple";

    private const int TtlSeconds = 2_592_000;   // 30 days

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (simple)",
        Kind = ProviderKind.Bank,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.Http,
        Agent = AgentRequirement.Inline,
        UnattendedFetch = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.notes",
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps = [MockBankManifests.Credentials],
            Challenges = [],
            Session = new SessionSpec { TtlSeconds = TtlSeconds, Refreshable = true, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources = MockBankManifests.Resources(typicalDurationSeconds: 2),
        Limits = MockBankManifests.Limits(),
    };

    public MockBankSimpleAdapter(TimeProvider? time = null) : base(time)
    {
    }

    public override ProviderManifest Describe() => Instance;

    public override Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();

        ctx.Progress(JobStep.OpeningProvider);
        _ = RequireInput(ctx, "username");
        var password = RequireInput(ctx, "password");

        ctx.Progress(JobStep.Authenticating);

        // latched before the verdict: once a credential went upstream a lost lease must fail the job
        // permanently, whatever the outcome
        ctx.CredentialSubmitted();

        if (string.Equals(password, MockBankCredentials.RejectedPassword, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidCredentials($"{ProviderId}: fixture rejects this password");
        }

        ctx.Progress(JobStep.Finalizing);

        return Task.FromResult(Connected(ctx, new SessionMaterial
        {
            AccessToken = Ids.New("mockat"),
            RefreshToken = Ids.New("mockrt"),
            AccessTokenExpiresAt = Time.GetUtcNow().AddHours(1),
            // minted once for the session: rotating a device id every run is a fraud signal
            DeviceId = Ids.New(Ids.Profile),
        }, TtlSeconds));
    }
}
