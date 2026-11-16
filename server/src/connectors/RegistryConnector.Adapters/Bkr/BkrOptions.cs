using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Bkr;

/// everything the portal could rename lives here, so their change is an operator edit, not a release
/// labels, not selectors, are keyed on: the Dutch label a human sees is stabler than Bootstrap column classes (2026-08-04)
public sealed record BkrOptions
{
    public string PortalUrl { get; init; } = "https://portaal.mijnkredietregistratie.nl/";

    /// Azure AD B2C, tenant bkrconsp.onmicrosoft.com, policy B2C_1A_SignUp_SignIn_SmsOrTotp (SMS or TOTP second factor)
    public string LoginHost { get; init; } = "login.mijnkredietregistratie.nl";

    /// <summary>Where a completed sign-in lands. Reaching it is what ends the login.</summary>
    public string SignedInUrlMarker { get; init; } = "portaal.mijnkredietregistratie.nl";

    /// confirmed: on BOTH the first and the password screen (the second shows it back filled),
    /// so finding it never proves which screen
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["#signInName", "#email", "input[name='signInName']", "input[type='email']"];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["#password", "input[name='password']", "input[type='password']"];

    /// confirmed: #next is "Start inzage" on the first screen and "Inloggen" on the second; the label changes, the id does not
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
        ["#next", "button#next", "button[type='submit']"];

    /// confirmed: the second-factor screen carries #otpCode beside #QrCodeVerifyInstruction (B2C's authenticator page)
    public IReadOnlyList<string> CodeSelectors { get; init; } =
        ["#otpCode", "#verificationCode", "input[name='otpCode']"];

    public IReadOnlyList<string> CodeSubmitSelectors { get; init; } =
        ["#continue", "button#continue", "button[type='submit']"];

    /// its absence is a shape change worth stopping for, not a reason to scrape the visible list
    public string PrintBlockMarker { get; init; } = "pdf-export";

    /// BKR's contract number, keyed on rather than the list's GUID: a re-issued GUID would duplicate every credit
    public string ReferenceLabel { get; init; } = "Overeenkomstnummer";

    public string CreditorLabel { get; init; } = "Aanbieder";

    public string AmountLabel { get; init; } = "Bedrag";

    public string KindLabel { get; init; } = "Kredietsoort";

    public string RegisteredLabel { get; init; } = "Registratiedatum";

    public string ExpectedEndLabel { get; init; } = "Verwachte einddatum";

    /// present and filled means ended; never inferred from the expected end having passed
    public string ActualEndLabel { get; init; } = "Werkelijke einddatum";

    public string SurnameLabel { get; init; } = "Achternaam";

    public string InitialsLabel { get; init; } = "Voorletter(s)";

    public IReadOnlyList<string> ArrearsLabels { get; init; } = ["Bijzonderheden", "Bijzonderheid", "Code"];

    /// matched so "no arrears" arrives as null, not as a sentence a consumer would render as a code
    public IReadOnlyList<string> NoArrearsMarkers { get; init; } =
        ["Geen bijzonderheden", "Geen bijzonderheid"];

    /// the page's words for "nothing registered": only this makes an empty result an answer rather than a parse failure
    public string EmptyRegisterMarker { get; init; } = "geen kredieten";

    /// longest and most specific first: "Doorlopend krediet" and "Aflopend krediet" both end in "krediet"
    public IReadOnlyList<KeyValuePair<string, CreditKind>> CreditKinds { get; init; } =
    [
        new("Doorlopend krediet", CreditKind.Revolving),
        new("Aflopend krediet", CreditKind.Instalment),
        new("Verzendhuiskrediet", CreditKind.DeferredPayment),
        new("Hypoth", CreditKind.Mortgage),
        new("Lease", CreditKind.Lease),
        new("Schuldregeling", CreditKind.Other),
    ];

    public IReadOnlyList<string> DateFormats { get; init; } = ["dd-MM-yyyy", "d-M-yyyy", "dd/MM/yyyy"];

    public string Currency { get; init; } = "EUR";

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// short on purpose: on the live page (separate screens) this probe always misses, so it is pure latency on every sign-in
    public int ProbeMs { get; init; } = 1_500;

    /// generous: someone may be finding a password manager or waiting on a text
    /// the job budget stops counting while parked on the challenge
    public int LiveLoginSeconds { get; init; } = 600;

    /// <summary>How long the human has to type six digits when we ask for them.</summary>
    public int CodeChallengeSeconds { get; init; } = 300;

    public int SettlePollSeconds { get; init; } = 2;

    public int SignInSeconds { get; init; } = 120;

    // the window is the whole check: an address read right after navigation is not proof (ASN, 2026-09-19; DUO's SAML chain too)
    // no second witness (no session endpoint), so too short is the dangerous side; a signed-in browser pays all of it
    // 10s is DUO's number, a judgement: BKR's own redirect was never timed
    public int SignedOutBounceSeconds { get; init; } = 10;

    public int SignedOutPollMs { get; init; } = 500;
}
