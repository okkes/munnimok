namespace BankConnector.Adapters.Ing;

/// read off a capture on 2026-08-12 (NL and EN); anything the capture did not establish says so on the property
public sealed record IngOptions
{
    /// <summary>The sign-in page. Everything after it is client-routed.</summary>
    public string LoginUrl { get; init; } = "https://mijn.ing.nl/login/";

    /// landing here makes ING's own app fetch the current account's transactions: the first page and the template for
    /// later ones; the agreement id in that URL rotates per session, so it is observed, never stored
    public string OverviewUrl { get; init; } = "https://mijn.ing.nl/banking";

    /// the fallback since AgreementsPath got a reader; reaches current accounts only (savings and cards load when the
    /// picker is switched). Composed requests got 401 from ING's webserver, so landing makes its client call /accounts/current
    public string DownloadPageUrl { get; init; } = "https://mijn.ing.nl/banking/download-transactions";

    /// ING's API is on its own origin, so the page's fetch needs credentials: 'include'; same-origin would send no cookies
    public string ApiOrigin { get; init; } = "https://api.mijn.ing.nl";

    /// both halves are needed: the id is opaque, and /v1/agreements/{id} alone also fronts a search endpoint
    public string TransactionsPathPrefix { get; init; } = "/v1/agreements/";

    public string TransactionsPathSuffix { get; init; } = "/transactions";

    /// path markers matched against urls ING's own client asks for, so no query string: one would match only what ING
    /// sent the day it was written down
    public string CurrentAccountsPath { get; init; } = "/accounts/current";

    /// not fetched on arrival: the download screen asks for these only when the picker is switched to savings or a card
    public string SavingsAccountsPath { get; init; } = "/savings/accounts/products";

    public string CreditCardsPath { get; init; } = "/credit-cards/cards";

    /// the one call that knows every account; the overview renders its list from it and landing there produces it free.
    /// Its reader was written from a schema (the capture withheld the response; keys, lengths and taxonomy via IngSchema),
    /// so DownloadPageUrl stays as the fallback
    public string AgreementsPath { get; init; } = "/global/agreements";

    /// by name, not id: ING mints element ids per render. The inputs sit in ING's web components, so they resolve only
    /// because Playwright's CSS engine pierces open shadow roots
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["input[name='username']", "#usernameInput input", "input[autocomplete='username']"];

    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["input[name='password']", "input[type='password']"];

    public IReadOnlyList<string> SubmitSelectors { get; init; } =
        ["#submitButton", "ing-button[type='submit']"];

    /// a list item, not a button: ING ships phone and desktop layouts in one document and hides one with CSS, so an
    /// ing-button selector matches one permanently invisible element; confirmed 2026-08-13 in NL and EN that li.list__item
    /// shows the form and ing-button times out. :visible leads because the text matches once per layout; plain forms follow
    public IReadOnlyList<string> PasswordFormSelectors { get; init; } =
    [
        "li.list__item:has-text('gebruikersnaam'):visible",
        "li.list__item:has-text('username'):visible",
        "li.list__item:has-text('gebruikersnaam')",
        "li.list__item:has-text('username')",
        // the desktop layout's own control, last: present but invisible on a phone
        "ing-button.list__button:has-text('gebruikersnaam')",
        "ing-button.list__button:has-text('username')",
    ];

    /// never press: #up-kbq-button starts credential recovery; the NL/EN switch would change the holder's phone language
    /// too; "App openen" hands off to the ING app
    public IReadOnlyList<string> ForbiddenSelectors { get; init; } =
    [
        "#up-kbq-button",
        "ing-button:has-text('App openen')",
        "button:has-text('App openen')",
    ];

    /// no stable id on the button; pressing it is what fires POST /api/sessions/logout, navigating to the goodbye page
    /// leaves the session alive
    public IReadOnlyList<string> LogoutSelectors { get; init; } =
    [
        "ing-button:has-text('Uitloggen')",
        "ing-button:has-text('Log out')",
        "button:has-text('Uitloggen')",
        "button:has-text('Log out')",
    ];

    public string LoggedOutPathMarker { get; init; } = "/particulier/logoff";

    /// ING's own sign-out call is the only real evidence a session ended; latched only if sent to ApiOrigin (the capture
    /// recorded the path, not the host), so the landing-page check is the fallback
    public string LogoutCallPathMarker { get; init; } = "/sessions/logout";

    /// a DENYLIST: an allowlist of six guessed names was not enough (401 from ING's webserver). No header VALUE may
    /// appear in any note, diagnostic or exception; the names are logged once
    public IReadOnlyList<string> WithheldHeaders { get; init; } =
    [
        // a page's fetch may not set these; the browser already sends the right ones
        "host",
        "connection",
        "content-length",
        "cookie",
        "origin",
        "referer",
        "date",
        "expect",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via",
        "accept-encoding",
        "accept-charset",
        // the browser's own identity: overriding it is refused and pointless
        "user-agent",
    ];

    /// sec- and proxy- are prefix rules, so they cannot live in the list
    public bool Withheld(string name) =>
        WithheldHeaders.Contains(name, StringComparer.OrdinalIgnoreCase)
        || name.StartsWith("sec-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("proxy-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(':');

    /// forty is what ING's client asks for; not raised, as rewriting maxrec in a cursor URL invents a request its front
    /// end never makes
    public int PageSize { get; init; } = 40;

    /// a hundred pages is 4000 rows, more than the record cap keeps, so the cap ends a walk first
    public int MaxPages { get; init; } = 100;

    public int PageGapMs { get; init; } = 750;

    /// null in production (the manifest answers); a seam so the budget split can be tested without hundreds of fixture rows
    public int? RecordCap { get; init; }

    public int StepProbeMs { get; init; } = 8_000;

    /// covers a cold agent, the bundle loading and the route mounting
    public int ApiCallTimeoutMs { get; init; } = 45_000;

    /// four minutes, about a PERSON not a network: the capture took about a minute phone in hand; generous costs an idle
    /// browser, mean costs a failed login and a second SCA
    public int AppApprovalTimeoutMs { get; init; } = 240_000;

    /// a data-loss guard: the challenge is never answered (the adapter stops awaiting when ING's page advances) and parks
    /// the job until the run completes; if it expires first the sweeper fails the job challenge_expired and the finished
    /// login is discarded. Derived from the budgets it must outlast, so raising either cannot reintroduce the race
    public int ChallengeTtlMs => AppApprovalTimeoutMs + (2 * ApiCallTimeoutMs);
}
