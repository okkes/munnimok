using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Duo;

// everything the portal could rename lives here: a change on DUO's side is an operator edit; values confirmed against
// two live authenticated sessions 2026-08-10 (sms, DigiD app) unless a remark says otherwise; docs/research/duo-digid.md
public sealed record DuoOptions
{
    // not DigiD's entry URL: hand-crafting an IdP start address logs in at the IdP and leaves the site signed out
    // (bol.com, Coolblue)
    public string StartUrl { get; init; } = "https://mijn.duo.nl/";

    public string SignedInUrlMarker { get; init; } = "mijn.duo.nl/particulier/portaal";

    // DUO's SAML endpoint is on mijn.duo.nl and carries the dashboard as Target=, so SignedInUrlMarker alone
    // would call the chain's first URL success
    public string LoginPathMarker { get; init; } = "/isam/";

    public string LoginHostMarker { get; init; } = "login.digid.nl";

    // selectors confirmed from the sms capture of 2026-08-10: DigiD's forms by id, DUO's WAYF and DigiD's chooser by label only
    // a missing element hands the page to the human (DuoAdapter.TypedSignInAsync): the weakest selector costs a streamed login

    // Voor mijzelf chosen explicitly: the other option, Als gemachtigde, would fetch somebody else's debt
    // label first: DUO parks the real input off-screen, so Playwright cannot click it
    public IReadOnlyList<string> SelfRadioSelectors { get; init; } =
    [
        "label[for='ITFIM_WAYF_IDP_0']",
        "label:has-text('Voor mijzelf')",
        "#ITFIM_WAYF_IDP_0",
        "input[name='ITFIM_WAYF_IDP']",
    ];

    // ids first, then a plain submit: only DigiD's two forms had ids recorded
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
        ["#submit-button", "button[type='submit']", "input[type='submit']"];

    // of four methods the other two need an NFC reader, out of scope for an automated browser
    public IReadOnlyList<string> SmsMethodSelectors { get; init; } =
        ["a:has-text('sms-controle')", "button:has-text('sms-controle')", "label:has-text('sms-controle')"];

    public IReadOnlyList<string> AppMethodSelectors { get; init; } =
        ["a:has-text('DigiD app')", "button:has-text('DigiD app')", "label:has-text('DigiD app')"];

    // always the other device: the agent's browser has no DigiD app; DigiD only asks a PHONE this, desktop captures missed it
    // href leads, text follows: both tiles share a class and the wrong one (inloggen_app_web_to_app) opens a missing app
    // text matches are the fallback, Dutch then English; none may match "dit apparaat" (DuoAppDeviceChoiceTests)
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

    // six single-digit boxes, filled in this order; the POST carries one field, smscode[smscode]
    public IReadOnlyList<string> CodeBoxSelectors { get; init; } =
    [
        "#smscode_smscode_field_0", "#smscode_smscode_field_1", "#smscode_smscode_field_2",
        "#smscode_smscode_field_3", "#smscode_smscode_field_4", "#smscode_smscode_field_5",
    ];

    public int CodeLength { get; init; } = 6;

    public string MethodConfigKey { get; init; } = "method";

    public string SmsMethod { get; init; } = "sms";

    public string AppMethod { get; init; } = "app";

    public int CodeChallengeSeconds { get; init; } = 300;

    // short: a miss costs the human a few seconds, and a long wait on a redesigned page looks hung
    public int StepProbeMs { get; init; } = 4_000;

    // anchored on data:image because the QR is not the block's first image: DigiD puts a 44x44 logo and a noscript copy first
    public IReadOnlyList<string> QrImageSelectors { get; init; } =
        ["#app_verification_code img[src^='data:image']", ".qr_code img[src^='data:image']"];

    // data-code holds the digid-app-auth:// link the QR encodes, relayed so a consumer on the phone can offer a tap
    public IReadOnlyList<string> QrBlockSelectors { get; init; } = ["#app_verification_code", ".qr_code"];

    public string QrImageAttribute { get; init; } = "src";

    public string QrPayloadAttribute { get; init; } = "data-code";

    public string QrDataUriPrefix { get; init; } = "data:image/";

    public string ServicesRoot { get; init; } = "https://mijn.duo.nl/particulier/services/";

    public string DebtPath { get; init; } = "pfd/json/raadplegen/mijn-schulden";

    // a schuldbedrag* field that is not a number is a missing debt and fails the fetch; anything else is only reported
    public string DebtAmountPrefix { get; init; } = "schuldbedrag";

    public string PositionsPath { get; init; } = "pfd/json/schulden";

    // refuses without peildatum (400 "Required parameter"); the portal passes today, and so does this
    public string PaymentHolidayPath { get; init; } = "pfd/json/raadplegen/resterend-aantal-maanden-aflosvrij";

    public string AsOfParam { get; init; } = "peildatum";

    // the endpoint with SaldoActueel.renteBerekendTot, in a payload without BSN: the as-of date does not need the dossier
    // earlier captures missed it because nobody had opened "Mijn schuldhistorie"
    public string HistoryPath { get; init; } = "pfd/json/raadplegen/schuldhistorie";

    // takes a base64 JSON request for the period and wanted figures, built in DuoAdapter
    public string GrondslagPath { get; init; } = "pfd/json/raadplegen/bepalen-grondslaggegevens-over-periode";

    public string GrondslagParam { get; init; } = "request";

    public string MonthsRemainingCode { get; init; } = "RESTEREND_AANTAL_MAANDEN_AFLOSFASE";

    // the pfd services answer 401 without the authorization header DUO's responses carry, though the session cookie
    // suffices for sessietoken/rest/jwt (confirmed 2026-08-11); named, not sniffed
    public string SessionTokenHeader { get; init; } = "authorization";

    // ends the login, a url does not: StartUrl redirects to the dashboard before bouncing into SAML, so a signed-out
    // browser sits on a portal address; signed in it answers {"profiel":"PP","nieuwToken":true,…}
    public string SessionPath { get; init; } = "sessietoken/rest/jwt";

    // profiel names whose session it is, so it cannot plausibly be present on an answer about nobody
    public string SessionProfileField { get; init; } = "profiel";

    // never called: 2.5 MB holding a BSN, both parents, a partner, twenty years of income, IBANs and every address;
    // named so the refusal is code
    public string ForbiddenPath { get; init; } = "raadplegen/klantbeeld";

    // same url under a second name: ForbiddenPath still refuses it on every ordinary read, so reaching it is deliberate
    // only when the caller asked for the ledger; the reader takes the movements and one instalment and nothing else
    public string DossierPath { get; init; } = "pfd/json/raadplegen/klantbeeld";

    // euros as a JSON number with eight decimals (Java BigDecimal), declared never sniffed; zero arrives as 0E-8,
    // which MoneyParser's string style refuses: read as decimal, never round-tripped through text
    public MoneyUnit AmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    public string Currency { get; init; } = "EUR";

    // generous: DigiD means a password manager, a phone, an app and a PIN; the job budget stops counting while parked
    public int LiveLoginSeconds { get; init; } = 900;

    // shorter than the live view, the phone is in hand; whether DigiD expires the code is UNKNOWN (a scan took ~6s),
    // so the relay re-reads the image every poll
    public int QrChallengeSeconds { get; init; } = 300;

    public int SettlePollSeconds { get; init; } = 2;

    // a round trip between two government systems (SAML artifact, then a DUO session), not a page load
    public int SignInSeconds { get; init; } = 120;

    // UNMEASURED: time a signed-out browser gets to bounce into the sign-in chain before the profile counts as inside DUO
    // the portal address looks signed in before the bounce (ASN, 2026-09-19); 10s not 15: a slower bounce falls to SessionPath
    // a profile really still inside pays this window on every connect: cheap against a DigiD sign-in
    public int SignedOutBounceSeconds { get; init; } = 10;

    public int SelectorTimeoutMs { get; init; } = 15_000;

    // short: runs on every poll of a live sign-in and misses every time on the sms path
    public int QrProbeMs { get; init; } = 250;
}
