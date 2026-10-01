using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// A pooled provider that will only be reached from a Dutch residential line.
/// BKR's shape, and Jumbo's, without either.
///
/// <para>
/// Thirteen shipped manifests ask for an address and every one of them belongs
/// to another product or drags something else in with it: DUO's is entangled
/// with the account-holder's-own-machine rule, AH's login is streamed, bol's
/// needs a human at the browser. This one asks for an address and nothing else,
/// so a test that fails here has failed about egress.
/// </para>
///
/// <para>
/// Pooled on purpose, which is the half the own-machine double cannot cover: a
/// residential requirement is a statement about the LINE, not about whose
/// computer it is, and the operator's own residential box satisfies it exactly
/// as a household's NAS does. Nothing in this suite serves it, which is the
/// state every routing decision under test is made in.
/// </para>
/// </summary>
internal sealed class ResidentialStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-residential-store";

    /// <summary>
    /// Optional, as the own-machine double's is: a login that types nothing is
    /// still a login, and the field exists so this manifest is not the one
    /// shape - no fields at all - the input validator treats specially.
    /// </summary>
    public const string UsernameField = "username";

    /// <summary>What the manifest asks to be reached from, for a test to assert against.</summary>
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

        // Browser-tier, because that is what an address requirement is about:
        // an http call from a datacenter is judged too, but the providers that
        // refuse one outright are the ones being driven through a browser.
        Runtime = ProviderRuntime.BrowserInteractive,

        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            Egress = Needs,
        },

        // False, so the headed rule never gets a chance to decide anything
        // here. A login that needs somebody at the browser is a different
        // exclusion with its own suite, and a double that declared both would
        // let either of them pass this one's tests.
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
