using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Amazon;

// CONFIRMED = read from the source of three scrapers; UNCONFIRMED = Amazon's DOM has no published contract and none of
// them carries a Dutch fixture, so selectors are guesses with a shelf life and routes are not
public sealed record AmazonOptions
{
    public string BaseUrl { get; init; } = "https://www.amazon.nl";

    // an unauthenticated GET redirects to /ax/claim?arb=… with 200: the .nl site shares the .com sign-in entry
    public string OrdersPath { get; init; } = "/your-orders/orders";

    // recorded, not used: heavier and more dynamic than the print invoice; the alternative if that route breaks
    public string OrderDetailsPath { get; init; } = "/gp/your-account/order-details";

    // preferred for items and totals: the print invoice is the least dynamically rendered page, so least likely to change shape
    public string InvoicePath { get; init; } = "/gp/css/summary/print.html";

    public string SignOutPath { get; init; } = "/gp/flex/sign-out.html";

    // the "Factuur" control links to the invoice list, not a document; matched on the href path as the anchor has no id or class
    // and its text is language-bound (confirmed 2026-08-06)
    public IReadOnlyList<string> InvoiceListLinkSelectors { get; init; } =
    [
        "a[href*='/your-orders/invoice/popover']",
        "a[href*='invoice/popover']",
    ];

    // every anchor in the invoice list; DocumentPathMarkers decides which are documents
    public IReadOnlyList<string> DocumentLinkSelectors { get; init; } =
    [
        "ul.invoice-list a",
        "ul a",
        "a",
    ];

    // the list holds print.html (a summary), /documents/download/ (the files) and "Factuur aanvragen" (a support form).
    // a path marker, because the form starts with the same word as the real invoice
    public IReadOnlyList<string> DocumentPathMarkers { get; init; } = ["/documents/download/"];

    // an expired session answers a sign-in HTML page from a .pdf URL, so the media type is checked, not the extension.
    // Amazon sends "application/pdf;charset=UTF-8", hence parameters are trimmed before comparing
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    // one invoice per SHIPMENT (four seen on a real order); ten bounds a strange order, each ~100KB and one paced request
    public int MaxDocumentsPerOrder { get; init; } = 10;

    public string TimeFilterTemplate { get; init; } = "year-{year}";

    // UNCONFIRMED: ten per page historically; a wrong value only costs requests, as the walk stops on a page with nothing new
    public int PageSize { get; init; } = 10;

    public int MaxPagesPerYear { get; init; } = 20;

    public int MaxYears { get; init; } = 6;

    // OFF on purpose: azad forces en_GB to dodge a '.'-decimal money parser, which ours is not (it resolves comma decimals)
    // the parameter is unverified on .nl and would fail quietly; labels carry Dutch and English, fixtures are Dutch
    // set en_GB only after a live run confirms it takes and what it does to number formats
    public string? LanguageOverride { get; init; }

    // amounts arrive as rendered strings in major units ("€ 1.234,56"): the unit is declared,
    // since a wrong guess corrupts money silently
    public MoneyUnit OrderTotalUnit { get; init; } = MoneyUnit.MajorString;

    public MoneyUnit ItemAmountUnit { get; init; } = MoneyUnit.MajorString;

    public MoneyUnit InvoiceTotalUnit { get; init; } = MoneyUnit.MajorString;

    public MoneyUnit DiscountAmountUnit { get; init; } = MoneyUnit.MajorString;

    // declared, never inferred from the symbol ("$" is several currencies)
    public string Currency { get; init; } = "EUR";

    // anything else in an amount stops the parse rather than being stripped (see AmazonMoney)
    public IReadOnlyList<string> CurrencyTokens { get; init; } = ["EUR", "€"];

    // old values stay below the confirmed ones: a candidate list is free and Amazon serves more than one layout

    public IReadOnlyList<string> OrderCardSelectors { get; init; } =
    [
        "div.order-card.js-order-card",
        "div.js-order-card",
        "li.order-card",
        "[data-order-id]",
    ];

    public IReadOnlyList<string> OrderIdSelectors { get; init; } =
    [
        ".yohtmlc-order-id span[dir='ltr']",
        ".yohtmlc-order-id",
        "bdi[dir='ltr']",
    ];

    // sturdiest identifier: survives a redesign that renames classes and is scoped to the card,
    // unlike order numbers read from loose page text
    public IReadOnlyList<string> OrderIdAttributes { get; init; } =
        ["data-csa-c-slot-id", "data-order-id", "data-orderid"];

    // header facts are identical li elements told apart only by their label, so date and total are found by label.
    // column-span selectors would report the total as the purchase date once the page reflows
    public IReadOnlyList<string> OrderHeaderItemSelectors { get; init; } =
    [
        "li.order-header__header-list-item",
        ".order-header__header-list-item",
    ];

    public IReadOnlyList<string> OrderDateLabels { get; init; } =
        ["bestelling geplaatst", "besteld op", "order placed"];

    public IReadOnlyList<string> OrderTotalLabels { get; init; } = ["totaal", "total"];

    // old layout, tried only when the labelled header yields nothing
    public IReadOnlyList<string> OrderDateSelectors { get; init; } =
    [
        ".yohtmlc-order-date .a-color-secondary.value",
        ".order-date-invoice-item .a-color-secondary.value",
    ];

    // old layout; #wfm-grand-total-amount is Whole Foods and absent on this storefront
    public IReadOnlyList<string> OrderTotalSelectors { get; init; } =
    [
        ".yohtmlc-order-total .a-color-secondary.value",
        ".yohtmlc-order-total span.value",
        "div.yohtmlc-order-total",
        "#wfm-grand-total-amount",
    ];

    // Amazon spells the parameter orderID on one route and orderId on the other
    public IReadOnlyList<string> OrderLinkSelectors { get; init; } =
    [
        "a[href*='orderID=']",
        "a[href*='orderId=']",
        "a[href*='order-details']",
    ];

    // looked for before the next link: present, its next control is authoritative.
    // absent (another layout), the walk's freshness guard decides
    public IReadOnlyList<string> PaginationSelectors { get; init; } =
    [
        "ul.a-pagination",
        ".a-pagination",
        "div.pagination",
    ];

    // the last page carries a-disabled on li.a-last instead of a link
    public IReadOnlyList<string> NextPageSelectors { get; init; } =
    [
        "li.a-last a",
        ".a-last a",
        "a.s-pagination-next",
    ];

    // data-component attributes name what a thing is, not its layout, and survived the redesign that removed every tr

    // not purchasedItems itself: there is one per SHIPMENT, so it would collapse a multi-product order into one item.
    // the per-item container has no data-component, so one layout class is load-bearing here
    public IReadOnlyList<string> InvoiceItemRowSelectors { get; init; } =
    [
        "[data-component='purchasedItems'] .a-fixed-left-grid-inner",
        "[data-component='purchasedItems']",
        "tr.item-row",
        "table.product-view tr.item-row",
    ];

    public IReadOnlyList<string> InvoiceItemNameSelectors { get; init; } =
    [
        "[data-component='itemTitle']",
        "td.item-title",
        "td[colspan]",
    ];

    // the price renders twice in span.a-price (.a-offscreen and aria-hidden), reading "€22,99€22,99".
    // the inner span is defensive only: the parse takes the first amount either way
    public IReadOnlyList<string> InvoiceItemPriceSelectors { get; init; } =
    [
        "[data-component='unitPrice'] .a-offscreen",
        "[data-component='unitPrice']",
        "td.item-price",
        "td[align='right']",
    ];

    // the empty data-component='quantity' is a decoy: the quantity is the .od-item-view-qty badge, absent when it is one.
    // trusting the decoy would report a two-pack at unit price and break reconciliation
    public IReadOnlyList<string> InvoiceItemQuantitySelectors { get; init; } =
    [
        ".od-item-view-qty span",
        ".od-item-view-qty",
        "[data-component='quantity']",
    ];

    // read so the seller can be cut off the end of a product name
    public IReadOnlyList<string> InvoiceItemMerchantSelectors { get; init; } =
        ["[data-component='orderedMerchant']"];

    // absent on this storefront (unit price and quantity, never a line total); a stated figure beats a computed one
    public IReadOnlyList<string> InvoiceItemTotalSelectors { get; init; } = ["td.item-total"];

    // UNCONFIRMED: where Amazon's commentary starts; cutting keeps the name stable,
    // as a new parenthetical would change the content hash
    public IReadOnlyList<string> ItemNameStopMarkers { get; init; } =
    [
        "verkocht door",
        "sold by",
        "leverancier:",
        "staat:",
        "condition:",
        "terugsturen kan tot",
    ];

    public IReadOnlyList<string> InvoiceTotalRowSelectors { get; init; } =
    [
        "[data-component='chargeSummary'] .od-line-item-row",
        "#od-subtotals .od-line-item-row",
        ".od-line-item-row",
        "table.totals tr",
    ];

    // read apart from the value so a label holding a number ("Subtotaal item(s):") is not mistaken for the amount
    public IReadOnlyList<string> InvoiceTotalLabelSelectors { get; init; } = [".od-line-item-row-label"];

    public IReadOnlyList<string> InvoiceTotalValueSelectors { get; init; } = [".od-line-item-row-content"];

    public IReadOnlyList<string> InvoicePaymentSelectors { get; init; } =
    [
        "[data-testid='payment-instrument']",
        "[data-component='viewPaymentPlanSummaryWidget']",
        ".payment-information",
        "#payment-information",
    ];

    public IReadOnlyList<string> PaymentNameSelectors { get; init; } =
        ["[data-testid='payment-instrument-name']"];

    // its own element: read, not sliced from "MasterCard •••• 7201" whose bullet characters vary by locale and font
    public IReadOnlyList<string> PaymentTailSelectors { get; init; } =
        ["[data-testid='payment-instrument-number']"];

    // matched in the parser's priority order: "subtotaal" contains "totaal", "totaal vóór btw" contains "btw",
    // so one contains-list misfiles both

    public IReadOnlyList<string> SubtotalLabels { get; init; } =
        ["artikelen (subtotaal)", "subtotaal", "items (subtotal)", "subtotal"];

    public IReadOnlyList<string> TotalBeforeTaxLabels { get; init; } =
        ["totaal vóór btw", "totaal voor btw", "total before tax", "totaal excl. btw"];

    // "Porto- en verpakkingskosten" matched no word, so shipping was dropped and reconciliation broke by that amount
    // (hidden by a €0,00 order)
    public IReadOnlyList<string> ShippingLabels { get; init; } =
    [
        "porto- en verpakkingskosten",
        "porto en verpakkingskosten",
        "verpakkingskosten",
        "porto",
        "verzendkosten",
        "verzending & verwerking",
        "verzending",
        "shipping & handling",
        "shipping",
        "postage",
    ];

    public IReadOnlyList<string> TaxLabels { get; init; } =
        ["btw", "belasting", "estimated tax", "vat", "tax"];

    public IReadOnlyList<string> PromotionLabels { get; init; } =
        ["actiekorting", "promotiekorting", "korting", "promotion applied", "promotion", "coupon"];

    public IReadOnlyList<string> GiftCardLabels { get; init; } =
        ["cadeaubon", "tegoedbon", "gift card amount", "gift card"];

    // Totaal (what the order came to) and Eindtotaal (what was charged) diverge once a gift card or balance pays part.
    // the receipt total is the charged one, as a bank transaction is matched against it
    public IReadOnlyList<string> FinalTotalLabels { get; init; } =
        ["eindtotaal", "grand total"];

    public IReadOnlyList<string> GrandTotalLabels { get; init; } =
        ["ordertotaal", "totaalbedrag", "totaal", "order total", "total"];

    // text-scanning fallback for a layout that states the tail in prose; see PaymentTailSelectors
    public IReadOnlyList<string> CardTailMarkers { get; init; } =
        ["eindigend op", "eindigt op", "ending in", "ending with"];

    // prices include BTW, so the tax row decomposes the total and is not emitted as a line: on the captured order
    // 2 × 12,99 = 25,98 = Eindtotaal, and subtotal 21,47 + Btw 4,51 = 25,98 too
    public bool TaxIsIncludedInItemPrices { get; init; } = true;

    // without it an empty history and an expired card selector look identical,
    // and the second must not read as "you have no orders"
    public IReadOnlyList<string> EmptyHistoryMarkers { get; init; } =
    [
        "geen bestellingen",
        "Je hebt geen bestellingen geplaatst",
        "niets besteld",
        "no orders",
        "You have not placed any orders",
    ];

    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input#ap_email",
        "input#ap_email_login",
        "input[name='email']",
        "input[type='email']",
        "input[name='username']",
    ];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input#ap_password",
        "input[name='password']",
        "input[type='password']",
    ];

    public IReadOnlyList<string> ContinueSelectors { get; init; } =
    [
        "input#continue",
        "#continue input[type='submit']",
        "input[type='submit'][aria-labelledby*='continue']",
    ];

    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "input#signInSubmit",
        "#signInSubmit input[type='submit']",
        "input[type='submit']",
        "button[type='submit']",
    ];

    // narrow on purpose: only phrasings stating a CREDENTIAL failure.
    // invalid_credentials is never retried, so a false one is permanent
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        "#auth-password-invalid-password-alert",
        "#auth-email-invalid-claim-alert",
        "#auth-error-message-box .a-alert-content",
    ];

    public IReadOnlyList<string> OtpSelectors { get; init; } =
    [
        "input#auth-mfa-otpcode",
        "input[name='otpCode']",
        "input[autocomplete='one-time-code']",
    ];

    public IReadOnlyList<string> OtpSubmitSelectors { get; init; } =
    [
        "input#auth-signin-button",
        "#auth-signin-button input[type='submit']",
        "input[type='submit']",
    ];

    // resolved by visible words, not markup: probed app, sms, then e-mail last, as an OTP page often prints
    // the account's own address; null when none match
    public IReadOnlyList<string> OtpAppSelectors { get; init; } =
    [
        ":text('authenticator')",
        ":text('verificatie-app')",
        ":text('authenticatie-app')",
    ];

    public IReadOnlyList<string> OtpSmsSelectors { get; init; } =
    [
        ":text('tekstbericht')",
        ":text('sms')",
        ":text('text message')",
    ];

    public IReadOnlyList<string> OtpEmailSelectors { get; init; } =
    [
        ":text('e-mail gestuurd')",
        ":text('sent to your email')",
        ":text('mailbox')",
    ];

    // a refusal that is not about the password (locked account, approve-sign-in wall): Blocked, never invalid_credentials
    public IReadOnlyList<string> RefusalSelectors { get; init; } =
    [
        "#auth-account-locked-alert",
        "#auth-suspended-alert",
    ];

    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "#sp-cc-accept",
        "input#sp-cc-accept",
        "button[name='accept']",
    ];

    // WAF JS challenge and the ACIC page mint tokens in their own JS: no screenshot or typed answer passes them,
    // so a human at the browser or blocked_by_provider, never a solver
    // the first four entries are the /ap/cvf/request wall (AAmation iframe) a headless sign-in lands on (2026-08-05)
    public IReadOnlyList<string> InteractiveCaptchaSelectors { get; init; } =
    [
        "#cvf-aamation-challenge-iframe",
        "form#cvf-aamation-challenge-form",
        "input#cvf_aamation_response_token",
        "#cvf-page-content",
        "#aa-challenge-page-captcha-container",
        "form[action*='/ax/aaut/verify']",
        "#challenge-container",
        "#captcha-container",
        "iframe[src*='captcha']",
        "iframe[src*='hcaptcha']",
        "iframe[src*='recaptcha']",
    ];

    // the CVF path cannot be renamed without moving the endpoint, and a page still drawing its iframe is already a wall by URL
    public IReadOnlyList<string> ChallengeUrlMarkers { get; init; } = ["/ap/cvf/", "/ax/aaut/"];

    // a cancelled order has no card total, lines or charge summary (not a receipt): reading those absences as a shape change
    // fails the fetch; the full sentence, as "geannuleerd" alone also appears for a single cancelled item of a live order
    public IReadOnlyList<string> CancelledOrderMarkers { get; init; } =
    [
        "deze bestelling is geannuleerd",
        "bestelling is geannuleerd",
        "this order was cancelled",
        "this order was canceled",
        "order has been cancelled",
        "order has been canceled",
    ];

    // the passkey nudge stopped every live login: password accepted, then a passkey page the settle loop had no name for.
    // served to the pooled agent, not to a plain desktop run

    public IReadOnlyList<string> PasskeyNudgeUrlMarkers { get; init; } = ["/ax/claim/webauthn/nudge"];

    // only controls that DECLINE: "set up a passkey" and "sign in with an existing passkey" would add a factor to the user's
    // Amazon account, never list them; skip variants appear when the nudge errors instead of "Niet nu"
    public IReadOnlyList<string> PasskeyDeclineSelectors { get; init; } =
    [
        "input[aria-labelledby*='nudge-not-now']",
        "input[aria-labelledby*='nudge-skip-client-error']",
        "input[aria-labelledby*='nudge-skip-server-error']",
        "input[aria-labelledby*='nudge-skip']",
    ];

    // the legacy OCR captcha (a picture and a box): the one kind a relay can carry to the account's owner
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "#auth-captcha-image",
        "img[src*='captcha']",
        "form[action*='validateCaptcha'] img",
    ];

    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input#auth-captcha-guess",
        "input#captchacharacters",
        "input[name='field-keywords']",
    ];

    // markers for a challenge no selector caught; window.gokuProps detects an AWS WAF JS challenge,
    // yielding the aws-waf-token cookie
    public IReadOnlyList<string> ChallengeBodyMarkers { get; init; } =
    [
        "gokuProps",
        "aws-waf-token",
        "/errors/validateCaptcha",
        "opfcaptcha",
        "Enter the characters you see below",
        "Voer de tekens in die je hieronder ziet",
    ];

    // a hard refusal with nothing for a human to do: blocked_by_provider even on a 200.
    // Cloudflare/Akamai listed so a CDN change is diagnosed, not parsed
    public IReadOnlyList<string> BlockedBodyMarkers { get; init; } =
    [
        "To discuss automated access to Amazon data please contact",
        "Sorry, we just need to make sure you're not a robot",
        "Request blocked",
        "Access Denied",
        "cf-browser-verification",
        "Attention Required! | Cloudflare",
        "Reference #18.",
    ];

    // URL fragments of the sign-in chain: during a fetch, a dead session
    public IReadOnlyList<string> SignInUrlMarkers { get; init; } = ["/ap/signin", "/ax/claim", "/ap/cvf"];

    public IReadOnlyList<string> SignedInUrlMarkers { get; init; } =
        ["/your-orders/orders", "/gp/css/order-history", "/gp/your-account/order-history"];

    // x-main is amazon.COM's cookie; amazon.nl suffixes its own and never sets x-main, so a working login was rejected
    // short on purpose: a signed-out visit already leaves session-id, ubid-acbnl, lc-acbnl, sst-acbnl.
    // x-main stays last for .com
    public IReadOnlyList<string> AuthCookieNames { get; init; } =
        ["x-acbnl", "at-acbnl", "sess-at-acbnl", "x-main"];

    // 429 and 503 are refusals from a bot wall, not retriable rate limits: retrying into it escalates to a hard block.
    // 500 is deliberately absent: a real server error is provider_unavailable and retriable
    public IReadOnlySet<int> BlockStatuses { get; init; } =
        new HashSet<int> { 403, 429, 502, 503, 504, 511 };

    public int SelectorTimeoutMs { get; init; } = 15_000;

    // short: on the two-screen sign-in this probe always misses on the first screen, so the wait is pure latency
    public int PasswordProbeMs { get; init; } = 1_500;

    /// <summary>Short probes: the settle loop runs them on every pass.</summary>
    public int ProbeMs { get; init; } = 500;

    public int LoginSettleSeconds { get; init; } = 240;

    public int RedirectPollSeconds { get; init; } = 5;

    public int ChallengeSeconds { get; init; } = 300;

    // longer than a typed captcha: nobody relays anything, so the wait covers someone noticing and walking back to the browser
    public int InteractiveCaptchaSeconds { get; init; } = 600;

    // generous: the person may need a password manager or a code; the job budget stops counting while parked on the challenge
    public int LiveLoginSeconds { get; init; } = 600;

    public int CodeChallengeSeconds { get; init; } = 300;

    /// <summary>UNCONFIRMED. Amazon's OTP is six digits.</summary>
    public int CodeLength { get; init; } = 6;
}
