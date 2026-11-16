using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// ASN on the holder's own machine: its "edge login" keeps a browser session alive, so a persistent profile fetches
/// unattended. The only such route in the project, and the justification for BYO agents.
/// A continuous bank session: safer than handing a password to a service, riskier than signing in each time.
internal static class AsnPersistentManifest
{
    public const int Version = 1;

    public const string ProviderId = "asn-persistent";

    /// Load-bearing: it explains a risk the user accepts rather than a limitation, so a consumer must render it.
    public const string NotesKey = "connect.asn.notes.persistent_session";

    public const string RegisterKey = "connect.asn.register_browser";

    public static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "ASN Bank (always-on)",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserPersistent,
        Agent = new AgentRequirement
        {
            Required = true,

            // BYO: the profile lives on the user's machine, so the session never exists where this platform runs
            Class = AgentClass.Byo,
        },

        // true: the only bank here that fetches unattended
        UnattendedFetch = true,

        // Agent custody: the bundle is { agent_id, profile_id } and no secret, so there is nothing to steal
        SecretCustody = SecretCustody.Agent,

        // Ephemeral although the connection is persistent: the bundle is only a pointer,
        // so a web user reconnects onto the same profile
        WebSupport = WebSupport.Ephemeral,

        // no logout: signing out would destroy the persistent session; revoke the agent or delete the profile instead
        Logout = LogoutSupport.None,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.DevicePersistent,
            Steps =
            [
                new AuthStep
                {
                    Id = "agent",
                    LabelKey = "connect.asn.step.agent",
                    Fields =
                    [
                        // no agent_id field: routing comes off prefer_agent on the request (ResolveProfileAsync)

                        // the browsercode: secret, client-held, never sealed into the bundle (profile = have, code = know)
                        // optional to the validator (no code before registration); a registered browser has no QR fallback, so the adapter
                        // refuses with invalid_request naming this key
                        new FieldSpec
                        {
                            Key = AsnPersistentAdapter.BrowserCodeKey,
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = "connect.asn.field.browser_code",
                            Pattern = "^[0-9]{5}$",
                        },
                    ],
                },
            ],

            // once, at enrolment. LiveView: ASN's code rotates every few seconds, so a still QrDisplay or CodeDisplay would expire
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec
            {
                // a year: a bound on the pointer, not a claim about ASN's edge login (unmeasured); a signed-out profile fails its next fetch
                TtlSeconds = 31_536_000,
                Refreshable = true,
                RotatesOnUse = false,
            },

            // cheap: the agent re-opens its own profile, no human unless the profile is gone
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),
            BankResources.TransactionsSpec(maxHistoryDays: 540, typicalDurationSeconds: 60),
        ],
        Limits = BankLimits.ForBank(maxHistoryDays: 540),
    };
}
