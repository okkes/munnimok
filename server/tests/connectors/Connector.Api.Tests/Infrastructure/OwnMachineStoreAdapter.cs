using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

// T3 provider that runs only on the account holder's own machine (DUO's shape): BYO, agent-required, browser_interactive
// profile pinning once hung off the runtime (browser_persistent only), so it got none of the own-machine routing
// never runs: no agent in this suite serves it
internal sealed class OwnMachineStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-own-machine-store";

    // optional, as DUO's: the field keeps this manifest from being the no-fields shape the input validator treats specially
    public const string UsernameField = "username";

    private static readonly ProviderManifest Contract = Build();

    public ProviderManifest Describe() => Contract;

    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    private static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "Own Machine Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,

        // T3: a browser drives the sign-in and nothing keeps one open between runs
        Runtime = ProviderRuntime.BrowserInteractive,

        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },

        // false, as DUO's: the provider re-authenticates the human whenever an authentication is initiated, so no fetch runs alone
        UnattendedFetch = false,

        // client, not agent: agent custody is refused outside browser_persistent
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        Logout = LogoutSupport.None,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = "connect.step.credentials",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = UsernameField,
                            Type = FieldType.Text,
                            Secret = false,
                            Required = false,
                            LabelKey = "connect.field.username",
                        },
                    ],
                },
            ],
            Challenges = [ChallengeType.LiveView],

            // DUO's idle quarter of an hour: a second connect inside it costs the human nothing
            Session = new SessionSpec { TtlSeconds = 900, Refreshable = false, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
