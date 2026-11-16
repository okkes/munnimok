using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Api.Tests.Infrastructure;

// T4 provider (ASN's shape): only browser_persistent turns on ResolveProfileAsync, whose routing had no coverage
// never runs: BYO and agent-required, so InlineJobRunner skips it and the login sits queued
internal sealed class PersistentStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-persistent-store";

    public const string AgentField = "agent_id";

    // ASN's browser_code: secret, client-held, optional - a browser has to be registered before it has one
    public const string PinField = "pin";

    private static readonly ProviderManifest Contract = Build();

    public ProviderManifest Describe() => Contract;

    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    private static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "Persistent Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,
        Runtime = ProviderRuntime.BrowserPersistent,

        // BYO is mandatory: the validator refuses any other class on this runtime
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
        UnattendedFetch = true,

        // a pointer, not a credential: the bundle names the agent and the profile, the session never leaves the machine
        SecretCustody = SecretCustody.Agent,
        WebSupport = WebSupport.Ephemeral,
        Logout = LogoutSupport.None,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.DevicePersistent,
            Steps =
            [
                new AuthStep
                {
                    Id = "agent",
                    LabelKey = "connect.step.agent",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = AgentField,
                            Type = FieldType.Text,
                            Secret = false,
                            Required = true,
                            LabelKey = "connect.field.agent",
                        },
                        new FieldSpec
                        {
                            Key = PinField,
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = "connect.field.pin",
                            Pattern = "^[0-9]{5}$",
                        },
                    ],
                },
            ],
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec { TtlSeconds = 31_536_000, Refreshable = true, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
