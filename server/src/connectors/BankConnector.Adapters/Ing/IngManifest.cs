using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Ing;

/// <summary>
/// ING's catalogue entry, and the first real bank in this connector.
///
/// Established from a capture of a real account on 2026-08-12, run twice - once
/// in Dutch and once in English - with a current account, a savings account and
/// a credit card on it.
/// </summary>
/// <remarks>
/// THE CSV EXPORT IS NOT THE ROUTE. It was the obvious one and the account
/// holder downloaded six of them during the capture, but ING builds those files
/// in the browser from a <c>blob:</c> URL, so there is no document to fetch -
/// only the API that fills it. Reading that API instead settled the problem the
/// CSV could not: it states an id per transaction, and that id is identical in
/// both languages, where the CSV's derived id changed for all 926 rows of the
/// real export. See <see cref="IngTransactions"/>.
/// <para>
/// CAMT.053 is not the route either, and not by choice: ING serves ISO 20022
/// statements to business customers only. Confirmed by the account holder, on
/// their own private account, rather than read in a support article.
/// </para>
/// </remarks>
internal static class IngManifest
{
    public const int Version = 1;

    /// <summary>
    /// The copy key. It names the two things a consumer has to plan for:
    /// ING wants a second factor on EVERY sign-in, and this connector signs
    /// out again when it is finished.
    ///
    /// A key, never prose: the connector cannot know the reader's language, and
    /// an English literal that reaches a screen becomes an untranslatable
    /// de-facto API the moment a consumer matches on it.
    /// </summary>
    public const string NotesKey = "connect.ing.notes.sca_every_login";

    /// <summary>"Approve the sign-in in your ING app."</summary>
    public const string AppApprovalKey = "connect.ing.challenge.app_approval";

    public static ProviderManifest Build() => new()
    {
        Id = IngAdapter.ProviderId,
        Name = "ING",
        Kind = ProviderKind.Bank,
        // ING trades across Europe and only mijn.ing.nl has been read. One
        // country, stated honestly, rather than a continent claimed.
        Country = "NL",
        ManifestVersion = Version,
        // The browser is not just for the login. Every page of transactions is
        // read through the signed-in page's own fetch, because the session is a
        // cookie jar and the agreement id in the URL belongs to the page.
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,
            // NO DesktopBrowser, and that is a decision rather than a default.
            //
            // The agent emulates a Pixel 5, and every figure this adapter was
            // built from came from a capture that ran exactly that way - down to
            // `senderref=MOBIEL` in ING's own cursor links. The desktop viewport
            // was captured too and serves a different first screen ("Log in met
            // een QR-code" instead of "Inloggen via je app"), so running one
            // against a contract read off the other is the mismatch that hid
            // DigiD's app-on-another-device screen for three captures.
            Egress = new EgressRequirement { Country = "NL", Kind = "any" },
        },
        // FALSE, and this is the honest answer rather than a cautious one.
        //
        // ING demands a second factor on EVERY sign-in - there is no
        // remembered-device path in the capture, and the password step is
        // followed by a push to the account holder's phone every time. Nothing
        // this connector holds can renew that without them.
        UnattendedFetch = false,
        // The approval happens on a phone, not in this browser, so the person
        // does not have to be sitting at the agent. The challenge relay carries
        // "go and approve it" to wherever they are.
        LoginNeedsHeadedAgent = false,
        // SESSION, and the first adapter here to declare anything but None.
        //
        // Asked for by the account holder, for a reason worth writing down:
        // ING's fraud detection notices an account that signs in repeatedly and
        // never signs out, and what it does about it lands on them rather than
        // on us. Signing out is also the only thing that ends the session early
        // - it cannot be renewed, so leaving it to expire means leaving a live
        // session lying around for its whole lifetime.
        Logout = LogoutSupport.Session,
        SecretCustody = SecretCustody.Client,
        // EPHEMERAL, which this said None for one commit and should not have.
        //
        // The reasoning was sound and the conclusion was not: a web bundle dies
        // with the tab, so a web user really does meet a full sign-in - password,
        // push notification, phone in hand - on every visit. But that is the
        // same deal DUO and BKR already ship as ephemeral, and DUO's is heavier
        // (DigiD texts a code on every single sync). None is for a login too
        // heavy to repeat per visit, not for one that is merely not free, and
        // the platform REFUSES a web session outright for a provider that
        // declares it - so the stricter value did not warn anybody, it just
        // made ING unreachable from a browser.
        //
        // What the caller actually needs to know here is already said twice
        // over: unattended_fetch is false, and the app_approval challenge is
        // the thing that makes "you will confirm each time" concrete.
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "ing",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // Credentials, then approval in the provider's app. Exactly what
            // was captured: POST /username-password/open/authenticate, then a
            // push session polled twelve times until it turned READY.
            Flow = AuthFlow.MobileApproval,
            Steps =
            [
                new AuthStep
                {
                    Id = "credentials",
                    LabelKey = "connect.ing.step.credentials",
                    Fields =
                    [
                        new FieldSpec
                        {
                            Key = "username",
                            Type = FieldType.Text,
                            Secret = false,
                            Required = true,
                            LabelKey = "connect.field.username",
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
                            LabelKey = "connect.field.password",
                            Autofill = "current-password",
                        },
                    ],
                },
            ],
            // AppApproval is the whole second factor and it is passive - there
            // is nothing to type, the human taps their phone. ING offers a QR
            // code and a TAN/PAC device as alternatives on the same screen.
            // Neither is declared, because neither was carried through to a
            // finished session in the capture and a manifest is not the place
            // to advertise a path nobody has walked.
            Challenges = [ChallengeType.AppApproval],
            Session = new SessionSpec
            {
                // FIFTEEN MINUTES, and short on purpose.
                //
                // ING's app refreshes its own session while somebody is using
                // it - POST /api/sessions/refresh is in the capture - which
                // keeps a session alive for as long as a browser is sitting on
                // the page and does nothing for one that is not. Keeping it
                // warm would mean running an agent continuously against
                // somebody's bank, which is both expensive and exactly the sort
                // of traffic that gets an account looked at.
                //
                // So: a short honest number, no refresh, and a sign-out at the
                // end of every job.
                TtlSeconds = 900,
                Refreshable = false,
                RotatesOnUse = false,
            },
            // A reauth is the whole login again - a password AND a person with
            // their phone. Telling the platform this is cheap invites it to
            // retry on a schedule against a bank that counts failed attempts.
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),
            // Five minutes is a first connect walking the history in cursor
            // pages of forty; two thousand rows is years on the captured
            // account, more than the 540 days ING keeps (user request
            // 2026-10-02: a first sync reaches as far back as the party allows).
            BankResources.TransactionsSpec(
                maxHistoryDays: MaxHistoryDays,
                typicalDurationSeconds: 300,
                maxRecordsPerFetch: 2_000),
        ],
        Limits = BankLimits.ForBank(maxHistoryDays: MaxHistoryDays) with
        {
            // Three quarters of a second between pages we ask for ourselves.
            // A stated preference rather than a measurement - no bank publishes
            // a threshold - and the thing it buys is that a first connect
            // walking twenty cursor pages does not arrive as a burst.
            MinRequestGapMs = 750,
        },
    };

    /// <summary>
    /// Eighteen months, which is <see cref="BankResources"/>' own default and
    /// is NOT established by the capture.
    /// </summary>
    /// <remarks>
    /// ING's download screen offered a range starting a year back and the API
    /// was only ever walked one page deep, so nothing here proves where its
    /// history ends. The number matters less than it looks: it CLAMPS a
    /// caller's <c>since</c>, so setting it from whatever a capture happened to
    /// show would turn "my transaction from 2023" into "that transaction does
    /// not exist" - and the page walk stops on ING's own last cursor either way.
    /// </remarks>
    private const int MaxHistoryDays = 540;
}
