using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Coolblue;

// there is no order API: the account is a server-rendered Next.js app, so orders are read from HTML (confirmed 2026-08-07)
public sealed record CoolblueOptions
{
    // authorizes under /connect/ but takes tokens under /oauth/: not a typo; assuming /connect/token is a 404 that costs a login
    public string AuthorizeUrl { get; init; } = "https://accounts.coolblue.nl/connect/authorize";

    // starts at the protected page so Coolblue runs its own OIDC flow; our own PKCE/state left the site session anonymous
    public string LoginStartUrl { get; init; } = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

    // cookie presence proves nothing: a signed-out request already gets Coolblue-Session (confirmed 2026-08-07)
    // arriving on a page that needs a session is the only proof
    public string SignedInUrlMarker { get; init; } = "/mijn-coolblue-account";

    // the sign-in form's host: still here means the sign-in has not happened yet
    public string LoginHostMarker { get; init; } = "accounts.coolblue.nl";

    // where a signed-out visitor is redirected; a different host from the form
    public string LoginPathMarker { get; init; } = "/inloggen";

    public string CookieDomainSuffix { get; init; } = "coolblue.nl";

    // covers Coolblue's own OIDC round trip after the credentials go in, possibly with a human answering a challenge
    public int SessionSettleSeconds { get; init; } = 20;

    public int SessionPollMs { get; init; } = 500;

    // how long one 307 takes, paid in full by every really signed-in browser; not the same number as SessionSettleSeconds
    // an address read right after navigation is no proof (ASN 2026-09-19, DUO); no second witness here, so too short hurts
    public int SignedOutBounceSeconds { get; init; } = 10;


    // server-rendered HTML, no JSON call; /bestellingen 307s to the account home, so the path is orderoverzicht
    // every order list row carries a direct invoice link, and an order can have several
    public string OrdersPageUrl { get; init; } = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

    // the overview states no money: an order total exists only here, one 600KB page load per record
    public string OrderDetailsUrlTemplate { get; init; } =
        "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht/{orderId}";

    // proves the page is the order asked for: /bestellingen silently redirects to a wrong-but-plausible page, not a 404
    public string OrderNumberLabel { get; init; } = "Ordernummer";

    // declared, never sniffed ("463" and "463,-" look alike); null refuses the fetch
    // reconciliation cannot catch a consistently wrong unit
    public MoneyUnit? TotalUnit { get; init; } = MoneyUnit.MajorString;

    // its own declaration: totals and lines are read from different parts of the page
    public MoneyUnit? ItemUnit { get; init; } = MoneyUnit.MajorString;

    // a label, not a selector: classes are CSS-in-JS hashes that change every deploy
    public IReadOnlyList<string> ItemsSectionLabels { get; init; } = ["Je bestelling"];

    // reading past it would put delivery addresses and accessory recommendations on the receipt
    public IReadOnlyList<string> ItemsSectionEndLabels { get; init; } =
        ["Adres- en betaalinformatie", "Betalingsdetails"];

    // tells a product heading apart from other headings in the section
    public string ProductHrefMarker { get; init; } = "/product/";

    public MoneyUnit ItemUnitOrThrow() =>
        ItemUnit ?? throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: coolblue's line money unit is not declared, so no item can be read. " +
            "Set CoolblueOptions.ItemUnit from a capture: '399,-' and '12,50' are MajorString.");

    // never inferred from a symbol: "$" is at least four currencies
    public string Currency { get; init; } = "EUR";

    // a label, not a selector: CSS-in-JS class hashes change every deploy
    public IReadOnlyList<string> TotalLabels { get; init; } = ["Totaalbedrag", "Totaal"];

    public string BaseUrl { get; init; } = "https://www.coolblue.nl";

    public string OrderedOnLabel { get; init; } = "Besteld op";

    // null does not mean euros: the unit is declared, never guessed from a value's shape
    public MoneyUnit TotalUnitOrThrow() =>
        TotalUnit ?? throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: coolblue's money unit is not declared, so no total can be read. " +
            "Set CoolblueOptions.TotalUnit from a capture: '463,-' and '12,50' are MajorString.");

    public string PageParam { get; init; } = "page";

    // ceiling so a pagination parameter Coolblue stops honouring cannot loop forever
    public int MaxPages { get; init; } = 100;

    // test seam overriding the manifest's MaxRecordsPerFetch; null in production
    public int? RecordCap { get; init; }

    // a guard against a pathological order: captured orders had one or two invoices
    public int MaxDocumentsPerOrder { get; init; } = 10;

    // MediaType has already dropped the charset: bol serves application/pdf;charset=UTF-8, a raw header comparison rejects it
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    // %PDF: catches a 200 that is an HTML error page with a PDF content type, what a session dying mid-fetch produces
    public IReadOnlyList<byte> DocumentMagic { get; init; } = [0x25, 0x50, 0x44, 0x46];

    // the account pages are served to browsers; a bare .NET default is a needless difference
    public string UserAgent { get; init; } =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/141.0.0.0 Safari/537.36";

    /// <summary>Coolblue's pages are locale-routed and the account is Dutch.</summary>
    public string AcceptLanguage { get; init; } = "nl-NL,nl;q=0.9,en;q=0.8";

    // phrases only an interstitial uses; not BlockPageMarkers, whose "cloudfront" is on every Coolblue page
    public IReadOnlyList<string> BotWallMarkers { get; init; } =
    [
        "The request could not be satisfied",
        "Request blocked",
        "Access Denied",
        "Generated by cloudfront",
        "captcha-delivery.com",
        "geo.captcha-delivery",
    ];

    // markers of the sign-in FORM only: account pages link the login host ("Uitloggen")
    // so the broad LoginPageMarkers would raise session_expired
    public IReadOnlyList<string> AccountPageLoginMarkers { get; init; } =
    [
        "name=\"csrf\"",
        "autocomplete=\"current-password\"",
    ];

    // username is the name the login form uses (observed 2026-07-28), so it leads; the rest are candidates
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input[name='username']",
        "input#username",
        "input[autocomplete='username']",
        "input[type='email']",
        "input[name='email']",
    ];

    // excludes the decoy: the only input[type=password] is a hidden one Coolblue adds for password managers
    // tabindex='-1' is the discriminator; data-hidden/aria-hidden are not CSS, so a visibility check still sees it
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input[name='password']:not([tabindex='-1'])",
        "input#password:not([tabindex='-1'])",
        "input[autocomplete='current-password']:not([tabindex='-1'])",
        "input[type='password']:not([tabindex='-1'])",
    ];

    // a submit naming another form is never the one to press: a bare button[type=submit] hit the password-reset button
    // and e-mailed a reset link (2026-08-07); the password screen has three submits, the login is the second
    public const string OwnFormOnly = ":not([form])";

    private const string OwnButton = "button" + OwnFormOnly;

    // every candidate keeps OwnFormOnly: a fact about HTML, not about today's markup
    // only clicked when there is provably no password box: else the identifier is submitted alone and an attempt is spent
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
    [
        "button[type='submit']" + OwnFormOnly,
        OwnButton + ":has-text('Doorgaan')",
        OwnButton + ":has-text('Verder')",
        OwnButton + ":has-text('Volgende')",
        "input[type='submit']" + OwnFormOnly,
    ];

    // no form attribute, between the reset and passwordless buttons
    // text-is, not has-text: "Inloggen zonder wachtwoord" contains "Inloggen"
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "button[type='submit']" + OwnFormOnly,
        "input[type='submit']" + OwnFormOnly,
        OwnButton + ":text-is('Inloggen')",
        OwnButton + ":text-is('Log in')",
    ];

    // must never be pressed (they e-mail the owner); not used to click, the suite asserts no candidate can select them
    public IReadOnlyList<string> NeverPressSelectors { get; init; } =
    [
        "[data-action='reset-password']",
        "[form='form__request_password_reset']",
        "[form='form__request_passwordless_login']",
    ];

    // narrow, credential-failure phrasings only: invalid_credentials is never retried
    // so a false positive is permanent for the session
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        ":text('e-mailadres of wachtwoord')",
        ":text('combinatie van e-mailadres en wachtwoord')",
        ":text('wachtwoord is onjuist')",
        ":text('inloggegevens kloppen niet')",
    ];

    /// <summary>UNCONFIRMED. A consent wall left standing covers the form.</summary>
    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "button#accept-cookies",
        "button[data-testid='consent-accept-all']",
        "button:has-text('Accepteren')",
        "button:has-text('Akkoord')",
    ];

    // observed absent 2026-07-28 (CloudFront, no bot management)
    // the probe stays so a later widget is named, not waited out as a shape change
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

    // where a typed answer goes; without it a picture is as unanswerable as a widget
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
    ];

    // HTML where JSON was promised is a wall or a login bounce, never a parse failure
    public IReadOnlyList<string> BlockPageMarkers { get; init; } =
    [
        "captcha",
        "access denied",
        "request blocked",
        "cloudfront",
        "cf-ray",
        "akamai",
        "datadome",
    ];

    // the login page is session_expired, not a block
    public IReadOnlyList<string> LoginPageMarkers { get; init; } =
    [
        "accounts.coolblue.nl",
        "/inloggen",
        "name=\"csrf\"",
    ];

    public int SelectorTimeoutMs { get; init; } = 15_000;

    // short: on the two-screen flow the probe always misses and is latency on every login
    // SelectorTimeoutMs goes to the second screen
    public int PasswordProbeMs { get; init; } = 1_500;

    /// <summary>Short probes: the settle loop runs them on every pass.</summary>
    public int ProbeMs { get; init; } = 500;

    public int LoginSettleSeconds { get; init; } = 180;

    public int RedirectPollSeconds { get; init; } = 5;

    public int ChallengeSeconds { get; init; } = 300;

    // longer than a typed captcha: nobody relays anything, the wait covers someone noticing
    public int InteractiveCaptchaSeconds { get; init; } = 600;
}
