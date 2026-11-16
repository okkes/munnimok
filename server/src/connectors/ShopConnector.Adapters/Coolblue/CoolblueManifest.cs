using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Coolblue;

/// The manifest is the contract consuming apps code against, so awkward truths go here: a RECEIPT COSTS A PAGE LOAD (the
/// list states no money), and a fetch is NOT unattended despite a refreshable-looking OIDC login: it spends a cookie
/// nothing can renew (live runs, 2026-08-07).
internal static class CoolblueManifest
{
    /// Stays at 1: a bundle sealed under 1 already holds the browser storage state, so nothing changed. The version is part
    /// of the sealed-bundle binding: bumping it refuses every existing Coolblue bundle and forces each user to sign in again.
    public const int Version = 1;

    /// Names the caveat: every receipt needs the order's own page, so a first connect takes minutes, not seconds. A key,
    /// never prose: an English literal reaching a screen becomes an untranslatable API.
    public const string NotesKey = "connect.coolblue.notes.page_per_order";

    public static ProviderManifest Build() => new()
    {
        Id = CoolblueAdapter.ProviderId,
        Name = "Coolblue",
        Kind = ProviderKind.Store,
        // Coolblue trades in NL, BE and DE but only accounts.coolblue.nl has been read: one country, stated honestly
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserOnce,
        Agent = new AgentRequirement
        {
            // a browser cannot run in the control plane, so the validator requires an agent here
            Required = true,
            Class = AgentClass.Pooled,
            // 'any', not 'residential': no bot management found (2026-07-28: CloudFront, no Akamai/DataDome/Cloudflare BM, no
            // captcha on the form), so residential is a cost against a wall nobody has seen. The country matters: locale-routed
            // site, Dutch login page.
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // FALSE: the fetch spends the session cookie (server-rendered HTML, no Authorization header, no API) and nothing
        // renews it without a browser. The refresh token renews an access token the fetch never sends. Same as bol.
        UnattendedFetch = false,
        // the axes disagree: the fetch needs nobody, but the login can still meet a widget only somebody at the browser passes
        LoginNeedsHeadedAgent = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "coolblue",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // one step: a step models what the USER is asked for, both at once. The sign-in really has two screens (the first
            // one's only password input is a DECOY), driven by CoolblueAdapter.SignInAsync; TwoStep would make a consumer prompt twice.
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
                            // an unmarked password is logged and screenshotted: redaction keys off this flag and the validator requires it
                            Secret = true,
                            Required = true,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // declared against the evidence (no captcha found): a consumer with no UI for a challenge strands the user. Image is
            // what a relay can carry; AppApproval is the widget only a human at the browser we opened can pass.
            Challenges = [ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // UNCONFIRMED, conservative: the session cookie states no lifetime. Under-promising only makes a reconnect offer
                // early; thirty days is a plausible floor for a retail "keep me signed in" cookie.
                TtlSeconds = 2_592_000,
                // FALSE like UnattendedFetch: the login does return a refresh token, but it renews an access token the fetch never sends
                Refreshable = false,
                // true, unconfirmed: rotation is in neither the discovery document nor the research; the error runs safe (a consumer
                // expecting a new token and getting the same one carries on)
                RotatesOnUse = true,
            },
            // NOT cheap: a reauth is the whole browser login (agent, page, password); saying otherwise invites scheduled retries
            // against a form that locks accounts
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = CoolblueAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // 'items' is offered: it was withdrawn after ONE order (399 itemised vs a total of 463) but another agrees to the cent
                    // (694), so the gap is per-order, covered by the derived Unattributed line. The invoice PDF stays the better
                    // accountant document, one request off a link the list carries.
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", ResourceRequest.InvoiceInclude],
                        Multi = true,
                    },
                ],
                // TWENTY YEARS: smaller caps (730, 1825) were wrong each time. ParamBinder.Widen CLAMPS the caller's since to it, so a
                // user asking for 2020 was silently given 2021. Nothing states retention (at least 6.5 years); cost is bounded by
                // MaxPages and MaxRecordsPerFetch, not by date.
                MaxHistoryDays = 7_300,
                // a daily sync is seconds; a first connect is the cap below times a paced page load: minutes, which is what a consumer
                // plans its UI around
                TypicalDurationSeconds = 900,
                // 400, where others say 200: a record costs a 600KB page load (a quarter GB, about a quarter hour of pacing), the most
                // a first connect should carry. Beyond it the newest 400 return with Complete = false, which the hub says out loud.
                MaxRecordsPerFetch = 400,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,
            MaxHistoryDays = 7_300,
            // an electronics order stays dated on its day; nothing settles late like a card transaction
            SettlementLagDays = 0,
            // 1.5 s, where Amazon asks 3 (it has rate-limited this project; Coolblue has no bot management): a stated preference,
            // not a measurement. Asked at all because a first connect pulls seventy-odd 600KB pages, a burst no shopper produces.
            MinRequestGapMs = 1_500,
        },
    };
}
