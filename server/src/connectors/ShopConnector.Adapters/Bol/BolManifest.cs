using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

internal static class BolManifest
{
    public const int Version = 1;

    // a guess, deliberately short: the JSESSIONID idle timeout is unknown outside bol; a manifest that lies promises silent
    // syncing and then fails, wrong short costs an extra sign-in, wrong long costs the user's trust
    public const int SessionTtlSeconds = 86_400;

    // CONFIRMED: the login field is type=email name=j_username; a member-number or phone field costs a failed attempt
    public const string UsernamePattern = @"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$";

    // browser_once: sign in once in a browser (JS login page, reCAPTCHA key), then plain HTTP with the cookie jar
    // not unattended: bol issues no token, so a dead cookie needs a human; unattended and refreshable are both false because
    // the manifest rules catch an inconsistency, not a lie
    public static ProviderManifest Build() => new()
    {
        Id = BolAdapter.ProviderId,
        Name = "bol.com",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = Version,
        // T3, not T2: T2 means a REFRESH TOKEN serves every fetch after, bol issues none (the jar dies in about a day);
        // Jumbo declares T3 for identical mechanics; a runtime-filtered agent pool would be offered a promise bol cannot keep
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // no enterprise bot vendor today (confirmed from response headers), but the page carries a reCAPTCHA key and a datacenter
            // range is the cheapest signal for a risk-based score to fail on
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = false,
        // reCAPTCHA's interactive form is unrelayable: there is no picture that
        // carries the question.
        LoginNeedsHeadedAgent = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "bol",
        NotesKey = BolMessageKeys.BolNotes,
        Auth = new AuthSpec
        {
            Flow = AuthFlow.Password,
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
                            Required = true,
                            LabelKey = MessageKeys.FieldEmail,
                            Pattern = UsernamePattern,
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
            // MfaCode: bol is assumed to send a code on a new device; Image: a plain captcha a relay can carry; AppApproval: the
            // reCAPTCHA widget (site key confirmed) cannot be relayed, so the human passes it in the agent's window
            // declared, not discovered: an unannounced challenge strands the user with a consumer that has no UI for it
            Challenges = [ChallengeType.MfaCode, ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,
                Refreshable = false,
                // false explicitly, the field defaults to true: bol issues no token, so no fetch ever returns RefreshedMaterial
                RotatesOnUse = false,
            },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = BolAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // "raw" is the verbatim order payload for diagnosing a shape change; "invoice" is the PDF bol issued; both opt-in
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", "raw", "invoice"],
                        Multi = true,
                    },
                ],
                MaxHistoryDays = 730,
                // covers the invoice path: each order asking for documents costs a details page and a paced download per invoice
                TypicalDurationSeconds = 600,
                // two thousand vs Amazon's 300, deliberately: bol's plain fetch is a handful of API calls a page, so a first sync can reach
                // as far back as bol allows; BolOptions.MaxDocumentOrdersPerFetch bounds the invoice path on its own
                MaxRecordsPerFetch = 2_000,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,
            MaxHistoryDays = 730,
            // a marketplace order is placed today and settles when the seller ships: a row can surface days later, and `since`
            // is widened by this so a late-appearing order is not lost invisibly
            SettlementLagDays = 7,
        },
    };
}
