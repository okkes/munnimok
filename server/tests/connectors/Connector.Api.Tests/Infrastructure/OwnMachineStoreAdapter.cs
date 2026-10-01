using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Api.Tests.Infrastructure;

/// <summary>
/// A T3 provider that may only run on a machine the account holder owns. The
/// shape DUO had when this was written, without DUO.
///
/// <para>
/// The combination is the point, and until DUO arrived nothing had it: BYO and
/// agent-required, like every persistent provider, but <c>browser_interactive</c>
/// rather than <c>browser_persistent</c>. Everything that kept a persistent
/// login on one machine hung off the RUNTIME - the login pinned a profile for
/// <c>browser_persistent</c> and nothing else - so a provider that declared it
/// needed the user's own computer, and was not T4, got none of it: the
/// operator's pooled fleet could lease its login after the head start, on a
/// datacenter address and in a browser wiped when the job ended.
/// </para>
///
/// <para>
/// Why not point these tests at DUO itself: it lives in the registry connector,
/// and the rule under test is the platform's. This suite already boots the shop
/// host with the two doubles that cover the other routing shapes, and a third
/// one keeps the rule asserted where it is implemented rather than in whichever
/// product happens to declare a manifest that uses it.
/// </para>
///
/// <para>
/// THAT CHOICE PAID ON 2026-09-21, which is worth recording because it looked
/// like extra work at the time. DUO's manifest went <c>pooled</c> that day -
/// the account holder's fleet is a container on their own connection serving
/// one person, so the Logius reasoning bought them nothing and cost them their
/// test route - and not one line of this suite moved. The rule is correct and
/// still routes every BYO provider the tree ships; it simply has no live
/// example that is also T3 today, which is precisely what this double is for.
/// </para>
///
/// <para>
/// Nothing here ever runs. No agent in this suite serves it, which is exactly
/// the state every routing decision under test is made in.
/// </para>
/// </summary>
internal sealed class OwnMachineStoreAdapter : IProviderAdapter
{
    public const string ProviderId = "test-own-machine-store";

    /// <summary>
    /// Optional, as DUO's are: a login that types nothing is still a login,
    /// and the field exists so this manifest is not the one shape - no fields
    /// at all - that the input validator treats specially.
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
        Name = "Own Machine Test Store",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = 1,

        // T3: a browser drives the sign-in and nothing keeps one open between
        // runs. What survives is whatever the browser kept, which on somebody's
        // own machine is a profile directory and a cookie jar.
        Runtime = ProviderRuntime.BrowserInteractive,

        // The declaration this whole file exists to have enforced.
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },

        // False, as DUO's is: the provider re-authenticates the human whenever
        // an authentication is actually initiated, so no fetch runs alone.
        UnattendedFetch = false,

        // Client, not agent: agent custody is refused outside
        // browser_persistent, and this provider's session is an ordinary sealed
        // bundle that happens to be worth nothing on another machine.
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

            // A quarter of an hour, idle, which is DUO's own number and the
            // reason a second connect inside it costs the human nothing.
            Session = new SessionSpec { TtlSeconds = 900, Refreshable = false, RotatesOnUse = false },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources = [new ResourceSpec { Id = "receipts", Returns = ResourceShape.Receipt }],
        Limits = new ProviderLimits { MinIntervalSeconds = 60 },
    };
}
