using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.AlbertHeijn;

internal static class AlbertHeijnManifest
{
    /// 2 since the login became e-mail and password; sealed into every bundle as AAD, so a version-1 bundle is rejected
    public const int Version = 2;

    /// <param name="liveLogin">true: RemoteBrowser, no fields; the human signs in on AH's page, no password reaches us</param>
    public static ProviderManifest Build(bool liveLogin = true) => new()
    {
        Id = AlbertHeijnAdapter.ProviderId,
        Name = "Albert Heijn",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserOnce,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // login.ah.nl is fronted by hCaptcha; a datacenter range fails
            // that test before the credentials are even considered.
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = true,               // the refresh token works headlessly
        // the streamed login relays AH's page wall and all, so any agent will do; the typed path meets hCaptcha itself
        LoginNeedsHeadedAgent = !liveLogin,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "ah",
        NotesKey = MessageKeys.AhNotes,
        Auth = new AuthSpec
        {
            Flow = liveLogin ? AuthFlow.RemoteBrowser : AuthFlow.Password,

            // empty under the live login (the validator enforces it): the human types into AH's own page
            Steps = liveLogin ? [] :
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,
                    Fields =
                    [
                        // an e-mail address, not a member number or a phone: a wrong form costs a failed attempt on a defended page
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Secret = false,
                            Required = true,
                            LabelKey = MessageKeys.FieldEmail,
                            Autofill = "username",
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = true,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // Image: a plain captcha can be relayed. AppApproval: hCaptcha is passed in the agent's window by whoever sits at it.
            // adding a challenge type keeps ManifestVersion at 2: a bump would invalidate every live AH connection
            // live login: LiveView and Redirect (last resort); the streamed page already shows any captcha to the human
            Challenges = liveLogin
                ? [ChallengeType.LiveView, ChallengeType.Redirect]
                : [ChallengeType.Image, ChallengeType.AppApproval, ChallengeType.Redirect],
            Session = new SessionSpec { TtlSeconds = 7_776_000, Refreshable = true, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = AlbertHeijnAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // raw returns AH's detail document; only meaningful with items, as the detail call is the only place it exists
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", "raw"],
                        Multi = true,
                    },
                ],
                // a first connect walks the whole history: two thousand receipts is forty list calls and a detail each
                TypicalDurationSeconds = 120,
                MaxRecordsPerFetch = 2_000,
            },
        ],
    };
}
