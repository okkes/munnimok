namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>
/// Everything about MediaMarkt that could move without warning.
///
/// Almost all of it was CONFIRMED live on 2026-08-11 from a capture of a real
/// account: the orders page, the login form, the GraphQL operation, its
/// variables, the headers its client sends and the shape of what comes back.
/// Values that were NOT confirmed say so on the property.
/// </summary>
public sealed record MediaMarktOptions
{
    /// <summary>
    /// Where the login starts, and it is the PROTECTED page rather than the
    /// form.
    /// </summary>
    /// <remarks>
    /// The same lesson bol, Coolblue and DUO each taught once: hand-crafting an
    /// entry to the sign-in page produces a session the app was never told
    /// about. MediaMarkt redirects this to
    /// <c>/nl/myaccount/auth/login?redirectURL=%2Fnl%2Fmyaccount%2Forders</c>
    /// and brings the browser back here afterwards, which is both what a
    /// shopper does and the only route that ends with the SPA holding a
    /// session.
    /// </remarks>
    public string OrdersPageUrl { get; init; } = "https://www.mediamarkt.nl/nl/myaccount/orders";

    /// <summary>The GraphQL endpoint, read out of the page's own bootstrap config.</summary>
    public string GraphQlPath { get; init; } = "/api/v1/graphql";

    /// <summary>
    /// The one operation this connector needs.
    /// </summary>
    /// <remarks>
    /// There is a second, <c>GetCombinedOrderV3</c>, which the page fires when
    /// an order is opened. It is not used and must not be: its payload was
    /// compared field-for-field against the same order's entry in the list and
    /// is identical, so calling it would double the request count to learn
    /// nothing.
    /// </remarks>
    public string OrdersOperation { get; init; } = "GetCombinedOrdersV3";

    /// <summary>The array inside <c>data</c>.</summary>
    public string OrdersField { get; init; } = "getCombinedOrders";

    /// <summary>
    /// When the order was placed. <c>meta.updated</c> exists beside it and is
    /// deliberately not used - it moves when a parcel ships, which would make a
    /// two-year-old purchase reappear as recent in an incremental sync.
    /// </summary>
    public string PurchasedAtField { get; init; } = "created";

    /// <summary>
    /// <c>productTitle</c> rather than <c>productData.title</c>. Both carry the
    /// same string in every line of the capture; this one is a scalar at the
    /// top of the product, so it survives <c>productData</c> being restructured.
    /// </summary>
    public string ProductTitleField { get; init; } = "productTitle";

    /// <summary>The only currency the NL storefront was seen to state.</summary>
    public string Currency { get; init; } = "EUR";

    /// <summary>
    /// Ten, which is what MediaMarkt's own client asks for.
    /// </summary>
    /// <remarks>
    /// Matched to the observed client rather than raised. A persisted query is
    /// a contract the server already knows, and the server is free to have
    /// opinions about a limit its own front end never sends - so asking for 100
    /// is a way to discover a validation error on somebody's first connect.
    /// </remarks>
    public int PageSize { get; init; } = 10;

    /// <summary>
    /// How many pages one fetch will walk before stopping and reporting itself
    /// incomplete. Twenty pages is two hundred orders.
    /// </summary>
    public int MaxPages { get; init; } = 20;

    /// <summary>
    /// The variables template. <c>{0}</c> is the limit and <c>{1}</c> the
    /// offset - the exact shape the client sends, confirmed live.
    /// </summary>
    public string VariablesTemplate { get; init; } = """{"limit":{0},"offset":{1}}""";

    /// <summary>
    /// Request headers worth carrying onto a page we ask for ourselves.
    /// </summary>
    /// <remarks>
    /// An ALLOWLIST copied off the client's own call, and short on purpose.
    /// <c>x-operation</c>, <c>x-mms-country</c>, <c>x-mms-language</c>,
    /// <c>x-mms-salesline</c> and the two Apollo headers are what identify the
    /// caller as MediaMarkt's own front end; <c>user-agent</c>, <c>referer</c>
    /// and the <c>sec-*</c> set are deliberately absent because a page's own
    /// <c>fetch</c> is not permitted to set them and the browser already sends
    /// the right ones.
    /// <para>
    /// No cookie and no authorization appear here, because none is needed: the
    /// session is the browser's cookie jar and <c>credentials: 'same-origin'</c>
    /// carries it without this process ever seeing it.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> CarriedHeaders { get; init; } =
    [
        // FIRST, AND LOAD-BEARING ON A GET.
        //
        // Leaving this out is what made the first live fetch die: page one -
        // the SPA's own call - came back 200, and page two, the one this
        // connector builds, answered 400. Apollo Server's CSRF prevention
        // refuses any GET whose content type is "simple" (or absent) unless it
        // carries `x-apollo-operation-name` or `apollo-require-preflight`.
        // MediaMarkt's client sends `content-type: application/json` on every
        // GET - which reads as pointless on a request with no body, and is
        // precisely what satisfies that check.
        //
        // CONFIRMED PRESENT on every captured request; the CSRF reading of WHY
        // is inference from Apollo's documented behaviour and the 400.
        "content-type",
        "apollographql-client-name",
        "apollographql-client-version",
        "x-operation",
        "x-cacheable",
        "x-mms-country",
        "x-mms-language",
        "x-mms-salesline",
    ];

    // ---- the login form ----------------------------------------------------

    /// <summary>CONFIRMED with ids on 2026-08-11.</summary>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["#userName", "input[name='userName__input']", "[data-test='userName__input']"];

    /// <summary>CONFIRMED with ids on 2026-08-11.</summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["#password", "input[name='password__input']", "[data-test='password__input']"];

    /// <summary>CONFIRMED with an id on 2026-08-11.</summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
        ["#mms-login-form__login-button", "button[type='submit']"];

    /// <summary>
    /// The cookie wall, answered with the NARROWEST option on the layer.
    /// </summary>
    /// <remarks>
    /// "Noodzakelijk" then "Opslaan", never "Alles accepteren". A connector
    /// signing in on somebody's behalf has no business opting them into
    /// marketing tracking, and the account holder confirmed on 2026-08-11 that
    /// the orders page works perfectly with only the necessary categories on.
    /// <para>
    /// Best effort: the layer only appears on a profile that has never answered
    /// it, and a miss costs nothing but the banner staying on screen.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> ConsentNecessarySelectors { get; init; } =
        ["#required", "button:has-text('Noodzakelijk')"];

    /// <summary>The button that stores the narrow choice above.</summary>
    public IReadOnlyList<string> ConsentSaveSelectors { get; init; } =
    [
        "[data-test='pwa-consent-layer-save-settings']",
        "button:has-text('Opslaan')",
    ];

    /// <summary>
    /// Sign-in options this connector must never press.
    /// </summary>
    /// <remarks>
    /// The login page offers "Verder met Google" and "Verder met Apple" beside
    /// the password form. Both hand off to an identity provider this connector
    /// holds no credential for, and a stray click lands the browser on a
    /// consent screen nobody can answer. Named here so a future selector can be
    /// checked against them rather than discovered by a live run - the same
    /// guard Amazon's passkey nudge needed, and DigiD's "op dit apparaat" tile
    /// after it.
    /// </remarks>
    public IReadOnlyList<string> ForbiddenSelectors { get; init; } =
    [
        "[data-test='social-login-buttons__google-button']",
        "[data-test='social-login-buttons__apple-button']",
    ];

    // ---- patience ----------------------------------------------------------

    /// <summary>How long one selector is waited for.</summary>
    public int StepProbeMs { get; init; } = 8_000;

    /// <summary>
    /// How long to wait for the SPA to fire the orders call after landing on
    /// the page. Generous: this covers a login redirect, the bundle loading and
    /// the route mounting, on an agent that may be cold.
    /// </summary>
    public int OrdersCallTimeoutMs { get; init; } = 45_000;

    /// <summary>Between pages we ask for ourselves. See the manifest's limits.</summary>
    public int PageGapMs { get; init; } = 1_000;

    /// <summary>
    /// Where a signed-out browser ends up, so a dead session is recognised by
    /// what MediaMarkt does rather than by a parse failure.
    /// </summary>
    public string LoginPathMarker { get; init; } = "/myaccount/auth";

    /// <summary>
    /// MediaMarkt's payment codes, mapped to the platform's closed vocabulary.
    /// </summary>
    /// <remarks>
    /// Four codes were seen live: <c>IDEAL</c>, <c>CRECA</c> (credit card) and
    /// <c>GICA</c> (gift card), plus nothing at all on an order still being
    /// created. Anything unrecognised becomes <c>other</c> rather than being
    /// passed through, because the vocabulary is what lets a consumer act on
    /// this field without knowing which shop it came from.
    /// </remarks>
    public IReadOnlyDictionary<string, string> PaymentMethods { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["IDEAL"] = "ideal",
            ["CRECA"] = "card",
            ["DEBCA"] = "card",
            ["GICA"] = "other",
            ["PAYPAL"] = "other",
            ["INVOICE"] = "other",
        };

    /// <summary>Null in, null out: an unpaid order states no method at all.</summary>
    public string? PaymentMethod(string? code) =>
        string.IsNullOrWhiteSpace(code) ? null
        : PaymentMethods.TryGetValue(code, out var mapped) ? mapped
        : "other";

    /// <summary>
    /// Branches cut out of an order before its payload is kept as <c>raw</c>.
    /// </summary>
    /// <remarks>
    /// RAW IS FOR THE PROVIDER'S OWN SHAPE, NOT FOR THE ACCOUNT HOLDER. A caller
    /// asks for it to see what MediaMarkt actually said about a purchase -
    /// fields this connector does not normalise, a discount it spells oddly, an
    /// order state nobody has mapped yet. None of that needs to know who bought
    /// it, and both of these branches are about exactly that:
    /// <list type="bullet">
    /// <item><c>user</c> - email address, first and last name, loyalty id, tax
    /// id and phone numbers.</item>
    /// <item><c>billing.address</c> and <c>items.deliveryAddress</c> - the
    /// account holder's home address, with their name on it, written in BOTH
    /// places. <c>billing.payments</c> stays, because the amount and the method
    /// are the receipt.</item>
    /// </list>
    /// <para>
    /// Cut at the source rather than filtered later, because raw is staged into
    /// the same row as the record and travels wherever that does. What is never
    /// captured cannot leak from a place nobody thought about.
    /// </para>
    /// <para>
    /// Dotted paths, in which ARRAY INDICES ARE TRANSPARENT:
    /// <c>items.deliveryAddress</c> names that branch on every item. The
    /// delivery address is why - the first version of this walked objects only
    /// and left a home address behind on each line of every order, which is the
    /// worst kind of miss because the scrub looked done.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> RawRemovals { get; init; } =
        ["user", "billing.address", "items.deliveryAddress"];
}
