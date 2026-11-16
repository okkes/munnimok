using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.LidlPlus;

/// confirmed from the reference (yagueto/lidl-plus); properties marked UNCONFIRMED are guesses an operator can override
public sealed record LidlPlusOptions
{
    public string AuthorizeUrl { get; init; } = "https://accounts.lidl.com/connect/authorize";

    public string TokenUrl { get; init; } = "https://accounts.lidl.com/connect/token";

    public string ClientId { get; init; } = "LidlPlusNativeClient";

    /// the reference's Basic header is "LidlPlusNativeClient:secret": "secret" is the value, not a placeholder
    /// an empty one is rejected
    public string ClientSecret { get; init; } = "secret";

    public string RedirectUri { get; init; } = "com.lidlplus.app://callback";

    /// <summary><c>offline_access</c> is the scope that yields the refresh token.</summary>
    public string Scope { get; init; } = "openid profile offline_access lpprofile lpapis";

    public string TicketsBaseUrl { get; init; } = "https://tickets.lidlplus.com";

    /// the list is v2 and the detail v3: not a typo, do not "fix"
    public string TicketListPathTemplate { get; init; } = "/api/v2/{country}/tickets?pageNumber={page}&onlyFavorite=false";

    public string TicketDetailPathTemplate { get; init; } = "/api/v3/{country}/tickets/{id}";

    /// 999.99.9 (the scraper library's value) makes Lidl's edge drop the connection with no response (confirmed 2026-08-03);
    /// 999.99.99, 99.99.9 and 15.20.3 reach a 401. A real release number is used:
    /// scrapers converge on whatever is blocklisted next
    public string AppVersionHeader { get; init; } = "15.20.3";

    /// casing confirmed; the API routes on it
    public string OperatingSystemHeader { get; init; } = "iOs";

    public string AppHeader { get; init; } = "com.lidl.eci.lidl.plus";

    /// a v3 detail states "totalAmount" as a JSON number in euros, not a string (confirmed 2026-08-04)
    public MoneyUnit AmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    /// the printed receipt is read as text with a comma ("0,79"), a different question from the JSON unit
    public MoneyUnit PrintedAmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    public string Currency { get; init; } = "EUR";

    public int MaxPages { get; init; } = 100;

    /// generous: they may have to find the phone or wait for a mail
    public int CodeChallengeSeconds { get; init; } = 300;

    /// Lidl's verification code is six digits (confirmed)
    public int CodeLength { get; init; } = 6;

    /// generous: the job's budget stops counting while it waits, so this is the only clock
    public int ClientAuthorizationSeconds { get; init; } = 900;

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// <summary>Short probes: these run on a page that is already the right one.</summary>
    public int ProbeMs { get; init; } = 500;

    /// short on purpose: the live two-step page always misses this probe, so it is latency on every login;
    /// raise only if a single-page variant is misread as a wizard
    public int PasswordProbeMs { get; init; } = 2_000;

    public int RedirectTimeoutSeconds { get; init; } = 120;

    public int RedirectPollSeconds { get; init; } = 5;

    /// far longer than the typed path: a person reads a real page and may wait on a text; the job budget stops while parked
    public int LiveLoginSeconds { get; init; } = 600;

    public int ChallengeSeconds { get; init; } = 300;

    /// longer than a typed captcha: nobody relays, so the wait covers someone noticing
    public int InteractiveCaptchaSeconds { get; init; } = 600;

    // the e-mail box: input-email confirmed from the reference (2026-07-28), which only knew the phone box
    // observed on accounts.lidl.com 2026-07-28: data-testid is the stable hook (classes are generated Tailwind), so it leads
    // the reference's role_next is not on the page: read the markup first

    public IReadOnlyList<string> EmailSelectors { get; init; } =
    [
        "input[data-testid='input-email']",
        "input#input-email",
        "input[name='input-email']",
        "input[autocomplete='email']",
        "input[type='email']",
    ];

    public IReadOnlyList<string> PhoneSelectors { get; init; } =
    [
        "input[data-testid='input-phone']",
        "input#input-phone",
        "input[name='input-phone']",
        "input[autocomplete='tel']",
        "input[type='tel']",
    ];

    /// step two: in the DOM from first paint but hidden in a second form, so found by id rather than visibility
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input[data-testid='login-input-password']",
        "input#Password",
        "input[name='Password']",
        "input[autocomplete='current-password']",
        "input[type='password']",
    ];

    /// the identifier step's "Volgende" is what makes this a two-screen login
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "[data-testid='login-or-register-submit-button']",
        "button[type='submit']",
        "input[type='submit']",
    ];

    /// OBSERVED: both screens' buttons read "Volgende"; screen one is login-or-register-submit-button, screen two button-primary
    public IReadOnlyList<string> PasswordSubmitSelectors { get; init; } =
    [
        "[data-testid='button-primary']",
        "#btn_submit_password",
        "button[type='submit']",
    ];

    /// "Gebruik telefoonnummer" swaps the identifier input; needed only if a phone is supplied while the e-mail box shows
    public IReadOnlyList<string> SwitchMethodSelectors { get; init; } =
    [
        "[data-testid='switch-method-button']",
    ];

    /// OBSERVED 2026-07-28: after the password an automated browser is thrown back to the e-mail screen with
    /// "Er is iets mis gegaan. Probeer het later nog eens." Not a credential error (the password works by hand): a reCAPTCHA
    /// Enterprise score verdict, so BlockedByProvider. Matched on copy: a stale string degrades to the old redirect wait.
    public IReadOnlyList<string> BlockedNoticeSelectors { get; init; } =
    [
        "p:has-text('Er is iets mis gegaan')",
        "p:has-text('Something went wrong')",
        "[data-testid='error-message']",
    ];

    /// <summary><c>VerificationCode</c> is CONFIRMED from the reference.</summary>
    public IReadOnlyList<string> VerificationCodeSelectors { get; init; } =
    [
        "input[name='VerificationCode']",
        "input[autocomplete='one-time-code']",
        "input[name='code']",
        "input#input-code",
    ];

    /// UNCONFIRMED: the code screen needs a real login to reach; button-primary leads because screen two uses it
    public IReadOnlyList<string> VerificationSubmitSelectors { get; init; } =
    [
        "[data-testid='button-primary']",
        "[data-testid='verify-code-submit-button']",
        "#btn_submit_code",
        "button[type='submit']",
        "input[type='submit']",
    ];

    /// UNCONFIRMED guesses: the reference passes the mode in rather than reading it back; only the page knows the mail case
    public IReadOnlyList<string> EmailDeliverySelectors { get; init; } =
    [
        "[data-verify-mode='email']",
        "[data-mode='email']",
        "input[name='VerificationMode'][value='email']",
    ];

    /// <summary>UNCONFIRMED. The same, for a code that went to a phone.</summary>
    public IReadOnlyList<string> SmsDeliverySelectors { get; init; } =
    [
        "[data-verify-mode='phone']",
        "[data-mode='phone']",
        "input[name='VerificationMode'][value='phone']",
    ];

    /// UNCONFIRMED: hCaptcha and reCAPTCHA widgets by iframe and container class; they mint a token in their own JS, so no relay
    public IReadOnlyList<string> InteractiveCaptchaSelectors { get; init; } =
    [
        "iframe[src*='hcaptcha']",
        "iframe[src*='recaptcha']",
        "[data-hcaptcha-widget-id]",
        ".h-captcha",
        ".g-recaptcha",
    ];

    /// <summary>UNCONFIRMED. A plain image captcha is the one kind a relay can carry.</summary>
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "img[alt*='captcha' i]",
        "img[src*='captcha' i]",
        "img[id*='captcha' i]",
        ".captcha img",
    ];

    /// UNCONFIRMED: where a typed captcha's answer goes; must not list VerificationCode, or the 2FA step reads as a wall
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
    ];
}
