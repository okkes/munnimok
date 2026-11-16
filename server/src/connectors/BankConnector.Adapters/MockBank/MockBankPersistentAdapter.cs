using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.MockBank;

// T4, bring-your-own agent: the sealed bundle holds only {agent_id, profile_id}, no secret, so a breach yields nothing
// jobs route only to that agent; if it is off the answer is AgentUnavailable with StartYourAgent, not a retry loop
public sealed class MockBankPersistentAdapter : MockBankAdapter
{
    public const string ProviderId = "mock-bank-persistent";

    public const string AgentIdKey = "agent_id";

    private const int TtlSeconds = 31_536_000;   // a year

    private static readonly ProviderManifest Instance = new()
    {
        Id = ProviderId,
        Name = "Mock Bank (always-on)",
        Kind = ProviderKind.Bank,
        Fixture = true,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserPersistent,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
        UnattendedFetch = true,
        SecretCustody = SecretCustody.Agent,
        // a bundle holding only a pointer is safe anywhere, so a web client with a BYO agent gets a fully persistent connection
        WebSupport = WebSupport.Ephemeral,
        LogoRef = MockBankManifests.LogoRef,
        NotesKey = "connect.mock_bank.persistent_notes",
        Auth = new AuthSpec
        {
            Flow = AuthFlow.DevicePersistent,
            Steps =
            [
                new AuthStep
                {
                    Id = "agent",
                    LabelKey = "connect.mock_bank.step.pick_agent",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = AgentIdKey,
                            Type = FieldType.Text,
                            Secret = false,

                            // required because LoginAsync requires it: optional let a blank pass the form and fail the job
                            Required = true,
                            LabelKey = "connect.mock_bank.field.agent_id",
                            Pattern = "^agt_[0-9a-f]{32}$",
                        },
                    ],
                },
            ],
            // Raised once, at enrollment, and never again.
            Challenges = [ChallengeType.QrDisplay],
            Session = new SessionSpec { TtlSeconds = TtlSeconds, Refreshable = true, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = true },
        },
        Resources = MockBankManifests.Resources(typicalDurationSeconds: 20),
        Limits = MockBankManifests.Limits(),
    };

    public MockBankPersistentAdapter(TimeProvider? time = null) : base(time)
    {
    }

    public override ProviderManifest Describe() => Instance;

    public override Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();

        var agentId = RequireInput(ctx, AgentIdKey);
        if (!Ids.Is(agentId, Ids.Agent))
        {
            throw ConnectorException.InvalidRequest($"'{AgentIdKey}' must be an agent id");
        }

        ctx.Progress(JobStep.OpeningProvider);

        // no CredentialSubmitted: nothing goes upstream, the human already authenticated into the profile
        ctx.Progress(JobStep.Finalizing);

        return Task.FromResult(Connected(ctx, SessionMaterial.ForAgent(agentId, Ids.New(Ids.Profile)), TtlSeconds));
    }

    public override Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ct.ThrowIfCancellationRequested();

        if (ctx.Material?.AgentId is null || ctx.Material.ProfileId is null)
        {
            throw new ConnectorException(
                ErrorCode.AgentUnavailable,
                $"{ProviderId}: this session's material names no agent and profile, so no host holds its login");
        }

        ctx.Progress(JobStep.OpeningProvider);
        return Task.FromResult(Serve(ctx, request));
    }
}
