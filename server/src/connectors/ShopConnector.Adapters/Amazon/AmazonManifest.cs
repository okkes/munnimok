using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

// copy keys declared outside the shared MessageKeys table; the values are the contract, not the location
internal static class AmazonMessageKeys
{
    public const string Notes = "connect.amazon.notes";
}

internal static class AmazonManifest
{
    public const int Version = 1;

    // 30 days, UNCONFIRMED: acceptance is Amazon's risk engine, not a cookie expiry.
    // too long a TTL claims a dead connection is fine
    public const int SessionTtlSeconds = 2_592_000;

    // T3, browser_interactive: no consumer API exists. unattended false: WAF/ACIC widgets can only be passed by a human at the
    // browser, and scheduled syncing would fail; the reference's unattended runs need paid captcha solvers, which we refuse
    public static ProviderManifest Build() => new()
    {
        Id = AmazonAdapter.ProviderId,
        Name = "Amazon.nl",
        Kind = ProviderKind.Store,
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,

            // desktop browser: amazon.nl's mobile sign-in submits nothing here (confirmed 2026-08-06); without emulation it posts and
            // reaches the verification wall, which a human can be handed
            DesktopBrowser = true,
            // a datacenter range fails Amazon's first test; pooled residential egress at least gets asked,
            // an attended BYO agent can pass ACIC
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = false,
        // the widget cannot be photographed into an answer: only a person at this browser can pass it
        LoginNeedsHeadedAgent = true,
        // None: LogoutAsync returns at once unless a browser is already running, and a logout job gets a fresh context.
        // launching Chromium only to sign out would hold a pooled agent, so nothing upstream is told
        Logout = LogoutSupport.None,
        SecretCustody = SecretCustody.Client,
        // the bundle dies with the tab (Ephemeral) although the multi-screen sign-in is heavy to repeat
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "amazon",
        NotesKey = AmazonMessageKeys.Notes,
        Auth = new AuthSpec
        {
            // two screens are Amazon's page, not the consumer's form: values are collected once and the adapter drives both.
            // TwoStep would render a round trip that does not exist. What follows the password is a per-login challenge below
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

                        // no otp_secret field on purpose: a TOTP secret plus the password is both factors, which takes the account over
                        // instead of connecting to it; the code goes to the human through the challenge protocol
                    ],
                },
            ],
            // LiveView first (confirmed 2026-08-05): correct credentials from a pooled browser land on /ap/cvf/request, the same from a
            // watched browser pass; Amazon challenges the client. MfaCode is relayable (a string); Image is the legacy OCR captcha
            // AppApproval is the passive wait of CaptchaGate: a wall met mid-fetch on a browser somebody sits at (#623)
            Challenges = [ChallengeType.LiveView, ChallengeType.MfaCode, ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,
                // no refresh grant: the credential is a cookie jar, renewed only by a human's sign-in
                Refreshable = false,
                RotatesOnUse = true,
            },
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = AmazonAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // "invoice" and no "raw": raw was the print page, 222KB of markup per order with under 3% visible text, and the kit says
                    // a scraping adapter leaves raw empty. invoice is the issued PDF, opt-in as an order has 1-4 of 80-190KB each
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", "invoice"],
                        Multi = true,
                    },
                ],
                MaxHistoryDays = 1_095,
                // minutes, not seconds: a navigation per page and per order's items; 300 orders at a 3s gap is 15 min of pacing alone
                TypicalDurationSeconds = 1_200,
                // lower than other stores: every order is its own navigation against a site that challenges.
                // a first connect stops at 300, newest first
                MaxRecordsPerFetch = 300,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,

            // chosen, not measured: Amazon publishes no threshold and a day of unpaced walking ended in a 503.
            // affordable as only a first connect pays it per order, later syncs a handful
            MinRequestGapMs = 3_000,

            MaxHistoryDays = 1_095,
            // an order's total moves after placing (partial shipments, refunds, late promotions).
            // re-reading 14 days keeps the first total from sticking
            SettlementLagDays = 14,
        },
    };
}
