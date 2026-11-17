using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// Rechecked 2026-08-11 after a "do not build": the Cloudflare challenge (403 to a plain POST, 200 to 22 Chromium calls)
/// is for non-browsers, and the persisted-query manifest forbids OUR queries only: the hash is never ours to keep.
/// One operation, ten orders a call, items and totals included.
internal static class MediaMarktManifest
{
    public const int Version = 1;

    /// the copy key names what a consumer plans for: CONSENT (the cookie wall is answered with necessary categories only)
    /// a key, never prose: an English literal reaching a screen becomes an untranslatable de-facto API
    public const string NotesKey = "connect.mediamarkt.notes.consent";

    public static ProviderManifest Build() => new()
    {
        Id = MediaMarktAdapter.ProviderId,
        Name = "MediaMarkt",
        Kind = ProviderKind.Store,
        // only www.mediamarkt.nl has been read: one country, not a continent claimed
        Country = "NL",
        ManifestVersion = Version,
        // the browser reads every page through the signed-in page's own fetch: the session is a cookie jar, the hash the page's
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // DESKTOP is a decision: the agent emulates a Pixel 5 otherwise, but every figure came from a desktop capture
            // ("captureChannel": "DESKTOP"); a phone against a desktop-read contract
            // is what hid DigiD's other-device screen for three captures
            DesktopBrowser = true,
            // 'any' not 'residential': the observed challenge fires on non-browsers; a real Chromium passed from an ordinary connection
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // FALSE: the session cookie is spent inside a browser and nothing can renew it headlessly (as bol, Coolblue)
        UnattendedFetch = false,
        LoginNeedsHeadedAgent = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "mediamarkt",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // one screen, two boxes (#userName, #password), one submit; no second factor on a real sign-in (confirmed live)
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
                            // redaction keys off this flag and the validator refuses the manifest without it
                            Secret = true,
                            Required = true,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // no captcha was seen, but the site is behind Cloudflare Bot Management and a consumer with no UI for a challenge
            // strands its user; AppApproval is the interactive widget only a human at the browser can pass
            Challenges = [ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // UNCONFIRMED, conservative: the cookie's lifetime is not stated, and under-promising only costs an early reconnect offer
                TtlSeconds = 2_592_000,
                // no token is issued: authenticated calls carry no authorization header (checked across every captured request)
                Refreshable = false,
                RotatesOnUse = false,
            },
            // a reauth is the whole browser login again; claiming it cheap would invite scheduled retries against a lockable form
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            new ResourceSpec
            {
                Id = MediaMarktAdapter.ReceiptsResource,
                Returns = ResourceShape.Receipt,
                Params =
                [
                    new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                    new ParamSpec { Key = "until", Type = ParamType.Date },
                    // 'invoice' is the PDF on an order's own page ("Factuur aanvragen", then "Download de factuur"); the list has no document
                    // link, so each costs a page, bounded by MediaMarktOptions.MaxDocumentOrdersPerFetch
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", ResourceRequest.RawInclude, ResourceRequest.InvoiceInclude],
                        Multi = true,
                    },
                ],
                // large because ParamBinder.Widen silently CLAMPS a caller's `since` to this, so a cap from one capture would turn
                // "my 2015 order" into "does not exist"; page count and record cap bound the work
                MaxHistoryDays = 7_300,
                // ten orders a call, a second apart; a first connect walks all history: 2,000 orders is 200 calls, plus a page per invoice
                TypicalDurationSeconds = 180,
                MaxRecordsPerFetch = 2_000,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,
            MaxHistoryDays = 7_300,
            // an electronics order stays dated on its day; nothing settles late like a card transaction
            SettlementLagDays = 0,
            // a second between pages: a burst no shopper makes could make Cloudflare re-examine an accepted browser (a preference)
            MinRequestGapMs = 1_000,
        },
    };
}
