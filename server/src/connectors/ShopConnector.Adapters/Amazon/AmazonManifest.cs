using Connector.Kit.Challenges;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

/// <summary>
/// Copy keys this provider needs that the shared table does not have yet.
///
/// Declared here rather than added to <see cref="MessageKeys"/> because that
/// file is shared with every other adapter being written tonight, and a
/// two-line edit to a shared file is not worth the merge. Fold them in when
/// the night is over; the values are the contract, not the location.
/// </summary>
internal static class AmazonMessageKeys
{
    public const string Notes = "connect.amazon.notes";
}

internal static class AmazonManifest
{
    public const int Version = 1;

    /// <summary>
    /// Thirty days, and UNCONFIRMED.
    ///
    /// Amazon's <c>x-main</c> cookie is long-lived, but the honest figure is
    /// how long the whole session keeps being ACCEPTED, and that is decided by
    /// Amazon's risk engine rather than by an expiry we can read. Thirty days
    /// is a deliberately conservative reading of a cookie that may well last a
    /// year: a manifest that over-promises makes the consuming app tell a user
    /// their connection is fine right up until it is not, and being early with
    /// a reconnect prompt costs one sign-in.
    /// </summary>
    public const int SessionTtlSeconds = 2_592_000;

    /// <summary>
    /// T3, and every field below is an admission rather than an ambition.
    ///
    /// <c>browser_interactive</c> because there is no consumer API to fall
    /// back to - three maintained projects in three languages all scrape HTML,
    /// and if a JSON endpoint existed at least one of them would be using it.
    ///
    /// <c>unattended: false</c> is the load-bearing one. Amazon challenges
    /// routinely, and a challenge that arrives at three in the morning has
    /// nobody to answer it: the AWS WAF and ACIC walls are interactive
    /// widgets, which means they are passed by a human at the browser or not
    /// at all. Declaring unattended operation here would make the consumer
    /// offer scheduled syncing and then fail it - and the reference library
    /// only manages unattended runs by shipping integrations for three paid
    /// captcha-solving services, which is exactly the thing this platform will
    /// not do.
    /// </summary>
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

            // CONFIRMED 2026-08-06, inside the agent's own container.
            //
            // amazon.nl's MOBILE sign-in does not submit here. Not "is
            // rejected" - no request is made at all, by a button click or
            // by Enter, with the password correctly in the field and the
            // e-mail step having POSTed a moment earlier. The identical run
            // with no device emulation posts immediately and gets Amazon's
            // verification wall, which is a page this adapter knows how to
            // hand to a human.
            //
            // Four live sign-ins went into that before it was reproduced in
            // the container, where one network log settled it.
            DesktopBrowser = true,
            // A datacenter range fails Amazon's first test before the
            // credentials are even considered. An attended BYO agent is the
            // configuration that can actually pass an ACIC puzzle; a pooled
            // one on residential egress is the configuration that at least
            // gets to be asked.
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },
        UnattendedFetch = false,
        // Amazon's widget is interactive and cannot be photographed into an
        // answer, so the only person who can pass it is one at this browser.
        LoginNeedsHeadedAgent = true,
        // None, and by a different route from the others: LogoutAsync exists,
        // but it navigates to the sign-out page and returns immediately unless
        // a browser is ALREADY running - and a logout job gets a context that
        // has just been created. Launching Chromium purely to sign out would
        // hold a pooled agent for a courtesy, which is the right call; it just
        // means nothing upstream is told, so the manifest says so.
        Logout = LogoutSupport.None,
        SecretCustody = SecretCustody.Client,
        // The sign-in is a multi-screen chain that can stop for an OTP and a
        // visual challenge. Repeating it on every browser visit is not a thing
        // to ask of anybody, but the bundle still dies with the tab, which is
        // what Ephemeral means and is the honest setting for a session this
        // heavy.
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "amazon",
        NotesKey = AmazonMessageKeys.Notes,
        Auth = new AuthSpec
        {
            // Amazon asks for the address and the password on two SCREENS, but
            // that is a property of its page rather than of the consumer's
            // form: both values are collected once and the adapter drives both
            // screens. TwoStep would make the consuming app render a round
            // trip that does not exist. What follows the password - a one-time
            // code, a puzzle - is declared below as a challenge, where its
            // delivery is decided per login instead of being frozen here.
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

                        // There is deliberately NO otp_secret field.
                        //
                        // The reference library accepts a TOTP shared secret
                        // and auto-solves Amazon's one-time code with it, and
                        // its own documentation notes that enabling 2FA
                        // reduces how often Amazon challenges. That is a real
                        // operational win and it is still refused here: a
                        // shared secret is the second factor, and a service
                        // holding both factors has not connected to an account
                        // on a user's behalf, it has taken it over. The code
                        // goes to the human through the challenge protocol,
                        // which already reaches them wherever they are.
                    ],
                },
            ],
            // LiveView first, because it is what this provider actually does.
            //
            // CONFIRMED 2026-08-05: correct credentials from a pooled browser
            // do not reach the order list. They reach /ap/cvf/request - "Bevestig
            // je identiteit" - and the same credentials from a browser somebody
            // is looking at go straight through. Amazon challenges on the
            // CLIENT, so streaming the page to its owner is not the fallback
            // here; it is the normal path.
            //
            // It replaces AppApproval, which was this manifest's way of saying
            // "a widget passed in the browser window in front of somebody". A
            // consumer cannot render that: it prints "approve it in the app"
            // for a puzzle that has no app, about a window the user cannot see.
            //
            // MfaCode is the one-time code, which IS relayable - it is a string
            // the human reads off their own phone. Image is the legacy OCR
            // captcha, the only picture-wall a relay can carry.
            Challenges = [ChallengeType.LiveView, ChallengeType.MfaCode, ChallengeType.Image],
            Session = new SessionSpec
            {
                TtlSeconds = SessionTtlSeconds,
                // No refresh grant exists: the credential is a cookie jar.
                // Nothing can renew it without driving the sign-in chain
                // again, which is a human's job on this provider.
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
                    // "invoice" and NO "raw", which is a deliberate pair.
                    //
                    // Raw is meant for the payload a record was derived from,
                    // so a shape change can be diagnosed from real traffic. On
                    // a provider with an API that is a JSON object worth
                    // keeping. Here it was the print page, and the kit's own
                    // contract says an adapter "that scraped a page... leaves
                    // it empty rather than inventing a shape". This one did not
                    // leave it empty, and what a consumer got was 222KB of live
                    // Amazon markup per order - measured, not estimated - whose
                    // visible text was under 3% of it, the rest being layout
                    // and Amazon's own analytics. It was withdrawn because it
                    // was unusable, which is the same reason the contract said
                    // not to ship it.
                    //
                    // "invoice" is the thing that was actually wanted: the PDF
                    // Amazon issues, carried whole. Opt-in because an order has
                    // one to four of them at 80-190KB apiece.
                    new ParamSpec
                    {
                        Key = "include",
                        Type = ParamType.Enum,
                        Values = ["items", "invoice"],
                        Multi = true,
                    },
                ],
                MaxHistoryDays = 1_095,
                // Every page is a browser navigation and every set of line
                // items is one more. This is minutes, not seconds, and saying
                // so lets a consumer choose to poll rather than block.
                //
                // Raised from 180 when the walk was paced: fifty orders at a
                // three-second gap is two and a half minutes of deliberate
                // waiting on top of the loading. Leaving the old number would
                // have made every full fetch look like it had overrun.
                TypicalDurationSeconds = 300,
                // Deliberately lower than the other stores'. Two hundred
                // orders with line items is two hundred and ten navigations
                // against a site that challenges when it is bored; a partial
                // pass that comes back for the rest is the safer shape.
                MaxRecordsPerFetch = 50,
            },
        ],
        Limits = new ProviderLimits
        {
            MinIntervalSeconds = 21_600,
            Concurrency = 1,

            // Well above the operator's 800ms floor, and CHOSEN rather than
            // measured - Amazon publishes no threshold, and the only datum we
            // have is that a day of unpaced automated walking ended in a 503.
            //
            // What makes three seconds affordable is the shape of the work: a
            // first connect pays it fifty times and every sync after that pays
            // it for a handful of new orders. Two and a half minutes once, and
            // seconds a day thereafter, to look less like a machine on the one
            // provider here that has actually rate-limited us.
            MinRequestGapMs = 3_000,

            MaxHistoryDays = 1_095,
            // An Amazon order's total moves after it is placed: it ships in
            // parts, it gets refunded, a promotion applies late. Re-reading a
            // fortnight on every sync is what keeps the first version of a
            // total from being the only one ever recorded.
            SettlementLagDays = 14,
        },
    };
}
