using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Jumbo;

// operation, money format and headers come from vghoost360/Jumbo-API (a working client); login chain and bot protection
// from unauthenticated walks 2026-07-28; still unconfirmed: the Auth0 login markup and the in-store print-layout dialect
public sealed record JumboOptions
{
    public string GraphQlUrl { get; init; } = "https://www.jumbo.com/api/graphql";

    // the old /inloggen is a 404; this 302s to /api/auth/login and on to Auth0
    public string LoginUrl { get; init; } = "https://www.jumbo.com/account/inloggen";

    // login ends on auth.jumbo.com/u/login, which the old marker "inloggen" never matched
    // any substring means still signing in
    public IReadOnlyList<string> LoginUrlMarkers { get; init; } =
        ["auth.jumbo.com", "/u/login", "/authorize", "/api/auth/login", "/account/inloggen"];

    // recorded, not used: the site builds its own /authorize (a hand-built one must reproduce audience, state and callback)
    // kept for a future mobile-style public client
    public string Auth0Domain { get; init; } = "auth.jumbo.com";

    public string Auth0ClientId { get; init; } = "rWRgjhmeqWGeMLyJwf2Zf863o18XiDk0";

    public string Auth0Audience { get; init; } = "https://jumbo.com/web";

    // includes offline_access, but no refresh token is reachable: the server-side callback keeps the tokens (see JumboManifest)
    public string Auth0Scope { get; init; } = "openid profile email offline_access";

    // JUMBO_WEB-orders is what the working client sends; the old mobile value was uncorroborated
    public string ClientNameHeader { get; init; } = "JUMBO_WEB-orders";

    // a mobile version string beside a web client name is an inconsistent fingerprint
    public string ClientVersionHeader { get; init; } = "master-v29.2.0-web";

    public string SourceHeader { get; init; } = "JUMBO_WEB-orders";

    // probably optional (the working client sends none), but a stable device id is sent when present
    // a changing one is a fraud signal; never gates a fetch
    public bool SendDeviceIdHeader { get; init; } = true;

    // a real browser UA is required (Akamai scores requests without one)
    // the exact string is unconfirmed and should match the agent's Chromium
    public string UserAgent { get; init; } =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36";

    public string CookieDomainSuffix { get; init; } = "jumbo.com";

    public string ListOperationName { get; init; } = "GetOnlineOrdersAndStoreReceipts";

    // two result sets under two aliases (online orders and till receipts are different systems)
    // a receipt summary has no total or items, hence DigitalReceiptDocument
    public string ListDocument { get; init; } =
        """
        query GetOnlineOrdersAndStoreReceipts($ordersInput: OrdersInput!, $page: Int, $pageSize: Int) {
          storeReceipts: receiptOverview(page: $page, pageSize: $pageSize) {
            totalResults
            pageSize
            currentPage
            receipts {
              transactionId
              purchaseEndOn
              receiptSource
              store { storeId name }
              pointBalance
            }
          }
          onlineOrders: orders(input: $ordersInput) {
            orders {
              orderId
              customerId
              deliveryDate
              slotStartTime
              slotEndTime
              cutoffTime
              fulfilmentType
              status
              emailAddress
              branchName
              deliveryAddress { street postalCode houseNumber addition city }
              totalToPayMoneyType { amount currency }
            }
            totalCount
          }
        }
        """;

    // the name matters: the transposition OrdersPageOrders is a schema validation error
    public string OrderDetailOperationName { get; init; } = "OrderPagesOrder";

    // $orderId is Float!, not Int or ID: the wrong type is a schema validation error
    public string OrderDetailDocument { get; init; } =
        """
        query OrderPagesOrder($orderId: Float!, $mergeItemsWithSameSkuAndPrice: Boolean! = true) {
          order(orderId: $orderId, options: {mergeItemsWithSameSkuAndPrice: $mergeItemsWithSameSkuAndPrice}) {
            orderId
            deliveryDate
            fulfilmentType
            paymentMethod
            items {
              lineId: lineNumber
              sku
              quantity
              orderedQuantity
              pickedQuantity
              unit
              linePriceExDiscount { amount currency }
              linePriceIncDiscount { amount currency }
              pricePerUnit { price { amount currency } unit }
              promotions { id discount { amount currency } type scope description }
              deposits { sku quantity unitPrice { amount currency } description }
              surcharges { type value { amount currency } }
              details { id sku title }
            }
            totals {
              totalToPay { amount currency }
              totalTax { amount currency }
              itemSubtotal { amount currency }
              itemDiscounts { amount currency }
              orderDiscounts { amount currency }
            }
          }
        }
        """;

    public string DigitalReceiptOperationName { get; init; } = "GetDigitalReceipt";

    public string DigitalReceiptDocument { get; init; } =
        """
        query GetDigitalReceipt($transactionId: String) {
          receipt(transactionId: $transactionId) {
            receiptImage {
              image
              type
              receiptPoints { earned newBalance oldBalance redeemed }
            }
            store { name location { address { city houseNumber postalCode street } } }
            purchaseEndOn
            receiptSource
            customerDetails { customerId loyaltyCard { number } }
            transactionId
          }
        }
        """;

    public int OrdersPageSize { get; init; } = 10;

    // top-level zero-based page; no single offset counter drives both sides
    public int ReceiptsPageSize { get; init; } = 10;

    public string OrdersStatusCategory { get; init; } = "CLOSED";

    /// <summary>CONFIRMED: newest first, which is what lets an old page end the walk.</summary>
    public string OrdersDirection { get; init; } = "DESC";

    public string OrdersSortBy { get; init; } = "deliveryDate";

    /// <summary>A ceiling on the walk, so a wrong cursor cannot loop forever.</summary>
    public int MaxPages { get; init; } = 200;

    public string OnlineOrdersPath { get; init; } = "data.onlineOrders.orders";

    /// <summary>CONFIRMED: the order count, so the walk can be bounded by a number.</summary>
    public string OnlineOrdersTotalPath { get; init; } = "data.onlineOrders.totalCount";

    public string StoreReceiptsPath { get; init; } = "data.storeReceipts.receipts";

    /// <summary>
    /// CONFIRMED: <c>receiptOverview</c> states <c>totalResults</c>, so the
    /// receipt walk terminates on a count instead of on a heuristic.
    /// </summary>
    public string StoreReceiptsTotalPath { get; init; } = "data.storeReceipts.totalResults";

    public string OrderDetailPath { get; init; } = "data.order";

    public string DigitalReceiptPath { get; init; } = "data.receipt";

    // decimal-string euros ("29.83"), not cents: orders and order lines are MAJOR units, catalogue prices MINOR
    // declared Minor once made every total a hundredth and reconciliation passed: it never catches a consistently wrong unit
    public MoneyUnit OrderTotalUnit { get; init; } = MoneyUnit.MajorString;

    // major units, as the order total
    public MoneyUnit OrderLineUnit { get; init; } = MoneyUnit.MajorString;

    // major units written Dutch-style with a comma ("0,94"): a rendering of a paper receipt
    public MoneyUnit StoreReceiptUnit { get; init; } = MoneyUnit.MajorString;

    // MINOR units, recorded though never read: the two conventions sit one field apart
    // writing both stops a "correction" of the order unit to Minor
    public MoneyUnit CataloguePriceUnit { get; init; } = MoneyUnit.Minor;

    public string Currency { get; init; } = "EUR";

    // no structured line items: when receiptImage.type is this, image holds a receipt-printer layout to text-parse
    public string DigitalReceiptJsonType { get; init; } = "JSON";

    public string PrintSectionsPath { get; init; } = "documents.0.documents.0.printSections";

    /// <summary>CONFIRMED: the items section starts at a line carrying both of these.</summary>
    public IReadOnlyList<string> ItemsHeaderTokens { get; init; } = ["OMSCHRIJVING", "BEDRAG"];

    /// <summary>CONFIRMED: the items section ends at a line starting with this, and that line states the total.</summary>
    public string TotalPrefix { get; init; } = "Totaal";

    /// <summary>CONFIRMED: the payment method follows a line starting with this.</summary>
    public string PaidPrefix { get; init; } = "Betaald";

    // unconfirmed: a promotion is flagged by P in the second text field; no discount is derived
    // the layout prints a price already net of it, so one would be subtracted twice
    public string PromotionFlag { get; init; } = "P";

    /// <summary>CONFIRMED: a line whose description is this is a deposit. Charged, so it counts.</summary>
    public string DepositLabel { get; init; } = "STATIEGELD";

    // a store receipt's total exists only in its detail (one round trip each)
    // newest first: the oldest are cut and the pass reports itself incomplete
    public int StoreReceiptDetailBudget { get; init; } = 400;

    // false: an unparseable shape is provider_changed, since silently dropping a purchase reads as a shop never visited
    // true lets an operator keep syncing past a legacy image-only receipt while the parser is fixed
    public bool SkipUnreadableStoreReceipts { get; init; }

    // receiptSource ONLINE is the till record of an online order, its transaction id begins with that order's id
    // dropped only when that order was already emitted
    public bool DeduplicateOnlineStoreReceipts { get; init; } = true;

    public string OnlineReceiptSource { get; init; } = "ONLINE";

    // the Auth0 page carried id="username" on 2026-07-28, so it is first; selectors have a shelf life
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input#username",
        "input[name='username']",
        "input[name='email']",
        "input[autocomplete='username']",
        "input[type='email']",
    ];

    /// <summary>The page carried <c>id="password"</c> on 2026-07-28.</summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input#password",
        "input[name='password']",
        "input[autocomplete='current-password']",
        "input[type='password']",
    ];

    // Auth0 may split the credentials over two screens; short probe, since on a single page it always misses
    public int PasswordProbeMs { get; init; } = 2_000;

    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "button[type='submit']",
        "button[name='action']",
        "input[type='submit']",
        "button:has-text('Inloggen')",
        "button:has-text('Doorgaan')",
    ];

    // best effort: a missing consent wall is the normal case on a fresh profile
    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "button#accept-all",
        "button[data-testid='accept-all']",
        "#onetrust-accept-btn-handler",
        "button:has-text('Accepteer')",
        "button:has-text('Akkoord')",
    ];

    // hCaptcha (8 refs), reCAPTCHA (18) and Turnstile (4) ship with Auth0 Universal Login; which one a login meets is unknowable
    // none is a picture: telling them from an image captcha decides whether the human is asked something answerable
    public IReadOnlyList<string> InteractiveCaptchaSelectors { get; init; } =
    [
        "iframe[src*='hcaptcha']",
        "iframe[src*='recaptcha']",
        "iframe[src*='challenges.cloudflare.com']",
        "[data-hcaptcha-widget-id]",
        ".h-captcha",
        ".g-recaptcha",
        ".cf-turnstile",
    ];

    // unconfirmed on Jumbo; a plain image captcha is the one kind a relay can carry
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "img[alt*='captcha' i]",
        "img[src*='captcha' i]",
        "img[id*='captcha' i]",
        ".captcha img",
    ];

    // where a typed answer goes; without one a picture is as unanswerable as a widget
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
        "input[autocomplete='off'][name*='captcha' i]",
    ];

    /// <summary>UNCONFIRMED. Auth0 supports MFA and Jumbo may have it enabled.</summary>
    public IReadOnlyList<string> MfaCodeSelectors { get; init; } =
    [
        "input[name='code']",
        "input#code",
        "input[autocomplete='one-time-code']",
        "input[name='otp']",
    ];

    // narrow, credential-failure phrasings only: invalid_credentials is never retried
    // so a false one is permanent for the session
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        ":text('Verkeerde e-mail of wachtwoord')",
        ":text('onjuiste combinatie')",
        ":text('wachtwoord is onjuist')",
        ":text('Wrong email or password')",
    ];

    public int SelectorTimeoutMs { get; init; } = 15_000;

    public int ProbeMs { get; init; } = 500;

    public int LoginSettleSeconds { get; init; } = 180;

    // generous: covers a password manager, a Turnstile round and a code
    // the job budget is parked while a human thinks, so this is the bound
    public int LiveLoginSeconds { get; init; } = 900;

    public int SettlePollSeconds { get; init; } = 5;

    public int ChallengeSeconds { get; init; } = 300;

    // longer than a typed captcha: nobody relays anything, the wait covers someone noticing
    public int InteractiveCaptchaSeconds { get; init; } = 600;
}
