using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Coolblue;

/// <summary>
/// Everything about Coolblue an operator may need to correct without a
/// release.
///
/// CONFIRMED from Coolblue's own public OIDC discovery document and the live
/// unauthenticated redirect chain (2026-07-28, recorded in
/// docs/research/retailers-priority-b.md §2): the issuer, the authorize and
/// token endpoints, the client id, the redirect URI, the scope list, S256
/// PKCE, and the <c>refresh_token</c> grant. That is the whole front door and
/// it is the best-behaved of any retailer researched - no bot wall, no captcha
/// on the login form.
///
/// CONFIRMED from a live signed-in capture (2026-08-07): the order pages, the
/// pagination, the invoice links, the labels, and the fact that settles the
/// shape of this whole adapter - THERE IS NO ORDER API. The account is a
/// Next.js app that server-renders its orders into ~600KB of HTML, and the
/// same capture recorded not one JSON response carrying an order.
/// <para>
/// This file used to carry forty-odd UNCONFIRMED property names for a JSON
/// payload - <c>OrderPaths</c>, <c>IdNames</c>, <c>ItemUnitPriceNames</c> and
/// the rest - behind a safety catch that refused to fetch until a human
/// captured the real endpoint. The human did. There is no endpoint, so those
/// options could never be filled in by anyone, and configuration that can
/// never be true is worse than none: it reads as live.
/// </para>
/// </summary>
public sealed record CoolblueOptions
{
    // ---- identity: CONFIRMED from the discovery document -------------------

    /// <summary>
    /// CONFIRMED: <c>authorization_endpoint</c>.
    ///
    /// Note the asymmetry with <see cref="TokenUrl"/> and do not "fix" it.
    /// Coolblue authorizes under <c>/connect/</c> (IdentityServer's own
    /// convention) and takes tokens under <c>/oauth/</c>. Both spellings came
    /// out of the same discovery document; assuming <c>/connect/token</c>
    /// because the authorize call lives under <c>/connect/</c> is a 404 that
    /// costs a whole login.
    /// </summary>
    public string AuthorizeUrl { get; init; } = "https://accounts.coolblue.nl/connect/authorize";

    /// <summary>
    /// Where the login starts, and it is deliberately the PROTECTED PAGE rather
    /// than any login form.
    ///
    /// CONFIRMED live 2026-08-07: a signed-out GET of the orders page answers
    /// <c>307</c> to <c>https://www.coolblue.nl/inloggen?returnUrl=...</c>, and
    /// Coolblue drives its own OIDC flow from there - its own state, its own
    /// PKCE verifier, its own callback - and brings the browser back to the
    /// page that was asked for.
    /// <para>
    /// This adapter used to open <see cref="AuthorizeUrl"/> itself with a PKCE
    /// pair and a state of its own minting, which is not a journey any shopper
    /// takes. The sign-in succeeded and the SITE session never did: Coolblue's
    /// callback page had no verifier for a flow it did not start, so
    /// www.coolblue.nl stayed anonymous and the first fetch was handed the
    /// sign-in form. Letting the site run its own login is what fixes that, and
    /// it is the same reason bol's login starts at bol's account page.
    /// </para>
    /// </summary>
    public string LoginStartUrl { get; init; } = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

    /// <summary>
    /// What a signed-in URL looks like: the account area, on the shop's own
    /// host. Reached only with a session, which is what makes arriving there
    /// the proof - and this is the ONLY proof available.
    ///
    /// COOKIE PRESENCE PROVES NOTHING ON THIS PROVIDER. A signed-OUT request to
    /// any Coolblue page is answered with <c>Set-Cookie: Coolblue-Session=...</c>
    /// alongside <c>cbvid</c>, <c>_csrfSecret</c> and
    /// <c>assignedVariations</c> - CONFIRMED live 2026-08-07 against a plain
    /// curl carrying no credentials at all. A jar full of coolblue.nl cookies
    /// is simply what an anonymous visitor holds.
    /// <para>
    /// This adapter's login checked for exactly that, passed instantly on an
    /// anonymous session, and sealed a bundle whose first fetch was handed the
    /// sign-in form. Landing on a page that cannot be reached without a session
    /// is the difference between having cookies and being signed in.
    /// </para>
    /// </summary>
    public string SignedInUrlMarker { get; init; } = "/mijn-coolblue-account";

    /// <summary>
    /// The host the sign-in form lives on. While the browser is still here,
    /// nothing has happened yet - and it costs no round trip to know that.
    /// </summary>
    public string LoginHostMarker { get; init; } = "accounts.coolblue.nl";

    /// <summary>
    /// The path Coolblue redirects an unauthenticated visitor to. Being here is
    /// also "not signed in yet", and it is a different host from the form.
    /// </summary>
    public string LoginPathMarker { get; init; } = "/inloggen";

    /// <summary>Cookies from this domain (and its subdomains) travel with every fetch.</summary>
    public string CookieDomainSuffix { get; init; } = "coolblue.nl";

    /// <summary>
    /// How long to wait for the browser to arrive back in the account area
    /// after the credentials go in.
    ///
    /// Coolblue's own OIDC round trip happens in here - form post, callback,
    /// session upgrade, redirect to the page originally asked for - and a human
    /// answering a challenge may be in the middle of it.
    /// </summary>
    public int SessionSettleSeconds { get; init; } = 20;

    /// <summary>How long between looks at where the browser has got to.</summary>
    public int SessionPollMs { get; init; } = 500;

    /// <summary>
    /// How long Coolblue is given to redirect a signed-out browser away from
    /// the account area before the check decides it will not.
    /// </summary>
    /// <remarks>
    /// A DIFFERENT NUMBER FROM <see cref="SessionSettleSeconds"/> AND FOR THE
    /// OPPOSITE REASON. That one is how long the shop's own OIDC round trip -
    /// form post, callback, session upgrade, redirect back - may take AFTER
    /// credentials go in, with a human possibly mid-challenge. This is how long
    /// a single 307 takes on a browser that is doing nothing else, and it is
    /// paid in full by every browser that really is signed in, because the
    /// redirect it waits for never comes.
    /// <para>
    /// THE WINDOW EXISTS BECAUSE AN ADDRESS READ THE INSTANT A NAVIGATION
    /// RETURNS IS NOT PROOF. ASN cost this platform exactly that on
    /// 2026-09-19 - its overview answered a signed-out browser at the overview
    /// address and moved to the sign-in page a moment later - and DUO's portal
    /// does the same with its SAML chain. Nothing has timed Coolblue's own
    /// redirect, so this is a judgment; being wrong short is the direction that
    /// hurts, because this shop offers no second witness at all. Its cookies
    /// certainly are not one: a signed-OUT request to any Coolblue page is
    /// answered with <c>Set-Cookie: Coolblue-Session=...</c>, CONFIRMED live
    /// 2026-08-07 against a plain curl carrying no credentials.
    /// </para>
    /// </remarks>
    public int SignedOutBounceSeconds { get; init; } = 10;


    // ---- orders: server-rendered HTML, confirmed live -----------------------

    /// <summary>
    /// The human-facing order list. CONFIRMED live 2026-08-07, and CORRECTED:
    /// this was <c>/mijn-coolblue-account/bestellingen</c>, which 307s.
    ///
    /// The real path is <c>orderoverzicht</c>. A signed-in visit to
    /// <c>/bestellingen</c> redirects to <c>/mijn-coolblue-account</c>, which
    /// is the account home rather than the orders, so the old value would have
    /// sent a capture - or a reader - to the wrong page and shown it something
    /// plausible.
    /// </summary>
    /// <remarks>
    /// Also confirmed on the same capture, and all of it new:
    /// <list type="bullet">
    /// <item>Pagination is <c>?page=2</c>, on this URL.</item>
    /// <item>One order's details are at <c>{this}/{orderId}</c>, where the id
    /// is an eight-digit number.</item>
    /// <item>THE ORDERS ARE SERVER-RENDERED HTML. There is no JSON call behind
    /// this page at all, which is why this adapter reads markup.</item>
    /// <item>Every order on the list carries a DIRECT invoice link:
    /// <c>/mijn-coolblue-account/mijn-factuur/{orderId}/{invoiceId}</c> with a
    /// <c>download="{invoiceId}.pdf"</c> attribute. Eleven of them across ten
    /// orders, so an order can have more than one - the same shape Amazon and
    /// bol both turned out to have.</item>
    /// </list>
    /// That last one is a gift by comparison: Amazon's document URL is an
    /// opaque guid reachable only through an AJAX fragment, and bol's needs a
    /// per-order details page. Coolblue puts it in the list markup.
    /// </remarks>
    public string OrdersPageUrl { get; init; } = "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht";

    /// <summary>
    /// One order's own page: <c>{OrdersPageUrl}/{orderId}</c>. CONFIRMED live
    /// 2026-08-07.
    ///
    /// This is the expensive half of a Coolblue fetch and there is no way
    /// around it. The overview states NO MONEY AT ALL - one euro sign on a
    /// 610KB page, inside a translations blob - so a receipt's total exists
    /// only here, and a record therefore costs a page load of well over half a
    /// megabyte. Every other provider in this service reads its totals off the
    /// list.
    /// </summary>
    public string OrderDetailsUrlTemplate { get; init; } =
        "https://www.coolblue.nl/mijn-coolblue-account/orderoverzicht/{orderId}";

    /// <summary>
    /// The words in front of the order number on a details page.
    ///
    /// Used to prove the page that came back is the order that was asked for,
    /// which matters more here than it looks: <c>/bestellingen</c> silently
    /// redirects to the account home, so this provider is known to answer a
    /// wrong-but-plausible page rather than a 404. Reading a total off the
    /// wrong page would put one order's money on another's receipt.
    /// </summary>
    public string OrderNumberLabel { get; init; } = "Ordernummer";

    // ---- money: DECLARED, never sniffed -------------------------------------

    /// <summary>
    /// The unit an order's stated total is written in.
    ///
    /// CONFIRMED <see cref="MoneyUnit.MajorString"/> from the live capture:
    /// the details page writes "463,-" and "12,50", which are major units as a
    /// string. It is still DECLARED rather than sniffed, and still nullable,
    /// because the whole discipline is that nobody reads a unit off a value's
    /// shape - "463" and "463,-" are indistinguishable to a parser and mean
    /// different things to a bank.
    /// <para>
    /// Null refuses the fetch outright rather than assuming euros.
    /// Reconciliation cannot save us here: it catches an inconsistent PAIR, not
    /// a consistently wrong one, so a total misread as minor units is a
    /// hundredth of the real money, silently, forever.
    /// </para>
    /// </summary>
    public MoneyUnit? TotalUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>
    /// The unit a LINE amount is written in. Its own declaration, because an
    /// API that states a total in one unit and its lines in another is not
    /// hypothetical - and here they are read from two different parts of the
    /// same page, which is no guarantee at all.
    /// </summary>
    public MoneyUnit? ItemUnit { get; init; } = MoneyUnit.MajorString;

    /// <summary>
    /// The heading above the ordered products. CONFIRMED live 2026-08-07.
    ///
    /// A label again, for the same reason every other hook here is one: the
    /// classes around it are CSS-in-JS hashes with a shelf life of one deploy,
    /// and the words a human reads are not.
    /// </summary>
    public IReadOnlyList<string> ItemsSectionLabels { get; init; } = ["Je bestelling"];

    /// <summary>
    /// The heading that ends it. CONFIRMED live: the products are followed by
    /// "Adres- en betaalinformatie", and after that come delivery addresses and
    /// a long tail of accessory recommendations - each with its own heading and
    /// its own prices. Reading past this point would put somebody else's
    /// suggestions on the receipt.
    /// </summary>
    public IReadOnlyList<string> ItemsSectionEndLabels { get; init; } =
        ["Adres- en betaalinformatie", "Betalingsdetails"];

    /// <summary>
    /// The path every ordered product links to. What tells a product heading
    /// apart from any other heading that might appear in the section.
    /// </summary>
    public string ProductHrefMarker { get; init; } = "/product/";

    /// <summary>The declared line unit, or a refusal. See <see cref="TotalUnitOrThrow"/>.</summary>
    public MoneyUnit ItemUnitOrThrow() =>
        ItemUnit ?? throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: coolblue's line money unit is not declared, so no item can be read. " +
            "Set CoolblueOptions.ItemUnit from a capture: '399,-' and '12,50' are MajorString.");

    /// <summary>
    /// Fallback ISO-4217 when the payload states none. Never inferred from a
    /// symbol: "€" is unambiguous but "$" is at least four currencies, and a
    /// fallback that only works for one of them is a trap.
    /// </summary>
    public string Currency { get; init; } = "EUR";

    /// <summary>
    /// CONFIRMED live 2026-08-07. The label the total sits beside on an order's
    /// details page.
    ///
    /// A LABEL and not a selector, for the same reason Amazon's header reader
    /// uses one: the surrounding classes are CSS-in-JS hashes that change on
    /// every deploy, while a word a human reads cannot change without the page
    /// changing meaning.
    /// </summary>
    public IReadOnlyList<string> TotalLabels { get; init; } = ["Totaalbedrag", "Totaal"];

    /// <summary>
    /// The site root, for turning the relative hrefs the pages carry into
    /// addresses a client can fetch. CONFIRMED.
    /// </summary>
    public string BaseUrl { get; init; } = "https://www.coolblue.nl";

    /// <summary>
    /// CONFIRMED live 2026-08-07. The words in front of an order's date on the
    /// list card.
    /// </summary>
    public string OrderedOnLabel { get; init; } = "Besteld op";

    /// <summary>
    /// The declared unit, or a refusal.
    ///
    /// <see cref="TotalUnit"/> is nullable and null does NOT mean euros - the
    /// whole point of this platform's money handling is that a unit is declared
    /// rather than guessed from a value's shape. A page writing "463,-" and one
    /// writing "463" are indistinguishable to a parser and mean different
    /// things to a bank.
    /// </summary>
    public MoneyUnit TotalUnitOrThrow() =>
        TotalUnit ?? throw ConnectorException.ProviderChanged(
            $"{CoolblueAdapter.ProviderId}: coolblue's money unit is not declared, so no total can be read. " +
            "Set CoolblueOptions.TotalUnit from a capture: '463,-' and '12,50' are MajorString.");

    // ---- the walk ----------------------------------------------------------

    /// <summary>
    /// The pagination parameter. CONFIRMED live 2026-08-07: the overview's own
    /// paging control links to <c>?page=2</c>, <c>?page=3</c> and <c>?page=7</c>
    /// on this account, so a full history is seven page loads before a single
    /// order is read.
    /// </summary>
    public string PageParam { get; init; } = "page";

    /// <summary>
    /// Ceiling on overview pages walked in one pass, so a pagination parameter
    /// Coolblue stops honouring cannot become an unbounded loop.
    ///
    /// The walk normally stops long before this - on an empty page, on a page
    /// that repeats the last one, or on the first page entirely older than the
    /// window. Twenty is roughly three times the deepest account seen.
    /// </summary>
    public int MaxPages { get; init; } = 20;

    /// <summary>
    /// Ceiling on invoice documents attached to one order.
    ///
    /// Ten, the same as bol's and Amazon's. Of the twenty orders on the two
    /// captured pages, seventeen had one invoice and three had two, so this is
    /// a guard against a pathological order rather than a limit anyone meets.
    /// </summary>
    public int MaxDocumentsPerOrder { get; init; } = 10;

    /// <summary>
    /// Media types an invoice may claim. Read through
    /// <c>ContentType.MediaType</c>, which has already dropped any charset -
    /// bol serves its PDFs as <c>application/pdf;charset=UTF-8</c>, and
    /// comparing the raw header would reject every one of them.
    /// </summary>
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    /// <summary>
    /// <c>%PDF</c>. The file's own claim, as opposed to the server's - and the
    /// half that catches a 200 that is really an HTML error page wearing a PDF
    /// content type, which is exactly what a session dying mid-fetch produces.
    /// </summary>
    public IReadOnlyList<byte> DocumentMagic { get; init; } = [0x25, 0x50, 0x44, 0x46];

    /// <summary>
    /// The browser this fetch claims to be, sent because the account pages are
    /// served to browsers and a bare .NET default is a needless difference.
    /// </summary>
    public string UserAgent { get; init; } =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/141.0.0.0 Safari/537.36";

    /// <summary>Coolblue's pages are locale-routed and the account is Dutch.</summary>
    public string AcceptLanguage { get; init; } = "nl-NL,nl;q=0.9,en;q=0.8";

    /// <summary>
    /// Text that says an HTML body is a bot wall rather than the page asked
    /// for. Matched case-insensitively.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT the same list as <see cref="BlockPageMarkers"/>, which
    /// contains "cloudfront" - every Coolblue page is served by CloudFront and
    /// most mention it, so guarding a 200 with that list would call every
    /// successful fetch a block. These are phrases only an interstitial uses.
    /// </remarks>
    public IReadOnlyList<string> BotWallMarkers { get; init; } =
    [
        "The request could not be satisfied",
        "Request blocked",
        "Access Denied",
        "Generated by cloudfront",
        "captcha-delivery.com",
        "geo.captcha-delivery",
    ];

    /// <summary>
    /// Text that says an HTML body is the sign-in page rather than an account
    /// page - which is <c>session_expired</c>, not a block, and the two want
    /// opposite things from the user.
    /// </summary>
    /// <remarks>
    /// Narrower than <see cref="LoginPageMarkers"/> on purpose, and for the
    /// reason bol needed the same split: an account page legitimately links to
    /// the login host in its own navigation - "Uitloggen" is on every one of
    /// them - so the broad list would raise session_expired on a page that
    /// worked perfectly. These are markers of the sign-in FORM.
    /// </remarks>
    public IReadOnlyList<string> AccountPageLoginMarkers { get; init; } =
    [
        "name=\"csrf\"",
        "autocomplete=\"current-password\"",
    ];

    // ---- login page --------------------------------------------------------

    /// <summary>
    /// The identifier box. <c>username</c> is the name the login form's own
    /// markup uses (OBSERVED in the 2026-07-28 capture of the authorize
    /// redirect's landing page, alongside hidden <c>csrf</c>, <c>view</c> and
    /// <c>view_context</c> fields), so it leads the list; the rest are
    /// candidates behind it.
    /// </summary>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
    [
        "input[name='username']",
        "input#username",
        "input[autocomplete='username']",
        "input[type='email']",
        "input[name='email']",
    ];

    /// <summary>
    /// The password box, and NOT the decoy sitting next to it.
    ///
    /// CONFIRMED live 2026-08-07, and it overturns what this said before. The
    /// sign-in screen carries exactly ONE input of type password, and it is a
    /// DECOY that Coolblue added on purpose - their own markup says so:
    /// <code>
    /// &lt;!-- unless we add a hidden password field to the html --&gt;
    /// &lt;div data-hidden aria-hidden="true"&gt;
    ///   &lt;input tabindex="-1" type="password" name="password"
    ///          autocomplete="current-password"&gt;
    /// &lt;/div&gt;
    /// </code>
    /// It exists so browser password managers behave. Every candidate this
    /// list used to hold matched it - by name, by autocomplete and by type
    /// alike - so the login typed the password into a field nobody reads and
    /// submitted the e-mail address on its own.
    /// <para>
    /// <c>tabindex='-1'</c> is what excludes it, and it is the right
    /// discriminator rather than a lucky one: a field a keyboard user cannot
    /// tab into is not the field a human types their password in. Visibility
    /// alone would not do it - <c>data-hidden</c> and <c>aria-hidden</c> are
    /// not CSS, so a layout-based check can still see the thing.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
    [
        "input[name='password']:not([tabindex='-1'])",
        "input#password:not([tabindex='-1'])",
        "input[autocomplete='current-password']:not([tabindex='-1'])",
        "input[type='password']:not([tabindex='-1'])",
    ];

    /// <summary>
    /// A submit button that names ANOTHER form by id, which is never the one to
    /// press.
    ///
    /// This is the single most important string in this file, and it is here
    /// because on 2026-08-07 this adapter e-mailed the account owner a
    /// password-reset link during an ordinary login.
    /// <para>
    /// Coolblue's password screen carries THREE submit buttons, and the login
    /// is the SECOND:
    /// <code>
    /// &lt;button type="submit" class="link" form="form__request_password_reset"
    ///         data-action="reset-password"&gt;Wachtwoord vergeten?&lt;/button&gt;
    /// &lt;button type="submit" class="button "&gt;Inloggen&lt;/button&gt;
    /// &lt;button type="submit" class="button button-secondary"
    ///         form="form__request_passwordless_login"&gt;Log in met code&lt;/button&gt;
    /// </code>
    /// The old selector was a bare <c>button[type='submit']</c>, which takes
    /// the first match - so a login that had typed the password in correctly
    /// then asked Coolblue to reset it.
    /// </para>
    /// <para>
    /// HTML's <c>form</c> attribute is what makes this structural rather than
    /// cosmetic: it exists precisely to say "this control belongs to a
    /// different form", so a submit that carries one is by definition not this
    /// form's submit. That holds whatever Coolblue renames its classes, its
    /// copy or its form ids to. Excluding by class or by button text would be
    /// guessing at the same thing from the outside.
    /// </para>
    /// </summary>
    public const string OwnFormOnly = ":not([form])";

    /// <summary>
    /// The control that advances the sign-in from the e-mail screen to the
    /// password screen. CONFIRMED live 2026-08-07: one
    /// <c>&lt;button type="submit"&gt;Doorgaan&lt;/button&gt;</c>, inside the
    /// credentials form.
    ///
    /// The first screen carries only that one submit, so the reset button that
    /// bit the second screen cannot be reached from here - but every candidate
    /// still carries <see cref="OwnFormOnly"/>, because "this screen happens to
    /// have only one button" is a fact about today's markup and the rule is a
    /// fact about HTML.
    /// <para>
    /// Only clicked when there is provably no password box to fill, which is
    /// the same shape Amazon's two-screen sign-in uses and for the same reason:
    /// clicking a "next" on a form that has no next submits the identifier
    /// alone and spends a login attempt.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> ContinueSelectors { get; init; } =
    [
        "button[type='submit']" + OwnFormOnly,
        "button" + OwnFormOnly + ":has-text('Doorgaan')",
        "button" + OwnFormOnly + ":has-text('Verder')",
        "button" + OwnFormOnly + ":has-text('Volgende')",
        "input[type='submit']" + OwnFormOnly,
    ];

    /// <summary>
    /// The button that actually signs in. CONFIRMED live 2026-08-07:
    /// <c>&lt;button type="submit" class="button "&gt;Inloggen&lt;/button&gt;</c>,
    /// with no <c>form</c> attribute, sitting between a password-reset button
    /// and a passwordless-login button that both have one.
    ///
    /// Every candidate excludes the other two by <see cref="OwnFormOnly"/>, and
    /// the text candidates use <c>text-is</c> rather than <c>has-text</c>
    /// because has-text matches substrings and "Inloggen zonder wachtwoord" -
    /// which is what the third button says in some renderings - contains
    /// "Inloggen".
    /// </summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
    [
        "button[type='submit']" + OwnFormOnly,
        "input[type='submit']" + OwnFormOnly,
        "button" + OwnFormOnly + ":text-is('Inloggen')",
        "button" + OwnFormOnly + ":text-is('Log in')",
    ];

    /// <summary>
    /// Controls this adapter must NEVER press, whatever else changes.
    ///
    /// Both of them e-mail the account owner and neither logs anybody in: one
    /// asks Coolblue to reset the password, the other asks it to send a
    /// sign-in code. The reset one was pressed for real.
    /// <para>
    /// Not used to click anything - it exists so the suite can assert that no
    /// candidate above can select either of them. That is the same guard
    /// Amazon's passkey nudge has, and it is written down for the same reason:
    /// the dangerous control sits next to the right one and looks just like it.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> NeverPressSelectors { get; init; } =
    [
        "[data-action='reset-password']",
        "[form='form__request_password_reset']",
        "[form='form__request_passwordless_login']",
    ];

    /// <summary>
    /// UNCONFIRMED, and deliberately narrow: only phrasings that state a
    /// CREDENTIAL failure.
    ///
    /// A generic error box would also match a consent banner or an outage
    /// notice, and <c>invalid_credentials</c> is never retried by anything - so
    /// a false positive is permanent for that session and sends the user to
    /// reset a password that was fine. This is the only path in the adapter
    /// allowed to report one.
    /// </summary>
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

    /// <summary>
    /// UNCONFIRMED, and OBSERVED ABSENT: the 2026-07-28 check found no captcha
    /// asset on Coolblue's login form and no bot-management cookie anywhere on
    /// the site (<c>server: CloudFront</c>, no Akamai, no DataDome, no
    /// Cloudflare BM).
    ///
    /// The probe stays anyway, and costs one short look per settle pass. A
    /// widget appearing later is a thing the adapter must be able to NAME - the
    /// alternative is a job that waits out its whole budget and then reports a
    /// shape change, which is the failure that has already happened twice on
    /// this platform.
    /// </summary>
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

    /// <summary>
    /// UNCONFIRMED. Where a typed captcha's answer goes - and, because a
    /// picture with nowhere to type it is no more answerable than a widget,
    /// also what decides which of the two is standing in the way.
    /// </summary>
    public IReadOnlyList<string> CaptchaInputSelectors { get; init; } =
    [
        "input[name='captcha']",
        "input#captcha",
    ];

    /// <summary>
    /// UNCONFIRMED. Text an edge challenge or an interstitial puts in a body
    /// that was supposed to be JSON. Matched case-insensitively.
    ///
    /// Coolblue fronts on CloudFront and no wall has been seen, but an HTML
    /// body where JSON was promised has exactly two readings - a wall or a
    /// bounce to the login - and calling either of them a parse failure buries
    /// the diagnosis.
    /// </summary>
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

    /// <summary>
    /// UNCONFIRMED. Text that says an HTML body is Coolblue's login page
    /// rather than a wall - which is <c>session_expired</c>, not a block, and
    /// the two want opposite things from the user.
    /// </summary>
    public IReadOnlyList<string> LoginPageMarkers { get; init; } =
    [
        "accounts.coolblue.nl",
        "/inloggen",
        "name=\"csrf\"",
    ];

    public int SelectorTimeoutMs { get; init; } = 15_000;

    /// <summary>
    /// How long to look for the password box BEFORE deciding this is the
    /// two-screen sign-in and pressing continue.
    ///
    /// Short on purpose. On the two-screen flow this probe always misses, and
    /// every millisecond of it is latency on every single login; on a
    /// one-screen flow it hits immediately. The full
    /// <see cref="SelectorTimeoutMs"/> is spent on the second screen, where the
    /// field really is expected.
    /// </summary>
    public int PasswordProbeMs { get; init; } = 1_500;

    /// <summary>Short probes: the settle loop runs them on every pass.</summary>
    public int ProbeMs { get; init; } = 500;

    /// <summary>How long the login may take to resolve into a code, an error or a wall.</summary>
    public int LoginSettleSeconds { get; init; } = 180;

    /// <summary>How long each settle pass waits on the redirect before looking at the page again.</summary>
    public int RedirectPollSeconds { get; init; } = 5;

    /// <summary>How long the human has to answer a relayed image captcha.</summary>
    public int ChallengeSeconds { get; init; } = 300;

    /// <summary>
    /// How long the human has to pass an interactive widget in the browser
    /// window we opened in front of them. Longer than a typed captcha: nobody
    /// is relaying anything, so the wait has to cover someone noticing.
    /// </summary>
    public int InteractiveCaptchaSeconds { get; init; } = 600;
}
