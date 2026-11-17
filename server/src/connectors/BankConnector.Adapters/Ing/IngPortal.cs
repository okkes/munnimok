using System.Collections.Concurrent;
using System.Text.Json;
using Connector.Kit.Browsing;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Ing;

// Status 0: the call could not be made. Headers are per call, not one slot: a single slot took the last 2xx's
// and ING's webserver refused the page. Seq orders latched calls: a ConcurrentDictionary promises no order,
// so seen[0] was an arbitrary pick
internal readonly record struct IngCall(
    int Status,
    string Url,
    string? Body,
    IReadOnlyDictionary<string, string>? Headers = null,
    long Seq = 0);

/// the seam: when to stop paging, what a refusal means and which account a page belongs to are testable without a browser
internal interface IIngPortal
{
    /// the whole design: the transactions id is encrypted per session so the URL cannot be built, and composed requests
    /// to the fixed-address account lists got 401 from ING's webserver on a live session; only the page's own client
    /// is let through, so every list is observed
    Task<IReadOnlyList<IngCall>> ObserveAsync(
        string url, string pathMarker, int timeoutMs, CancellationToken ct);

    /// <summary>The same wait, WITHOUT navigating.</summary>
    Task<IReadOnlyList<IngCall>> WatchAsync(string pathMarker, int timeoutMs, CancellationToken ct);

    /// for calls that arrive as a side effect of another navigation: a customer without savings is one ING makes
    /// no savings call for
    IReadOnlyList<IngCall> Seen(string pathMarker);

    /// puts the headers this connector repeats within reach
    Task<bool> AwaitApiAsync(int timeoutMs, CancellationToken ct);

    /// finds a card's balance endpoint without guessing; PATHS only (see PageIngPortal.Endpoint): which endpoints a bank
    /// exposes is not a secret, which account asked is
    IReadOnlyList<string> Endpoints();

    /// through the page's own fetch: the session is the browser's cookie jar and this spends it without copying it
    Task<IngCall> ReadAsync(
        string path, IReadOnlyDictionary<string, string>? headers, CancellationToken ct);

    Task<string> DescribeAsync(CancellationToken ct);
}

internal sealed partial class PageIngPortal : IIngPortal
{
    private readonly IPage _page;
    private readonly IngOptions _options;

    /// a latch, not a wait: calls can land before anything waits (a route fires on mount); kept as a set per url since
    /// two current accounts make two transactions calls
    private readonly ConcurrentDictionary<string, IngCall> _seen = new(StringComparer.Ordinal);

    private long _latched;

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

        // the body must be read while the response is alive; fire-and-forget, a gone body is latched without one
        _ = Task.Run(async () =>
        {
            string? body = null;
            IReadOnlyDictionary<string, string>? headers = null;

            try
            {
                body = await response.TextAsync().ConfigureAwait(false);

                // AllHeadersAsync, NOT Request.Headers: the synchronous view withholds security headers, and the first cursor page
                // went out without what ING needed (401)
                headers = Carry(await response.Request.AllHeadersAsync().ConfigureAwait(false), _options);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // response gone (page moved on or driver dropped it): latched without a body
            }

            _seen[response.Request.Url] = new IngCall(
                response.Status, response.Request.Url, body, headers, Interlocked.Increment(ref _latched));
        });
    }

    /// match the path and stop at its end: /transactions/search is another question than /transactions, and
    /// /accounts/current shares a prefix with /accounts/all/transactions/reports/history
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

        // clear only this endpoint: a fetch visits two pages, and clearing all would drop the first page's transactions
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
            // a superseded navigation is not a failure: the latch decides whether the call happened
        }

        return await WatchAsync(pathMarker, timeoutMs, ct).ConfigureAwait(false);
    }

    /// the extra settle is not padding: one navigation makes a transactions call PER CURRENT ACCOUNT, arriving apart,
    /// and returning on the first would report the other as having no transactions
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

    /// newest first: the store promises no order and callers take the first; on a twice-called endpoint "first" was
    /// arbitrary, and the later call is what ING's page shows
    public IReadOnlyList<IngCall> Seen(string pathMarker) =>
        Freshest(_seen.Where(entry => Matches(entry.Key, pathMarker)).Select(entry => entry.Value));

    /// its own method so the ordering, which decides which answer is believed, is testable without an IPage
    internal static IReadOnlyList<IngCall> Freshest(IEnumerable<IngCall> calls) =>
        [.. calls.OrderByDescending(call => call.Seq)];

    public IReadOnlyList<string> Endpoints() =>
        [.. _seen.Keys.Select(Endpoint).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];

    /// drops origin, query and any segment that could be an identifier; a segment survives only if it looks like a word
    /// (lowercase, hyphenated, v1 exempt) so unknown endpoint names are kept. Limit: an all-lowercase identifier would pass
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

    /// public because a link's rel is logged too; the empty segment is kept, else every path's leading slash
    /// would read as an identifier
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
            // the page navigated or left ING's origin: a reading with no status, not an exception, which would reach a user as HTTP 500
            return new IngCall(0, url, $"<not reached: {ex.Message}>");
        }

        return new IngCall(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // untrimmed: this is the response itself, and a parser downstream is entitled to the provider's bytes
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null);
    }

    /// ING's UI is custom elements in shadow roots, so plain querySelectorAll finds nothing (the first capture reported
    /// "0 inputs"); field VALUES are never read, a password was just typed there
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

    /// a denylist (see IngOptions.WithheldHeaders); split out so the rule is testable without a browser: an inverted
    /// comparison would otherwise pass the suite
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

    /// keeps listening for the second account's transactions answer
    private const int SettleMs = 2_000;
}
