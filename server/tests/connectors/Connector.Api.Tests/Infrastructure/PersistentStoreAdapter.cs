using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// A T4 provider: a browser that lives on hardware the account holder owns and
/// stays signed in between runs. ASN's shape, without ASN.
///
/// <para>
/// It exists because <c>ResolveProfileAsync</c> - which decides WHICH browser
/// directory on WHICH machine a connection lands in - runs for no other
/// provider in this suite. <c>runtime: browser_persistent</c> is the only thing
/// that turns it on, the shipped fleet's one such provider is a real bank that
/// cannot be driven from a test, and so the routing that carries a person's
/// bank session to the right machine had no coverage at all.
/// </para>
///
/// <para>
/// Nothing here ever runs. The manifest is BYO and agent-required, so
/// <c>InlineJobRunner</c> will not touch it and the login job sits queued for
/// an agent that this suite never stands up - which is exactly the state the
/// profile decision has already been made in.
/// </para>
/// </summary>
internal sealed class PersistentStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-persistent-store";

    public const string AgentField = "agent_id";

    /// <summary>
    /// ASN's <c>browser_code</c>: the digits a browser the bank already trusts
    /// signs in with. Secret, client-held, optional - a browser has to be
    /// registered before it has one.
    /// </summary>
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

        // BYO is not a preference here; the validator refuses any other class
        // on this runtime, because a persistent login belongs on hardware the
        // user controls.
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
        UnattendedFetch = true,

        // A pointer rather than a credential, as every persistent connection
        // holds: the bundle names the agent and the profile, and the session
        // itself never leaves the machine.
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
