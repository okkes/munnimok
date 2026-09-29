using System.Collections.Concurrent;
using System.Text.Json;
using Connector.Kit.Browsing;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Ing;

/// <summary>What one call to ING's API answered.</summary>
/// <param name="Status">The HTTP status. Zero when the call could not be made at all.</param>
/// <param name="Url">The request url, whole.</param>
/// <param name="Body">The response text, whatever it turned out to be.</param>
/// <param name="Headers">
/// The headers ING's own client sent on THIS call, minus the ones a page's
/// fetch may not set.
/// </param>
/// <param name="Seq">
/// When this call was latched, counting from the start of the run.
/// </param>
/// <remarks>
/// Headers are carried per call rather than kept in one slot on the portal,
/// because the next page of transactions is a continuation of a particular
/// request and not of whichever API call happened to answer most recently. A
/// single slot took its contents from the last 2xx to arrive, which on the live
/// run was something minimal - the first cursor page went out with
/// <c>accept-language</c> and <c>content-type</c> and nothing else, and ING's
/// webserver refused it.
/// <para>
/// <b><see cref="Seq"/> exists because "the first one" was whatever a
/// ConcurrentDictionary happened to yield.</b> The latch is keyed by url and
/// enumerated to answer
/// <see cref="IIngPortal.Seen"/>, and a dictionary promises no order at all -
/// so on a page where ING calls the same endpoint twice, <c>seen[0]</c> was an
/// arbitrary pick between them, and it decided which account list this adapter
/// read and whose headers the cursor walk repeated.
/// <para>
/// Nothing about that is visible when it goes wrong: both entries parse, both
/// look like answers, and the run reports success either way. Ordering by this
/// makes "the freshest" a thing that can be asked for rather than hoped for.
/// </para>
/// </para>
/// </remarks>
internal readonly record struct IngCall(
    int Status,
    string Url,
    string? Body,
    IReadOnlyDictionary<string, string>? Headers = null,
    long Seq = 0);

/// <summary>
/// The seam between "which pages of transactions to read" and "how to reach
/// them".
///
/// Behind an interface for the same reason MediaMarkt's and DUO's are: the
/// decisions worth testing - when to stop paging, what a refusal means, which
/// account a page belongs to - should not need a browser and somebody's real
/// bank account to exercise.
/// </summary>
internal interface IIngPortal
{
    /// <summary>
    /// Navigates, and answers with every call ING's own client made to the
    /// endpoint named by <paramref name="pathMarker"/>.
    /// </summary>
    /// <remarks>
    /// THIS IS THE WHOLE DESIGN, and the second live run widened it from the
    /// transactions feed to every list this adapter reads.
    /// <para>
    /// ING's transactions endpoint is <c>/v1/agreements/{id}/transactions</c>,
    /// and that id is encrypted per session: the same account was
    /// <c>aYDrNOy1…</c> in one login and <c>L-zdMpP6…</c> in the next. There is
    /// no way to construct the URL, so nothing here tries.
    /// </para>
    /// <para>
    /// The account lists have addresses that DO NOT move - <c>/accounts/current</c>
    /// is <c>/accounts/current</c> - and asking for them directly still failed:
    /// ING answered <c>401 Authorization Required</c> from its webserver to a
    /// request this connector composed, on a session its own javascript was
    /// using successfully at that moment. So those are observed too. Knowing an
    /// endpoint's address turns out to be a long way from being allowed to call
    /// it, and the page's own client is the only thing that reliably is.
    /// </para>
    /// </remarks>
    Task<IReadOnlyList<IngCall>> ObserveAsync(
        string url, string pathMarker, int timeoutMs, CancellationToken ct);

    /// <summary>The same wait, WITHOUT navigating.</summary>
    Task<IReadOnlyList<IngCall>> WatchAsync(string pathMarker, int timeoutMs, CancellationToken ct);

    /// <summary>
    /// What has already been latched for an endpoint, without waiting for
    /// anything.
    /// </summary>
    /// <remarks>
    /// For the calls that arrive as a SIDE EFFECT of a navigation made for
    /// something else. Landing on the download screen fetches all three account
    /// lists; only one of them is worth waiting for, and the other two are
    /// either there by then or genuinely absent - a customer with no savings
    /// account is a customer ING makes no savings call for.
    /// </remarks>
    IReadOnlyList<IngCall> Seen(string pathMarker);

    /// <summary>
    /// Waits until ING's app has made any API call at all, which is what puts
    /// the headers this connector repeats within reach.
    /// </summary>
    Task<bool> AwaitApiAsync(int timeoutMs, CancellationToken ct);

    /// <summary>
    /// Which of ING's endpoints this session touched, as bare paths.
    /// </summary>
    /// <remarks>
    /// For the question this adapter cannot answer from a payload it has:
    /// ING states no balance for a credit card in the agreement list OR in
    /// <c>/credit-cards/cards</c>, so the figure is served by some third call,
    /// and the only way to find out which without guessing is to see what its
    /// own client asked for.
    /// <para>
    /// PATHS, and only paths. No origin, no query string, and no segment that
    /// could be an identifier - see <see cref="PageIngPortal.Endpoint"/>. Which
    /// endpoints a bank exposes is not a secret; which account asked is.
    /// </para>
    /// </remarks>
    IReadOnlyList<string> Endpoints();

    /// <summary>
    /// Asks ING's API for one more thing, from inside the signed-in page,
    /// carrying the headers of the call it continues.
    /// </summary>
    /// <remarks>
    /// Through the page's own <c>fetch</c> rather than an HTTP client, because
    /// the session IS the browser's cookie jar and this is the only way to spend
    /// it without copying it anywhere.
    /// </remarks>
    Task<IngCall> ReadAsync(
        string path, IReadOnlyDictionary<string, string>? headers, CancellationToken ct);

    /// <summary>
    /// Where the browser ended up and what it is showing, for a failure message
    /// that names something.
    /// </summary>
    Task<string> DescribeAsync(CancellationToken ct);
}

/// <summary>ING's API, read from inside the signed-in page.</summary>
internal sealed partial class PageIngPortal : IIngPortal
{
    private readonly IPage _page;
    private readonly IngOptions _options;

    /// <summary>
    /// Every answer ING's own client received from its API, latched as it
    /// arrives, keyed by request url.
    /// </summary>
    /// <remarks>
    /// A LATCH RATHER THAN A WAIT, because the calls this adapter cares about
    /// can easily land before anything is waiting for them: a route mounts and
    /// fires immediately, and a listener armed after that waits out its whole
    /// budget for a call that will not come again.
    /// <para>
    /// Keyed by url and kept as a set rather than one slot per endpoint,
    /// because an account holder with two current accounts gets two
    /// transactions calls from one navigation and only one would survive a
    /// single-value latch.
    /// </para>
    /// </remarks>
    private readonly ConcurrentDictionary<string, IngCall> _seen = new(StringComparer.Ordinal);

    /// <summary>How many calls have been latched, so "the freshest" has a meaning.</summary>
    private long _latched;

    /// <summary>
    /// True once ING's own client has called its API at all.
    /// </summary>
    private volatile bool _apiSeen;

    public PageIngPortal(IPage page, IngOptions options)
    {
        _page = page;
        _options = options;
        _page.Response += OnResponse;
    }

    private void OnResponse(object? sender, IResponse response)
    {
        if (!response.Url.StartsWith(_options.ApiOrigin, StringComparison.OrdinalIgnoreCase)) return;

        _apiSeen = true;

        // The body has to be read while the response is still alive, so this
        // cannot wait until somebody asks. Fire-and-forget on purpose: a body
        // that has gone is latched without one, and the status and url still
        // say plenty.
        _ = Task.Run(async () =>
        {
            string? body = null;
            IReadOnlyDictionary<string, string>? headers = null;

            try
            {
                body = await response.TextAsync().ConfigureAwait(false);

                // AllHeadersAsync, NOT Request.Headers. The synchronous view is
                // documented to withhold security-related headers, and on the
                // live run it withheld everything that mattered: the first
                // cursor page went out carrying accept-language and
                // content-type, and ING's webserver answered 401.
                headers = Carry(await response.Request.AllHeadersAsync().ConfigureAwait(false), _options);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // The response is gone - the page moved on, or the driver
                // dropped it - so this call is latched without a body, as
                // promised above: the status and url still say plenty.
            }

            _seen[response.Request.Url] = new IngCall(
                response.Status, response.Request.Url, body, headers, Interlocked.Increment(ref _latched));
        });
    }

    /// <summary>
    /// Does this url name the endpoint being waited for?
    /// </summary>
    /// <remarks>
    /// The marker has to match the path and stop at its end, because ING hangs
    /// other endpoints off the same stems: <c>/transactions/search</c> answers a
    /// different question from <c>/transactions</c>, and
    /// <c>/accounts/current</c> shares a prefix with
    /// <c>/accounts/all/transactions/reports/history</c>.
    /// </remarks>
    public static bool Matches(string? url, string pathMarker)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pathMarker);

        if (url is null) return false;

        var at = url.IndexOf(pathMarker, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return false;

        var after = at + pathMarker.Length;

        return after >= url.Length || url[after] == '?';
    }

    private const string FetchScript = """
    async ([url, headers]) => {
      try {
        const response = await fetch(url, {
          // INCLUDE, not same-origin: ING's app runs on mijn.ing.nl and its
          // API is api.mijn.ing.nl, so same-origin would send no cookies at
          // all and every call would come back unauthenticated.
          credentials: 'include',
          headers: Object.assign({ 'Accept': 'application/json' }, headers),
        });

        return { status: response.status, url: response.url, body: await response.text() };
      } catch (e) {
        return { status: 0, url, body: '<not reached: ' + e.message + '>' };
      }
    }
    """;

    public async Task<IReadOnlyList<IngCall>> ObserveAsync(
        string url, string pathMarker, int timeoutMs, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Only this endpoint is cleared, not the whole latch. A fetch visits two
        // pages - the overview for transactions, then the download screen for
        // the account lists - and clearing everything on the second navigation
        // would throw away the transactions the first one just produced.
        foreach (var latched in _seen.Keys.Where(key => Matches(key, pathMarker)).ToList())
        {
            _seen.TryRemove(latched, out _);
        }

        try
        {
            await _page.GotoAsync(url, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // A navigation that was superseded is not a failure by itself - the
            // latch below is what decides whether the call happened.
        }

        return await WatchAsync(pathMarker, timeoutMs, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Waits for the first answer from an endpoint, then for a moment longer.
    /// </summary>
    /// <remarks>
    /// The extra moment is not padding. One navigation produces one transactions
    /// call PER CURRENT ACCOUNT, and they do not arrive together; returning on
    /// the first would quietly read one account and report the other as having
    /// no transactions at all - which looks exactly like an account with no
    /// transactions.
    /// </remarks>
    public async Task<IReadOnlyList<IngCall>> WatchAsync(
        string pathMarker, int timeoutMs, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (Seen(pathMarker) is { Count: > 0 })
            {
                await Task.Delay(SettleMs, ct).ConfigureAwait(false);
                return Seen(pathMarker);
            }

            if (DateTimeOffset.UtcNow >= deadline) return [];

            await Task.Delay(PollMs, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Every latched call for an endpoint, NEWEST FIRST.
    /// </summary>
    /// <remarks>
    /// Ordered, because callers take the first one and the store underneath is
    /// a <see cref="ConcurrentDictionary{TKey, TValue}"/> that promises no order
    /// whatsoever. On a page where ING calls the same endpoint twice - a
    /// refresh, a widget asking for its own slice - "the first" was an
    /// arbitrary pick, and it decided which account list was read and whose
    /// headers the cursor walk repeated.
    /// <para>
    /// Newest rather than oldest: a second call to the same endpoint is a
    /// later answer to the same question, and the later one is the one ING's
    /// own page is showing.
    /// </para>
    /// </remarks>
    public IReadOnlyList<IngCall> Seen(string pathMarker) =>
        Freshest(_seen.Where(entry => Matches(entry.Key, pathMarker)).Select(entry => entry.Value));

    /// <summary>
    /// The same calls, newest first.
    /// </summary>
    /// <remarks>
    /// Its own method so the claim can be tested: <see cref="Seen"/> needs a
    /// live <c>IPage</c> to reach, and the ordering is the part that decides
    /// which answer this adapter believes.
    /// </remarks>
    internal static IReadOnlyList<IngCall> Freshest(IEnumerable<IngCall> calls) =>
        [.. calls.OrderByDescending(call => call.Seq)];

    public IReadOnlyList<string> Endpoints() =>
        [.. _seen.Keys.Select(Endpoint).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];

    /// <summary>
    /// A url cut down to the endpoint it names, and nothing that says whose.
    /// </summary>
    /// <remarks>
    /// The origin and the query string go entirely, and so does any segment
    /// that could be an identifier: ING's transactions path carries an
    /// agreement id encrypted per session, and a card or account number is not
    /// something to write into a log at all.
    /// <para>
    /// A SEGMENT IS KEPT ONLY IF IT LOOKS LIKE A WORD, rather than dropped only
    /// if it looks like an identifier, because the whole point of this is to
    /// find an endpoint whose name nobody here knows yet - an allowlist would
    /// hide the one thing it is for. ING's path words are lowercase and
    /// hyphenated (<c>credit-cards</c>, <c>transactions</c>), and its
    /// identifiers are not: a card number is digits, an account number is
    /// digits, and the agreement id is a mixed-case encrypted blob. So a digit
    /// or a capital letter anywhere in a segment is enough to lose it, with
    /// <c>v1</c> exempted because a version marker is part of the address.
    /// </para>
    /// <para>
    /// The limit worth stating: an identifier that is entirely lowercase
    /// letters and hyphens is indistinguishable from a path word by shape and
    /// would survive. Nothing ING sends looks like that, and no rule that keeps
    /// unknown words can also catch it.
    /// </para>
    /// </remarks>
    public static string Endpoint(string url)
    {
        ArgumentNullException.ThrowIfNull(url);

        var query = url.IndexOf('?', StringComparison.Ordinal);
        var whole = query < 0 ? url : url[..query];

        var origin = whole.IndexOf("://", StringComparison.Ordinal);
        var path = origin < 0 ? whole : whole[(origin + 3)..];
        var root = path.IndexOf('/', StringComparison.Ordinal);

        path = root < 0 ? "/" : path[root..];

        return string.Join('/', path.Split('/').Select(Segment));
    }

    /// <summary>
    /// One piece of a url, kept only if it reads as a word.
    /// </summary>
    /// <remarks>
    /// Public because a link's <c>rel</c> needs the same treatment as a path
    /// segment and for the same reason: it is about to be written into a log,
    /// and nothing here has established what a bank will one day put in one.
    /// <para>
    /// The empty segment is kept: a path starts with a slash, so splitting one
    /// puts an empty string in front of every real segment, and eliding that
    /// would make every endpoint read as an identifier.
    /// </para>
    /// </remarks>
    public static string Segment(string segment) =>
        segment.Length == 0 || Version().IsMatch(segment) || WordShape().IsMatch(segment) ? segment : "…";

    [System.Text.RegularExpressions.GeneratedRegex(
        "^v[0-9]{1,2}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex Version();

    [System.Text.RegularExpressions.GeneratedRegex(
        "^[a-z][a-z-]{0,19}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex WordShape();

    public async Task<bool> AwaitApiAsync(int timeoutMs, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (_apiSeen) return true;

            if (DateTimeOffset.UtcNow >= deadline) return false;

            await Task.Delay(PollMs, ct).ConfigureAwait(false);
        }
    }

    public async Task<IngCall> ReadAsync(
        string path, IReadOnlyDictionary<string, string>? headers, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var url = path.StartsWith("http", StringComparison.OrdinalIgnoreCase)
            ? path
            : _options.ApiOrigin + path;

        JsonElement answer;

        try
        {
            answer = await _page
                .EvaluateAsync<JsonElement>(
                    FetchScript,
                    new object[] { url, headers ?? new Dictionary<string, string>(StringComparer.Ordinal) })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // The page navigated under us, or is no longer on ING's origin so
            // the browser refused outright. A reading with no status, not an
            // exception - thrown, this reaches a user as "something broke on our
            // side, HTTP 500", which is both unhelpful and untrue.
            return new IngCall(0, url, $"<not reached: {ex.Message}>");
        }

        return new IngCall(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // Untrimmed, unlike everything else read here: this is the response
            // itself, and a parser downstream is entitled to the bytes the
            // provider sent rather than a tidied copy of them.
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null);
    }

    /// <summary>
    /// The page's address and what it is showing, THROUGH THE SHADOW ROOTS.
    /// </summary>
    /// <remarks>
    /// ING's whole interface is custom elements - <c>ing-form</c>,
    /// <c>ing-auth-input</c>, <c>ing-button</c> - and a plain
    /// <c>document.querySelectorAll('h1,h2')</c> on this site returns an empty
    /// list. The first capture attempt reported "0 inputs" on the sign-in form
    /// for exactly that reason, and a diagnostic that confidently says a page is
    /// empty is worse than no diagnostic.
    /// <para>
    /// Field VALUES are never read - only the type and the name - because this
    /// runs on a page a password was just typed into.
    /// </para>
    /// </remarks>
    private const string DescribeScript = """
    () => {
      const roots = [document];
      const walk = (root, depth) => {
        if (depth > 8 || roots.length > 500) return;
        let all;
        try { all = root.querySelectorAll('*'); } catch (e) { return; }
        for (const el of all) {
          if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
        }
      };
      walk(document, 0);

      const pick = selector => {
        const out = [];
        for (const root of roots) {
          let els;
          try { els = root.querySelectorAll(selector); } catch (e) { continue; }
          for (const el of els) out.push(el);
        }
        return out;
      };

      const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      // CAPPED, because ING wraps an inline script in its own <h1>: the
      // loading screen's heading reads "Een moment..." followed by two
      // thousand characters of minified javascript, and textContent returns
      // all of it. An uncapped diagnostic puts that in an operator's log.
      //
      // Confirmed on 2026-08-13 by running THIS script - extracted from this
      // file, not copied - against the live sign-in page: 80 characters during
      // the loading screen, "Inloggen via je app" once it settles. The offline
      // suite cannot reach here, because there is no page without a browser.
      const text = el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);

      const said = pick('[role=alert], [class*=error i], [id*=error i], [class*=notification i]')
        .filter(vis).map(text).filter(t => t.length > 2 && t.length < 200);

      return {
        url: location.href,
        title: document.title,
        headings: [...new Set(pick('h1,h2').filter(vis).map(text).filter(Boolean))].slice(0, 4),
        said: [...new Set(said)].slice(0, 4),
        fields: pick('input').filter(vis)
          .map(i => i.getAttribute('type') + ':' + (i.getAttribute('name') || i.id || '?')).slice(0, 8),
      };
    }
    """;

    public async Task<string> DescribeAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            var shape = await _page.EvaluateAsync<JsonElement>(DescribeScript).ConfigureAwait(false);

            static string Join(JsonElement parent, string name) =>
                string.Join(" | ", parent.Items(name).Select(v => v.Text()));

            var url = shape.Text("url") ?? _page.Url;
            var said = Join(shape, "said");
            var headings = Join(shape, "headings");
            var fields = Join(shape, "fields");

            return $"at {url}"
                   + (headings.Length > 0 ? $"; showing '{headings}'" : string.Empty)
                   + (said.Length > 0 ? $"; it says '{said}'" : string.Empty)
                   + (fields.Length > 0 ? $"; inputs [{fields}]" : string.Empty);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return $"at {_page.Url} (the page could not be read: {ex.Message})";
        }
    }

    /// <summary>
    /// ING's own headers, minus the ones a page's fetch may not set.
    /// </summary>
    /// <remarks>
    /// A denylist, because an allowlist can only carry what somebody thought
    /// of - and the six names guessed from the response side were not enough to
    /// get past ING's edge. See <see cref="IngOptions.WithheldHeaders"/>.
    /// <para>
    /// Taken apart from the request so the rule can be exercised without a
    /// browser. Everything else in this class needs a real page; this is the
    /// one piece that decides what a call carries, and leaving it unreachable
    /// meant an inverted comparison here would have passed the whole suite.
    /// </para>
    /// </remarks>
    public static Dictionary<string, string> Carry(
        IEnumerable<KeyValuePair<string, string>> headers, IngOptions options)
    {
        ArgumentNullException.ThrowIfNull(headers);
        ArgumentNullException.ThrowIfNull(options);

        var carried = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var header in headers.Where(header => !options.Withheld(header.Key)))
        {
            carried[header.Key] = header.Value;
        }

        return carried;
    }

    private const int PollMs = 250;

    /// <summary>
    /// How long to keep listening after the first transactions answer, for the
    /// second account's.
    /// </summary>
    private const int SettleMs = 2_000;
}
