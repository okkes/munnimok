using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Amazon;

/// <summary>
/// Everything about amazon.nl an operator may need to correct without a
/// release.
///
/// The split matters here more than anywhere else in this service, because
/// amazon.nl has no API: every route below is CONFIRMED from the source of
/// three independently maintained scrapers, and every selector below is
/// UNCONFIRMED, because Amazon's rendered DOM has no published contract and
/// none of those three projects carries a Dutch fixture. A page's markup is a
/// guess with a shelf life; the routes are not.
///
/// Sources read as source, not README: <c>alexdlaird/amazon-orders</c>
/// (<c>constants.py</c>, <c>session.py</c>, <c>selectors.py</c>),
/// <c>philipmulcahy/azad</c> (<c>url.ts</c>, <c>order_list_page.ts</c>) and
/// <c>eshaffer321/amazon-monarch-sync</c>.
/// </summary>
public sealed record AmazonOptions
{
    // ---- routes: CONFIRMED -------------------------------------------------

    /// <summary>CONFIRMED. The Dutch storefront.</summary>
    public string BaseUrl { get; init; } = "https://www.amazon.nl";

    /// <summary>
    /// CONFIRMED. The order list, driven by <c>timeFilter</c> and
    /// <c>startIndex</c>. An unauthenticated GET of this path was observed to
    /// redirect to <c>/ax/claim?arb=…</c> and return 200, which is what proves
    /// the .nl site shares the .com sign-in entry.
    /// </summary>
    public string OrdersPath { get; init; } = "/your-orders/orders";

    /// <summary>
    /// CONFIRMED. Per-order detail. Recorded rather than used: it is the
    /// heavier and more dynamically rendered of the two item sources, so the
    /// print invoice below is preferred. It is here so an operator whose
    /// invoice route stops working has the alternative written down instead of
    /// having to rediscover it.
    /// </summary>
    public string OrderDetailsPath { get; init; } = "/gp/your-account/order-details";

    /// <summary>
    /// CONFIRMED, and preferred for line items and totals: the print-friendly
    /// invoice is the least dynamically rendered page Amazon serves, so it is
    /// the one least likely to change shape underneath us.
    /// </summary>
    public string InvoicePath { get; init; } = "/gp/css/summary/print.html";

    /// <summary>CONFIRMED. Best-effort sign-out.</summary>
    public string SignOutPath { get; init; } = "/gp/flex/sign-out.html";

    // ---- invoice documents -------------------------------------------------

    /// <summary>
    /// CONFIRMED live on 2026-08-06. The "Factuur" control on an order card,
    /// which links to the invoice list rather than to any document.
    /// </summary>
    /// <remarks>
    /// Matched on the PATH inside the href because that is the only durable
    /// part: the anchor carries no id, no class of its own, and its text is the
    /// storefront's language.
    /// </remarks>
    public IReadOnlyList<string> InvoiceListLinkSelectors { get; init; } =
    [
        "a[href*='/your-orders/invoice/popover']",
        "a[href*='invoice/popover']",
    ];

    /// <summary>
    /// CONFIRMED live on 2026-08-06. Every anchor in the fetched invoice list;
    /// which of them is a document is decided by
    /// <see cref="DocumentPathMarkers"/>, not by this.
    /// </summary>
    public IReadOnlyList<string> DocumentLinkSelectors { get; init; } =
    [
        "ul.invoice-list a",
        "ul a",
        "a",
    ];

    /// <summary>
    /// CONFIRMED live on 2026-08-06. What makes an anchor in that list a
    /// document rather than a decoy.
    /// </summary>
    /// <remarks>
    /// The fragment holds three kinds of link and only one is a file:
    /// <code>
    /// /gp/css/summary/print.html?orderID=...   Printbaar besteloverzicht
    /// /documents/download/{guid}/invoice.pdf   Factuur   (or Factuur 1, 2, 3, 4)
    /// /gp/help/contact/contact.html?orderID=.. Factuur aanvragen
    /// </code>
    /// The third is a support form for REQUESTING an invoice, and it is the
    /// reason this is a path marker rather than a label: it starts with the
    /// same word as the real thing, so matching on "Factuur" would hand
    /// somebody a contact page as their invoice.
    /// </remarks>
    public IReadOnlyList<string> DocumentPathMarkers { get; init; } = ["/documents/download/"];

    /// <summary>
    /// What a document must claim to be before its bytes are attached.
    ///
    /// Checked because the failure it prevents is silent: a session that has
    /// expired between the order list and the download gets an HTML sign-in
    /// page from a URL ending in <c>.pdf</c>, and a connector that trusted the
    /// extension would hand the user a "PDF" that opens to nothing. Amazon
    /// sends <c>application/pdf;charset=UTF-8</c> - a charset on a binary file,
    /// which is why the parameters are trimmed before this is compared.
    /// </summary>
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    /// <summary>
    /// Ceiling on documents fetched for one order.
    ///
    /// Amazon issues one invoice per SHIPMENT, and a real account had an order
    /// with four. Ten is well clear of anything observed while still bounding
    /// what one strange order can do to a fetch: each is around a hundred
    /// kilobytes and each costs its own paced request.
    /// </summary>
    public int MaxDocumentsPerOrder { get; init; } = 10;

    /// <summary>CONFIRMED. <c>timeFilter=year-YYYY</c>.</summary>
    public string TimeFilterTemplate { get; init; } = "year-{year}";

    /// <summary>
    /// UNCONFIRMED. Amazon has historically paged the order list ten at a
    /// time. The adapter does not depend on the number being right - it stops
    /// on a page that yields nothing new - but a wrong value costs extra
    /// requests against a defended site.
    /// </summary>
    public int PageSize { get; init; } = 10;

    /// <summary>Ceiling on pages walked per year, so a loop cannot run away.</summary>
    public int MaxPagesPerYear { get; init; } = 20;

    /// <summary>Ceiling on years walked in one pass.</summary>
    public int MaxYears { get; init; } = 6;

    /// <summary>
    /// The language override, DELIBERATELY OFF, and the most consequential
    /// decision in this adapter.
    ///
    /// <c>azad</c> appends <c>&amp;language=en_GB</c> to the order list URL on
    /// every non-English storefront, precisely to dodge locale-dependent
    /// parsing, and amazon.nl is not even in its table so it falls through to
    /// <c>en_US</c>. Copying that would be reasonable if we had the problem it
    /// solves. We do not:
    ///
    /// <list type="number">
    /// <item>The landmine it dodges is a money parser that assumes '.' is the
    /// decimal point. Ours declares the unit per field and hands the digits to
    /// <see cref="MoneyParser"/>, which resolves comma decimals and mixed
    /// grouping natively; <see cref="AmazonMoney"/> adds the only case it
    /// cannot decide alone. Forcing English would not make our numbers safer,
    /// and English grouping has an ambiguity of its own ("€1,234").</item>
    /// <item>The parameter is UNVERIFIED on <c>.nl</c> specifically - nobody
    /// has confirmed it takes there. If it silently does not, an adapter built
    /// for English labels meets a Dutch page and fails the way the reference
    /// fails: quietly, with plausible output.</item>
    /// <item>Dutch is what a Dutch account is actually served, so Dutch is
    /// what the fixtures record and what the parser is tested against. Every
    /// label list here also carries its English spelling, so flipping this
    /// knob - or Amazon deciding to serve English on its own - changes nothing
    /// about whether the adapter works.</item>
    /// </list>
    ///
    /// Set it to <c>en_GB</c> only after a live run has confirmed both that it
    /// takes and what it does to the rendered number format.
    /// </summary>
    public string? LanguageOverride { get; init; }

    // ---- money: DECLARED, never sniffed ------------------------------------

    /// <summary>
    /// The order total on the list card. Amazon publishes no number anywhere -
    /// there is no API - so every amount arrives as a rendered currency STRING
    /// in MAJOR units: "€ 1.234,56". Hence <see cref="MoneyUnit.MajorString"/>,
    /// declared here rather than inferred from the value, because a heuristic
    /// that guesses wrong corrupts financial data silently.
    /// </summary>
    public MoneyUnit OrderTotalUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>An invoice line's price. Same rendering, its own declaration.</summary>
    public MoneyUnit ItemAmountUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>An invoice's shipping, tax and grand-total rows.</summary>
    public MoneyUnit InvoiceTotalUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>A promotion, coupon or gift-card row. Its own field, its own declaration.</summary>
    public MoneyUnit DiscountAmountUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>
    /// ISO-4217, declared. Never inferred from the rendered symbol: "$" is at
    /// least four different currencies, and amazon.nl bills in euros.
    /// </summary>
    public string Currency { get; init; } = "EUR";

    /// <summary>
    /// The currency tokens an amount on this storefront may carry. Anything
    /// else in an amount stops the parse rather than being stripped - see
    /// <see cref="AmazonMoney"/>.
    /// </summary>
    public IReadOnlyList<string> CurrencyTokens { get; init; } = ["EUR", "€"];

    // ---- order list page: CONFIRMED 2026-08-05 -----------------------------
    //
    // Against a live amazon.nl account, captured and read rather than inferred.
    // Where the guess was already right it is now marked as confirmed rather
    // than rewritten; where it was wrong the old value is kept BELOW the real
    // one, because a candidate list costs nothing to carry and Amazon serves
    // more than one layout.

    /// <summary>
    /// CONFIRMED. One card per order on <c>/your-orders/orders</c>, ten to a
    /// page.
    /// </summary>
    public IReadOnlyList<string> OrderCardSelectors { get; init; } =
    [
        "div.order-card.js-order-card",
        "div.js-order-card",
        "li.order-card",
        "[data-order-id]",
    ];

    /// <summary>CONFIRMED. The order number inside a card.</summary>
    public IReadOnlyList<string> OrderIdSelectors { get; init; } =
    [
        ".yohtmlc-order-id span[dir='ltr']",
        ".yohtmlc-order-id",
        "bdi[dir='ltr']",
    ];

    /// <summary>
    /// CONFIRMED, and the sturdiest identifier on the page: every card carries
    /// <c>data-csa-c-slot-id="amzn1.yourorders.order-card.402-1122334-5566778"</c>.
    /// It survives a redesign that renames every class, and it is scoped to the
    /// card, which matters more than it sounds - see
    /// <see cref="AmazonOrderParser"/>, where reading an order number out of
    /// loose page text is the mistake this attribute exists to avoid.
    /// </summary>
    public IReadOnlyList<string> OrderIdAttributes { get; init; } =
        ["data-csa-c-slot-id", "data-order-id", "data-orderid"];

    /// <summary>
    /// CONFIRMED. The four facts in a card's header are label/value pairs in
    /// identical <c>li</c> elements - date, total, recipient, order number -
    /// distinguished by nothing but the small-caps label above each value.
    ///
    /// Which is why the date and the total are found by their LABEL below
    /// rather than by a selector. The only selectors that would separate these
    /// four are the grid's own column spans (<c>a-span3</c>, <c>a-span2</c>),
    /// and pinning a receipt's date to a layout column means a page that
    /// reflows starts reporting the total as the purchase date.
    /// </summary>
    public IReadOnlyList<string> OrderHeaderItemSelectors { get; init; } =
    [
        "li.order-header__header-list-item",
        ".order-header__header-list-item",
    ];

    /// <summary>CONFIRMED. "Bestelling geplaatst", above the date.</summary>
    public IReadOnlyList<string> OrderDateLabels { get; init; } =
        ["bestelling geplaatst", "besteld op", "order placed"];

    /// <summary>CONFIRMED. "Totaal", above the order total.</summary>
    public IReadOnlyList<string> OrderTotalLabels { get; init; } = ["totaal", "total"];

    /// <summary>
    /// The old layout's date, tried only when the labelled header yields
    /// nothing.
    /// </summary>
    public IReadOnlyList<string> OrderDateSelectors { get; init; } =
    [
        ".yohtmlc-order-date .a-color-secondary.value",
        ".order-date-invoice-item .a-color-secondary.value",
    ];

    /// <summary>
    /// The old layout's total. <c>#wfm-grand-total-amount</c> is Whole Foods,
    /// which does not exist on this storefront and costs nothing to keep.
    /// </summary>
    public IReadOnlyList<string> OrderTotalSelectors { get; init; } =
    [
        ".yohtmlc-order-total .a-color-secondary.value",
        ".yohtmlc-order-total span.value",
        "div.yohtmlc-order-total",
        "#wfm-grand-total-amount",
    ];

    /// <summary>
    /// CONFIRMED. A card links to <c>/your-orders/order-details?orderID=…</c>
    /// and to <c>/your-orders/invoice/popover?orderId=…</c> - note that Amazon
    /// spells the parameter both ways, one per route.
    /// </summary>
    public IReadOnlyList<string> OrderLinkSelectors { get; init; } =
    [
        "a[href*='orderID=']",
        "a[href*='orderId=']",
        "a[href*='order-details']",
    ];

    /// <summary>
    /// CONFIRMED. The pagination block, looked for BEFORE the next link.
    ///
    /// The distinction is what stops the walk fetching one page too many on
    /// every single year. When this block is present its "next" control is
    /// authoritative; when it is absent - Amazon has more than one order-list
    /// layout - the walk falls back to its own freshness guard rather than
    /// assuming the history ended.
    /// </summary>
    public IReadOnlyList<string> PaginationSelectors { get; init; } =
    [
        "ul.a-pagination",
        ".a-pagination",
        "div.pagination",
    ];

    /// <summary>
    /// CONFIRMED. <c>li.a-last</c> holds the next link, and carries the class
    /// <c>a-disabled</c> instead of a link on the final page.
    /// </summary>
    public IReadOnlyList<string> NextPageSelectors { get; init; } =
    [
        "li.a-last a",
        ".a-last a",
        "a.s-pagination-next",
    ];

    // ---- print invoice: CONFIRMED 2026-08-05 ------------------------------
    //
    // This page was a table when this adapter was written and is not one now.
    // It is built out of `data-component` attributes - orderId, itemTitle,
    // unitPrice, chargeSummary - which are a considerably better contract than
    // the class names around them: they name what a thing IS rather than how it
    // is laid out, and they survived the redesign that removed every <tr> the
    // old selectors were looking for.

    /// <summary>
    /// CONFIRMED, and NOT <c>purchasedItems</c> itself.
    ///
    /// There is exactly one <c>[data-component='purchasedItems']</c> per
    /// SHIPMENT, however many products are in it, so treating it as the line
    /// would collapse a two-product order into a single item priced at the
    /// first one - a receipt that looks entirely normal and is missing goods.
    ///
    /// Amazon gives the per-item container no <c>data-component</c> of its
    /// own, so this is the one place a layout class is load-bearing. It is
    /// scoped under the semantic parent to keep it honest, and the grid holds
    /// both halves an item needs: the thumbnail with its quantity badge, and
    /// the title with its price.
    /// </summary>
    public IReadOnlyList<string> InvoiceItemRowSelectors { get; init; } =
    [
        "[data-component='purchasedItems'] .a-fixed-left-grid-inner",
        "[data-component='purchasedItems']",
        "tr.item-row",
        "table.product-view tr.item-row",
    ];

    /// <summary>
    /// CONFIRMED. The product's name, as a link to its detail page.
    /// </summary>
    public IReadOnlyList<string> InvoiceItemNameSelectors { get; init; } =
    [
        "[data-component='itemTitle']",
        "td.item-title",
        "td[colspan]",
    ];

    /// <summary>
    /// CONFIRMED. Amazon renders a price TWICE inside <c>span.a-price</c> -
    /// once in <c>.a-offscreen</c> for a screen reader and once more with
    /// <c>aria-hidden</c> for everyone else - so the text of the container
    /// reads "€22,99€22,99".
    /// </summary>
    /// <remarks>
    /// The inner span is preferred for precision, NOT because the parse
    /// depends on it: <see cref="AmazonMoney"/> takes the first amount it finds
    /// and reads the doubled string correctly either way. Removing this entry
    /// changes no test, which is how that was established rather than assumed -
    /// so it is documented as defensive instead of as load-bearing.
    /// </remarks>
    public IReadOnlyList<string> InvoiceItemPriceSelectors { get; init; } =
    [
        "[data-component='unitPrice'] .a-offscreen",
        "[data-component='unitPrice']",
        "td.item-price",
        "td[align='right']",
    ];

    /// <summary>
    /// CONFIRMED, and NOT what it looks like.
    ///
    /// The invoice carries an empty <c>[data-component='quantity']</c> on every
    /// line, whatever the quantity is. The number a human sees is a badge drawn
    /// over the thumbnail, <c>.od-item-view-qty</c>, and it is absent entirely
    /// when the quantity is one.
    ///
    /// So the obvious selector is a decoy that always yields nothing, and a
    /// parser trusting it would report a two-pack as a single item at the unit
    /// price - halving the line and breaking reconciliation against a total
    /// that is right.
    /// </summary>
    public IReadOnlyList<string> InvoiceItemQuantitySelectors { get; init; } =
    [
        ".od-item-view-qty span",
        ".od-item-view-qty",
        "[data-component='quantity']",
    ];

    /// <summary>
    /// CONFIRMED. "Verkocht door: Amazon.nl". Read so the seller can be cut
    /// off the end of a product name rather than becoming part of it.
    /// </summary>
    public IReadOnlyList<string> InvoiceItemMerchantSelectors { get; init; } =
        ["[data-component='orderedMerchant']"];

    /// <summary>
    /// Optional, and absent on this storefront: Amazon's invoice states a unit
    /// price and a quantity, never a line total. Kept because a stated figure
    /// always beats a computed one wherever one does appear.
    /// </summary>
    public IReadOnlyList<string> InvoiceItemTotalSelectors { get; init; } = ["td.item-total"];

    /// <summary>
    /// UNCONFIRMED. Where an item cell stops being the product's name and
    /// starts being Amazon's commentary on it - the seller, the condition, the
    /// returns window. Cutting there keeps a receipt line readable and, more
    /// importantly, keeps it STABLE: a name that silently grows a new
    /// parenthetical changes the receipt's content hash and de-duplicates
    /// against nothing.
    /// </summary>
    public IReadOnlyList<string> ItemNameStopMarkers { get; init; } =
    [
        "verkocht door",
        "sold by",
        "leverancier:",
        "staat:",
        "condition:",
        "terugsturen kan tot",
    ];

    /// <summary>
    /// CONFIRMED. Every charge is one <c>.od-line-item-row</c>: a label column
    /// and a value column, uniform from "Subtotaal item(s)" to "Eindtotaal".
    /// </summary>
    public IReadOnlyList<string> InvoiceTotalRowSelectors { get; init; } =
    [
        "[data-component='chargeSummary'] .od-line-item-row",
        "#od-subtotals .od-line-item-row",
        ".od-line-item-row",
        "table.totals tr",
    ];

    /// <summary>
    /// CONFIRMED. The label half of a charge row, read separately from the
    /// value half so a label containing a number - and "Subtotaal item(s):"
    /// nearly does - cannot be mistaken for the amount.
    /// </summary>
    public IReadOnlyList<string> InvoiceTotalLabelSelectors { get; init; } = [".od-line-item-row-label"];

    /// <summary>CONFIRMED. The value half of a charge row.</summary>
    public IReadOnlyList<string> InvoiceTotalValueSelectors { get; init; } = [".od-line-item-row-content"];

    /// <summary>
    /// CONFIRMED, and the one part of this page that is not Amazon's own
    /// markup: the payment method is a separate front-end, mounted into
    /// <c>viewPaymentPlanSummaryWidget</c> and served from
    /// <c>cdn.view.eu.eu-west-1.iris.apx.amazon.dev</c>.
    ///
    /// It renders AFTER the page loads, which is why the adapter waits for it
    /// rather than reading whatever is there when navigation settles. It is
    /// also why its absence is treated as "no tail stated" and never as a
    /// broken page: the invoice is complete without it, and a widget that was
    /// slow is not a shape change.
    /// </summary>
    public IReadOnlyList<string> InvoicePaymentSelectors { get; init; } =
    [
        "[data-testid='payment-instrument']",
        "[data-component='viewPaymentPlanSummaryWidget']",
        ".payment-information",
        "#payment-information",
    ];

    /// <summary>CONFIRMED. "MasterCard", "Visa", "iDEAL".</summary>
    public IReadOnlyList<string> PaymentNameSelectors { get; init; } =
        ["[data-testid='payment-instrument-name']"];

    /// <summary>
    /// CONFIRMED. The last four digits, in their own element - so they are
    /// read rather than sliced out of "MasterCard •••• 7201" with a regex over
    /// bullet characters that vary by locale and font.
    /// </summary>
    public IReadOnlyList<string> PaymentTailSelectors { get; init; } =
        ["[data-testid='payment-instrument-number']"];

    // ---- invoice labels: Dutch first, English beside it --------------------
    //
    // Matched in the priority order the parser applies, which is why
    // "totaal vóór btw" and "subtotaal" are separate categories: "subtotaal"
    // contains "totaal" and "totaal vóór btw" contains "btw", so a naive
    // contains-match against a single list assigns both of them to the wrong
    // row and the receipt reconciles against a number that is not its total.

    public IReadOnlyList<string> SubtotalLabels { get; init; } =
        ["artikelen (subtotaal)", "subtotaal", "items (subtotal)", "subtotal"];

    public IReadOnlyList<string> TotalBeforeTaxLabels { get; init; } =
        ["totaal vóór btw", "totaal voor btw", "total before tax", "totaal excl. btw"];

    /// <summary>
    /// CONFIRMED, and the first entry is the one that matters: amazon.nl bills
    /// postage as "Porto- en verpakkingskosten", which contains no word this
    /// list had. Shipping was therefore categorised as Unknown and dropped
    /// from the receipt entirely - invisible on the captured order because it
    /// was €0,00, and on any order with real postage it would have removed a
    /// charge the customer paid and broken reconciliation by exactly that
    /// amount.
    /// </summary>
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

    /// <summary>
    /// CONFIRMED, and separated from <see cref="GrandTotalLabels"/> on purpose.
    ///
    /// The invoice states BOTH "Totaal:" and "Eindtotaal:" and they are not the
    /// same claim. Totaal is what the order came to; Eindtotaal is what was
    /// actually charged, and the two diverge the moment a gift card or a
    /// balance pays part of it. They were equal on every captured order, which
    /// is exactly the condition under which picking the wrong one goes
    /// unnoticed until somebody pays with a voucher.
    ///
    /// A receipt's total is what the customer was charged, because that is the
    /// number a bank transaction is matched against.
    /// </summary>
    public IReadOnlyList<string> FinalTotalLabels { get; init; } =
        ["eindtotaal", "grand total"];

    public IReadOnlyList<string> GrandTotalLabels { get; init; } =
        ["ordertotaal", "totaalbedrag", "totaal", "order total", "total"];

    /// <summary>
    /// The old text-scanning fallback for a card tail, kept only for a layout
    /// that states it in prose. The live page gives the four digits their own
    /// element - see <see cref="PaymentTailSelectors"/>.
    /// </summary>
    public IReadOnlyList<string> CardTailMarkers { get; init; } =
        ["eindigend op", "eindigt op", "ending in", "ending with"];

    /// <summary>
    /// CONFIRMED. The prices on a line are quoted INCLUDING BTW, so the
    /// invoice's tax row decomposes the total rather than adding to it and
    /// must not be emitted as a line of its own.
    ///
    /// The captured order settles it arithmetically: a headlamp at €12,99,
    /// quantity 2, against "Subtotaal item(s): € 21,47", "Btw: € 4,51" and
    /// "Eindtotaal: € 25,98". 2 × 12,99 = 25,98, which is the FINAL total, and
    /// 21,47 + 4,51 = 25,98 as well - so the subtotal is the tax-exclusive
    /// figure and the line price is not.
    ///
    /// Emitting the tax row as a line would therefore have made every Amazon
    /// receipt overshoot its own total by exactly the BTW, and it would still
    /// have looked like a receipt.
    /// </summary>
    public bool TaxIsIncludedInItemPrices { get; init; } = true;

    /// <summary>
    /// UNCONFIRMED. What an order list with nothing on it says. Without this
    /// an empty history and a list whose card selector has expired look
    /// identical, and the second one must not be reported as "you have no
    /// orders".
    /// </summary>
    public IReadOnlyList<string> EmptyHistoryMarkers { get; init; } =
    [
        "geen bestellingen",
        "Je hebt geen bestellingen geplaatst",
        "niets besteld",
        "no orders",
        "You have not placed any orders",
    ];

    // ---- sign-in page: UNCONFIRMED ----------------------------------------

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

    /// <summary>UNCONFIRMED. The button on the e-mail screen of the two-step form.</summary>
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
    [
        "input#continue",
        "#continue input[type='submit']",
        "input[type='submit'][aria-labelledby*='continue']",
    ];

    /// <summary>UNCONFIRMED. The button on the password screen.</summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "input#signInSubmit",
        "#signInSubmit input[type='submit']",
        "input[type='submit']",
        "button[type='submit']",
    ];

    /// <summary>
    /// UNCONFIRMED, and deliberately narrow: only phrasings that state a
    /// CREDENTIAL failure. <c>invalid_credentials</c> is never retried by
    /// anything, so a false one is permanent for that session and sends
    /// somebody to reset a password that was fine. A generic Amazon error box
    /// also carries "There was a problem", which is not evidence of anything.
    /// </summary>
    public IReadOnlyList<string> LoginErrorSelectors { get; init; } =
    [
        "#auth-password-invalid-password-alert",
        "#auth-email-invalid-claim-alert",
        "#auth-error-message-box .a-alert-content",
    ];

    /// <summary>UNCONFIRMED. The one-time code box.</summary>
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

    /// <summary>
    /// UNCONFIRMED. How the page says the code was delivered, resolved by the
    /// visible words rather than by markup: an id can be renamed by a
    /// redesign, but the sentence telling somebody where to look for their
    /// code cannot change without the page changing meaning.
    ///
    /// Probed app first, then sms, then e-mail, and null when none of them
    /// matches. The e-mail candidates come last because an OTP page often
    /// prints the account's own address in its header, and matching that would
    /// tell somebody to watch a mailbox while their code sits in an app.
    /// </summary>
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

    /// <summary>
    /// UNCONFIRMED. Amazon showing that it has stopped talking to us for a
    /// reason that is not a password: a locked account, an "approve this
    /// sign-in" wall we cannot reach. Blocked, never invalid_credentials.
    /// </summary>
    public IReadOnlyList<string> RefusalSelectors { get; init; } =
    [
        "#auth-account-locked-alert",
        "#auth-suspended-alert",
    ];

    /// <summary>UNCONFIRMED. A consent wall left standing covers the form.</summary>
    public IReadOnlyList<string> ConsentSelectors { get; init; } =
    [
        "#sp-cc-accept",
        "input#sp-cc-accept",
        "button[name='accept']",
    ];

    // ---- bot protection ----------------------------------------------------

    /// <summary>
    /// UNCONFIRMED. The walls that cannot be relayed: AWS WAF's JS challenge,
    /// and the ACIC challenge page at <c>/ax/aaut/verify/ap/challenge</c> whose
    /// container the reference names <c>#aa-challenge-page-captcha-container</c>.
    ///
    /// These are widgets, not pictures. They want drags and tile clicks and
    /// mint their token inside their own JavaScript, so no screenshot and no
    /// typed answer can pass one however faithfully the page is photographed -
    /// which is why they route to somebody sitting at the browser or to
    /// <c>blocked_by_provider</c>, and never to a solving service. The
    /// reference ships integrations for three paid solvers. We ship none.
    /// </summary>
    /// <summary>
    /// CONFIRMED 2026-08-05, and the first four entries are the wall this
    /// provider actually puts up.
    ///
    /// A headless sign-in with correct credentials does not reach the order
    /// list: it lands on <c>/ap/cvf/request</c> - Amazon's Customer
    /// Verification Flow, headed "Bevestig je identiteit" - which mounts an
    /// AAmation challenge inside an iframe. The same sequence in a headed
    /// browser goes straight through, so this is a decision Amazon makes about
    /// the CLIENT rather than about the credentials.
    ///
    /// None of the previously guessed selectors match that page. So the wall
    /// was invisible: the settle loop polled a challenge it could not see for
    /// four minutes and then reported the provider as changed, which is both
    /// wrong and unactionable - the site had changed nothing and a person could
    /// have passed the puzzle in ten seconds.
    /// </summary>
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

    /// <summary>
    /// CONFIRMED. The verification flow's own path. Checked beside the
    /// selectors because it is the one part of that page Amazon cannot rename
    /// without moving the endpoint, and because a page still drawing its
    /// iframe is already unmistakably a wall by its URL.
    /// </summary>
    public IReadOnlyList<string> ChallengeUrlMarkers { get; init; } = ["/ap/cvf/", "/ax/aaut/"];

    /// <summary>
    /// CONFIRMED 2026-08-06. What a CANCELLED order's invoice says, and the
    /// whole page it says it on.
    /// </summary>
    /// <remarks>
    /// A cancelled order is not a receipt. Nothing was bought and nothing was
    /// paid, which is exactly why its list card states no total and its invoice
    /// carries no lines and no charge summary - and why an adapter that reads
    /// those absences as a shape change fails the entire fetch over an order
    /// that is behaving perfectly correctly. One in nineteen on a real account.
    ///
    /// The full sentence rather than the word: "geannuleerd" on its own also
    /// appears where a single ITEM in a live order was cancelled, and skipping
    /// that order would lose a real purchase.
    /// </remarks>
    public IReadOnlyList<string> CancelledOrderMarkers { get; init; } =
    [
        "deze bestelling is geannuleerd",
        "bestelling is geannuleerd",
        "this order was cancelled",
        "this order was canceled",
        "order has been cancelled",
        "order has been canceled",
    ];

    // ---- the passkey nudge: CONFIRMED 2026-08-06 --------------------------
    //
    // The thing that actually stopped every live login.
    //
    // The password is ACCEPTED. Amazon then interposes a passkey enrolment
    // page - "Passkey setup" at /ax/claim/webauthn/nudge - and the sign-in does
    // not finish until somebody dismisses it. It is not an error, not a
    // captcha, not a one-time code and not the order list, so the settle loop
    // had no name for it and simply waited: four minutes of polling a page that
    // was one button away from done.
    //
    // It is served to the AGENT and not to a plain desktop run, which is why
    // three probes walked past it and the pooled browser never did.

    /// <summary>CONFIRMED. The nudge's own path.</summary>
    public IReadOnlyList<string> PasskeyNudgeUrlMarkers { get; init; } = ["/ax/claim/webauthn/nudge"];

    /// <summary>
    /// CONFIRMED. The controls that DECLINE, and only those.
    ///
    /// The page offers six buttons and two of them - "set up a passkey" and
    /// "sign in with an existing passkey" - would register a new credential
    /// against the user's Amazon account. A connector adding a factor to
    /// somebody's account in order to read their receipts has done something
    /// far larger than it was asked to, so those two are not in this list and
    /// must never be: a candidate list is tried in order until one matches, and
    /// a wrong entry here is a permanent change to an account.
    ///
    /// The skip variants are here because the nudge frequently errors on its
    /// own - "Hmm, er is iets fout gegaan", when the device already holds a
    /// passkey - and then renders those instead of the plain "Niet nu".
    /// </summary>
    public IReadOnlyList<string> PasskeyDeclineSelectors { get; init; } =
    [
        "input[aria-labelledby*='nudge-not-now']",
        "input[aria-labelledby*='nudge-skip-client-error']",
        "input[aria-labelledby*='nudge-skip-server-error']",
        "input[aria-labelledby*='nudge-skip']",
    ];

    /// <summary>
    /// UNCONFIRMED. The legacy OCR captcha - a picture and a box - which is
    /// the one kind a relay can actually carry to the account's owner.
    /// </summary>
    public IReadOnlyList<string> ImageCaptchaSelectors { get; init; } =
    [
        "#auth-captcha-image",
        "img[src*='captcha']",
        "form[action*='validateCaptcha'] img",
    ];

    /// <summary>UNCONFIRMED. Where a typed captcha's answer goes.</summary>
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input#auth-captcha-guess",
        "input#captchacharacters",
        "input[name='field-keywords']",
    ];

    /// <summary>
    /// UNCONFIRMED. Markers in the raw body that name a challenge no selector
    /// caught. <c>window.gokuProps</c> is how the reference detects an AWS WAF
    /// JS challenge; the token it yields is the <c>aws-waf-token</c> cookie.
    /// </summary>
    public IReadOnlyList<string> ChallengeBodyMarkers { get; init; } =
    [
        "gokuProps",
        "aws-waf-token",
        "/errors/validateCaptcha",
        "opfcaptcha",
        "Enter the characters you see below",
        "Voer de tekens in die je hieronder ziet",
    ];

    /// <summary>
    /// UNCONFIRMED. A hard refusal rather than a challenge: no puzzle is
    /// offered and there is nothing for a human to do. Reported as
    /// <c>blocked_by_provider</c> even on a 200, because a bot wall that
    /// answers 200 is still a bot wall. Cloudflare and Akamai are listed for
    /// completeness - Amazon runs its own - so that a CDN change in front of
    /// the storefront is diagnosed rather than parsed.
    /// </summary>
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

    /// <summary>
    /// UNCONFIRMED. URL fragments that mean we are looking at the sign-in
    /// chain rather than at data. During a fetch that is a dead session.
    /// </summary>
    public IReadOnlyList<string> SignInUrlMarkers { get; init; } = ["/ap/signin", "/ax/claim", "/ap/cvf"];

    /// <summary>UNCONFIRMED. URL fragments that mean the browser is on the order history.</summary>
    public IReadOnlyList<string> SignedInUrlMarkers { get; init; } =
        ["/your-orders/orders", "/gp/css/order-history", "/gp/your-account/order-history"];

    /// <summary>
    /// The cookies that mean somebody is signed IN, on this storefront.
    /// </summary>
    /// <remarks>
    /// This said <c>["x-main"]</c>, described as CONFIRMED from the reference's
    /// <c>COOKIES_SET_WHEN_AUTHENTICATED</c>. It was confirmed - for
    /// amazon.COM. The Dutch storefront suffixes its cookies with its own
    /// marketplace: <c>x-acbnl</c>, <c>at-acbnl</c>, <c>sess-at-acbnl</c>.
    /// amazon.nl never sets <c>x-main</c> at all, so a login that worked
    /// perfectly - puzzle passed, order list on screen - was rejected at the
    /// last gate for leaving behind a cookie this storefront does not have.
    ///
    /// The list is deliberately short. A signed-OUT visit to amazon.nl already
    /// leaves <c>session-id</c>, <c>ubid-acbnl</c>, <c>lc-acbnl</c> and
    /// <c>sst-acbnl</c>, so any of those here would wave through a login that
    /// failed - which is worse than this bug was, because it would seal a
    /// bundle that cannot fetch anything.
    ///
    /// Both captured live on 2026-08-06; the two jars are fixtures, and the
    /// test asserts the anonymous one is refused.
    ///
    /// <c>x-main</c> stays last: <see cref="BaseUrl"/> is an operator setting,
    /// and someone pointing this at .com needs it.
    /// </remarks>
    public IReadOnlyList<string> AuthCookieNames { get; init; } =
        ["x-acbnl", "at-acbnl", "sess-at-acbnl", "x-main"];

    /// <summary>
    /// Statuses that mean amazon.nl is REFUSING us rather than failing.
    ///
    /// 429 is in this set deliberately. The platform's default reading of 429
    /// is <c>rate_limited</c>, which is retriable and tells the consumer to
    /// wait a bit; from a bot wall it is not a queueing hint, it is a refusal,
    /// and retrying into it is how a session gets escalated to a hard block.
    /// 503 is here for the same reason: Amazon's interstitials answer 503 far
    /// more often than they answer 403.
    ///
    /// 500 is deliberately NOT here. A genuine server error is
    /// <c>provider_unavailable</c> and retriable; calling it a block would
    /// tell a user to stop using a connection that is merely having a bad
    /// minute.
    /// </summary>
    public IReadOnlySet<int> BlockStatuses { get; init; } =
        new HashSet<int> { 403, 429, 502, 503, 504, 511 };

    // ---- patience ----------------------------------------------------------

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// <summary>
    /// Short: on Amazon's two-screen sign-in this probe always misses on the
    /// first screen, and that wait is pure latency on every single login.
    /// </summary>
    public int PasswordProbeMs { get; init; } = 1_500;

    /// <summary>Short probes: the settle loop runs them on every pass.</summary>
    public int ProbeMs { get; init; } = 500;

    /// <summary>How long the login may take to resolve into an order page, an error or a wall.</summary>
    public int LoginSettleSeconds { get; init; } = 240;

    public int RedirectPollSeconds { get; init; } = 5;

    /// <summary>How long the human has to answer a relayed image captcha.</summary>
    public int ChallengeSeconds { get; init; } = 300;

    /// <summary>
    /// How long the human has to pass a WAF or ACIC widget in the browser
    /// window in front of them. Longer than a typed captcha on purpose:
    /// nobody is relaying anything, so the wait has to cover someone noticing
    /// and walking back to their desk.
    /// </summary>
    public int InteractiveCaptchaSeconds { get; init; } = 600;

    /// <summary>
    /// How long a streamed sign-in may stay open. Generous, and for the same
    /// reason it is on every other provider that streams: the person is being
    /// asked to pass a puzzle, and possibly to find a password manager or wait
    /// for a code afterwards. The job budget stops counting while parked on
    /// the challenge.
    /// </summary>
    public int LiveLoginSeconds { get; init; } = 600;

    /// <summary>How long the human has to read a one-time code and type it back.</summary>
    public int CodeChallengeSeconds { get; init; } = 300;

    /// <summary>UNCONFIRMED. Amazon's OTP is six digits.</summary>
    public int CodeLength { get; init; } = 6;
}
