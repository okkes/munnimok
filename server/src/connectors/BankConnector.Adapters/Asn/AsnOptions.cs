namespace BankConnector.Adapters.Asn;

/// Every fact about asnbank.nl, marked OBSERVED (a live run reported it) or UNVERIFIED (still reasoning).
/// The site is de Volksbank's, serving ASN, SNS, RegioBank and BLG Wonen: a tab and a login path per brand, one adapter.
public sealed record AsnOptions
{
    /// Where a sign-in begins. OBSERVED. Siblings: /online/web/mijnsns/, /mijnregiobank/, /mijnblg/ (each + inloggen/).
    public string LoginUrl { get; init; } = "https://www.asnbank.nl/online/web/onlinebankieren/inloggen/";

    /// The cookie banner. OBSERVED. Refuse, not accept; it appears on the second sample, so it is waited for.
    public IReadOnlyList<string> CookieRefuseSelectors { get; init; } =
        ["button[aria-label='Cookies weigeren']"];

    /// The "Klant bij SNS, RegioBank of BLG Wonen?" banner, dismissed so the QR is not below the fold. Best effort.
    /// Its X is the only button[data-testid='button'] here (brand tabs are tabs-tab): no tab (another bank's sign-in) is hit.
    public IReadOnlyList<string> BannerDismissSelectors { get; init; } =
        ["button[data-testid='button']"];

    /// The way past ASN's "Browser updaten" notice, shown to a browser it judges outdated. OBSERVED (#562).
    public IReadOnlyList<string> BrowserNoticeContinueSelectors { get; init; } =
        ["a:has-text('Naar ASN Online Bankieren')", "button:has-text('Naar ASN Online Bankieren')"];

    /// Short: on a current browser the notice never comes, and every sign-in pays the wait.
    public int BrowserNoticeProbeMs { get; init; } = 1_500;

    /// OBSERVED: three button.ap-button told apart only by label (provider product names; nothing else to match on).
    public string AppMethodLabel { get; init; } = "ASN Bank app";

    public string PasswordMethodLabel { get; init; } = "Wachtwoord + Beveiligingscode";

    // no Digipass label: ASN has stopped issuing the devices

    public IReadOnlyList<string> MethodSelectors { get; init; } = ["button.ap-button"];

    /// OBSERVED. Every input is input[data-testid='input'] (it names the component, not the field),
    /// so only the type tells them apart.
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["input[type='text'][data-testid='input']"];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["input[type='password'][data-testid='input']"];

    /// <summary>Submitting the sign-in form. OBSERVED.</summary>
    public string SubmitLabel { get; init; } = "Inloggen";

    /// The QR is an id-less svg found by geometry. OBSERVED 205x205 against the 158x30 logo: "the square one, bigger than this".
    public int QrMinimumPixels { get; init; } = 150;

    public int QrSquareTolerance { get; init; } = 8;

    /// What proves the sign-in landed: a path, not a word (a translated site would fail every login on "Uitloggen"). OBSERVED.
    public string SignedInPathMarker { get; init; } = "/online/web/onlinebankieren/";

    public string SignInPathMarker { get; init; } = "/inloggen/";

    /// Where statements are downloaded. OBSERVED: one form with a multi-select account picker, two typed date boxes,
    /// a direction filter and a format picker.
    public string ExportPath { get; init; } = "/online/web/onlinebankieren/zelf-regelen/transacties-downloaden";

    /// OBSERVED maxlength=10 (dd-mm-jjjj), so dates can be typed; the calendar behind "Kies een dag" breaks on redesigns.
    public IReadOnlyList<string> DateSelectors { get; init; } =
        ["input[type='text'][maxlength='10'][data-testid='input']"];

    /// <summary>Opening the format modal, and saving it. OBSERVED.</summary>
    public string FormatChangeLabel { get; init; } = "Wijzigen";

    /// The format dialog's heading, so opening it is checked. OBSERVED. The form has three modals;
    /// a step means different things depending on which is open.
    public string FormatModalHeading { get; init; } = "Wijzigen bestandsformaat";

    public string FormatSaveLabel { get; init; } = "Opslaan";

    /// <summary>Starting the download. OBSERVED.</summary>
    public string DownloadLabel { get; init; } = "Downloaden";

    /// The accounts are picked in a modal opened by the box AROUND the select (Playwright refuses the select itself).
    /// NOT the third button: index 2 is the app shell's BACK control (label = previous page's title); clicking it left the page.
    public IReadOnlyList<string> AccountPickerSelectors { get; init; } =
        ["xpath=//select[@data-testid='select']/.."];

    /// <summary>The select itself, for a click that ignores actionability.</summary>
    public IReadOnlyList<string> AccountPickerForceSelectors { get; init; } =
        ["select[data-testid='select']"];

    /// A last resort. UNVERIFIED: of button[data-testid='button'], 0-1 are page chrome, 2 is the back control,
    /// 3-4 sit in the form (likely calendar triggers). 2 is excluded: a wrong rung costs a reload, the back control the page.
    public IReadOnlyList<string> AccountPickerFallbackSelectors { get; init; } =
        ["button[data-testid='button']"];

    public IReadOnlyList<int> AccountPickerFallbackIndexes { get; init; } = [3, 4];

    /// "Kies een rekening", checked since every failure so far was an unverified click; the form beneath reads
    /// "Kies je rekening(en)", and neither contains the other. OBSERVED.
    public string AccountModalHeading { get; init; } = "Kies een rekening";

    /// "Selectie bevestigen (3)": applies the dialog, which closing does not; prefix because of the count. OBSERVED.
    /// It sits beside "Selectie wissen (3)" (clear all) and is a button.ap-button, outside button[data-testid='button'].
    public IReadOnlyList<string> AccountConfirmLabels { get; init; } = ["Selectie bevestigen"];

    /// One checkbox per account: counted, not read, so no name or IBAN is asked for.
    public IReadOnlyList<string> AccountCheckboxSelectors { get; init; } =
        ["input[type='checkbox'][data-testid='input']"];

    /// <summary>Dismissing that modal. OBSERVED, and by test id rather than by a word.</summary>
    public IReadOnlyList<string> ModalCloseSelectors { get; init; } =
        ["button[data-testid='modal-close']"];

    /// "Alles selecteren (3)": prefix, the count is in the label. One export covers all selected; per-account downloads
    /// are watched. CHECKED, not best effort: a miss would export whatever is ticked as the complete set.
    public string AllAccountsLabelPrefix { get; init; } = "Alles selecteren";

    public string NoZipLabel { get; init; } = "Geen zip-bestand van maken";

    /// ASN assembles the statement before sending it (eight months, half a megabyte): a bank doing work, not a page loading.
    public int DownloadSeconds { get; init; } = 120;

    /// OBSERVED: the export is a zip by default (one xml inside); the unzipped option is taken via the no-zip checkbox.
    /// A real export: 390 entries, camt.053.001.02, distinct external ids, value dates, both balances, entries sum exactly.
    public bool PreferUnzippedExport { get; init; } = true;

    /// Three radios: Pdf, CSV, CAMT.053. OBSERVED. Chosen by index (2), not label: labels sit in sibling markup a selector
    /// cannot reach, and an index fails loudly when the list changes.
    public IReadOnlyList<string> FormatRadioSelectors { get; init; } =
        ["input[type='radio'][data-testid='input']"];

    /// <summary>Which of them is CAMT.053. OBSERVED: third, after Pdf and CSV.</summary>
    public int Camt053RadioIndex { get; init; } = 2;

    /// "Geen zip-bestand van maken" means do NOT zip: TICKING it gives the bare XML, ASN zips by default. OBSERVED.
    public IReadOnlyList<string> NoZipCheckboxSelectors { get; init; } =
        ["input[type='checkbox'][data-testid='input']"];

    /// <summary>Whether that checkbox has to be TICKED to get unzipped XML. OBSERVED: yes.</summary>
    public bool TickNoZipForXml { get; init; } = true;

    /// Where a sign-out lands: /asn-app-en-asn-online-bankieren/uitgelogd.html, a path not a word. OBSERVED.
    public string SignedOutPathMarker { get; init; } = "/uitgelogd.html";

    /// The hamburger menu (the agent emulates a phone, so navigation is collapsed). OBSERVED.
    /// The sign-out is NOT in it (only Overzicht, Zelf regelen, Contact): it is in the user menu, see SignOutMenuSelectors.
    public IReadOnlyList<string> MenuSelectors { get; init; } =
        ["button[data-testid='header-hamburger-button']"];

    /// Header controls that might open the user menu: two unnamed button[data-testid='button']. PURPOSE unverified.
    // trusted browser (OBSERVED 2026-08-26): /online/browser-aanmelden/ registers one (five-digit browsercode, e-mail code,
    // SMS code, debit card); its sign-in page then shows "Je logt in als <name>" and one box. Only a BYO agent keeps the profile

    /// Where a browser is registered. OBSERVED. Never driven (two one-time codes, a card): the holder goes once, in a live view.
    public string BrowserRegistrationPath { get; init; } = "/online/browser-aanmelden/";

    /// The five-digit box (maxlength 5, type password), THE tell of a trusted browser:
    /// an unregistered one has three method buttons. OBSERVED.
    public IReadOnlyList<string> BrowserCodeSelectors { get; init; } =
        ["input[type='password'][maxlength='5'][data-testid='input']"];

    /// <summary>How many digits ASN's browsercode has. OBSERVED: five.</summary>
    public int BrowserCodeLength { get; init; } = 5;

    /// <summary>The button beside it. OBSERVED.</summary>
    public string BrowserCodeSubmitLabel { get; init; } = "Inloggen";

    /// "Je logt in als (naam)", matched by prefix (the name is the holder's). OBSERVED. Second witness behind the box: if ASN
    /// restyles the input, a registered browser reads as "page changed" rather than falling into the ordinary sign-in.
    public string SignedInAsHeadingPrefix { get; init; } = "Je logt in als";

    /// The user menu by name. OBSERVED (the probe read the aria-label); unlike a position it survives ASN reordering its header.
    /// Also the witness that a page is signed in (seen on no other page): see SignedInSettleSeconds.
    public IReadOnlyList<string> UserMenuSelectors { get; init; } =
        ["button[aria-label='Profiel menu openen']"];

    /// The same control by accessible name (aria-label or title alike): UserMenuSelectors assumes aria-label, a guess; if it is
    /// a title, that selector matches nothing.
    public string UserMenuLabel { get; init; } = "Profiel menu openen";

    public IReadOnlyList<string> SignOutMenuSelectors { get; init; } =
        ["button[data-testid='button']"];

    /// 1 first because 0 is the search (opens "Veel gebruikte links"); 1 opens the user menu. WALKED.
    /// 0 stays as a fallback in case the header is rearranged; each rung is judged by the sign-out appearing.
    public IReadOnlyList<int> SignOutMenuIndexes { get; init; } = [1, 0];

    /// OBSERVED only with the menu open: at the phone width the agent emulates, the menu is shut and the button absent.
    /// Worth doing: ASN expires an idle session on its own schedule, and unended sessions draw conclusions.
    public string SignOutLabel { get; init; } = "Uitloggen";

    /// Five minutes, UNVERIFIED: the discovery session was cut short by ASN's idle timeout, so its window is not generous.
    public int HumanSeconds { get; init; } = 300;

    /// Twelve minutes: registration is twenty screens with an e-mail and an SMS code the connector cannot hurry.
    /// Bounded so an abandoned run releases its agent.
    public int RegistrationSeconds { get; init; } = 720;

    /// Thirty seconds, a JUDGMENT (nobody timed the page). It borrowed SelectorTimeoutMs (10s): an eleven-second
    /// landing was reported as a refused code and marked the profile unhealthy. A wrong code stays on sign-in: waiting is cheap.
    public int BrowserCodeLandingSeconds { get; init; } = 30;

    /// How long the overview may BOUNCE to /inloggen/ before a page counts as signed in; then the menu confirms.
    /// OBSERVED 2026-09-19: a signed-out profile kept the overview address with a visible profile menu, then moved within 25s.
    /// 15s is a judgment: revisit first if a signed-out profile reads connected. A signed-in profile pays it on every check.
    public int SignedInSettleSeconds { get; init; } = 15;

    public int SelectorTimeoutMs { get; init; } = 10_000;

    /// Twelve minutes, bounded so an abandoned run releases its agent instead of holding a browser open on an account.
    public int DiscoverySeconds { get; init; } = 720;

    /// Ninety seconds: a live view has no "done" button, so without it the run holds the agent for the full window.
    public int QuietSeconds { get; init; } = 90;

    public int SamplePollSeconds { get; init; } = 2;

    /// A cap; the first run hit 20 exactly. The agent buffers a bounded number of notes per job, so a longer session would
    /// push early screens out of the report.
    public int DiscoveryScreens { get; init; } = 20;
}
