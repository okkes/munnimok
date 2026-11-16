using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.LidlPlus;

internal static class LidlPlusManifest
{
    /// sealed into every bundle as AAD: an older version's bundle is rejected, not reinterpreted (bumped for "e-mail or phone")
    public const int Version = 3;

    /// <summary>Countries the ticket API is addressed by. Uppercase in the URL and the header.</summary>
    public static readonly IReadOnlyList<string> Countries = ["NL", "DE", "AT", "BE", "FR", "IT", "ES"];

    public static readonly IReadOnlyList<string> Languages = ["nl", "de", "en", "fr", "it", "es"];

    /// anchored; only the e-mail can contain '@', which is how the adapter picks Lidl's input, so validation and fill agree
    /// the phone half is E.164
    public const string UsernamePattern = @"^(?:[^@\s]+@[^@\s]+\.[A-Za-z]{2,}|\+[1-9][0-9]{6,14})$";

    public static ProviderManifest Build() => new()
    {
        Id = LidlPlusAdapter.ProviderId,
        Name = "Lidl Plus",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = Version,
        // reCAPTCHA Enterprise (2026-07-28) scores the browser, so headless Chromium fails; the user's browser cannot follow
        // com.lidlplus.app://. Streaming lets a real person pass and the redirect arrives in OUR browser:
        // still a 90-day refresh token
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        // the login is the only part needing anybody; the refresh token then serves fetches for ninety days
        UnattendedFetch = true,
        LoginNeedsHeadedAgent = false,

        // no credential store: refused on a refreshable session, and the 90-day refresh token already avoids asking again
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "lidl",
        NotesKey = MessageKeys.LidlNotes,
        Auth = new AuthSpec
        {
            // not PasswordSms: the code goes by SMS or e-mail by identifier, and the frozen kit enum has no password_otp.
            // the code is declared below in challenges, its delivery decided per login
            Flow = AuthFlow.Password,
            // config, neither secrets nor challenges: they appear in the ticket URLs and the Accept-Language and Country headers
            Config =
            [
                new FieldSpec
                {
                    Key = "country",
                    Type = FieldType.Select,
                    Options = Countries,
                    Required = true,
                    LabelKey = MessageKeys.LidlCountry,
                },
                new FieldSpec
                {
                    Key = "language",
                    Type = FieldType.Select,
                    Options = Languages,
                    Required = true,
                    LabelKey = MessageKeys.LidlLanguage,
                },
            ],
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = MessageKeys.StepCredentials,

                    // both optional: with none, the page is streamed from the first screen; the credential store only seals what was typed
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Required = false,
                            Pattern = UsernamePattern,
                            LabelKey = MessageKeys.FieldEmailOrPhone,
                        },
                        new FieldSpec
                        {
                            Key = "password",
                            Type = FieldType.Password,
                            Secret = true,
                            Required = false,
                            LabelKey = MessageKeys.FieldPassword,
                        },
                    ],
                },
            ],

            // LiveView first: reCAPTCHA Enterprise scores the browser and only a person-driven one passes; the rest cover the typed path
            Challenges =
            [
                ChallengeType.LiveView,
                ChallengeType.MfaCode,
                ChallengeType.Image,
                ChallengeType.AppApproval,
            ],
            Session = new SessionSpec { TtlSeconds = 7_776_000, Refreshable = true, RotatesOnUse = true },
            Reauth = new ReauthSpec { Cheap = true, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = LidlPlusAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    new ParamSpec { Key = "include", Type = ParamType.Enum, Values = ["items", "raw"], Multi = true },
                ],
                MaxHistoryDays = 730,
                // a first connect walks the whole history: a hundred pages, two thousand tickets
                TypicalDurationSeconds = 120,
                MaxRecordsPerFetch = 2_000,
            },
        ],
        Limits = new ProviderLimits { MinIntervalSeconds = 21_600, Concurrency = 1, MaxHistoryDays = 730 },
    };
}
