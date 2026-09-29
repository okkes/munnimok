namespace BankConnector.Adapters.Ing;

/// <summary>
/// Everything about ING that could move without warning.
///
/// Read off a capture of a real account on 2026-08-12, in Dutch AND in
/// English, with a current account, a savings account and a credit card on
/// it. Anything below that the capture did not establish says so on the
/// property; nothing here is a guess presented as a finding.
/// </summary>
public sealed record IngOptions
{
    // ---- where things are --------------------------------------------------

    /// <summary>The sign-in page. Everything after it is client-routed.</summary>
    public string LoginUrl { get; init; } = "https://mijn.ing.nl/login/";

    /// <summary>
    /// The page to land on, and the reason the whole adapter works.
    /// </summary>
    /// <remarks>
    /// Landing here makes ING's own app fetch the current account's
    /// transactions by itself - <c>/v1/agreements/{id}/transactions</c> - which
    /// is both the first page of data and the template every later page is
    /// built from. The agreement id in that URL is opaque AND rotates: the same
    /// account was <c>aYDrNOy1…</c> in one session and <c>L-zdMpP6…</c> in the
    /// next, so it can never be stored, only observed.
    /// </remarks>
    public string OverviewUrl { get; init; } = "https://mijn.ing.nl/banking";

    /// <summary>
    /// The statement-download screen, which this connector visits for what its
    /// app FETCHES on the way in rather than for what it offers.
    /// </summary>
    /// <remarks>
    /// THE FALLBACK, since <see cref="AgreementsPath"/> got a reader. It is
    /// visited only when the agreement list is missing or unreadable, and it
    /// reaches less: ING asks for savings and cards here only when somebody
    /// switches the picker, so arriving produces the current accounts alone.
    /// <para>
    /// Landing here makes ING's own client call <c>/accounts/current</c>, with
    /// whatever headers ING requires, without this process having to know what
    /// those are.
    /// </para>
    /// <para>
    /// That is the correction the second live run forced. The adapter used to
    /// ask for those three itself, through the page's own <c>fetch</c>, and ING
    /// answered <c>401 Authorization Required</c> from its webserver - an
    /// edge-level refusal, not an API one, on a session that had just
    /// successfully served a page of transactions to ING's own javascript
    /// seconds earlier. Reproducing a bank's request precisely enough to be let
    /// through is a guessing game; asking the bank's own client to make it is
    /// not.
    /// </para>
    /// <para>
    /// Nothing is downloaded by arriving. The export needs a form submitted,
    /// and this connector never submits it.
    /// </para>
    /// </remarks>
    public string DownloadPageUrl { get; init; } = "https://mijn.ing.nl/banking/download-transactions";

    /// <summary>
    /// ING's API lives on its OWN ORIGIN, which is why the page's fetch has to
    /// send <c>credentials: 'include'</c> rather than <c>'same-origin'</c>.
    /// </summary>
    /// <remarks>
    /// The app runs on <c>mijn.ing.nl</c> and every data call goes to
    /// <c>api.mijn.ing.nl</c>. Every one of those responses carries
    /// <c>access-control-allow-credentials</c>, which is only meaningful for a
    /// credentialed cross-origin request - so the session really is the
    /// browser's cookie jar and a same-origin fetch would silently send none of
    /// it.
    /// </remarks>
    public string ApiOrigin { get; init; } = "https://api.mijn.ing.nl";

    /// <summary>
    /// What a transactions call looks like. Both halves are needed: the id in
    /// the middle is opaque, and <c>/v1/agreements/{id}</c> alone also fronts a
    /// search endpoint this connector never calls.
    /// </summary>
    public string TransactionsPathPrefix { get; init; } = "/v1/agreements/";

    public string TransactionsPathSuffix { get; init; } = "/transactions";

    /// <summary>Current accounts. Also names the one ING considers preferred.</summary>
    /// <remarks>
    /// These three are PATH MARKERS, matched against the urls ING's own client
    /// asks for - not requests this connector composes. So they carry no query
    /// string: ING's client sends <c>?fields=target,holders,ascription</c> on
    /// the savings call and <c>?includeInactiveCards=false</c> on the cards
    /// one, and those are its business rather than ours. A marker with a query
    /// in it would match only the exact query ING happened to send on the day it
    /// was written down.
    /// </remarks>
    public string CurrentAccountsPath { get; init; } = "/accounts/current";

    /// <remarks>
    /// NOT FETCHED ON ARRIVAL, which cost a live run to establish. ING's
    /// download screen loads with the current account chosen and asks for these
    /// two only when somebody switches the picker to savings or to a card. The
    /// capture showed both calls on that page and the order of the traffic said
    /// why: each one follows a
    /// <c>/accounts/transactions/reports/formats?accountType=…</c> for the type
    /// just selected. Landing on the page produces the current accounts and
    /// nothing else.
    /// </remarks>
    public string SavingsAccountsPath { get; init; } = "/savings/accounts/products";

    public string CreditCardsPath { get; init; } = "/credit-cards/cards";

    /// <summary>
    /// The one call that knows about every account somebody has, and the one
    /// this connector now lists them from.
    /// </summary>
    /// <remarks>
    /// It is what the overview renders its own list from - the page shows
    /// Betaalrekeningen, Spaarrekeningen, Creditcards AND Leningen, and this is
    /// the only account-shaped call that navigation makes. Landing on
    /// <see cref="OverviewUrl"/> for the transactions produces it as a side
    /// effect, so reading it costs no extra navigation at all.
    /// <para>
    /// ITS READER WAS WRITTEN FROM A SCHEMA RATHER THAN A SAMPLE. The capture
    /// this adapter was built from withheld this response - the recorder ran
    /// against an account with real money in it and kept only what it had a
    /// stated reason to keep - so what is known about it came back from a live
    /// run through <see cref="IngSchema"/>: keys, nesting, string lengths, and
    /// the product taxonomy, never a value. That run reported seven agreements
    /// across five types on an account whose savings and card the statement
    /// screen could not reach.
    /// </para>
    /// <para>
    /// Which is why <see cref="DownloadPageUrl"/> stays as a fallback rather
    /// than being deleted.
    /// </para>
    /// </remarks>
    public string AgreementsPath { get; init; } = "/global/agreements";

    // ---- the login form ----------------------------------------------------

    /// <summary>CONFIRMED on 2026-08-12, by <c>name</c> rather than by id.</summary>
    /// <remarks>
    /// ING mints its element ids per render - <c>ing-auth-input-kr3dyd5wir</c>
    /// one load, something else the next - so an id selector here would work
    /// exactly once. The <c>name</c> attributes are stable and are what the form
    /// actually posts.
    /// <para>
    /// The inputs live inside ING's own web components (<c>ing-auth-input</c>,
    /// itself inside <c>ing-form</c>), so these only resolve because
    /// Playwright's CSS engine pierces open shadow roots. A plain
    /// <c>document.querySelectorAll</c> finds nothing at all on this page, which
    /// is how the first capture attempt came back reporting zero inputs.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> UsernameSelectors { get; init; } =
        ["input[name='username']", "#usernameInput input", "input[autocomplete='username']"];

    /// <summary>CONFIRMED on 2026-08-12.</summary>
    public IReadOnlyList<string> PasswordSelectors { get; init; } =
        ["input[name='password']", "input[type='password']"];

    /// <summary>CONFIRMED on 2026-08-12: a stable id, on an <c>ing-button</c>.</summary>
    public IReadOnlyList<string> SubmitSelectors { get; init; } =
        ["#submitButton", "ing-button[type='submit']"];

    /// <summary>
    /// The link from ING's default sign-in screen to the password form.
    /// </summary>
    /// <remarks>
    /// ING opens on whichever method it feels like - "Inloggen via je app" on a
    /// phone, "Log in met een QR-code" on a desktop - and the password form is
    /// one tap away under "Inloggen kan ook zo:" / "You can also log in like
    /// this:".
    /// <para>
    /// A LIST ITEM, NOT A BUTTON, and getting that wrong cost the first live
    /// sign-in. ING ships BOTH layouts in the same document and hides one with
    /// CSS: the phone layout renders <c>li.list__item</c> with a plain
    /// <c>div.selector-name</c> inside, while the desktop layout's
    /// <c>ing-button.list__button</c> sits in the DOM with no box at all. An
    /// <c>ing-button</c> selector therefore MATCHES - exactly one element,
    /// permanently invisible - and every wait for it times out while the thing
    /// a person would tap is right there.
    /// </para>
    /// <para>
    /// CONFIRMED on 2026-08-13 against the live public sign-in page, in Dutch
    /// AND in English, by clicking each candidate and checking that the form
    /// appeared: both <c>li.list__item</c> selectors below produced
    /// <c>input[name=username]</c>, <c>input[name=password]</c> and
    /// <c>#submitButton</c>; both <c>ing-button</c> ones timed out. No
    /// credentials were involved - the switch only asks ING to show a form.
    /// </para>
    /// <para>
    /// <c>:visible</c> leads because the text matches TWICE, once per layout,
    /// and which of the two a bare selector resolves to is an ordering
    /// assumption rather than a fact. The plain forms follow as a fallback for
    /// the day ING stops shipping the layout it is not using.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> PasswordFormSelectors { get; init; } =
    [
        "li.list__item:has-text('gebruikersnaam'):visible",
        "li.list__item:has-text('username'):visible",
        "li.list__item:has-text('gebruikersnaam')",
        "li.list__item:has-text('username')",
        // The desktop layout's own control, last: it is what a wider viewport
        // renders, and it is the one that is present-but-invisible on a phone.
        "ing-button.list__button:has-text('gebruikersnaam')",
        "ing-button.list__button:has-text('username')",
    ];

    /// <summary>
    /// Things on ING's pages this connector must never press.
    /// </summary>
    /// <remarks>
    /// Three of them, and each would do real damage:
    /// <list type="bullet">
    /// <item><c>#up-kbq-button</c> - "Inloggegevens kwijt?" - starts ING's
    /// credential-recovery flow. The same class of mistake as Coolblue's
    /// "Wachtwoord vergeten?", which this project already made once.</item>
    /// <item>The NL/EN switch in the profile menu. THE ACCOUNT HOLDER'S
    /// LANGUAGE IS NOT OURS TO CHOOSE: changing it here changes it on their
    /// phone too. The connector takes whatever language it is handed, which is
    /// why so much of this adapter is written to be language-independent.</item>
    /// <item>"App openen" - a deep link that hands off to the ING app.</item>
    /// </list>
    /// </remarks>
    public IReadOnlyList<string> ForbiddenSelectors { get; init; } =
    [
        "#up-kbq-button",
        "ing-button:has-text('App openen')",
        "button:has-text('App openen')",
    ];

    /// <summary>
    /// Sign-out, by the word on the button.
    /// </summary>
    /// <remarks>
    /// Both spellings were captured on the same account: "Uitloggen" in Dutch
    /// and "Log out" in English, in the top bar of every signed-in page. There
    /// is no stable id on it.
    /// <para>
    /// Pressing it is what makes ING's own <c>POST /api/sessions/logout</c>
    /// happen. Navigating to the goodbye page instead would show the goodbye
    /// page and leave the session alive, which is the failure mode worth naming
    /// because it looks exactly like success.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> LogoutSelectors { get; init; } =
    [
        "ing-button:has-text('Uitloggen')",
        "ing-button:has-text('Log out')",
        "button:has-text('Uitloggen')",
        "button:has-text('Log out')",
    ];

    /// <summary>Where ING lands a browser it has signed out.</summary>
    public string LoggedOutPathMarker { get; init; } = "/particulier/logoff";

    /// <summary>
    /// ING's OWN sign-out call, which is the only real evidence a session
    /// ended.
    /// </summary>
    /// <remarks>
    /// Pressing the button is what makes this happen; watching for it is what
    /// turns "we clicked something" into "the session is over". The whole
    /// adapter is built on that distinction - a login is confirmed by ING
    /// asking for transactions rather than by a url - and a disconnect that
    /// says "signed out" without it would be the same lie in the other
    /// direction.
    /// <para>
    /// Latched only if ING sends it to <see cref="ApiOrigin"/>. The capture
    /// recorded the path and not the host, so the landing-page check beside it
    /// is the fallback rather than dead weight.
    /// </para>
    /// </remarks>
    public string LogoutCallPathMarker { get; init; } = "/sessions/logout";

    // ---- what to carry -----------------------------------------------------

    /// <summary>
    /// Headers NOT to repeat when this connector asks ING for one more page.
    /// Everything else ING's own client sent is carried through unchanged.
    /// </summary>
    /// <remarks>
    /// A DENYLIST, and it used to be an allowlist of six names that turned out
    /// to be a guess. The recorder was written never to read request headers,
    /// on an account with real money in it, so the capture could not say what
    /// ING sends - and the six chosen from the response side were not enough:
    /// the second live run met <c>401 Authorization Required</c> from ING's
    /// webserver on a session its own javascript was using successfully.
    /// <para>
    /// An allowlist can only carry what somebody thought of. A denylist carries
    /// ING's own request and drops the parts a page's <c>fetch</c> is not
    /// permitted to set - the browser supplies those itself, correctly, and
    /// trying to override them makes the call fail outright rather than
    /// differently.
    /// </para>
    /// <para>
    /// This may now carry an <c>authorization</c> header if ING sends one.
    /// That costs little that is not already spent - this process seals the
    /// whole cookie jar into the bundle, which is strictly more powerful than
    /// one token - but it must never be SAID: no header VALUE appears in a
    /// note, a diagnostic or an exception message anywhere in this adapter.
    /// The header NAMES are logged once, and names are not secrets.
    /// </para>
    /// </remarks>
    public IReadOnlyList<string> WithheldHeaders { get; init; } =
    [
        // Forbidden header names: a page's fetch may not set these, and the
        // browser already sends the right ones.
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
        // The browser's own identity. Overriding it is both refused and
        // pointless: this IS that browser.
        "user-agent",
    ];

    /// <summary>
    /// Is this a header the page may not set for itself?
    /// </summary>
    /// <remarks>
    /// <c>sec-</c> and <c>proxy-</c> are prefix rules rather than names, so
    /// they cannot live in the list above.
    /// </remarks>
    public bool Withheld(string name) =>
        WithheldHeaders.Contains(name, StringComparer.OrdinalIgnoreCase)
        || name.StartsWith("sec-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("proxy-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(":", StringComparison.Ordinal);

    // ---- paging ------------------------------------------------------------

    /// <summary>
    /// Forty, because that is what ING's own client asks for and what its
    /// cursor links come back carrying.
    /// </summary>
    /// <remarks>
    /// Not raised. The next-page link is ING's, cursor and all; rewriting
    /// <c>maxrec</c> inside a cursor URL would be inventing a request its own
    /// front end never makes, against a server free to have opinions about it.
    /// </remarks>
    public int PageSize { get; init; } = 40;

    /// <summary>
    /// How many pages one fetch walks before stopping and reporting itself
    /// incomplete. Twenty-five pages is a thousand transactions - about two
    /// years on the captured account.
    /// </summary>
    public int MaxPages { get; init; } = 25;

    /// <summary>Between pages we ask for ourselves.</summary>
    public int PageGapMs { get; init; } = 750;

    /// <summary>
    /// Overrides the manifest's <c>MaxRecordsPerFetch</c>, which is the budget
    /// one fetch shares between the accounts it was asked for.
    /// </summary>
    /// <remarks>
    /// Null in production, where the manifest is the single published answer.
    /// It exists as a SEAM: the way that budget goes wrong is one heavy account
    /// eating all five hundred rows and leaving every other selected account
    /// emitting nothing, and reaching five hundred rows through a fixture would
    /// mean shipping five hundred invented transactions to prove it. The same
    /// trade as <see cref="IIngPortal"/> - a seam, so the decision worth
    /// testing does not need the conditions that produce it.
    /// </remarks>
    public int? RecordCap { get; init; }

    // ---- patience ----------------------------------------------------------

    /// <summary>How long one selector is waited for.</summary>
    public int StepProbeMs { get; init; } = 8_000;

    /// <summary>
    /// How long to wait for ING's app to make its first API call after a
    /// navigation. Covers a cold agent, the bundle loading and the route
    /// mounting.
    /// </summary>
    public int ApiCallTimeoutMs { get; init; } = 45_000;

    /// <summary>
    /// How long to wait for a human to approve the sign-in in the ING app.
    /// </summary>
    /// <remarks>
    /// Four minutes, and it is the one timeout here that is about a PERSON
    /// rather than a network. ING pushes a notification to the account holder's
    /// phone and the page polls until they tap it; the capture took about a
    /// minute with the phone already in hand. Somebody who has to go and find it
    /// needs more than that, and the cost of being generous is a browser sitting
    /// idle, while the cost of being mean is a failed login and a second SCA.
    /// </remarks>
    public int AppApprovalTimeoutMs { get; init; } = 240_000;

    /// <summary>
    /// How long the "approve it in your app" card stays askable, which is a
    /// longer clock than the wait above and is NOT a UI preference.
    /// </summary>
    /// <remarks>
    /// THIS IS A DATA-LOSS GUARD. The adapter raises the challenge and stops
    /// awaiting it the moment ING's own page advances, so the card is never
    /// answered - and an unanswered challenge parks the job in
    /// <c>AwaitingInput</c> for the whole rest of the run. Only the run's own
    /// completion unparks it.
    /// <para>
    /// If the challenge expires before that completion lands, the platform's
    /// sweeper fails the job <c>challenge_expired</c> and clears its lease,
    /// after which the agent's result is refused by the owner check and
    /// discarded - a finished bank login, with a sealed session, thrown away,
    /// and not retried because a parked job has no edge back to the queue.
    /// </para>
    /// <para>
    /// So the clock has to cover the approval wait PLUS everything after it:
    /// the account lists, and sealing the cookie jar. Derived from the two
    /// budgets it must outlast rather than written down as a number, so that
    /// raising either one cannot silently reintroduce the race.
    /// </para>
    /// </remarks>
    public int ChallengeTtlMs => AppApprovalTimeoutMs + (2 * ApiCallTimeoutMs);
}
