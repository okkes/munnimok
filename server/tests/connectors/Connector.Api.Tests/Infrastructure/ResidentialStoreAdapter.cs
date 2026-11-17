using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

// pooled, reachable only from a Dutch residential line (BKR's and Jumbo's shape): asks for an address and nothing else
// pooled on purpose: residential is about the LINE, not whose computer; the operator's residential box satisfies it too
internal sealed class ResidentialStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-residential-store";

    // optional, as the other doubles': the field avoids the no-fields shape the input validator treats specially
    public const string UsernameField = "username";

    public static EgressRequirement Needs { get; } =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    private static readonly ProviderManifest Contract = Build();

    public ProviderManifest Describe() => Contract;

    public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
        throw new NotSupportedException($"{ProviderId} is never leased: no agent in this suite serves it");

    private static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "Residential Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,

        // browser-tier: the providers that refuse a datacenter address outright are the ones driven through a browser
        Runtime = ProviderRuntime.BrowserInteractive,

        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            Egress = Needs,
        },

        // false: the headed rule is another exclusion with its own suite and must not decide here
        LoginNeedsHeadedAgent = false,

        UnattendedFetch = false,
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
            Session = new SessionSpec { TtlSeconds = 86_400, Refreshable = false },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
