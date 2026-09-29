using Connector.Kit.Challenges;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// ASN Bank's catalogue entry.
///
/// <para>
/// <b>NO CAPTURE STANDS BEHIND THIS FILE, and that is the first thing to know
/// about it.</b> Every other provider here was written from a recording of a
/// real account: ING's from two captures of the same account in two languages,
/// DUO's from a live DigiD session, the retailers' from their own traffic. This
/// one is written from a design document, and a design document is a statement
/// of intent rather than evidence about a website.
/// </para>
///
/// <para>
/// What that means in practice is drawn as sharply as the code allows. This
/// manifest and <see cref="AsnOptions"/> hold everything that follows from the
/// PLATFORM - which challenge types a digipass maps onto, what custody a pooled
/// agent implies, which resources a bank offers - and every fact that belongs
/// to asnbank.nl instead lives in one options file, named, defaulted and marked
/// unverified. So a capture turns this from a sketch into an adapter by
/// changing configuration, and until there is one, nothing here pretends to
/// have been tried.
/// </para>
///
/// <para>
/// Two things are genuinely known rather than assumed, and they are why ASN is
/// worth this shape at all:
/// </para>
/// <list type="number">
/// <item><b>ASN serves CAMT.053 to private customers.</b> ING does not - it
/// reserves ISO 20022 for business accounts, which is why that adapter reads a
/// JSON API instead. A statement format with a published schema is a far better
/// contract than anybody's private endpoint, and this repository already parses
/// it: <c>Camt053Parser</c>, with an ASN fixture beside the ING one.</item>
/// <item><b>ASN's "edge login" keeps a browser signed in indefinitely.</b> That
/// is the entire justification for the persistent tier - see
/// <see cref="AsnPersistentManifest"/> - and the only route to unattended bank
/// sync anywhere in this project.</item>
/// </list>
/// </summary>
internal static class AsnManifest
{
    public const int Version = 1;

    /// <summary>
    /// The provider this manifest describes, held here because there is no
    /// adapter yet to hold it.
    /// </summary>
    /// <remarks>
    /// THE ADAPTER WAS DELETED RATHER THAN PATCHED, and that is the honest
    /// bookkeeping. It was written from a design document: a digipas serial
    /// number typed into a form, then a challenge number read back. The
    /// discovery session showed a different provider - no serial field on
    /// either path anybody uses, a cookie wall in front of everything, three
    /// login methods chosen by their own product names, and a QR that is an
    /// unlabelled svg told apart from the logo by being square.
    /// <para>
    /// Nothing about that flow was salvageable by editing selectors, which is
    /// what <see cref="AsnOptions"/> was built to allow. Keeping it would have
    /// meant keeping code whose shape the evidence contradicts, next to an
    /// options file that now records the evidence. So the manifest and the
    /// options stay - both are now mostly observed - and the adapter gets
    /// written once, against what the bank actually does.
    /// </para>
    /// </remarks>
    public const string ProviderId = "asn";

    /// <summary>
    /// The copy key. It names what a consumer has to plan for: a physical
    /// device, or the bank's app, on every single sign-in.
    /// </summary>
    public const string NotesKey = "connect.asn.notes.device_every_login";

    /// <summary>"Scan the code on screen with the ASN app."</summary>
    public const string QrKey = "connect.asn.challenge.app_qr";

    /// <summary>
    /// "Every account comes down in one file, whatever you filter by."
    /// </summary>
    /// <remarks>
    /// On the FETCH rather than on the provider, because somebody reads the
    /// connect screen once and the fetch screen every time - and this is a fact
    /// about what leaves the bank.
    /// </remarks>
    public const string WholeExportKey = "fetch.asn.notes.whole_export";

    /// <summary>
    /// Eighteen months, matching every other bank here.
    /// </summary>
    /// <remarks>
    /// NOT established. It clamps a caller's <c>since</c>, so a number taken
    /// from whatever a capture happened to show would turn "my transaction from
    /// 2023" into "that transaction does not exist". The export screen's own
    /// range is what will actually bound a fetch.
    /// </remarks>
    private const int MaxHistoryDays = 540;

    public static ProviderManifest Build() => new()
    {
        Id = ProviderId,
        Name = "ASN Bank",
        Kind = ProviderKind.Bank,
        Country = "NL",
        ManifestVersion = Version,

        // The whole session lives in a browser: a statement download is a
        // signed-in page's own request, and the sign-in itself is a form.
        Runtime = ProviderRuntime.BrowserInteractive,
        Agent = new AgentRequirement
        {
            Required = true,
            Class = AgentClass.Pooled,

            // RESIDENTIAL, unlike ING's "any". A bank that authenticates with a
            // physical device is a bank whose fraud rules are watching where
            // the session came from, and a datacentre address is the cheapest
            // way to get an account holder's login questioned. ING's capture
            // proved a datacentre egress worked there; nothing proves it here,
            // so this asks for the safer thing rather than the convenient one.
            Egress = new EgressRequirement { Country = "NL", Kind = "residential" },
        },

        // A digipass response cannot be produced by anything this connector
        // holds. There is no version of this that runs without a person.
        UnattendedFetch = false,

        // The code travels OUTWARD to the human and the response comes back, so
        // the human needs their device - but not this browser. They can be
        // anywhere the challenge relay reaches.
        LoginNeedsHeadedAgent = false,

        // SESSION, and what changed is the reason rather than the evidence.
        //
        // This said None while the sign-out was a path nobody had driven - a
        // logout that silently does nothing being exactly the failure the
        // disconnect work spent a week on. It is declared now because the
        // account holder decided what it is FOR: not a courtesy at the end of
        // every fetch, but the thing that runs when a fetch fails on our side.
        // A session this connector abandoned over its own bug is one ASN leaves
        // open, on a bank whose fraud rules watch for exactly that.
        //
        // The adapter's LogoutAsync confirms the sign-out by the page it
        // reaches - /uitgelogd.html, observed - rather than by having clicked,
        // and says so either way.
        Logout = LogoutSupport.Session,
        SecretCustody = SecretCustody.Client,

        // A sign-in costs a device in hand, which is more than DUO's texted
        // code and less than nothing. Ephemeral for the same reason ING is: the
        // stricter value does not warn anybody, it makes the provider
        // unreachable from a browser.
        WebSupport = WebSupport.Ephemeral,
        LogoRef = "asn",
        NotesKey = NotesKey,
        Auth = new AuthSpec
        {
            // QR SCAN, and the digipas is gone entirely.
            //
            // This declared ChallengeResponse and asked for an eight-to-twelve
            // digit serial number, because the design document it was written
            // from described a card reader. ASN has stopped issuing those
            // devices, and the adapter never read the field anyway - it clicks
            // "ASN Bank app" and photographs a QR. So the form demanded a
            // number nobody has, marked it required, and refused to submit
            // without it: a provider nobody could connect, described by a
            // manifest that was internally consistent and externally wrong.
            Flow = AuthFlow.QrScan,

            // NO FIELDS AT ALL, which is the honest form for this bank. There
            // is nothing to type: the human scans a code with the phone that
            // already holds their banking app, and the connection is made by
            // the provider rather than by anything a consumer collects.
            Steps = [new AuthStep { Id = "scan", LabelKey = "connect.asn.step.scan", Fields = [] }],

            // LIVE VIEW, not a still QR, because ASN's code rotates every few
            // seconds. A photograph relayed once is a code that has expired by
            // the time somebody has their phone out; what they scan has to be
            // what the page is showing now. There is still no answer to bring
            // back - the scan finishes by the bank moving the browser on, which
            // is what the adapter waits for.
            Challenges = [ChallengeType.LiveView],
            Session = new SessionSpec
            {
                // An hour, still UNVERIFIED against ASN's own patience. The
                // second discovery session was cut short by the bank's idle
                // timeout rather than by this, which says the window is not
                // generous - but not what it is.
                TtlSeconds = 3600,
                Refreshable = false,
                RotatesOnUse = false,
            },

            // A reauth means the phone again, so it is not cheap and the
            // platform must not retry into it on a schedule.
            Reauth = new ReauthSpec { Cheap = false, TriggerCodes = ["session_expired"] },
        },
        Resources =
        [
            BankResources.AccountsSpec(),

            // No maxRecordsPerFetch cap, unlike ING's five hundred. A CAMT.053
            // statement arrives as ONE document for the whole window - there
            // are no pages to stop walking, and truncating a parsed statement
            // would break the balance chain that makes the format worth using.
            // ONE ACCOUNT TYPE, because that is all this export can tell apart.
            //
            // A CAMT.053 statement names an IBAN, a currency and two balances.
            // It does not say whether the account behind it is a current
            // account or a savings account, and nothing else in the download
            // does either - so every account this adapter returns is Current,
            // including the ones its owner would call savings.
            //
            // Offering four types anyway is what the shared spec did, and the
            // account holder duly ticked "credit_card" and "loan" on a
            // connection that has neither. A parameter offering choices a
            // provider cannot honour is worse than no parameter: it cannot be
            // answered correctly, only ignored or refused.
            // AND THE FETCH SAYS SO ITSELF, because the filter cannot.
            //
            // One export covers every account this login can see. The accounts
            // parameter therefore decides what a caller is SHOWN and not what
            // leaves the bank - a distinction no combination of enum values can
            // state, and one somebody filtering to a single account would
            // otherwise be entitled to get wrong.
            BankResources.TransactionsSpec(
                maxHistoryDays: MaxHistoryDays,
                typicalDurationSeconds: 60,
                accountTypes: ["current"],
                notesKey: WholeExportKey),
        ],
        // SETTLEMENT LAG ZERO, unlike every other bank here.
        //
        // The default of fourteen days exists so a card transaction that books
        // late is not missed, and it widens every caller's `since` by two weeks
        // to catch one. A CAMT.053 statement has nothing to catch: its entries
        // are booked, the bank states an opening and a closing balance around
        // them, and the parser refuses the document outright if they do not add
        // up. Widening the window here would download two extra weeks on every
        // fetch to guard against a gap that cannot exist without being
        // reported.
        Limits = BankLimits.ForBank(maxHistoryDays: MaxHistoryDays, settlementLagDays: 0),
    };
}
