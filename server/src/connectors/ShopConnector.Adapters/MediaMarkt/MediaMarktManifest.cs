using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>
/// MediaMarkt's catalogue entry.
///
/// This provider was researched on 2026-07-28 and written up as
/// <b>"do not build"</b>, on two blockers that were both real and both
/// correctly observed: a Cloudflare interactive challenge served to the first
/// unauthenticated API request, and <c>isPersistedQueryManifestActive: true</c>
/// forbidding a query of our own. Re-checked on 2026-08-11 from a browser, both
/// turned out to be walls against the wrong kind of client rather than walls
/// around the data:
/// <list type="number">
/// <item>The challenge is for non-browsers. The same endpoint answered 403 with
/// <c>cf-mitigated: challenge</c> to a plain POST and 200 to all twenty-two
/// calls a real Chromium made minutes later, signed in and out.</item>
/// <item>The manifest forbids OUR queries, not MediaMarkt's own. The adapter
/// asks the page to load and reads the answer to the question the page's own
/// javascript asked - so the hash is never ours to know or to keep current.
/// See <see cref="IMediaMarktPortal.ObserveAsync"/>.</item>
/// </list>
/// What is left is the cheapest fetch of any shop here: ONE operation, ten
/// orders a call, line items and totals included.
/// </summary>
internal static class MediaMarktManifest
{
    public const int Version = 1;

    /// <summary>
    /// The copy key. It names what a consumer has to plan for, which here is
    /// not cost but CONSENT: the browser meets a cookie wall on its first visit
    /// and this connector answers it with the necessary categories only.
    ///
    /// A key, never prose: the connector cannot know the reader's language, and
    /// an English literal that reaches a screen becomes an untranslatable
    /// de-facto API the moment a consumer matches on it.
    /// </summary>
    public const string NotesKey = "connect.mediamarkt.notes.consent";

    public static ProviderManifest Build() => new()
    {
        Id = MediaMarktAdapter.ProviderId,
        Name = "MediaMarkt",
        Kind = ProviderKind.Store,
        // MediaMarktSaturn trades across Europe, and only www.mediamarkt.nl has
        // been read. One country, stated honestly, rather than a continent
        // claimed.
        Country = "NL",
        ManifestVersion = Version,
        // The browser is not just for the login. Every page of orders is read
        // through the signed-in page's own fetch, because the session is a
        // cookie jar and the persisted-query hash belongs to the page.
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // DESKTOP, and this is a decision rather than a default.
            //
            // The agent otherwise emulates a Pixel 5, and every figure this
            // adapter was built from came from a desktop capture - down to the
            // `"captureChannel": "DESKTOP"` MediaMarkt's own client puts in the
            // extensions of every call. Running a phone against a contract read
            // off a desktop is precisely the mismatch that hid DigiD's
            // app-on-another-device screen for three captures.
            DesktopBrowser = true,
            // Cloudflare fronts this site, so the egress is worth stating - but
            // 'any' rather than 'residential': the challenge that was observed
            // fires on the CLIENT being a non-browser, and a real Chromium
            // passed it from an ordinary connection. Demanding a residential
            // line would buy real operational cost against a wall that was not
            // the wall.
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // FALSE. The fetch spends a session cookie inside a browser, and
        // nothing can renew it headlessly - the same situation as bol and
        // Coolblue, and the same honest answer. Promising unattended sync
        // would promise a nightly job that works until it quietly stops.
        UnattendedFetch = false,
        LoginNeedsHeadedAgent = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "mediamarkt",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // One screen, two boxes, CONFIRMED live: #userName and #password
            // are on the same form with one submit button, and no second factor
            // was offered on a real sign-in.
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
                            // An unmarked password is logged and screenshotted:
                            // redaction keys off exactly this flag, and the
                            // validator refuses the manifest without it.
                            Secret = true,
                            Required = true,
                            LabelKey = MessageKeys.FieldPassword,
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // Declared against the evidence rather than for it: no captcha
            // appeared on the login form, and no challenge appeared on any of
            // the twenty-two API calls. But this site IS behind Cloudflare Bot
            // Management, a challenge is exactly what it would serve if it ever
            // stopped believing the browser, and a consumer with no UI for one
            // strands its user at the worst moment. AppApproval is the
            // interactive widget - only a human at the browser can pass it.
            Challenges = [ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // UNCONFIRMED and deliberately conservative. Nothing states the
                // lifetime of MediaMarkt's session cookie, so this errs in the
                // only safe direction: under-promising makes a consumer offer a
                // reconnect slightly early, where over-promising makes it
                // promise months of silent syncing and then fail daily.
                TtlSeconds = 2_592_000,
                // Nothing to refresh. No token of any kind is issued to the
                // browser - the authenticated calls carry no authorization
                // header at all, which was checked across every captured
                // request rather than assumed.
                Refreshable = false,
                RotatesOnUse = false,
            },
            // A reauth is the whole browser login again - an agent, a page, a
            // password. Telling the platform otherwise invites it to retry on a
            // schedule against a form that can lock an account.
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
                    // 'invoice' is the PDF MediaMarkt issues on an order's own
                    // page ("Factuur aanvragen", then "Download de factuur" -
                    // the user's walk-through, 2026-10-02). The list payload
                    // carries no document link, so each one costs a page of
                    // its own; MediaMarktOptions.MaxDocumentOrdersPerFetch
                    // bounds that.
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", ResourceRequest.RawInclude, ResourceRequest.InvoiceInclude],
                        Multi = true,
                    },
                ],
                // TWENTY YEARS. The captured account's oldest order is from
                // April 2015 and MediaMarkt served it in the ordinary list, so
                // a decade is demonstrably kept. The number is large for the
                // reason Coolblue's is: ParamBinder.Widen CLAMPS a caller's
                // `since` to this, silently, so a cap set from whatever a
                // capture happened to show turns "my 2015 order" into "that
                // order does not exist". Nothing rides on it - the page count
                // and the record cap below bound the work.
                MaxHistoryDays = 7_300,
                // Ten orders a call, one call a page, a second apart, and every
                // figure included. A first connect walks the whole history (user
                // request 2026-10-02): two thousand orders is two hundred calls,
                // and the invoices, when asked for, a page each on top.
                TypicalDurationSeconds = 180,
                MaxRecordsPerFetch = 2_000,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,
            MaxHistoryDays = 7_300,
            // An electronics order is placed on one day and stays dated that
            // day; nothing settles late the way a card transaction does.
            SettlementLagDays = 0,
            // A second between pages. Cloudflare sits in front of this endpoint
            // and the one thing that would make it look again at a browser it
            // has already accepted is a burst no shopper produces. A stated
            // preference, not a measurement - nobody publishes a threshold.
            MinRequestGapMs = 1_000,
        },
    };
}
