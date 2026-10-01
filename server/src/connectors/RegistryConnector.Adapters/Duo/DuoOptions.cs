using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Duo;

/// <summary>
/// DUO's settings. Everything the portal could rename lives here, so a change
/// on their side is an operator edit rather than a release.
///
/// Every value is CONFIRMED against two live authenticated sessions on
/// 2026-08-10 - one signed in by sms, one by the DigiD app - unless its own
/// remark says otherwise. See docs/research/duo-digid.md.
/// </summary>
public sealed record DuoOptions
{
    /// <summary>
    /// The protected page. DUO's own redirects drive from here: it 302s to the
    /// dashboard, which bounces into SAML with <c>ForceAuthn=true</c>.
    /// </summary>
    /// <remarks>
    /// Deliberately not DigiD's entry URL. Hand-crafting an identity
    /// provider's start address is how a login succeeds at the IdP and leaves
    /// the site itself signed out - the correction bol.com forced, then
    /// Coolblue, and there is no reason to learn it a third time.
    /// </remarks>
    public string StartUrl { get; init; } = "https://mijn.duo.nl/";

    /// <summary>Where a completed sign-in lands.</summary>
    public string SignedInUrlMarker { get; init; } = "mijn.duo.nl/particulier/portaal";

    /// <summary>
    /// DUO's own SAML endpoint, which is ON <c>mijn.duo.nl</c> and carries the
    /// dashboard's address inside it as <c>Target=</c>.
    /// </summary>
    /// <remarks>
    /// This is why <see cref="SignedInUrlMarker"/> cannot stand alone, and the
    /// trap is live rather than theoretical: the very first URL of the login
    /// chain contains the string a naive check would call success.
    /// </remarks>
    public string LoginPathMarker { get; init; } = "/isam/";

    /// <summary>DigiD itself. Never ours, and never a signed-in page.</summary>
    public string LoginHostMarker { get; init; } = "login.digid.nl";

    // ---- the typed sign-in --------------------------------------------------
    //
    // Every selector below is CONFIRMED from the sms capture of 2026-08-10,
    // and they are NOT equally strong. The two DigiD forms were recorded with
    // their ids; DUO's own WAYF and DigiD's method chooser were recorded by
    // their visible LABELS only, because the capture wrote down inputs and
    // headings rather than every anchor on the page.
    //
    // That difference is why nothing here is fatal. A step whose element
    // cannot be found hands the page to the human instead - see
    // DuoAdapter.TypedSignInAsync - so the weakest selectors here cost a
    // streamed login at worst, which is exactly what this provider did before
    // any of them existed.

    /// <summary>
    /// DUO's own fork, which comes BEFORE DigiD: "who are you signing in as".
    /// </summary>
    /// <remarks>
    /// <c>Voor mijzelf</c> is chosen explicitly rather than by accepting a
    /// default, because the other option is <c>Als gemachtigde</c> - signing in
    /// on somebody else's behalf - and picking that by accident would fetch a
    /// different person's debt.
    /// </remarks>
    /// <remarks>
    /// The LABEL first, and the input second, because the input is the one
    /// that cannot be clicked. DUO styles these radios as cards and parks the
    /// real <c>input</c> off-screen, so Playwright finds it, scrolls to it,
    /// and reports "element is outside of the viewport" for as long as it is
    /// allowed to. Clicking the label is what a human does and what actually
    /// selects it.
    /// </remarks>
    public IReadOnlyList<string> SelfRadioSelectors { get; init; } =
    [
        "label[for='ITFIM_WAYF_IDP_0']",
        "label:has-text('Voor mijzelf')",
        "#ITFIM_WAYF_IDP_0",
        "input[name='ITFIM_WAYF_IDP']",
    ];

    /// <summary>
    /// The button that submits any of these pages. Ids first, then a plain
    /// submit, because only DigiD's two forms had their ids recorded.
    /// </summary>
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
        ["#submit-button", "button[type='submit']", "input[type='submit']"];

    /// <summary>
    /// DigiD's "Hoe wilt u inloggen?" chooser, by the words on the control.
    /// </summary>
    /// <remarks>
    /// Four methods are offered; the other two need an NFC document reader and
    /// are out of scope for any automated browser, so only these two are named.
    /// </remarks>
    public IReadOnlyList<string> SmsMethodSelectors { get; init; } =
        ["a:has-text('sms-controle')", "button:has-text('sms-controle')", "label:has-text('sms-controle')"];

    public IReadOnlyList<string> AppMethodSelectors { get; init; } =
        ["a:has-text('DigiD app')", "button:has-text('DigiD app')", "label:has-text('DigiD app')"];

    /// <summary>
    /// DigiD's second question on the app path: is the app on THIS device or
    /// another one.
    /// </summary>
    /// <remarks>
    /// Reported by the account holder on 2026-08-11 after a working QR sign-in:
    /// choosing the app still left one screen to click through by hand. It was
    /// invisible to the capture because the capture's operator answered it
    /// before the recorder could see it as a distinct screen.
    /// <para>
    /// ALWAYS the other device. There is no DigiD app on the agent's browser
    /// and there never will be - the phone is the whole point of this path, and
    /// the QR exists precisely to reach one that is somewhere else.
    /// </para>
    /// <para>
    /// CAPTURED 2026-08-11, and recorded as <c>duo/app-device-choice.html</c>.
    /// The earlier captures missed it for a reason worth keeping: they ran
    /// desktop Chromium while the agent runs Pixel 5, and DigiD only asks a
    /// PHONE which device the app is on. The recorder was watching a browser
    /// the agent never uses.
    /// </para>
    /// <para>
    /// The href leads, and the text follows it. Both tiles are plain anchors
    /// with the same class, so the only thing telling them apart is where they
    /// go: <c>?confirm=true</c> is the other device, and
    /// <c>inloggen_app_web_to_app</c> is this one. Taking the wrong tile does
    /// not fail loudly - it asks the operating system to open a DigiD app that
    /// does not exist in a container, and the login simply stops. A text match
    /// alone is one DigiD rewording away from that.
    /// </para>
    /// <para>
    /// The text matches stay as a fallback, Dutch first and English after,
    /// because the account holder's screen was English while a Dutch session
    /// gets Dutch. None of them may match "dit apparaat" - see
    /// <c>DuoAppDeviceChoiceTests</c>, which holds them to it.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> AppOnOtherDeviceSelectors { get; init; } =
    [
        "a.login_tile[href*='confirm=true']",
        "label:has-text('ander mobiel apparaat')",
        "a:has-text('ander mobiel apparaat')",
        "button:has-text('ander mobiel apparaat')",
        "label:has-text('another mobile device')",
        "a:has-text('another mobile device')",
        "button:has-text('another mobile device')",
    ];

    /// <summary>CONFIRMED with ids: <c>login.digid.nl/inloggen_sms</c>.</summary>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["#authentication_username", "input[name='authentication[username]']"];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["#authentication_password", "input[name='authentication[password]']", "input[type='password']"];

    /// <summary>
    /// The code, as SIX single-digit boxes.
    /// </summary>
    /// <remarks>
    /// The POST carries one field, <c>smscode[smscode]</c>, so the six boxes
    /// are presentation - but they are the presentation a browser has to type
    /// into, one digit each. Ordered, and the order is the order they are
    /// filled in.
    /// </remarks>
    public IReadOnlyList<string> CodeBoxSelectors { get; init; } =
    [
        "#smscode_smscode_field_0", "#smscode_smscode_field_1", "#smscode_smscode_field_2",
        "#smscode_smscode_field_3", "#smscode_smscode_field_4", "#smscode_smscode_field_5",
    ];

    /// <summary>How many digits DigiD texts. Six, CONFIRMED.</summary>
    public int CodeLength { get; init; } = 6;

    /// <summary>The config key naming which DigiD method to drive.</summary>
    public string MethodConfigKey { get; init; } = "method";

    public string SmsMethod { get; init; } = "sms";

    public string AppMethod { get; init; } = "app";

    /// <summary>How long the human has to read a text message and type it back.</summary>
    public int CodeChallengeSeconds { get; init; } = 300;

    /// <summary>
    /// How long to look for a step of the typed flow before giving up on it and
    /// handing the page over.
    ///
    /// Short. Every one of these misses costs the human nothing but a few
    /// seconds before the stream appears, and a long wait on a page that has
    /// been redesigned is a login that looks hung.
    /// </summary>
    public int StepProbeMs { get; init; } = 4_000;

    // ---- the QR, on the DigiD app path --------------------------------------

    /// <summary>
    /// The QR image, and the only selector here that had to be settled by
    /// capture rather than guessed.
    /// </summary>
    /// <remarks>
    /// Anchored on <c>data:image</c> because the QR is NOT the first image in
    /// its block. DigiD puts its own 44x44 logo there, serves a second remote
    /// copy inside a <c>noscript</c>, and draws the real code on a hidden
    /// canvas before exporting it into this element. An adapter selecting by
    /// position relays a logo to somebody's phone and then waits for a scan
    /// that cannot happen.
    /// </remarks>
    public IReadOnlyList<string> QrImageSelectors { get; init; } =
        ["#app_verification_code img[src^='data:image']", ".qr_code img[src^='data:image']"];

    /// <summary>
    /// The block that also states the QR's payload in plain attributes.
    /// </summary>
    /// <remarks>
    /// <c>data-code</c> holds the same <c>digid-app-auth://</c> link the image
    /// encodes. Relayed beside the picture so a consumer running ON the phone
    /// can offer a tap instead of asking somebody to photograph their own
    /// screen - which is not a scan anybody can perform.
    /// </remarks>
    public IReadOnlyList<string> QrBlockSelectors { get; init; } = ["#app_verification_code", ".qr_code"];

    public string QrImageAttribute { get; init; } = "src";

    public string QrPayloadAttribute { get; init; } = "data-code";

    /// <summary>What a relayed QR must start with to be a picture at all.</summary>
    public string QrDataUriPrefix { get; init; } = "data:image/";

    // ---- the data -----------------------------------------------------------

    public string ServicesRoot { get; init; } = "https://mijn.duo.nl/particulier/services/";

    /// <summary>The eight debt components, one field each. 346 bytes.</summary>
    public string DebtPath { get; init; } = "pfd/json/raadplegen/mijn-schulden";

    /// <summary>
    /// What DUO names an amount in that object. OBSERVED, on all eight.
    /// </summary>
    /// <remarks>
    /// USED TO TELL A HOLE FROM A NEW FIELD. The reader skipped anything that
    /// was not a JSON number, so a debt component DUO started sending as a
    /// string - or nested, or null - would drop out of the total silently,
    /// while the remaining seven still summed and the answer still looked like
    /// a complete statement of what somebody owes.
    /// <para>
    /// Their own vocabulary is the test: every amount in this object is
    /// <c>schuldbedrag*</c>, so a <c>schuldbedrag</c> that is not a number is a
    /// missing debt and fails the fetch, while anything else is metadata this
    /// connector does not read and is reported rather than refused.
    /// </para>
    /// </remarks>
    public string DebtAmountPrefix { get; init; } = "schuldbedrag";

    /// <summary>Status and the interest-rate periods, one entry per position.</summary>
    public string PositionsPath { get; init; } = "pfd/json/schulden";

    /// <summary>Months of payment holiday left. 38 bytes.</summary>
    /// <remarks>
    /// Takes a <c>peildatum</c> - the day to answer as of - and REFUSES
    /// without one: <c>{"detail":"Required parameter 'peildatum' is not
    /// present.","status":400}</c>. Missed on the first build because the
    /// query string was stripped while mapping the capture's urls, so this
    /// endpoint quietly 400'd and the record carried no payment holiday at
    /// all. DUO's own portal passes today - <c>ophalenNormenOpPeildatum(...,
    /// moment())</c> - and so does this.
    /// </remarks>
    public string PaymentHolidayPath { get; init; } = "pfd/json/raadplegen/resterend-aantal-maanden-aflosvrij";

    public string AsOfParam { get; init; } = "peildatum";

    /// <summary>
    /// Balances DUO has stated at named moments, and the date it calculated
    /// interest to. 5.6 KB.
    /// </summary>
    /// <remarks>
    /// The endpoint that overturned this connector's most argued-over
    /// decision. <c>StudentDebt</c> shipped with no as-of date at all, on the
    /// stated grounds that the date lived only inside the 2.5 MB customer
    /// dossier - and it does not: <c>SaldoActueel.renteBerekendTot</c> is right
    /// here, in a payload with no BSN, no parents and no income in it.
    /// <para>
    /// Two live captures missed it because both recorded only the pages the
    /// account holder happened to open, and nobody had opened "Mijn
    /// schuldhistorie". A third capture, aimed deliberately at the pages nobody
    /// had visited, found it in one run.
    /// </para>
    /// </remarks>
    public string HistoryPath { get; init; } = "pfd/json/raadplegen/schuldhistorie";

    /// <summary>
    /// How many months of the repayment phase are left.
    /// </summary>
    /// <remarks>
    /// Takes a base64 JSON request describing the period and which figures are
    /// wanted, which is why it is built rather than written out - see
    /// <c>DuoAdapter</c>.
    /// </remarks>
    public string GrondslagPath { get; init; } = "pfd/json/raadplegen/bepalen-grondslaggegevens-over-periode";

    public string GrondslagParam { get; init; } = "request";

    /// <summary>DUO's own name for the months-remaining figure.</summary>
    public string MonthsRemainingCode { get; init; } = "RESTEREND_AANTAL_MAANDEN_AFLOSFASE";

    /// <summary>
    /// The header DUO's own services authenticate with, and the answer to a
    /// 401 that cost four live sign-ins to understand.
    /// </summary>
    /// <remarks>
    /// CONFIRMED from a live fetch on 2026-08-11: every response from
    /// <c>mijn.duo.nl/particulier/services/</c> carries an
    /// <c>authorization</c> header, and the <c>pfd</c> services answer 401 to
    /// a request that does not send it back. The session cookie alone is not
    /// enough for them, although it is enough for <c>sessietoken/rest/jwt</c> -
    /// which is what made the failure so confusing: DUO said "signed in" and
    /// "unauthorized" in the same second.
    /// <para>
    /// Named rather than sniffed. The first version matched any header whose
    /// name looked token-ish, which was a deliberate guess to make the next
    /// run diagnosable; it is not something to keep once the answer is known.
    /// </para>
    /// </remarks>
    public string SessionTokenHeader { get; init; } = "authorization";

    /// <summary>
    /// DUO's own answer to "is anybody signed in here". 99 bytes.
    /// </summary>
    /// <remarks>
    /// This is what ENDS the login, and a url is not. Going to
    /// <see cref="StartUrl"/> redirects to the dashboard FIRST and only then
    /// bounces into SAML, so for a moment the browser sits on a
    /// <c>/particulier/portaal/</c> address while comprehensively signed out -
    /// and no amount of reading that address can tell it apart from the same
    /// address after a successful sign-in.
    /// <para>
    /// Signed in it answers <c>{"profiel":"PP","nieuwToken":true,…}</c>. Signed
    /// out it does not, and the difference is DUO's own rather than ours.
    /// </para>
    /// </remarks>
    public string SessionPath { get; init; } = "sessietoken/rest/jwt";

    /// <summary>
    /// The field that has to be there for a session to be real.
    /// </summary>
    /// <remarks>
    /// <c>profiel</c> rather than <c>timeout</c> or <c>nieuwToken</c>: it names
    /// WHOSE session this is, so it cannot plausibly be present on an answer
    /// about nobody.
    /// </remarks>
    public string SessionProfileField { get; init; } = "profiel";

    /// <summary>
    /// The endpoint no adapter may call, named here so the refusal is code
    /// rather than a paragraph in a document.
    /// </summary>
    /// <remarks>
    /// <c>raadplegen/klantbeeld</c> answers with 2.5 MB holding a BSN, both
    /// parents, a partner, twenty years of tax income, IBANs and every address
    /// somebody has lived at - and DUO's own portal calls it to draw a debt
    /// page. It is the only place the "rente is berekend tot" date exists,
    /// which is why this connector states no such date. See the note on
    /// <see cref="StudentDebt"/>.
    /// </remarks>
    public string ForbiddenPath { get; init; } = "raadplegen/klantbeeld";

    /// <summary>
    /// The same endpoint, named again for the one call that is allowed to make
    /// it.
    /// </summary>
    /// <remarks>
    /// TWO NAMES FOR ONE URL, on purpose. <see cref="ForbiddenPath"/> is the
    /// rule <see cref="DuoCalls"/> enforces on every ordinary read, and it
    /// still refuses this url outright. This one exists so that reaching the
    /// dossier requires naming it separately, at a call site that had to be
    /// written deliberately - rather than being a matter of somebody deleting
    /// a check.
    /// <para>
    /// It is reached only when the caller asked for the ledger, which nothing
    /// does by default. The account holder authorised it knowing what the
    /// endpoint holds, and what leaves the reader is the movements and one
    /// instalment: the BSN, both parents, twenty years of income, the IBANs and
    /// the addresses are never read out of the payload at all.
    /// </para>
    /// </remarks>
    public string DossierPath { get; init; } = "pfd/json/raadplegen/klantbeeld";

    /// <summary>
    /// Euros, as a JSON number, with eight decimal places - a Java BigDecimal
    /// on the wire. DECLARED, never sniffed.
    /// </summary>
    /// <remarks>
    /// It also means zero arrives as <c>0E-8</c>. That parses as a JSON number
    /// and as a <c>decimal</c> under <c>NumberStyles.Float</c>, and does NOT
    /// parse under the style <see cref="MoneyParser"/> uses for strings - so
    /// the reader takes the decimal off the reader and never round-trips these
    /// through text. Seven of the eight components are zero for almost
    /// everybody, so getting that wrong would fail on nearly every account.
    /// </remarks>
    public MoneyUnit AmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    public string Currency { get; init; } = "EUR";

    // ---- patience -----------------------------------------------------------

    /// <summary>
    /// How long a streamed sign-in may stay open. Generous on purpose: DigiD
    /// means finding a password manager, then a phone, then an app, then a
    /// PIN. The job budget stops counting while parked on the challenge.
    /// </summary>
    public int LiveLoginSeconds { get; init; } = 900;

    /// <summary>
    /// How long the QR stays on offer once it is relayed.
    /// </summary>
    /// <remarks>
    /// Shorter than the live view it interrupts, because by this point the
    /// human has their phone in their hand. Whether DigiD expires the code
    /// itself is UNKNOWN - the captured session went from QR to scan in about
    /// six seconds and nothing refreshed in that window - which is why the
    /// relay re-reads the image every poll rather than sending one and
    /// waiting.
    /// </remarks>
    public int QrChallengeSeconds { get; init; } = 300;

    public int SettlePollSeconds { get; init; } = 2;

    /// <summary>
    /// How long to wait for the portal after a typed code is submitted. DigiD
    /// resolves a SAML artifact and DUO builds a session on the way back, so
    /// this is a round trip between two government systems rather than a page
    /// load.
    /// </summary>
    public int SignInSeconds { get; init; } = 120;

    /// <summary>
    /// How long the portal is given to BOUNCE a signed-out browser into the
    /// sign-in chain, before this adapter is willing to believe the profile is
    /// still inside DUO.
    /// </summary>
    /// <remarks>
    /// UNMEASURED, and marked so rather than dressed up. Neither capture timed
    /// this redirect, because before a kept browser profile existed there was
    /// no such thing as arriving already signed in - every run started signed
    /// out and the bounce was simply the first thing that happened. What is
    /// known is the SHAPE of what is being waited for: <see cref="StartUrl"/>
    /// 302s to the dashboard and the dashboard bounces into SAML, so this is a
    /// page load's worth of patience on a slow line rather than a human's.
    /// <para>
    /// WHY THERE IS A WINDOW AT ALL, which this file has said since version 1
    /// from the other direction - see <see cref="SessionPath"/>. Opening the
    /// portal lands on a <c>/particulier/portaal/</c> address BEFORE the
    /// bounce, so for a moment a comprehensively signed-out browser is sitting
    /// on the address a signed-in one ends at. A check that read that address
    /// the instant the navigation returned would report a connect that asked
    /// nobody anything, on a browser DigiD has never seen. ASN cost this
    /// platform exactly that on 2026-09-19: its overview page answered a
    /// signed-out browser at the overview address, with a profile menu drawn
    /// on it, and moved to the sign-in page only afterwards.
    /// </para>
    /// <para>
    /// Ten seconds rather than the fifteen ASN settled on, because being wrong
    /// about this number is survivable here and was not there. A bounce slower
    /// than this window does not seal a session: it leaves the decision to
    /// <see cref="SessionPath"/>, which is DUO's own answer to "is anybody
    /// signed in here" and cannot be fooled by an address. What the window
    /// buys is the cheaper half of the answer - a browser that has already
    /// left for DigiD is signed out without a services call being made from
    /// inside the SAML chain at all.
    /// </para>
    /// <para>
    /// A profile that really IS still inside pays this window on every
    /// connect, because the bounce it waits for never arrives. That is the
    /// right way round: ten seconds, against a DigiD sign-in that costs
    /// somebody their password, their phone and a texted code.
    /// </para>
    /// </remarks>
    public int SignedOutBounceSeconds { get; init; } = 10;

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// <summary>
    /// How long to look for the QR on a page that is probably not showing one.
    /// Short: this runs on every poll of a live sign-in, and on the sms path it
    /// misses every single time.
    /// </summary>
    public int QrProbeMs { get; init; } = 250;
}
