using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.AlbertHeijn;

/// client id, version, user agent, headers, auth paths and both operations come from gwillem/appie-go v0.0.12;
/// the login-page selectors are unverifiable candidate lists with a shelf life
public sealed record AlbertHeijnOptions
{
    /// from defaultClientID; "appie" made a real login fail, the suffix is not cosmetic
    public string ClientId { get; init; } = "appie-ios";

    /// <summary>Confirmed: <c>defaultClientVersion</c>. Sent as <c>x-client-version</c>.</summary>
    public string ClientVersion { get; init; } = "9.28";

    /// from defaultUserAgent; sent because the API answers differently without it
    public string UserAgent { get; init; } = "Appie/9.28 (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)";

    /// <summary>Confirmed: the <c>x-application</c> the API routes on.</summary>
    public string Application { get; init; } = "AHWEBSHOP";

    /// <summary>Confirmed: <c>defaultBaseURL</c>.</summary>
    public string ApiBaseUrl { get; init; } = "https://api.ah.nl";

    /// from loginURLTemplate; the redirect URI goes in verbatim: percent-encoding it can fail the authorize request
    public string AuthorizeUrlTemplate { get; init; } =
        "https://login.ah.nl/login?client_id={client_id}&response_type=code&redirect_uri={redirect_uri}";

    /// <summary>Confirmed: the scheme Chromium refuses to navigate to.</summary>
    public string RedirectUri { get; init; } = "appie://login-exit";

    public string TokenPath { get; init; } = "/mobile-auth/v1/auth/token";

    public string RefreshPath { get; init; } = "/mobile-auth/v1/auth/token/refresh";

    /// <summary>Confirmed: receipts are GraphQL, not REST. There is no receipts path.</summary>
    public string GraphQlPath { get; init; } = "/graphql";

    /// the list operation; AH's endpoint takes { query, variables } and no operationName
    public string ListQuery { get; init; } =
        """
        query FetchPosReceipts($offset: Int!, $limit: Int!) {
          posReceiptsPage(pagination: {offset: $offset, limit: $limit}) {
            posReceipts { id dateTime totalAmount { amount } }
          }
        }
        """;

    /// the detail selects no total and nothing carrying a card or IBAN tail, so the total comes from the list:
    /// a real reconciliation pair
    public string DetailQuery { get; init; } =
        """
        query FetchReceipt($id: String!) {
          posReceiptDetails(id: $id) {
            id
            memberId
            products  { id quantity name price { amount } amount { amount } }
            discounts { name amount { amount } }
            payments  { method amount { amount } }
          }
        }
        """;

    public int PageSize { get; init; } = 50;

    /// AH sends every amount as a JSON number in euros; declared rather than sniffed, as a wrong guess corrupts money silently
    public MoneyUnit ListTotalUnit { get; init; } = MoneyUnit.MajorDecimal;

    public MoneyUnit ItemAmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    public MoneyUnit DiscountAmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    /// <summary>A payment's <c>amount</c>, used only to pick the largest of a split tender.</summary>
    public MoneyUnit PaymentAmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    public string Currency { get; init; } = "EUR";

    /// UNCONFIRMED. AH's page is Dutch: the last candidate resolves by visible label, which outlives a markup rename
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input[name='username']",
        "input[name='email']",
        "input#email",
        "input[autocomplete='username']",
        "input[type='email']",
        "input:below(:text('E-mailadres'))",
    ];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input[name='password']",
        "input#password",
        "input[autocomplete='current-password']",
        "input[type='password']",
        "input:below(:text('Wachtwoord'))",
    ];

    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "button[type='submit']",
        "input[type='submit']",
        "button:has-text('Inloggen')",
        "button:has-text('Log in')",
    ];

    /// UNCONFIRMED, narrow on purpose: only phrasings stating a credential failure, as invalid_credentials is never retried
    /// and a false one is permanent for that session
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        ":text('e-mailadres of wachtwoord')",
        ":text('onjuiste combinatie')",
        ":text('wachtwoord is onjuist')",
        ":text('inloggegevens kloppen niet')",
    ];

    /// UNCONFIRMED beyond the hCaptcha entries. Fallback, reached only when neither grid nor checkbox matched:
    /// a widget whose parts we cannot name cannot be relayed, so the person at the browser passes it, or nobody can
    public IReadOnlyList<string> InteractiveCaptchaSelectors { get; init; } =
    [
        "iframe[src*='hcaptcha']",
        "iframe[src*='recaptcha']",
        "[data-hcaptcha-widget-id]",
        ".h-captcha",
        ".g-recaptcha",
    ];

    /// CONFIRMED 2026-07-28 on login.ah.nl: two hCaptcha iframes told apart only by URL fragment, #frame=challenge (grid)
    /// and #frame=checkbox-i (box); the rest is UNCONFIRMED, title is the fallback if the fragment convention changes.
    /// A grid also matches iframe[src*='hcaptcha'], so the gate probes this list before InteractiveCaptchaSelectors.
    public IReadOnlyList<string> CaptchaGridSelectors { get; init; } =
    [
        "iframe[src*='hcaptcha.com'][src*='#frame=challenge']",
        "iframe[src*='hcaptcha'][src*='challenge']",
        "iframe[title*='hCaptcha challenge' i]",
    ];

    /// CONFIRMED as an iframe on login.ah.nl; fragment and title UNCONFIRMED. A real click, not a solve or a bypass:
    /// hCaptcha either lets the login through or draws the grid
    public IReadOnlyList<string> CaptchaCheckboxSelectors { get; init; } =
    [
        "iframe[src*='hcaptcha.com'][src*='#frame=checkbox']",
        "iframe[src*='hcaptcha'][src*='checkbox']",
        "iframe[title*='hCaptcha' i][title*='checkbox' i]",
    ];

    /// UNCONFIRMED on AH: a plain image captcha is the one kind a relay can carry, so it stays supported
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "img[alt*='captcha' i]",
        "img[src*='captcha' i]",
        "img[id*='captcha' i]",
        ".captcha img",
    ];

    /// UNCONFIRMED. Where a typed captcha's answer goes; a picture with nowhere to type is as unanswerable as a widget
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
        "input[autocomplete='one-time-code']",
    ];

    /// <summary>UNCONFIRMED. A consent wall left standing covers the form.</summary>
    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "button#accept-cookies",
        "button:has-text('Accepteer')",
        "button:has-text('Akkoord')",
    ];

    public int SelectorTimeoutMs { get; init; } = 15_000;

    public int LoginSettleSeconds { get; init; } = 180;

    /// short: the page is the only place a captcha or a stated error shows up
    public int RedirectPollSeconds { get; init; } = 5;

    public int ChallengeSeconds { get; init; } = 300;

    /// longer than a typed captcha on purpose: covers someone noticing a prompt on a phone in another room
    public int InteractiveCaptchaSeconds { get; init; } = 600;

    /// gestures the relay carries per hCaptcha before handing back; bounded because the loop's exit is hCaptcha's JavaScript
    public int CaptchaRelayRounds { get; init; } = 4;

    /// on by default: no password reaches the platform and whatever AH asks next is answered by the person on its own page.
    /// False restores the typed login and its captcha relay, proven live.
    public bool LiveLogin { get; init; } = true;

    /// generous: covers reading an SMS, a password manager and a multi-round captcha;
    /// the job's own budget is parked while a human thinks
    public int LiveLoginSeconds { get; init; } = 900;

    /// longer than a captcha: a whole login, on a device they may have to find
    public int RedirectChallengeSeconds { get; init; } = 600;

    /// the human's own browser and IP are the likeliest to get past the wall that stopped the agent
    public bool RedirectFallbackEnabled { get; init; } = true;

    /// null in production, where the manifest is the single answer; a test seam so the cap needs no two thousand receipts
    public int? RecordCap { get; init; }
}
