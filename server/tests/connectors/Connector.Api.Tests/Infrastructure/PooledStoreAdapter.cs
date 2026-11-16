using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

// the ordinary shop shape (every shipped store's): the one kind where asking for the fleet is a choice, not a contradiction
// no egress requirement on purpose: shipped pooled stores need a Dutch line, so a test agent's claimed address would decide
// never runs: no agent in this suite serves it
internal sealed class PooledStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-pooled-store";

    // optional, as the other doubles': the field avoids the no-fields shape the input validator treats specially
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
        Name = "Pooled Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,

        // T3: the tier where both answers are real: an http provider has no machine to point at, a persistent one is the caller's
        Runtime = ProviderRuntime.BrowserInteractive,

        Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },

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
