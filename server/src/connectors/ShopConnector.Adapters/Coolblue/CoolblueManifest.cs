using Connector.Kit.Challenges;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Coolblue;

/// <summary>
/// Coolblue's catalogue entry.
///
/// The manifest is the only contract a consuming app codes against, so it is
/// the place a provider's awkward truths have to be told rather than
/// discovered. Coolblue's are that a RECEIPT COSTS A PAGE LOAD - its order list
/// states no money at all - and that a fetch is NOT unattended even though the
/// login is a textbook refreshable OIDC session, because what the fetch spends
/// is a cookie nothing can renew.
/// <para>
/// Both were settled by live runs on 2026-08-07, and both are the opposite of
/// what this file claimed before them. A third claim - that no line items were
/// offered - was made on the same day and was simply wrong: it generalised from
/// one order whose page charged more than it itemised, and was corrected once an
/// account owner asked where their items had gone.
/// </para>
/// </summary>
internal static class CoolblueManifest
{
    /// <summary>
    /// Version 1, and it deliberately STAYS at 1 now that the fetch has landed.
    ///
    /// The old note here said to bump it "the moment the order fetch lands and
    /// changes what the material has to carry". The fetch has landed and the
    /// material has not changed: a bundle sealed under version 1 already holds
    /// the browser storage state, because <c>CaptureStorageState</c> has been on
    /// from the start precisely so the cookie would be there whichever
    /// credential turned out to be needed. It was the cookie.
    /// <para>
    /// This matters more than a version number usually does, because the
    /// version is part of the sealed-bundle binding: bumping it would refuse
    /// every existing Coolblue bundle and make each user sign in again to
    /// announce a change that does not affect them.
    /// </para>
    /// </summary>
    public const int Version = 1;

    /// <summary>
    /// The copy key, and it names the caveat rather than hiding it.
    ///
    /// The caveat is what a first sync COSTS. Coolblue's order list states no
    /// money at all, so every receipt needs that order's own page - which makes
    /// this the one provider here where a record is a page load, and a first
    /// connect a matter of minutes rather than seconds.
    ///
    /// A key, never prose: the connector cannot know the reader's language, and
    /// an English literal that reaches a screen becomes an untranslatable
    /// de-facto API the moment a consumer matches on it.
    /// </summary>
    public const string NotesKey = "connect.coolblue.notes.page_per_order";

    /// <summary>
    /// A browser drives one standards-compliant OIDC login, and every fetch
    /// afterwards is plain HTTP carrying the cookie jar that login left behind.
    /// </summary>
    public static ProviderManifest Build() => new()
    {
        Id = CoolblueAdapter.ProviderId,
        Name = "Coolblue",
        Kind = ProviderKind.Store,
        // Coolblue trades in NL, BE and DE, but only accounts.coolblue.nl has
        // been read. One country, stated honestly, rather than three claimed.
        Country = "NL",
        ManifestVersion = Version,
        Runtime = ProviderRuntime.BrowserOnce,
        Agent = new AgentRequirement
        {
            // A browser cannot run in the control plane, so the validator
            // requires an agent here whatever we think of the login's defences.
            Required = true,
            Class = AgentClass.Pooled,
            // 'any', not 'residential' - and that is a finding, not an
            // oversight. The 2026-07-28 check found no bot management on
            // coolblue.nl at all: server: CloudFront, no Akamai, no DataDome,
            // no Cloudflare BM cookie, and no captcha asset on the login form.
            // Demanding a residential line buys a real operational cost against
            // a wall nobody has seen. The country still matters: the site is
            // locale-routed and the login page is Dutch.
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // FALSE, and this is the correction that cost the most to establish.
        //
        // Until the capture, this said true, and the reasoning was sound for
        // the adapter we thought we were building: offline_access yields a
        // refresh token, a refresh token renews an access token headlessly, so
        // a scheduled sync needs nobody. Every step of that is still true and
        // none of it applies, because the thing the fetch actually spends is
        // not the access token.
        //
        // Coolblue's account pages are server-rendered HTML behind the session
        // cookie. The captured request for the order list carried NO
        // Authorization header at all, and there is no API to send one to. So
        // the fetch lives exactly as long as that cookie does, nothing can
        // renew it without a browser, and promising unattended sync would mean
        // promising a daily job that works until it silently stops.
        //
        // The same technical situation as bol, and the same answer.
        UnattendedFetch = false,
        // The two axes disagreeing, which is the whole reason they are two
        // fields: the refresh token fetches at three in the morning on its own,
        // and the login it came from can still meet a widget only somebody at
        // the browser can pass.
        LoginNeedsHeadedAgent = true,
        SecretCustody = SecretCustody.Client,
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "coolblue",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // Password, collected in ONE step - and that is now a statement
            // about the consumer's form rather than about Coolblue's.
            //
            // This said "one screen, two boxes, CONFIRMED", and it was wrong:
            // the sign-in asks for the e-mail address, and only reveals a
            // password field after it is submitted. The single input of type
            // password on the first screen is a DECOY Coolblue keeps for
            // browser password managers.
            //
            // One step is still right, because a step models what the USER is
            // asked for and they are asked for both at once. The adapter drives
            // the two screens itself, probing for the password box before
            // pressing anything - see CoolblueAdapter.SignInAsync. Declaring
            // TwoStep would make a consumer prompt twice for credentials it
            // already holds.
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
            // Declared defensively, and against the evidence rather than for
            // it: no captcha was found on this login form. But a consumer with
            // no UI for a challenge its provider suddenly raises strands the
            // user at the worst possible moment, and declaring two challenge
            // types costs nothing. Image is the kind a relay can carry;
            // AppApproval is the interactive widget, which can only be passed
            // by a human sitting at the browser we opened.
            Challenges = [ChallengeType.Image, ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // UNCONFIRMED and deliberately conservative. Coolblue's session
                // cookie states no lifetime anyone can read, so this is a guess
                // that errs in the only safe direction: a manifest that
                // under-promises makes a consumer offer a reconnect slightly
                // early, where one that over-promises makes it promise months
                // of silent syncing and then fail every day.
                //
                // Thirty days, not because IdentityServer defaults to it -
                // which is what this said, and which was about the wrong
                // session - but because it is a plausible floor for a retail
                // "keep me signed in" cookie.
                TtlSeconds = 2_592_000,
                // FALSE, and this is the same correction as UnattendedFetch.
                //
                // The refresh_token grant IS confirmed and offline_access IS in
                // the scope list - the login really does come back with a
                // refresh token, and this adapter really does seal it. What it
                // renews is an access token that the fetch never sends. A
                // renewal that cannot keep the fetch alive is not a refreshable
                // session; calling it one would tell the platform it may keep
                // this connection going by itself, which it cannot.
                Refreshable = false,
                // Left TRUE, unchanged and still UNCONFIRMED. Rotation appears
                // in neither the discovery document nor the research file. The
                // error runs the safe way round: a consumer that expects a new
                // refresh token and gets the same one carries on, while one
                // told the token is stable and has it rotated underneath
                // silently loses the connection.
                RotatesOnUse = true,
            },
            // NOT cheap. A reauth here is the whole browser OIDC login again -
            // an agent, a page, a password - and telling the platform otherwise
            // invites it to retry on a schedule against a form that locks
            // accounts.
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
                    // Both, and 'items' is here after being wrongly withdrawn.
                    //
                    // It was dropped because ONE captured order lists a single
                    // product at 399 against a stated total of 463 and never
                    // says what the other 64 was - so reading lines seemed to
                    // mean flagging an ordinary order as failing
                    // reconciliation. That was a conclusion drawn from a single
                    // observation, which is the exact mistake this adapter has
                    // now made three times. A second captured order lists a
                    // product at 694 against a total of 694 and agrees to the
                    // cent.
                    //
                    // So the gap is a per-order fact about Coolblue's page, and
                    // the platform already had the vocabulary for it:
                    // ReceiptLineKind.Unattributed, a DERIVED line naming money
                    // whose reason is unknown. The breakdown adds up, the flag
                    // means something again, and the eight orders that itemise
                    // perfectly are no longer thrown away to avoid being wrong
                    // about the ninth.
                    //
                    // The invoice PDF remains the better document for an
                    // accountant, and on this provider it costs one request off
                    // a link the list already carries.
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", ResourceRequest.InvoiceInclude],
                        Multi = true,
                    },
                ],
                // TWENTY YEARS, and the number is large because every smaller
                // one so far has been wrong in the same direction.
                //
                // This said 730, then 1825, each time set from the oldest order
                // that happened to be visible in a capture. A cap here does not
                // decline politely: ParamBinder.Widen CLAMPS the caller's
                // `since` to it, so a user asking for 2020 is silently given
                // 2021 and told nothing. The account owner hit exactly that,
                // looking at a January 2020 order on Coolblue's own site that
                // this connector insisted did not exist.
                //
                // Nothing anywhere says how long Coolblue keeps an order. What
                // IS known is that it keeps at least six and a half years of
                // them, and that no cost here rides on this number: the work is
                // bounded by MaxPages and by MaxRecordsPerFetch below, both of
                // which bite long before a date does. So the honest setting is
                // one that cannot hide a purchase somebody can see.
                MaxHistoryDays = 7_300,
                // A daily sync is one list page and a detail or two: seconds. A
                // first connect is the number below times a paced page load,
                // which is minutes. This states the one a consumer has to plan
                // its UI around, and that is the first connect.
                TypicalDurationSeconds = 900,
                // SEVENTY-FIVE, where every other provider here says 200, and
                // the difference is not caution - it is arithmetic.
                //
                // On Coolblue a record COSTS A PAGE LOAD. The order list states
                // no money at all, so each total needs the order's own page,
                // and those run 600KB. Four hundred is a quarter of a gigabyte
                // of pages read one at a time and about a quarter of an hour
                // of paced loading - the most a first connect should carry,
                // and many times this account's entire history (user request
                // 2026-10-02: a first sync reaches as far back as the party
                // allows). Beyond it the fetch returns the newest four hundred
                // and reports Complete = false, which the hub says out loud.
                MaxRecordsPerFetch = 400,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,
            // The fallback when a resource states none, and the same reasoning:
            // see the resource's own note above.
            MaxHistoryDays = 7_300,
            // An electronics order is placed on one day and stays dated that
            // day; nothing settles late the way a card transaction does.
            SettlementLagDays = 0,
            // A second and a half between requests, where Amazon asks for three.
            //
            // Halved because the situations differ in the one way that matters:
            // Amazon has actually rate-limited this project, and Coolblue has
            // no bot management at all - no Akamai, no DataDome, no Cloudflare,
            // no captcha on the login form. What justifies asking for anything
            // is that this is the heaviest fetch here: a first connect pulls
            // seventy-odd pages of 600KB, which is a burst no shopper produces.
            //
            // A stated preference and not a measurement - nobody publishes a
            // threshold - so it is written down where the decision was made.
            MinRequestGapMs = 1_500,
        },
    };
}
