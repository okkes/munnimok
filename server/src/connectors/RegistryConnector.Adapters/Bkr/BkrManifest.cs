using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

using RegistryConnector.Adapters.Support;

namespace RegistryConnector.Adapters.Bkr;

internal static class BkrManifest
{
    public const int Version = 1;

    /// an hour: BKR states a standing position that changes a few times a year;
    /// hourly sync means asking a human for six digits hourly
    public const int SessionTtlSeconds = 3_600;

    public static ProviderManifest Build() => new()
    {
        Id = BkrAdapter.ProviderId,
        Name = "BKR",
        Kind = ProviderKind.Registry,
        Country = "NL",
        ManifestVersion = Version,

        // a browser drives the login (B2C behind a second factor, server-rendered portal); nothing needs it open afterwards
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },

        // stays false whatever is stored: even with the seed the credential sits in the user's own device bundle,
        // nobody hands it over at 3am; a registry signing itself in unattended is an account takeover with a cron entry
        UnattendedFetch = false,
        LoginNeedsHeadedAgent = false,

        // the password does not change; retyping it for a monthly sync is the friction that stops syncing
        OffersCredentialStore = true,

        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "bkr",
        NotesKey = MessageKeys.BkrNotes,

        Auth = new AuthSpec
        {
            Flow = AuthFlow.PasswordTotp,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,

                    // all three optional: what the user supplies decides how much sign-in they watch (nothing: streamed,
                    // user+password: typed, second factor streamed; plus seed: computed); a required field would rule out the first two
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Required = false,
                            LabelKey = MessageKeys.FieldEmail,
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = MessageKeys.FieldPassword,
                        },

                        // secret: the seed behind every code the account accepts, so storing it lets this connection alone pass both factors
                        // optional, unset by default (connect.bkr.totp)
                        new FieldSpec
                        {
                            Key = "totp",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = MessageKeys.BkrTotpSecret,
                        },
                    ],
                },
            ],

            // LiveView answers what the typed path cannot (texted code, choice, reset, consent).
            // MfaCode too: a drifted clock or mistyped seed must be answerable by a human
            Challenges = [ChallengeType.LiveView, ChallengeType.MfaCode],

            // B2C is on its own host, so a streamed login pinned to the portal stops at the password screen
            // exactly the two hosts in BkrOptions
            LoginOrigins = ["portaal.mijnkredietregistratie.nl", "login.mijnkredietregistratie.nl"],

            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,

                // nothing to refresh: no refresh token, so the next sync signs in again from the stored password and a new code
                Refreshable = false,
                RotatesOnUse = false,
            },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },

        Resources =
        [
            new ResourceSpec
            {
                Id = BkrAdapter.CreditsResource,
                Returns = ResourceShape.CreditRegistration,

                // no since/until: a register states what is true now, and declaring the parameter would invite a question it cannot answer
                Params = [],
                MaxRecordsPerFetch = 200,
            },
        ],

        Limits = new ProviderLimits { MinIntervalSeconds = 3_600, Concurrency = 1 },
    };
}
