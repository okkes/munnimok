using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// The ordinary shop shape and nothing else: an agent is required, the
/// operator's pool may serve it, and a machine of the caller's may serve it
/// too. DUO's shape since 2026-09-21, and every shipped store's.
///
/// <para>
/// This is the provider the "Run it on" dropdown has TWO real answers for, and
/// the only kind where asking for the fleet is a choice rather than a
/// contradiction. The own-machine double beside it refuses the fleet by
/// manifest and the residential one refuses most agents by address; neither
/// can express "either of these could have taken it, and the caller said
/// which".
/// </para>
///
/// <para>
/// NO EGRESS REQUIREMENT, deliberately, and it is the reason this is a sixth
/// double rather than a shipped provider. Every pooled store in this tree asks
/// to be reached from a Dutch line, so a fleet agent would have to claim one
/// before it could serve the provider at all - and a test about who asked for
/// the fleet would then fail, or pass, on the address a test agent happened to
/// claim. It is also the reason not to borrow mediamarkt-nl: the suite shares
/// one host, other classes leave queued logins for shipped providers behind,
/// and a FLEET lease sees every caller's work rather than one subject's - so
/// "the job I queued came back" would be an assertion about the order of the
/// whole assembly.
/// </para>
///
/// <para>
/// Nothing here ever runs. No agent in this suite serves it, which is exactly
/// the state every routing decision under test is made in.
/// </para>
/// </summary>
internal sealed class PooledStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-pooled-store";

    /// <summary>
    /// Optional, as the other routing doubles' are: a login that types nothing
    /// is still a login, and the field exists so this manifest is not the one
    /// shape - no fields at all - the input validator treats specially.
    /// </summary>
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

        // T3, because that is the tier where both answers are real: an http
        // provider runs inside the control plane and has no machine of
        // anybody's to be pointed at, and a persistent one can only ever be a
        // machine of the caller's.
        Runtime = ProviderRuntime.BrowserInteractive,

        Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },

        // False, so the headed rule never gets a chance to decide anything
        // here. A login that needs somebody at the browser is a different
        // exclusion with its own suite, and a double declaring both would let
        // either of them pass this one's tests.
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
