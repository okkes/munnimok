using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Bol;

/// <summary>Which shape the order list is served in; every failure message names the shape that was tried.</summary>
public enum BolOrdersShape
{
    /// <summary>Default, confirmed on a real account: the overview is a shell, "Toon meer" is a GraphQL call.</summary>
    GraphQl,

    /// <summary>Parse the account page's own markup. Superseded; see the README.</summary>
    Html,

    /// <summary>A plain JSON endpoint. Never found; kept because the parser is written and tested.</summary>
    Json,
}

/// Login confirmed from public pages (2026-07-28): login.bol.com/wsp/login posts j_username/j_password; JSESSIONID, XSC.
/// Unconfirmed: order list HTML vs JSON, markup, pagination, session lifetime, a one-time code on a new device.
/// api.bol.com/retailer is a SELLER API (client_credentials, no user context): never a route to a shopper's orders.
public sealed record BolOptions
{
    /// <summary>The protected page, not login.bol.com: bol's own 302 chain is a real shopper's flow and ends on the orders page.
    /// The old /rnwy/account/bestellingen answers 404 to a signed-in client since 2026-08-06, and the login watcher accepts
    /// a 404 as success.</summary>
    public string LoginStartUrl { get; init; } = "https://www.bol.com/nl/nl/account/bestellingen/overzicht/";

    /// <summary>The form itself (Next.js under /wsp/); second entry when LoginStartUrl's redirects do not end at one,
    /// so the login survives bol changing its 302s.</summary>
    public string LoginFormUrl { get; init; } = "https://login.bol.com/wsp/login";

    /// <summary>While the URL contains this the login has not completed; no selector has to survive a redesign.</summary>
    public string LoginHostMarker { get; init; } = "login.bol.com";

    /// <summary>j_username is the Spring Security form-login field (confirmed); the rest cover a renamed input.</summary>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input[name='j_username']",
        "input#j_username",
        "input[autocomplete='username']",
        "input[type='email']",
    ];

    /// <summary>j_password is the Spring Security form-login field (confirmed).</summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input[name='j_password']",
        "input#j_password",
        "input[autocomplete='current-password']",
        "input[type='password']",
    ];

    /// <summary>Unconfirmed: the form has no action and is hydrated by React, so the button's hooks were not readable.</summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "button[type='submit']",
        "[data-test='login-submit']",
        "input[type='submit']",
    ];

    /// <summary>The cookie wall's way out, most specific first: a Radix dialog with "Weigeren" / "Alles accepteren"
    /// (prod, 2026-10-06), refuse before accept. The bare "accept-all" test id matched a button UNDER the dialog and
    /// timed out. Best effort.</summary>
    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "[role='dialog'][data-state='open'] button:has-text('Weigeren')",
        "[role='dialog'][data-state='open'] button:has-text('Alles accepteren')",
        "[role='dialog'] button:has-text('Weigeren')",
        "[role='dialog'] button:has-text('Alles accepteren')",
        "#js-first-screen-accept-all-button",
        "button[data-test='consent-modal-confirm-btn']",
        "#onetrust-accept-btn-handler",
    ];

    /// <summary>How long the cookie wall gets to appear: its script hydrates after the page, 500 ms was not enough.</summary>
    public int ConsentMs { get; init; } = 2_000;

    /// <summary>The language-chooser wall (prod, 2026-10-07): a Radix dialog whose "Doorgaan" is the way through; it blocked
    /// the login's click like the cookie wall. "Continue" for a session served in English.</summary>
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
    [
        "[role='dialog'][data-state='open'] button:has-text('Doorgaan')",
        "[role='dialog'] button:has-text('Doorgaan')",
        "[role='dialog'][data-state='open'] button:has-text('Continue')",
    ];

    /// <summary>How long the language chooser gets to appear behind the cookie wall; most sessions never see it.</summary>
    public int ContinueMs { get; init; } = 1_500;

    /// Unconfirmed. Only hooks meaning "this credential is wrong": a match is the one path reporting InvalidCredentials,
    /// never retried. Generic notices ("er is iets misgegaan") go in BlockedNoticeSelectors: Lidl answered an automated
    /// browser with one, and reading it as a bad password was a real bug.
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        "[data-test='login-error']",
        "[data-test='invalid-credentials']",
    ];

    /// Unconfirmed and empty on purpose: nothing observed. A generic notice shown to an automated browser goes here
    /// and yields BlockedByProvider, not a credential error.
    public IReadOnlyList<string> BlockedNoticeSelectors { get; init; } = [];

    /// <summary>Unconfirmed: assumed bol forces an e-mail or SMS code on a new device, so the box is relayed.</summary>
    public IReadOnlyList<string> VerificationCodeSelectors { get; init; } =
    [
        "input[autocomplete='one-time-code']",
        "input[name='verificationCode']",
        "input[name='otp']",
        "input[name='code']",
    ];

    /// <summary>UNCONFIRMED. The code screen's own button; an Enter keypress is the fallback.</summary>
    public IReadOnlyList<string> VerificationSubmitSelectors { get; init; } =
    [
        "[data-test='verify-code-submit']",
        "button[type='submit']",
    ];

    public IReadOnlyList<string> EmailDeliverySelectors { get; init; } =
    [
        "[data-test='verification-by-email']",
        "[data-delivery='email']",
    ];

    public IReadOnlyList<string> SmsDeliverySelectors { get; init; } =
    [
        "[data-test='verification-by-sms']",
        "[data-delivery='sms']",
    ];

    /// Interactive widgets by iframe/container; a reCAPTCHA site key is in the login config blob, whether it renders is unknown.
    /// No screenshot or typed answer passes a widget, so meeting one unattended is reported at once, not relayed.
    public IReadOnlyList<string> InteractiveCaptchaSelectors { get; init; } =
    [
        "iframe[src*='recaptcha']",
        "iframe[src*='hcaptcha']",
        ".g-recaptcha",
        "[data-sitekey]",
    ];

    /// <summary>UNCONFIRMED. A plain image captcha is the one kind a relay can carry.</summary>
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "img[alt*='captcha' i]",
        "img[src*='captcha' i]",
    ];

    /// Unconfirmed. Where a typed captcha's answer goes; a picture with nowhere to type is as unreachable as a widget.
    /// Deliberately excludes the one-time-code box: relaying 2FA as a captcha would photograph it and call it a wall.
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
    ];

    /// <summary>Everything under bol.com; the host match below decides what is actually sent.</summary>
    public string CookieDomainSuffix { get; init; } = "bol.com";

    /// <summary>Names confirmed, meaning not: which one www.bol.com authenticates on is unknown, so any one present counts
    /// as "a session exists" and the fetch's own answer settles the rest.</summary>
    public IReadOnlyList<string> SessionCookieNames { get; init; } =
    [
        "JSESSIONID",
        "XSC",
        "shopping_session_id",
        "BUI",
    ];

    /// <summary>The host the orders request goes to; only cookies scoped to it are sent.</summary>
    public string OrdersHost { get; init; } = "www.bol.com";

    public BolOrdersShape OrdersShape { get; init; } = BolOrdersShape.GraphQl;

    /// <summary>CONFIRMED. The endpoint every "Toon meer" posts to.</summary>
    public string GraphQlUrl { get; init; } = "https://www.bol.com/api/graphql";

    public string OrdersOperationName { get; init; } = "OrdersOverviewClient";

    /// Automatic persisted query: bol sends this hash and no document. It moves with every front-end release; an unknown
    /// hash answers PersistedQueryNotFound, reported as provider_changed naming this setting. No document fallback:
    /// the schema is not public.
    public string OrdersPersistedQueryHash { get; init; } =
        "sha256:d195253b815a6082cdee63bef6234513d5c0520c9f064e96fc1a9037d689add2";

    /// <summary>How long sign-in waits after the session lands for bol's page to fire the orders operation whose hash it
    /// learns (BolPersistedQuery); a page that never fires it falls back to the hash above.</summary>
    public int HashProbeMs { get; init; } = 4_000;

    /// The orders request exactly as bol's page sent it; never configured, filled from the session material. Null rebuilds it.
    /// A rebuilt request was refused ("Error(s) redacted.", prod 2026-10-07) even with the page's own hash: it sent a cursor
    /// the page never sends and lacked its headers. A replay rewrites only AfterVariable.
    public string? OrdersRequestTemplate { get; init; }

    /// Headers the page sent with that request, laid over the fetch's defaults; empty is the fetch's own set. Never the jar,
    /// referer or CSRF echo: the double-submitted token must match the cookie beside it, so those stay the fetch's.
    public IReadOnlyDictionary<string, string> OrdersRequestHeaders { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// What sign-in presses when the overview stays silent: "Toon meer" fires the operation the adapter needs. Once the
    /// landing page fired nothing, the configured hash was refused and every fetch failed as provider_changed (2026-10-05).
    public IReadOnlyList<string> LoadMoreSelectors { get; init; } =
    [
        "button:has-text(\"Toon meer\")",
        "button:has-text(\"Meer laden\")",
        "[data-test='load-more']",
        "button[data-testid*='load-more']",
    ];

    /// <summary>The cursor variable is a string: bol sends "5", then "10", an offset and not an opaque token.</summary>
    public string AfterVariable { get; init; } = "after";

    /// <summary>CONFIRMED. Five orders per call, which is what the button fetches.</summary>
    public int OrdersPageSize { get; init; } = 5;

    /// Confirmed: listPrice.priceInclVat.amount is a JSON number in euros (31.75, not 3175). A wrong unit cannot be caught
    /// downstream: declared minor, every receipt would be a hundredth of the truth and still reconcile.
    public MoneyUnit GraphQlAmountUnit { get; init; } = MoneyUnit.MajorDecimal;

    /// bol's edge requires the operation named in a HEADER as well as the body, else HTTP 400 InvalidRequest before GraphQL
    /// sees it. Verified on three operations, signed out: a property of the endpoint.
    public string OperationNameHeader { get; init; } = "bol-app-operation-name";

    /// <summary>bol double-submits its CSRF token: the XSRF-TOKEN cookie value must be echoed here, else 403.</summary>
    public string XsrfHeader { get; init; } = "x-xsrf-token";

    public string XsrfCookieName { get; init; } = "XSRF-TOKEN";

    /// Body text of bol's 403 for a bad or missing token. 403 is otherwise in BlockStatuses and would read as bol refusing
    /// us (provider degraded); it is a session to renew.
    public string XsrfFailureMarker { get; init; } = "XSRF failed";

    /// What data.me.__typename says once the session is over: bol answers 200 with a valid payload lacking an orders field,
    /// which would otherwise be reported as provider_changed.
    public string AnonymousTypeName { get; init; } = "AnonymousCustomer";

    /// Dead since 2026-08-06 (404 to a signed-in client); live list: /nl/nl/account/bestellingen/overzicht/. Not repointed:
    /// that page has no data-test attributes yet shows EmptyStateMarkers' text as an i18n label: a SILENT EMPTY SYNC.
    /// A stale escape hatch; the default GraphQl shape is unaffected.
    public string HtmlOrdersUrlTemplate { get; init; } =
        "https://www.bol.com/nl/nl/rnwy/account/bestellingen?page={page}";

    /// Unconfirmed in every part: no JSON order endpoint has been identified; correct it when devtools names the real one.
    public string JsonOrdersUrlTemplate { get; init; } =
        "https://www.bol.com/nl/rnwy/api/account/orders?page={page}";

    /// Unconfirmed paths to the orders array, tried in order; none matching is provider_changed naming every path
    /// (guessing an array in an unknown document would report wrong data).
    public IReadOnlyList<string> JsonOrderPaths { get; init; } =
    [
        "orders",
        "data.orders",
        "results",
        "items",
        "content",
    ];

    /// <summary>UNCONFIRMED field names for one order, most likely first.</summary>
    public IReadOnlyList<string> JsonOrderIdNames { get; init; } = ["orderId", "orderNumber", "id", "number"];

    public IReadOnlyList<string> JsonOrderDateNames { get; init; } =
        ["orderDate", "placedAt", "date", "createdAt", "dateTime"];

    public IReadOnlyList<string> JsonOrderTotalNames { get; init; } =
        ["totalAmount", "total", "orderTotal", "grandTotal", "amount"];

    public IReadOnlyList<string> JsonSellerNames { get; init; } = ["sellerName", "seller", "merchant", "shopName"];

    public IReadOnlyList<string> JsonItemArrayNames { get; init; } =
        ["orderItems", "items", "lines", "products", "orderLines"];

    public IReadOnlyList<string> JsonItemNameNames { get; init; } = ["title", "productTitle", "name", "description"];

    public IReadOnlyList<string> JsonItemQuantityNames { get; init; } = ["quantity", "amount", "count"];

    public IReadOnlyList<string> JsonItemUnitPriceNames { get; init; } = ["unitPrice", "pricePerUnit", "price"];

    public IReadOnlyList<string> JsonItemTotalNames { get; init; } = ["totalPrice", "lineTotal", "total", "subTotal"];

    public IReadOnlyList<string> JsonItemDiscountNames { get; init; } = ["discount", "discountAmount", "promotion"];

    public IReadOnlyList<string> JsonPaymentMethodNames { get; init; } = ["paymentMethod", "payment", "method"];

    public IReadOnlyList<string> JsonPaymentMaskNames { get; init; } =
        ["maskedCardNumber", "cardNumber", "last4", "iban"];

    /// Unconfirmed, all of it: the first candidate matching anything wins, so repairing after a redesign is a configuration
    /// edit, not a release.
    public IReadOnlyList<string> OrderBlockSelectors { get; init; } =
    [
        "[data-test=order-container]",
        "[data-test=order]",
        "[data-test*=order-overview-item]",
        ".order-overview__item",
    ];

    public IReadOnlyList<string> OrderIdAttributes { get; init; } =
        ["data-order-id", "data-ordernumber", "data-test-order-id", "id"];

    public IReadOnlyList<string> OrderIdSelectors { get; init; } =
        ["[data-test=order-number]", "[data-test=order-id]"];

    public IReadOnlyList<string> OrderDateSelectors { get; init; } =
        ["[data-test=order-date]", "[data-test=order-placed]", "time"];

    /// A machine-readable date beats the rendered Dutch text, which is the riskier path.
    public IReadOnlyList<string> DateAttributes { get; init; } = ["datetime", "data-date", "data-order-date"];

    public IReadOnlyList<string> OrderTotalSelectors { get; init; } =
        ["[data-test=order-total]", "[data-test=order-amount]", "[data-test=total-amount]"];

    public IReadOnlyList<string> OrderSellerSelectors { get; init; } =
        ["[data-test=order-seller]", "[data-test=seller-name]", "[data-test=sold-by]"];

    public IReadOnlyList<string> OrderPaymentSelectors { get; init; } =
        ["[data-test=payment-method]", "[data-test=order-payment]"];

    public IReadOnlyList<string> ItemBlockSelectors { get; init; } =
        ["[data-test=order-item]", "[data-test=order-line]", "[data-test=product-item]"];

    public IReadOnlyList<string> ItemNameSelectors { get; init; } =
        ["[data-test=item-title]", "[data-test=product-title]", "[data-test=title]"];

    public IReadOnlyList<string> ItemQuantitySelectors { get; init; } =
        ["[data-test=item-quantity]", "[data-test=quantity]"];

    public IReadOnlyList<string> ItemUnitPriceSelectors { get; init; } =
        ["[data-test=item-unit-price]", "[data-test=unit-price]"];

    public IReadOnlyList<string> ItemTotalSelectors { get; init; } =
        ["[data-test=item-total]", "[data-test=item-price]", "[data-test=line-total]"];

    public IReadOnlyList<string> ItemDiscountSelectors { get; init; } =
        ["[data-test=item-discount]", "[data-test=discount]"];

    /// Without this, "the page changed" and "never ordered" are the same observation (zero blocks) with opposite answers:
    /// page an operator vs a good empty sync. Unconfirmed; substrings are checked against the raw page too.
    public IReadOnlyList<string> EmptyStateSelectors { get; init; } =
        ["[data-test=no-orders]", "[data-test=empty-state]", "[data-test=orders-empty]"];

    public IReadOnlyList<string> EmptyStateMarkers { get; init; } =
    [
        "Je hebt nog geen bestellingen",
        "geen bestellingen gevonden",
        "Nog geen bestellingen",
    ];

    /// A 200 that is the login form: the session died (session_expired, a new login job), not a parse failure.
    public IReadOnlyList<string> LoginPageMarkers { get; init; } =
    [
        "j_username",
        "j_password",
        "login.bol.com/wsp",
    ];

    /// A 200 that is a wall. bol runs no enterprise bot vendor (confirmed from headers), so this guards against change.
    /// Checked BEFORE the login markers: mistaking a wall for a dead session starts a fresh login against the wall.
    public IReadOnlyList<string> BotWallMarkers { get; init; } =
    [
        "cf-browser-verification",
        "Attention Required! | Cloudflare",
        "__cf_chl",
        "datadome",
        "DataDome",
        "Reference&#32;&#35;",
        "AkamaiGHost",
        "Access Denied",
        "Pardon Our Interruption",
    ];

    /// Statuses meaning bol refuses us. 429 is here, not under rate limiting: bol publishes no consumer quota, so it reads
    /// as a wall. Never invalid_credentials (sends the user to reset a fine password). 502/504: a tarpitting edge.
    public IReadOnlySet<int> BlockStatuses { get; init; } = new HashSet<int> { 403, 429, 502, 504 };

    /// Confirmed: a Dutch page renders "€ 12,50" (decimal comma, dot for thousands), a major-unit string. Declared, never
    /// sniffed: a consistently wrong unit passes every reconciliation (one provider's totals came out 100x wrong).
    public MoneyUnit HtmlAmountUnit { get; init; } = MoneyUnit.MajorString;

    /// Unconfirmed unit for the JSON shape, the most dangerous value here. MajorString is the least-bad default: it reads
    /// "12,50", "12.50" and 12.50 alike, wrong only for JSON in minor units (1250 becomes €1250,00), silently.
    /// First live-run check: compare one order's number against the page.
    public MoneyUnit JsonAmountUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>Declared, never inferred from a symbol: "$" is at least four currencies.</summary>
    public string Currency { get; init; } = "EUR";

    public int MaxPages { get; init; } = 400;

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// <summary>Short probes: these run on a page that is already the right one.</summary>
    public int ProbeMs { get; init; } = 500;

    /// <summary>The hash probe's "Toon meer" press: find and click, which Playwright retries while something covers the
    /// button. The probe's 500 ms was not enough: three sign-ins died as `internal` on a click bol's second wall took
    /// the pointer from (prod, 2026-10-06/07).</summary>
    public int LoadMoreMs { get; init; } = 5_000;

    public int LoginSettleSeconds { get; init; } = 120;

    public int PollSeconds { get; init; } = 2;

    public int SessionPollMs { get; init; } = 500;

    public int CodeChallengeSeconds { get; init; } = 300;

    /// Unconfirmed length, so null rather than a plausible 6: a wrong length rejects a valid code before it is tried,
    /// burning a code the user must wait for again.
    public int? CodeLength { get; init; }

    public int ChallengeSeconds { get; init; } = 300;

    /// <summary>Longer than a typed captcha: nobody relays anything, so the wait has to cover someone noticing.</summary>
    public int InteractiveCaptchaSeconds { get; init; } = 600;

    /// <summary>Honest, not a disguise: an ordinary browser fingerprint is what the page is built for.</summary>
    public string UserAgent { get; init; } =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

    public string AcceptLanguage { get; init; } = "nl-NL,nl;q=0.9,en;q=0.8";

    /// Confirmed live 2026-08-06. One request per order, unavoidable: the overview carries no invoice reference at all.
    /// ?order_item_id is omitted (the captured page answered with EVERY item regardless) but this exact form was never
    /// fetched: if a run returns one item's invoices, append the query.
    public string OrderDetailsUrlTemplate { get; init; } =
        "https://www.bol.com/nl/nl/account/bestellingen/details/{reference}/";

    /// Confirmed live 2026-08-06. A PATTERN over the RAW BODY, not a selector: only ONE invoice anchor is in the DOM (one
    /// order carried THREE), the others sit in a script payload that BolHtml strips. Anchored on the path segment, never
    /// bare digits (16-digit help/product ids, 14-digit item ids, 13-digit invoice id); tolerates the ?paid form without rnwy.
    public string InvoiceIdPattern { get; init; } = @"account/facturen/details/(?<id>[0-9]{6,})";

    /// Confirmed live 2026-08-06: the route bol's UI uses for every invoice; the Plaza/non-EU flags change only the label.
    /// The bltgh tracking token is omitted. Unconfirmed: its BYTES were only read from PlazaVatPdfUrlTemplate's route,
    /// hence the magic-number check.
    public string InvoicePdfUrlTemplate { get; init; } = "https://www.bol.com/nl/rnwy/invoice/pdf?i={invoiceId}";

    /// A DIFFERENT DOCUMENT, not a fallback: the marketplace partner's VAT invoice, which bol reaches only for a plaza seller.
    /// Null by default: two documents per invoice would double every receipt's payload for a document most orders lack.
    public string? PlazaVatPdfUrlTemplate { get; init; }

    /// <summary>bol sends application/pdf;charset=UTF-8: compare the bare MediaType, or every PDF is rejected.</summary>
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    /// <summary>Confirmed. The file's own claim, beside the provider's media type: catches a 200 error page wearing a PDF
    /// content type, as when a session dies between list and download.</summary>
    public IReadOnlyList<byte> DocumentMagic { get; init; } = "%PDF-"u8.ToArray();

    /// <summary>One invoice per shipment AND selling party: the captured order (four items, two shipments, two sellers)
    /// gave three. Ten bounds a strange order.</summary>
    public int MaxDocumentsPerOrder { get; init; } = 10;

    /// <summary>bol's record cap is 200 and each invoice-mode order costs a 0.5MB+ details page plus paced downloads.
    /// Orders past this still become receipts without documents, and the run says so.</summary>
    public int MaxDocumentOrdersPerFetch { get; init; } = 200;

    /// Login-form markers safe on account pages: LoginPageMarkers' login.bol.com/wsp occurs once on them (passwordForgottenUrl)
    /// and would raise session_expired on a working page. These two occur ZERO times on every captured account page.
    public IReadOnlyList<string> AccountPageLoginMarkers { get; init; } =
    [
        "j_username",
        "j_password",
    ];
}
