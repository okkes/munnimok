namespace ShopConnector.Adapters.MediaMarkt;

/// almost all confirmed live 2026-08-11 from a real account's capture; properties not confirmed say so
public sealed record MediaMarktOptions
{
    /// the PROTECTED page, not the sign-in form: a hand-crafted entry to the form gives a session the app was never told about
    /// (bol, Coolblue, DUO); MediaMarkt redirects to /nl/myaccount/auth/login?redirectURL=… and back
    public string OrdersPageUrl { get; init; } = "https://www.mediamarkt.nl/nl/myaccount/orders";

    /// <summary>The GraphQL endpoint, read out of the page's own bootstrap config.</summary>
    public string GraphQlPath { get; init; } = "/api/v1/graphql";

    /// GetCombinedOrderV3 (an opened order) is unused: its payload equals the list entry, so it only doubles requests
    public string OrdersOperation { get; init; } = "GetCombinedOrdersV3";

    public string OrdersField { get; init; } = "getCombinedOrders";

    /// meta.updated is deliberately unused: it moves when a parcel ships, so an old purchase would look recent in a sync
    public string PurchasedAtField { get; init; } = "created";

    /// productTitle, not productData.title: same string, but a top-level scalar survives productData being restructured
    public string ProductTitleField { get; init; } = "productTitle";

    /// <summary>The only currency the NL storefront was seen to state.</summary>
    public string Currency { get; init; } = "EUR";

    /// ten, as MediaMarkt's own client asks: the server may reject a limit its front end never sends, found on a first connect
    public int PageSize { get; init; } = 10;

    /// two hundred pages is two thousand orders, the whole history of any account seen
    public int MaxPages { get; init; } = 200;

    public string VariablesTemplate { get; init; } = """{"limit":{0},"offset":{1}}""";

    /// an ALLOWLIST copied off the client's own call; user-agent, referer and sec-* are absent: a page's fetch cannot set them
    /// no cookie or authorization: the session is the browser's cookie jar, carried by credentials: 'same-origin'
    public IReadOnlyList<string> CarriedHeaders { get; init; } =
    [
        // FIRST, load-bearing on a GET: Apollo's CSRF prevention refuses a GET with a simple or absent content type
        // unless it carries x-apollo-operation-name or apollo-require-preflight; without it page two (ours) got 400,
        // the SPA's page one 200 (the CSRF reading is inference)
        "content-type",
        "apollographql-client-name",
        "apollographql-client-version",
        "x-operation",
        "x-cacheable",
        "x-mms-country",
        "x-mms-language",
        "x-mms-salesline",
    ];

    /// <summary>CONFIRMED with ids on 2026-08-11.</summary>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["#userName", "input[name='userName__input']", "[data-test='userName__input']"];

    /// <summary>CONFIRMED with ids on 2026-08-11.</summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["#password", "input[name='password__input']", "[data-test='password__input']"];

    /// <summary>CONFIRMED with an id on 2026-08-11.</summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
        ["#mms-login-form__login-button", "button[type='submit']"];

    /// the narrowest option, never "Alles accepteren": no opting somebody into marketing tracking; the orders page works with
    /// necessary only (confirmed 2026-08-11). Best effort: a miss only leaves the banner on screen
    public IReadOnlyList<string> ConsentNecessarySelectors { get; init; } =
        ["#required", "button:has-text('Noodzakelijk')"];

    public IReadOnlyList<string> ConsentSaveSelectors { get; init; } =
    [
        "[data-test='pwa-consent-layer-save-settings']",
        "button:has-text('Opslaan')",
    ];

    /// never pressed: "Verder met Google/Apple" hand off to an identity provider we hold no credential for,
    /// landing on a consent screen nobody can answer
    public IReadOnlyList<string> ForbiddenSelectors { get; init; } =
    [
        "[data-test='social-login-buttons__google-button']",
        "[data-test='social-login-buttons__apple-button']",
    ];

    public int StepProbeMs { get; init; } = 8_000;

    /// an order's own page: "Factuur aanvragen" asks for the invoice, "Download de factuur" hands it over; {id} is the order id
    public string OrderDetailsUrlTemplate { get; init; } = "https://www.mediamarkt.nl/nl/myaccount/orders/{id}";

    /// absent on an order that already has its invoice; the download is looked for either way
    public IReadOnlyList<string> RequestInvoiceSelectors { get; init; } =
    [
        """button:has-text("Factuur aanvragen")""",
        """a:has-text("Factuur aanvragen")""",
        """button:has-text("Request invoice")""",
    ];

    public IReadOnlyList<string> DownloadInvoiceSelectors { get; init; } =
    [
        """a:has-text("Download de factuur")""",
        """button:has-text("Download de factuur")""",
        """a:has-text("Download invoice")""",
        """a[href*="invoice"]""",
    ];

    /// <summary>How long the download is waited for after asking - MediaMarkt renders the invoice on request.</summary>
    public int InvoiceProbeMs { get; init; } = 15_000;

    /// what a rendered order page shows (#430); client-rendered, so waited for before the invoice controls are looked for
    public IReadOnlyList<string> OrderPageSelectors { get; init; } =
    [
        """h1:has-text("Mijn bestelling")""",
        """body:has-text("Overzicht bestelling")""",
        """body:has-text("Order overview")""",
    ];

    public int OrderPageMs { get; init; } = 15_000;

    /// <summary>How long the invoice controls may trail the rendered order before the order is taken to offer none.</summary>
    public int InvoiceControlsMs { get; init; } = 3_000;

    /// a sign-in page answered to a document link is text/html named .pdf, and is not attached
    public IReadOnlyList<string> DocumentMediaTypes { get; init; } = ["application/pdf"];

    /// each order is a page of its own: a first connect on a long history gets the newest hundred, the next sync more
    public int MaxDocumentOrdersPerFetch { get; init; } = 100;

    /// generous: covers a login redirect, the bundle loading and the route mounting on a cold agent
    public int OrdersCallTimeoutMs { get; init; } = 45_000;

    public int PageGapMs { get; init; } = 1_000;

    /// where a signed-out browser ends up: a dead session is recognised by what MediaMarkt does, not a parse failure
    public string LoginPathMarker { get; init; } = "/myaccount/auth";

    private const string Other = "other";

    /// codes seen live: IDEAL, CRECA (credit card), GICA (gift card); none on an order still being created
    /// unrecognised becomes other: the closed vocabulary lets a consumer act without knowing the shop
    public IReadOnlyDictionary<string, string> PaymentMethods { get; init; } =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["IDEAL"] = "ideal",
            ["CRECA"] = "card",
            ["DEBCA"] = "card",
            ["GICA"] = Other,
            ["PAYPAL"] = Other,
            ["INVOICE"] = Other,
        };

    /// <summary>Null in, null out: an unpaid order states no method at all.</summary>
    public string? PaymentMethod(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;

        return PaymentMethods.TryGetValue(code, out var mapped) ? mapped : Other;
    }

    /// raw shows the provider's shape, not the account holder: cut at the source because raw travels with the record's row
    /// removed: user (email, names, ids, phones) and the home address, in BOTH billing.address and items.deliveryAddress
    /// dotted paths, array indices transparent: a walk of objects only left a home address on every line
    public IReadOnlyList<string> RawRemovals { get; init; } =
        ["user", "billing.address", "items.deliveryAddress"];
}
