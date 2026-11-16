using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Jumbo;

internal static class JumboManifest
{
    // stays 1: only what is read changed, not the session material
    // bumping would invalidate every bundle and force an Auth0 login behind Akamai
    public const int Version = 1;

    /// <summary>The cookie's real life. Not a target, a measurement.</summary>
    public const int SessionTtlSeconds = 86_400;

    // T3: the cookie lives ~24h and cannot be renewed, so a human signs in about daily; claiming 30 days would promise more
    // refreshable false: the server-side callback keeps the tokens, the browser gets only a cookie
    // a mobile-style public client would hand over a real refresh token (T2)
    public static ProviderManifest Build() => new()
    {
        Id = JumboAdapter.ProviderId,
        Name = "Jumbo",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // confirmed live: www.jumbo.com is fronted by Akamai (akaas_as, ak_bmsc), login is Auth0 Universal Login
            // a datacenter range is a high-risk signal
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = false,              // a human signs in roughly daily
        // any agent will do: the Auth0 wall is streamed to the account owner, nobody has to stand at the machine
        LoginNeedsHeadedAgent = false,
        // the cookie cannot be refreshed, so sign-in recurs daily
        // a stored credential means nobody is disturbed on days Auth0 raises no wall
        OffersCredentialStore = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "jumbo",
        NotesKey = MessageKeys.JumboNotes,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
            // both optional: with none the page is streamed from the start
            // the wall decides who finishes (Turnstile cannot be relayed or solved)
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Secret = false,
                            Required = false,
                            LabelKey = MessageKeys.FieldEmail,
                            Autofill = "username",
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // all four declared, not discovered: a consumer with no UI for a raised challenge strands the user
            // LiveView answers the Turnstile wall (token minted in the browser, nothing to photograph): the human passes it in the page
            // the other three are the typed path: a code, a picture captcha, or a widget appearing only after the submit
            Challenges =
            [
                ChallengeType.LiveView,
                ChallengeType.MfaCode,
                ChallengeType.Image,
                ChallengeType.AppApproval,
            ],
            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,
                Refreshable = false,
                // the field defaults to true; nothing rotates, the browser never holds a refresh token
                RotatesOnUse = false,
            },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = JumboAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // opt-in: a verbatim copy of somebody's shopping is not carried unasked
                    new ParamSpec { Key = "include", Type = ParamType.Enum, Values = ["items", "raw"], Multi = true },
                ],
                // in-store receipts cost a second round trip; a first connect walks the whole history (2,000 rows over 200 pages)
                TypicalDurationSeconds = 300,
                MaxRecordsPerFetch = 2_000,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,

            // observed 2026-07-28: an order 586 days old came back; the platform default of 365 clamped since and hid the only order
            // three years covers that; Jumbo's real retention is unconfirmed
            MaxHistoryDays = 1_095,
        },
    };
}
