namespace BankConnector.Adapters.Asn;

/// <summary>
/// Every fact about asnbank.nl this adapter depends on, in one place.
///
/// <para>
/// <b>This file used to be a list of guesses. A discovery session on
/// 2026-08-17 replaced most of them with observations</b>, and the two are
/// marked apart on every field, because the distinction is the only thing that
/// makes an options file worth having. OBSERVED means a live run reported it.
/// UNVERIFIED means it is still reasoning.
/// </para>
///
/// <para>
/// <b>The finding that reframes the provider:</b> this is not ASN's website. It
/// is de Volksbank's, serving ASN, SNS, RegioBank and BLG Wonen from the same
/// pages - the sign-in screen carries a tab per brand and a sibling login path
/// for each. So four Dutch banks are one adapter here, differing by which
/// address it opens and which tab it lands on. Nothing else in this file is
/// brand-specific.
/// </para>
///
/// <para>
/// <b>One thing is still unknown</b>, and it is the one that decides the shape
/// of the fetch: whether the download arrives as an ordinary response the
/// adapter can request, or as a blob assembled in the browser with nothing to
/// fetch. ING's turned out to be a blob, which is what sent that adapter to a
/// JSON API instead. A page probe cannot see it - answering it needs the
/// endpoint recorder ING's portal already has, lifted into the discovery run.
/// </para>
/// </summary>
public sealed record AsnOptions
{
    /// <summary>
    /// Where a sign-in begins. OBSERVED.
    /// </summary>
    /// <remarks>
    /// Arrived by disproving its predecessor. The default was
    /// <c>/online/inloggen</c>, reasoned from the pattern every Dutch bank
    /// follows; ASN answered "Pagina niet gevonden", the discovery run rendered
    /// that 404 faithfully, and the account holder found the real address.
    /// <para>
    /// The siblings, from the same page's own links, are
    /// <c>/online/web/mijnsns/inloggen/</c>,
    /// <c>/online/web/mijnregiobank/inloggen/</c> and
    /// <c>/online/web/mijnblg/inloggen/</c> - which is what makes this one
    /// adapter for four banks rather than one for ASN.
    /// </para>
    /// </remarks>
    public string LoginUrl { get; init; } = "https://www.asnbank.nl/online/web/onlinebankieren/inloggen/";

    /// <summary>
    /// The cookie banner, which stands in front of everything. OBSERVED.
    /// </summary>
    /// <remarks>
    /// REFUSE, NOT ACCEPT, and the page offers both by name:
    /// <c>Cookies weigeren</c> beside <c>Cookies accepteren</c>. A connector
    /// reading somebody's statements has no business accepting tracking on
    /// their behalf, and the banner appeared on the second sample rather than
    /// the first - so it has to be waited for rather than assumed present.
    /// </remarks>
    public IReadOnlyList<string> CookieRefuseSelectors { get; init; } =
        ["button[aria-label='Cookies weigeren']"];

    /// <summary>
    /// The "Klant bij SNS, RegioBank of BLG Wonen?" banner, dismissed so the
    /// QR fits on a phone. OBSERVED.
    /// </summary>
    /// <remarks>
    /// A COURTESY, AND THE ONLY ONE IN THIS FILE. It changes nothing about the
    /// sign-in: the banner is de Volksbank telling ASN's visitors that its
    /// other three brands live elsewhere. But the live view relays the page at
    /// the phone width the agent emulates, and with the banner up the QR is
    /// pushed below the fold - so the account holder has to scroll a streamed
    /// image before they can scan it.
    /// <para>
    /// Best effort, and it must stay that way. A sign-in that failed because a
    /// promotional banner would not close would be a defect invented for a
    /// convenience.
    /// </para>
    /// <para>
    /// Its X is the only <c>button[data-testid='button']</c> on this page - the
    /// four brand tabs beside it are <c>button[data-testid='tabs-tab']</c> and
    /// the hamburger carries its own id, so neither is reachable through this
    /// selector. That matters: clicking a tab would switch the customer to
    /// another bank's sign-in.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> BannerDismissSelectors { get; init; } =
        ["button[data-testid='button']"];

    /// <summary>
    /// Choosing how to sign in. OBSERVED - three of them, by their own words.
    /// </summary>
    /// <remarks>
    /// The page offers <c>ASN Bank app</c>, <c>Wachtwoord + Beveiligingscode</c>
    /// and <c>Digipas</c> as three <c>button.ap-button</c> elements, told apart
    /// only by their labels. Matching a label means matching Dutch, which this
    /// codebase avoids everywhere else - but here there is nothing else to
    /// match on, and the words are the provider's own product names rather than
    /// prose. Recorded as the limitation it is.
    /// </remarks>
    public string AppMethodLabel { get; init; } = "ASN Bank app";

    /// <inheritdoc cref="AppMethodLabel"/>
    public string PasswordMethodLabel { get; init; } = "Wachtwoord + Beveiligingscode";

    // NO DIGIPASS LABEL. The button is still on ASN's page and the bank has
    // stopped issuing the devices, so an option nobody can use is an option
    // worth not offering. The password path stays because it is a path
    // somebody could still be on.

    /// <summary>Every method button, to pick the wanted one out of.</summary>
    public IReadOnlyList<string> MethodSelectors { get; init; } = ["button.ap-button"];

    /// <summary>
    /// The username and password boxes on the password path. OBSERVED, and the
    /// selector is qualified by TYPE for a reason.
    /// </summary>
    /// <remarks>
    /// Every input on de Volksbank's pages is <c>input[data-testid='input']</c>
    /// - the username, the password, the checkbox, the date fields on the
    /// export screen, all of it. The test id identifies the COMPONENT, not the
    /// field, so it is useless on its own and only the type tells them apart.
    /// <para>
    /// This is the sort of thing a capture is for. A reasoned selector would
    /// have been <c>#username</c> or <c>input[name=...]</c>, and neither
    /// exists.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["input[type='text'][data-testid='input']"];

    /// <inheritdoc cref="UsernameSelectors"/>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["input[type='password'][data-testid='input']"];

    /// <summary>Submitting the sign-in form. OBSERVED.</summary>
    public string SubmitLabel { get; init; } = "Inloggen";

    /// <summary>
    /// The QR the app scans, which has to be found by GEOMETRY. OBSERVED.
    /// </summary>
    /// <remarks>
    /// It is an <c>svg</c> with no id, no test id and no class worth the name,
    /// sitting on a page whose logo is also an <c>svg</c>. What separates them
    /// is shape: the code measured 205x205 and the logo 158x30, so the rule is
    /// "the square one, bigger than this".
    /// <para>
    /// Every guess this replaced - <c>[data-test='qr']</c>, <c>canvas.qr</c>,
    /// <c>img[alt*='QR']</c> - was wrong about the element type as well as the
    /// handle. A selector was never going to find this.
    /// </para>
    /// </remarks>
    public int QrMinimumPixels { get; init; } = 150;

    /// <summary>How square a thing has to be to be a code rather than a banner.</summary>
    public int QrSquareTolerance { get; init; } = 8;

    /// <summary>
    /// What proves the sign-in landed. OBSERVED, and deliberately not a word.
    /// </summary>
    /// <remarks>
    /// The signed-in pages leave <c>/inloggen/</c> behind: the overview is
    /// <c>/online/web/onlinebankieren/</c> and an account is
    /// <c>/online/web/onlinebankieren/rekening/{id}</c>. There is also an
    /// "Uitloggen" button, which is a better marker in every way except the one
    /// that matters - it is a Dutch word, and a bank that translates its own
    /// site for an English-speaking customer would silently fail every login.
    /// A path does not translate.
    /// </remarks>
    public string SignedInPathMarker { get; init; } = "/online/web/onlinebankieren/";

    /// <summary>The path that means the sign-in has NOT happened yet.</summary>
    public string SignInPathMarker { get; init; } = "/inloggen/";

    /// <summary>
    /// Where statements are downloaded. OBSERVED.
    /// </summary>
    /// <remarks>
    /// Reached from an account page's "Bij- en afschrijvingen downloaden", and
    /// it carries the whole export as one form: an account picker that
    /// multi-selects (the session saw three accounts and an "Alles selecteren"
    /// button), two typed date boxes, a direction filter and a format picker.
    /// <para>
    /// The format modal states it outright - "CAMT.053 is geschikt voor
    /// boekhoudpakketten en vervangt bestandsformaat MT940" - which confirms
    /// the format this connector wants is offered to private customers, the
    /// thing ING reserves for businesses.
    /// </para>
    /// </remarks>
    public string ExportPath { get; init; } = "/online/web/onlinebankieren/zelf-regelen/transacties-downloaden";

    /// <summary>
    /// The two date boxes on the export form. OBSERVED, including the length.
    /// </summary>
    /// <remarks>
    /// <c>maxlength=10</c> on both, which is <c>dd-mm-jjjj</c> and means the
    /// dates can be TYPED. That matters more than it looks: the screen also has
    /// a month-by-month calendar behind "Kies een dag", and driving one of
    /// those back through years of history is the kind of loop that breaks on
    /// every redesign.
    /// </remarks>
    public IReadOnlyList<string> DateSelectors { get; init; } =
        ["input[type='text'][maxlength='10'][data-testid='input']"];

    /// <summary>Opening the format modal, and saving it. OBSERVED.</summary>
    public string FormatChangeLabel { get; init; } = "Wijzigen";

    /// <summary>
    /// The format dialog's own heading, so opening it is checked. OBSERVED.
    /// </summary>
    /// <remarks>
    /// The same discipline the account dialog gets, for the same reason: this
    /// form has three separate modals, and every step after one of them means
    /// something different depending on which is open.
    /// </remarks>
    public string FormatModalHeading { get; init; } = "Wijzigen bestandsformaat";

    /// <inheritdoc cref="FormatChangeLabel"/>
    public string FormatSaveLabel { get; init; } = "Opslaan";

    /// <summary>Starting the download. OBSERVED.</summary>
    public string DownloadLabel { get; init; } = "Downloaden";

    /// <summary>
    /// THE ACCOUNTS ARE PICKED IN A MODAL, opened by the box around the select.
    /// </summary>
    /// <remarks>
    /// The account control is the form's one <c>select[data-testid='select']</c>
    /// - first input in the document, ahead of both date boxes, which puts it
    /// under "Kies je rekening(en)" and nowhere else. It cannot be clicked
    /// directly: Playwright refused it as unactionable while the shape probe
    /// listed it happily, which is what a native control parked behind a styled
    /// wrapper looks like. <b>A probe that walks the DOM sees elements a user
    /// cannot reach.</b> So the click goes to its parent, which is the thing a
    /// person actually presses.
    /// <para>
    /// <b>NOT the third button, and this is the one to remember.</b> Two
    /// commits in a row aimed at it - first by the stem "rekening", then by its
    /// exact label and its index - and it is the app shell's BACK control. Its
    /// label is the title of the page you came from: "Overzicht" on an account
    /// page, "ASN Bankrekening" on a form reached from that account, absent
    /// entirely on the root overview, and "Rekening" for this adapter, which
    /// arrives from nowhere. On a capture with the user menu open, "Uitloggen"
    /// is inserted immediately before it - so it sits in the header, not in the
    /// form. Clicking it does exactly what a back button does, which is how a
    /// fetch ended up on /zelf-regelen/rekeningen.
    /// </para>
    /// <para>
    /// A label that names what you want, on a control that does something else,
    /// is the most expensive kind of evidence in this file.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> AccountPickerSelectors { get; init; } =
        ["xpath=//select[@data-testid='select']/.."];

    /// <summary>The select itself, for a click that ignores actionability.</summary>
    public IReadOnlyList<string> AccountPickerForceSelectors { get; init; } =
        ["select[data-testid='select']"];

    /// <summary>
    /// The form's two unlabelled buttons, as a last resort. UNVERIFIED.
    /// </summary>
    /// <remarks>
    /// Among <c>button[data-testid='button']</c> the export form has 0 and 1 in
    /// the page chrome, 2 as the back control, and 3 and 4 inside the form
    /// itself with no text on them. The likeliest reading is that those two are
    /// the calendar triggers for the two date boxes - there are exactly two of
    /// each - which is why they are last and not first.
    /// <para>
    /// <b>2 is deliberately not in this list.</b> Every attempt is judged by
    /// whether the account dialog actually appeared, so a wrong guess here
    /// costs a reload; a click on the back control costs the page.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> AccountPickerFallbackSelectors { get; init; } =
        ["button[data-testid='button']"];

    /// <inheritdoc cref="AccountPickerFallbackSelectors"/>
    public IReadOnlyList<int> AccountPickerFallbackIndexes { get; init; } = [3, 4];

    /// <summary>
    /// The dialog's own heading, which is how "it opened" is CHECKED. OBSERVED.
    /// </summary>
    /// <remarks>
    /// "Kies een rekening", and the form underneath it permanently shows "Kies
    /// je rekening(en)" - close enough to read alike, far enough apart that
    /// neither contains the other. Checking beats assuming here for a specific
    /// reason: every failure on this bank so far has been a click that landed
    /// somewhere unintended and was never verified, so the next step hunted for
    /// something on a page that had moved on.
    /// </remarks>
    public string AccountModalHeading { get; init; } = "Kies een rekening";

    /// <summary>
    /// APPLYING the account dialog, which is not the same as closing it.
    /// OBSERVED at last, and by PREFIX because it carries a count.
    /// </summary>
    /// <remarks>
    /// <c>Selectie bevestigen (3)</c>. Three commits guessed at this - Opslaan,
    /// Gereed, Toepassen, Bevestigen, Klaar, Selecteren - and it was none of
    /// them, because the shape probe's button cap was hiding the end of the
    /// dialog. Raising the cap showed it immediately, along with its neighbour.
    /// <para>
    /// <b>Its neighbour is why a guess was never going to be good enough.</b>
    /// The dialog ends with "Alles selecteren (3)", "Selectie wissen (3)" and
    /// "Selectie bevestigen (3)" - take all, CLEAR ALL, and confirm. A run that
    /// pressed the last <c>button[data-testid='button']</c> as a guess at the
    /// primary action pressed "Selectie wissen" and threw the selection away;
    /// the capture afterwards read "(0)" where it had read "(3)". The confirm
    /// is a <c>button.ap-button</c> and sits outside that selector entirely.
    /// </para>
    /// <para>
    /// The count in the label is the same trap as the select-all, so this is
    /// matched as a prefix.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> AccountConfirmLabels { get; init; } = ["Selectie bevestigen"];

    /// <summary>One checkbox per account, which is how many there are.</summary>
    /// <remarks>
    /// Counted rather than read. A number says whether an export covered
    /// everything without this connector asking the dialog for a single name or
    /// IBAN.
    /// </remarks>
    public IReadOnlyList<string> AccountCheckboxSelectors { get; init; } =
        ["input[type='checkbox'][data-testid='input']"];

    /// <summary>Dismissing that modal. OBSERVED, and by test id rather than by a word.</summary>
    public IReadOnlyList<string> ModalCloseSelectors { get; init; } =
        ["button[data-testid='modal-close']"];

    /// <summary>
    /// Selecting every account at once. OBSERVED as "Alles selecteren (3)".
    /// </summary>
    /// <remarks>
    /// The count is in the label, so the whole string cannot be matched - this
    /// is the prefix. One export covers every account selected, which is why it
    /// is worth taking them all: asking per account would mean one download
    /// each, against a bank that is watching how often somebody exports.
    /// <para>
    /// The click is CHECKED rather than best-effort. A miss would go on to
    /// export whatever happened to be ticked and return it as the complete set,
    /// and a partial list of somebody's accounts published as the whole list is
    /// the failure nobody can see from the outside.
    /// </para>
    /// </remarks>
    public string AllAccountsLabelPrefix { get; init; } = "Alles selecteren";

    /// <summary>What the zip checkbox says, for the message when a zip arrives anyway.</summary>
    public string NoZipLabel { get; init; } = "Geen zip-bestand van maken";

    /// <summary>
    /// How long to wait for the file after the download is clicked.
    /// </summary>
    /// <remarks>
    /// A statement is assembled on ASN's side before it is sent - the real one
    /// covered eight months and half a megabyte - so this is a bank doing work
    /// rather than a page loading.
    /// </remarks>
    public int DownloadSeconds { get; init; } = 120;

    /// <summary>
    /// THE EXPORT ARRIVES AS A ZIP, not as the XML inside it. OBSERVED.
    /// </summary>
    /// <remarks>
    /// A real download from 2026-08-17 was
    /// <c>transactie-historie__&lt;stamp&gt;.zip</c> holding one
    /// <c>transactieoverzicht-&lt;stamp&gt;.xml</c>. ASN offers an unzipped
    /// option too, and taking it is the simpler adapter - one fewer format to
    /// be wrong about, and nothing to unpack in memory. Which radio selects it
    /// is not yet known.
    /// <para>
    /// <b>What the file proved</b>, by being run through this repository's own
    /// <c>Camt053Parser</c>: 390 entries over eight months in
    /// <c>camt.053.001.02</c>; an IBAN, a currency and BOTH balances stated;
    /// every entry carrying its own external id and all 390 distinct - so ASN
    /// needs none of the derived-id machinery ING's card and loan feeds forced;
    /// a value date on every row, which ING states nowhere; and the entries
    /// summing EXACTLY onto the balance movement.
    /// </para>
    /// <para>
    /// The kinds came out CardPayment 275, Transfer 68, Other 29, DirectDebit
    /// 9, Fee 8, Interest 1 - which means the format separates interest from
    /// fees, the very thing ING's DV bucket cannot do. The 29 left as Other are
    /// this provider's open question, and the same instrument that answered
    /// ING's will answer it.
    /// </para>
    /// </remarks>
    public bool PreferUnzippedExport { get; init; } = true;

    /// <summary>
    /// The format modal: three radios, in this order. OBSERVED.
    /// </summary>
    /// <remarks>
    /// <c>Pdf</c>, <c>CSV</c>, <c>CAMT.053</c> - so the one this connector
    /// wants is the THIRD, at index 2. Two earlier readings of this modal were
    /// both wrong: "five radios" counted the feedback widget's stars on the
    /// same page, and guessing the three were CSV, MT940 and CAMT.053 put a
    /// format in the list that is not offered at all. It took a screenshot to
    /// settle, because the labels live in sibling elements the shape probe does
    /// not read.
    /// <para>
    /// Selected by index rather than by its label, which is the safer of two
    /// imperfect options: "CAMT.053" is a standard's name and will not
    /// translate, but the modal renders it inside its own markup where a
    /// selector cannot reach, and an index at least fails loudly when the list
    /// changes length.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> FormatRadioSelectors { get; init; } =
        ["input[type='radio'][data-testid='input']"];

    /// <summary>Which of them is CAMT.053. OBSERVED: third, after Pdf and CSV.</summary>
    public int Camt053RadioIndex { get; init; } = 2;

    /// <summary>
    /// The zip checkbox, WHICH MEANS THE OPPOSITE OF WHAT IT LOOKS LIKE.
    /// OBSERVED.
    /// </summary>
    /// <remarks>
    /// It reads <c>Geen zip-bestand van maken</c> - "do not make a zip file" -
    /// so TICKING it is what produces the bare XML, and leaving it produces the
    /// archive. ASN zips by default and says so above it: "Je bestand wordt
    /// standaard verkleind in een zip-bestand".
    /// <para>
    /// A NEGATIVE CHECKBOX IS THE KIND OF THING THAT BREAKS SILENTLY. An
    /// adapter written to "tick the zip box" would get precisely the wrong file,
    /// and the failure would arrive as a parser refusing a zip where XML was
    /// expected, which reads like the bank changing its export rather than like
    /// this connector reading a label backwards. Recorded as a property rather
    /// than left to whoever writes the fetch.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> NoZipCheckboxSelectors { get; init; } =
        ["input[type='checkbox'][data-testid='input']"];

    /// <summary>Whether that checkbox has to be TICKED to get unzipped XML. OBSERVED: yes.</summary>
    public bool TickNoZipForXml { get; init; } = true;

    /// <summary>
    /// Where a sign-out lands. OBSERVED - the run signed out and arrived here.
    /// </summary>
    /// <remarks>
    /// <c>/asn-app-en-asn-online-bankieren/uitgelogd.html</c>, titled
    /// "Uitgelogd". A path rather than a word again, for the same reason the
    /// signed-in marker is one.
    /// <para>
    /// So the sign-out is now a walked route rather than a button somebody
    /// noticed, and the manifest can declare <see cref="LogoutSupport.Session"/>
    /// when the adapter that clicks it exists. Until then the manifest still
    /// says None, because what has been walked is a HUMAN clicking it.
    /// </para>
    /// </remarks>
    public string SignedOutPathMarker { get; init; } = "/uitgelogd.html";

    /// <summary>
    /// The menu, which is behind a hamburger. OBSERVED.
    /// </summary>
    /// <remarks>
    /// The agent emulates a phone, so the navigation that a desktop shows
    /// outright is collapsed here - the same trap ING's adapter documents,
    /// where a desktop viewport served a different first screen entirely. An
    /// adapter that reasoned from a desktop layout would find no menu at all.
    /// <para>
    /// <b>AND THE SIGN-OUT IS NOT IN IT.</b> Walked, on a live disconnect that
    /// opened this menu and then described what it had: three
    /// <c>button[data-testid='header-menu-vertical-item']</c> reading
    /// "Overzicht", "Zelf regelen" and "Contact". That is the whole menu. The
    /// user menu that holds <see cref="SignOutLabel"/> is a different control -
    /// see <see cref="SignOutMenuSelectors"/> - and reading "the menu" as "the
    /// hamburger" cost a disconnect to find out.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> MenuSelectors { get; init; } =
        ["button[data-testid='header-hamburger-button']"];

    /// <summary>
    /// The header controls that might open the user menu. OBSERVED as present,
    /// PURPOSE unverified.
    /// </summary>
    /// <remarks>
    /// AN ENUMERATION OVER A SET OF TWO, not a guess. The signed-in header
    /// carries exactly two unnamed <c>button[data-testid='button']</c> ahead of
    /// everything else - the same two this file already records on the export
    /// form, where "0 and 1 are in the page chrome, 2 is the back control". One
    /// of them opens the user menu; there is no third candidate.
    /// <para>
    /// The evidence that the sign-out lives behind one of them is the export
    /// form's own capture: with the user menu open, "Uitloggen" is inserted
    /// IMMEDIATELY BEFORE the back control - so it lands at index 2, directly
    /// after these two, which is what a panel hung off one of them would do.
    /// </para>
    /// <para>
    /// Each rung is checked by whether <see cref="SignOutLabel"/> appears, so a
    /// press that opens the wrong thing is not mistaken for the right one. Both
    /// are header chrome on an overview page - the destructive controls on this
    /// bank are several confirmations deep, and neither of these is one of
    /// them.
    /// </para>
    /// </remarks>
    // ---- the trusted browser -----------------------------------------------
    //
    // Everything in this block is OBSERVED, from one mapping run on
    // 2026-08-26 that walked ASN's browser registration end to end.
    //
    // What it settles: ASN will remember a browser. /online/browser-aanmelden/
    // takes a five-digit BROWSERCODE the customer chooses, confirms it against
    // an e-mail code, an SMS code and their debit card, and signs the whole
    // thing with the browsercode itself. Afterwards the sign-in page for that
    // browser is not three method buttons - it is "Je logt in als <name>", one
    // five-digit box, and Inloggen.
    //
    // That is the difference between a sync that needs a phone in somebody's
    // hand and one that needs five digits, and it is only reachable at all
    // because a BYO agent keeps its profile: the trust IS a cookie.

    /// <summary>Where a browser is registered. OBSERVED.</summary>
    /// <remarks>
    /// Linked from the sign-in page itself, which is how the mapping run
    /// reached it. The registration is long and human - two one-time codes and
    /// a card - so this adapter never drives it; it is where the account holder
    /// is sent, once, in a live view.
    /// </remarks>
    public string BrowserRegistrationPath { get; init; } = "/online/browser-aanmelden/";

    /// <summary>
    /// The five-digit box a trusted browser signs in with. OBSERVED.
    /// </summary>
    /// <remarks>
    /// <c>maxlength=5</c> and <c>type=password</c>, and it is THE tell that
    /// this browser is trusted: on an unregistered browser the same page offers
    /// three method buttons and no input at all. So "is this profile still
    /// trusted" is a question about whether this box is on the page, which is
    /// cheaper and more honest than remembering that it once was.
    /// </remarks>
    public IReadOnlyList<string> BrowserCodeSelectors { get; init; } =
        ["input[type='password'][maxlength='5'][data-testid='input']"];

    /// <summary>How many digits ASN's browsercode has. OBSERVED: five.</summary>
    public int BrowserCodeLength { get; init; } = 5;

    /// <summary>The button beside it. OBSERVED.</summary>
    public string BrowserCodeSubmitLabel { get; init; } = "Inloggen";

    /// <summary>
    /// What a trusted browser's sign-in page greets you with. OBSERVED:
    /// "Je logt in als (naam)".
    /// </summary>
    /// <remarks>
    /// Matched as a PREFIX, because the rest of it is the account holder's own
    /// name - which this connector has no business asserting and no way to know
    /// before it arrives.
    /// <para>
    /// The SECOND witness that a browser is registered, behind the box. On its
    /// own the box is the tell; this is here for the day ASN restyles the
    /// input, so that a registered browser whose box has moved reads as "the
    /// page has changed" rather than as "sign in the ordinary way" - which on
    /// a registered browser is a page with no method buttons, and degrades the
    /// provider for everyone.
    /// </para>
    /// </remarks>
    public string SignedInAsHeadingPrefix { get; init; } = "Je logt in als";

    /// <summary>
    /// The user menu, BY NAME. OBSERVED, and it ends the guessing.
    /// </summary>
    /// <remarks>
    /// A mapping run on 2026-08-26 described the signed-in header as
    /// <c>button[data-testid='button'] "Zoeken"</c> and
    /// <c>button[data-testid='button'] "Profiel menu openen"</c> - which is the
    /// first time either of them has had a name. They had one all along: the
    /// probe was reporting a control with no text as unnamed instead of reading
    /// its <c>aria-label</c>, and fixing that is what put these words on screen.
    /// <para>
    /// Three live sign-outs were spent finding "the second header control" by
    /// pressing header controls in order. This is that answer said properly,
    /// and it survives ASN reordering its own header - which the positional
    /// form below does not.
    /// </para>
    /// <para>
    /// ALSO THE WITNESS THAT A PAGE IS SIGNED IN AT ALL. It is the one control
    /// seen on a signed-in page and on no other, so the persistent tier waits
    /// for it before believing an overview address - see
    /// <see cref="SignedInSettleSeconds"/> for why the address alone was not
    /// enough. The address still has the final word; this only says when it
    /// is safe to read.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> UserMenuSelectors { get; init; } =
        ["button[aria-label='Profiel menu openen']"];

    /// <summary>
    /// The same control by its NAME, which is the half of that observation
    /// that was actually observed.
    /// </summary>
    /// <remarks>
    /// The probe reports a control as selector plus name, and it builds the
    /// selector from <c>data-testid</c> when there is one - which for every
    /// button in ASN's design system there is. The name it reads from
    /// <c>aria-label</c> OR <c>title</c>. So "Profiel menu openen" is a fact
    /// and <see cref="UserMenuSelectors"/>, which spells it as an aria-label,
    /// is a guess about where the fact lives; if it is a title, that selector
    /// matches nothing on a page that plainly has the control.
    /// <para>
    /// Asked by name it does not matter which: a button is matched on its
    /// accessible name, computed from either attribute. Kept as its own option
    /// rather than folded into the selector list because it is a different
    /// KIND of question - one goes to the DOM, the other to the accessibility
    /// tree - and because the day a live run settles which attribute it is,
    /// this is the line that records it.
    /// </para>
    /// </remarks>
    public string UserMenuLabel { get; init; } = "Profiel menu openen";

    public IReadOnlyList<string> SignOutMenuSelectors { get; init; } =
        ["button[data-testid='button']"];

    /// <summary>
    /// Which of them to try, in order. WALKED, and 1 is the one.
    /// </summary>
    /// <remarks>
    /// <b>1 FIRST BECAUSE 0 IS THE SEARCH.</b> Pressing it opens a panel
    /// reading "Veel gebruikte links" with a search box in it - seen on a live
    /// disconnect, which then went on to press "the second header control"
    /// while that panel was covering the header, and pressed the second search
    /// result instead. Control 1 opens the user menu, and the sign-out that
    /// finally landed came through it.
    /// <para>
    /// 0 is kept behind it rather than deleted: it costs nothing when 1 works,
    /// and a header that gets rearranged is the likeliest way this breaks
    /// again. Every rung is judged by whether the sign-out appeared, so trying
    /// the search does no harm beyond a press and a reload.
    /// </para>
    /// </remarks>
    public IReadOnlyList<int> SignOutMenuIndexes { get; init; } = [1, 0];

    /// <summary>
    /// Signing out. OBSERVED, and only with the menu open.
    /// </summary>
    /// <remarks>
    /// <b>ONLY WITH THE MENU OPEN, which is what a live disconnect cost to
    /// learn.</b> "The button is on every signed-in page" was this file's own
    /// wording and it was read as "on the page"; the capture it came from says
    /// otherwise a hundred lines up - "on a capture with the user menu open,
    /// 'Uitloggen' is inserted immediately before [the back control]". At the
    /// phone width the agent emulates, the menu is shut, so the button does not
    /// exist. Every disconnect ASN has ever been sent spent ten seconds missing
    /// it and then reported the bank as not having a sign-out.
    /// <para>
    /// The evidence was already written down. It was filed under the account
    /// picker, because that is what the capture was taken for, and nobody
    /// carried it to the field it describes - so <see cref="MenuSelectors"/>
    /// sat in this file read by nothing at all.
    /// </para>
    /// <para>
    /// Worth doing: the session in the discovery run timed out on its own, so
    /// ASN does end an idle session - but on its schedule rather than ours, and
    /// a bank that sees a string of sessions never signed out of draws its own
    /// conclusions about the account.
    /// </para>
    /// </remarks>
    public string SignOutLabel { get; init; } = "Uitloggen";

    /// <summary>
    /// How long to wait for a human with a phone in their hand.
    /// </summary>
    /// <remarks>
    /// Five minutes. UNVERIFIED against ASN's own patience - the discovery
    /// session was cut short by the bank's idle timeout rather than by this,
    /// which is worth knowing: whatever ASN's window is, it is not generous.
    /// </remarks>
    public int HumanSeconds { get; init; } = 300;

    /// <summary>
    /// How long somebody has to register a browser with ASN.
    /// </summary>
    /// <remarks>
    /// TWELVE MINUTES, and generous because the errand is: twenty screens, an
    /// account number, a card sequence, a code that arrives by e-mail and
    /// another that arrives by text. Two of those wait on a message this
    /// connector cannot see and cannot hurry, and a budget that expired
    /// mid-registration would leave a half-trusted browser and somebody
    /// starting again.
    /// <para>
    /// Bounded all the same. It happens once per machine, and an abandoned run
    /// must release its agent rather than hold a browser open on somebody's
    /// bank for the whole job budget.
    /// </para>
    /// </remarks>
    public int RegistrationSeconds { get; init; } = 720;

    /// <summary>
    /// How long a trusted browser gets to LAND after its five digits are
    /// submitted.
    /// </summary>
    /// <remarks>
    /// Thirty seconds, and A JUDGMENT RATHER THAN AN OBSERVATION - nobody has
    /// timed this page. What is known is what the wait costs when it is
    /// wrong. It used to borrow <see cref="SelectorTimeoutMs"/>, which is ten
    /// seconds and is the budget for a control APPEARING on a page that is
    /// already open. This is a different thing: a bank checking a credential,
    /// setting up a session and serving an overview, on a headed emulated
    /// Chromium. A landing that takes eleven seconds was reported as "ASN did
    /// not accept that browsercode", the profile was marked unhealthy for it,
    /// and the account holder was sent to re-check five digits that were
    /// right.
    /// <para>
    /// Long, because the wrong-code case is cheap to wait on - a refused code
    /// leaves the browser on the sign-in page, which reads the same at ten
    /// seconds as at thirty - and the slow-landing case is expensive to get
    /// wrong. Bounded, because a page that has not moved in half a minute is
    /// not going to.
    /// </para>
    /// </remarks>
    public int BrowserCodeLandingSeconds { get; init; } = 30;

    /// <summary>
    /// How long the overview is given to SETTLE before it is read as signed
    /// in or out.
    /// </summary>
    /// <remarks>
    /// <b>OBSERVED, now, and the answer was the expensive one.</b> On
    /// 2026-09-19 a profile made minutes earlier was answered at the overview
    /// address with a page that kept that address and showed a visible
    /// profile menu, and moved to <c>/inloggen/</c> only afterwards. So this
    /// is how long the page is given to BOUNCE, and a page that has not
    /// bounced within it is then confirmed by its menu - rather than, as
    /// before, how long the menu was given to appear before the address was
    /// believed.
    /// <para>
    /// What that run showed, in order: the login reported "this profile was
    /// still signed in to ASN, so nothing was asked of you" on a profile
    /// directory that had existed for seconds; twenty-five seconds later the
    /// fetch captured the page and it was <c>/inloggen/</c>, offering the
    /// three method buttons an UNREGISTERED browser gets. So the address was
    /// the overview's and the menu was on screen while the browser was
    /// neither signed in nor known to the bank, and the two witnesses that
    /// were supposed to disagree with each other agreed, wrongly.
    /// </para>
    /// <para>
    /// Hence the inversion this number now serves. A signed-out browser's
    /// page eventually goes to <c>/inloggen/</c>; a signed-in one never does.
    /// That is the only behaviour observed to separate them, so the page is
    /// given this long to do it, and only a page that does not is then
    /// confirmed by its menu. Fifteen seconds is still a judgment - the
    /// observed bounce landed somewhere inside twenty-five - and it is the
    /// number to revisit first if a signed-out profile is ever again reported
    /// as connected.
    /// </para>
    /// <para>
    /// A profile that really is signed in pays this window on every check,
    /// because the bounce it waits for never arrives. That is the right way
    /// round: seconds on a fetch that takes a minute, against a connect which
    /// asks nobody anything and a fetch which then drives the export form
    /// into a sign-in page and degrades the provider for everybody.
    /// </para>
    /// </remarks>
    public int SignedInSettleSeconds { get; init; } = 15;

    /// <summary>How long to wait for one of this file's selectors to appear.</summary>
    public int SelectorTimeoutMs { get; init; } = 10_000;

    /// <summary>
    /// How long a discovery run streams the bank to whoever is driving it.
    /// </summary>
    /// <remarks>
    /// Twelve minutes, and generous on purpose: this is somebody reading an
    /// unfamiliar bank's screens, fetching a phone, scanning a code and then
    /// hunting for the statement download. Bounded all the same - an abandoned
    /// run must release its agent rather than hold a browser open on an
    /// account for the whole job budget.
    /// </remarks>
    public int DiscoverySeconds { get; init; } = 720;

    /// <summary>
    /// How long to see nothing new before deciding somebody has finished.
    /// </summary>
    /// <remarks>
    /// Ninety seconds. A live view is passive - there is no button for "I am
    /// done" - so without this the run holds an agent and a browser for its
    /// full twelve minutes after the last screen, showing the caller a
    /// progress trail with nothing under it. That happened on the second real
    /// session: the account holder downloaded their statement, finished, and
    /// was left waiting.
    /// <para>
    /// Long enough to survive somebody reading a page, hunting for a menu or
    /// answering their phone; short enough that finishing feels like finishing.
    /// </para>
    /// </remarks>
    public int QuietSeconds { get; init; } = 90;

    /// <summary>How often to look at the page while somebody is driving it.</summary>
    /// <remarks>
    /// Two seconds. Fast enough that a screen passed through quickly is still
    /// caught, slow enough that it costs nothing - and duplicates are dropped
    /// anyway, so the only cost of sampling often is the sampling.
    /// </remarks>
    public int SamplePollSeconds { get; init; } = 2;

    /// <summary>
    /// How many distinct screens to record before stopping.
    /// </summary>
    /// <remarks>
    /// A cap rather than an expectation, and the first run hit it exactly: 20
    /// screens, with the sign-out page arriving last. Worth raising if a
    /// session needs to go further, and worth knowing that the agent buffers a
    /// bounded number of notes per job - a session that wandered through fifty
    /// screens would push the early ones out of the very report they exist for.
    /// </remarks>
    public int DiscoveryScreens { get; init; } = 20;
}
