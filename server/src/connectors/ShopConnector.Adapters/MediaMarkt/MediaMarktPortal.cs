using System.Net;
using System.Text.Json;
using Connector.Kit.Browsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>What one call to MediaMarkt's GraphQL endpoint answered.</summary>
/// <param name="Status">The HTTP status. Zero when the call could not be made at all.</param>
/// <param name="Url">
/// The request url, whole. This is the field the walk pages with: the client
/// asks with GET, so the operation, its persisted hash and its variables are
/// all in here, and a later page is this url with one parameter changed.
/// </param>
/// <param name="Body">The response text, whatever it turned out to be.</param>
/// <param name="Headers">
/// The request headers MediaMarkt's own client sent, filtered to the ones worth
/// repeating. Never a cookie and never an authorization: the session travels in
/// the browser's own jar and this process never holds it.
/// </param>
internal readonly record struct MediaMarktCall(
    int Status,
    string Url,
    string? Body,
    IReadOnlyDictionary<string, string>? Headers = null);

/// <summary>
/// The seam between "which pages of orders to read" and "how to reach them".
///
/// Behind an interface for the same reason DUO's is: the decisions worth
/// testing - when to stop paging, what a refusal means, whether a session is
/// really alive - should not need a browser and somebody's real MediaMarkt
/// account to exercise.
/// </summary>
internal interface IMediaMarktPortal
{
    /// <summary>
    /// Navigates, and answers with the operation's OWN call once the page makes
    /// it - the request url, the headers it carried and the body it received.
    /// </summary>
    /// <remarks>
    /// THIS IS THE WHOLE DESIGN, and it is what makes MediaMarkt buildable at
    /// all.
    /// <para>
    /// The storefront runs with <c>isPersistedQueryManifestActive: true</c>: the
    /// server accepts only query hashes from the manifest its own bundle ships,
    /// and rejects a document we write ourselves. Extracting the hash from that
    /// bundle would work exactly until the next front-end deploy - the bundle id
    /// moved from <c>ec9060f</c> to <c>de0feeb</c> between two checks two weeks
    /// apart.
    /// <para>
    /// So nothing here knows a hash. The page is asked to load, MediaMarkt's own
    /// javascript asks its own question with its own current hash, and this
    /// listens. Rotation becomes MediaMarkt's problem, which is where it
    /// belongs.
    /// </para>
    /// </para>
    /// </remarks>
    Task<MediaMarktCall?> ObserveAsync(string url, string operationName, int timeoutMs, CancellationToken ct);

    /// <summary>
    /// The same wait, WITHOUT navigating: watches the page the browser is
    /// already on until it makes the call, or the budget runs out.
    /// </summary>
    /// <remarks>
    /// This is the correction the first live run forced. Login used to submit
    /// the form and then call <see cref="ObserveAsync"/>, which navigates - and
    /// navigating on top of a sign-in that is still in flight cancels it. The
    /// browser dutifully arrived at the orders page as an anonymous visitor,
    /// was bounced to the login form, never asked for orders, and the adapter
    /// reported the credentials as refused. They were not; they were
    /// interrupted.
    /// <para>
    /// MediaMarkt's form already carries <c>redirectURL=/nl/myaccount/orders</c>,
    /// so the app navigates itself once the sign-in completes. The right thing
    /// to do after pressing the button is nothing at all.
    /// </para>
    /// </remarks>
    Task<MediaMarktCall?> WatchAsync(string operationName, int timeoutMs, CancellationToken ct);

    /// <summary>
    /// Where the browser ended up and what it is showing, for a failure message
    /// that names something.
    /// </summary>
    /// <remarks>
    /// "Either the credentials were refused or the form has changed" is the
    /// kind of sentence that costs a live sign-in to get past, and this
    /// adapter shipped one. The page states which it is - MediaMarkt renders a
    /// message into the form - and a diagnostic that quotes it turns a second
    /// attempt into a decision.
    /// </remarks>
    Task<string> DescribeAsync(CancellationToken ct);

    /// <summary>
    /// Asks for one more page, from inside the signed-in page.
    /// </summary>
    /// <remarks>
    /// Through the page's own <c>fetch</c> rather than an HTTP client, because
    /// the session IS the browser's cookie jar and this is the only way to spend
    /// it without copying it anywhere. It is also the same request the SPA makes
    /// from the same origin, so nothing here is a shape MediaMarkt does not
    /// already serve.
    /// </remarks>
    Task<MediaMarktCall> ReadAsync(
        string url, IReadOnlyDictionary<string, string> headers, CancellationToken ct);
}

/// <summary>MediaMarkt's GraphQL endpoint, read from inside the signed-in page.</summary>
internal sealed class PageMediaMarktPortal : IMediaMarktPortal
{
    private readonly IPage _page;
    private readonly MediaMarktOptions _options;

    /// <summary>
    /// The most recent answer to each operation, latched as it arrives.
    /// </summary>
    /// <remarks>
    /// A LATCH RATHER THAN A WAIT, because the call this adapter cares about
    /// can easily land before anything is waiting for it. MediaMarkt's app
    /// redirects itself after a sign-in and fires the orders query
    /// immediately; a listener armed after that has already missed it and
    /// waits out its whole budget for a call that will not come again.
    /// <para>
    /// Subscribed in the constructor so the window is open from the moment the
    /// portal exists, and cleared explicitly before a navigation that is meant
    /// to provoke a fresh one.
    /// </para>
    /// </remarks>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, MediaMarktCall> _seen =
        new(StringComparer.Ordinal);

    public PageMediaMarktPortal(IPage page, MediaMarktOptions options)
    {
        _page = page;
        _options = options;
        _page.Response += OnResponse;
    }

    private void OnResponse(object? sender, IResponse response)
    {
        if (!response.Url.Contains(_options.GraphQlPath, StringComparison.OrdinalIgnoreCase)) return;
        if (MediaMarktCalls.Parameter(response.Url, "operationName") is not { } operation) return;

        // The body has to be read while the response is still alive, so this
        // cannot wait until somebody asks. Fire-and-forget on purpose: a body
        // that has gone is latched without one, and the status and url still
        // say plenty.
        _ = Task.Run(async () =>
        {
            string? body = null;

            try
            {
                body = await response.TextAsync().ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
            }

            _seen[operation] = new MediaMarktCall(
                response.Status, response.Request.Url, body, Carried(response.Request));
        });
    }

    private const string FetchScript = """
    async ([url, headers]) => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          headers: Object.assign({ 'Accept': '*/*' }, headers),
        });

        return { status: response.status, url: response.url, body: await response.text() };
      } catch (e) {
        return { status: 0, url, body: '<not reached: ' + e.message + '>' };
      }
    }
    """;

    public async Task<MediaMarktCall?> ObserveAsync(
        string url, string operationName, int timeoutMs, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Cleared first, so what comes back is this navigation's answer rather
        // than one latched before it.
        _seen.TryRemove(operationName, out _);

        try
        {
            await _page.GotoAsync(url, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // A navigation that was superseded is not a failure by itself -
            // the latch below is what decides whether the call happened.
        }

        return await WatchAsync(operationName, timeoutMs, ct).ConfigureAwait(false);
    }

    public async Task<MediaMarktCall?> WatchAsync(string operationName, int timeoutMs, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow.AddMilliseconds(timeoutMs);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (_seen.TryGetValue(operationName, out var call)) return call;

            if (DateTimeOffset.UtcNow >= deadline) return null;

            await Task.Delay(250, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The page's address, and any message it is showing, capped and
    /// single-lined so a page of markup cannot land in an operator's log.
    /// </summary>
    private const string DescribeScript = """
    () => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text = el => (el.textContent || '').trim().replace(/\s+/g, ' ');

      const said = [...document.querySelectorAll(
        '[role=alert], [data-test*=error i], [class*=error i], [id*=error i], [class*=alert i]')]
        .filter(vis).map(text).filter(t => t.length > 2 && t.length < 200);

      return {
        url: location.href,
        title: document.title,
        headings: [...document.querySelectorAll('h1,h2')].filter(vis).map(text).filter(Boolean).slice(0, 4),
        said: [...new Set(said)].slice(0, 4),
        fields: [...document.querySelectorAll('input')].filter(vis)
          .map(i => i.getAttribute('type') + ':' + (i.id || i.getAttribute('name') || '?')).slice(0, 8),
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

    public async Task<MediaMarktCall> ReadAsync(
        string url, IReadOnlyDictionary<string, string> headers, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        JsonElement answer;

        try
        {
            answer = await _page
                .EvaluateAsync<JsonElement>(FetchScript, new object[] { url, headers })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // The page navigated under us, or is no longer on MediaMarkt's
            // origin so the browser refused outright. A reading with no status,
            // not an exception - thrown, this reaches a user as "something broke
            // on our side, HTTP 500", which is both unhelpful and untrue.
            return new MediaMarktCall(0, url, $"<not reached: {ex.Message}>");
        }

        return new MediaMarktCall(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // Untrimmed, unlike everything else read here: this is the response
            // itself, and a parser downstream is entitled to the bytes the
            // provider sent rather than a tidied copy of them.
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null);
    }

    /// <summary>
    /// The client's own headers, filtered to the allowlist. Names are compared
    /// case-insensitively because a browser lowercases them and a capture does
    /// not promise to.
    /// </summary>
    private Dictionary<string, string> Carried(IRequest request)
    {
        var carried = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var header in request.Headers)
        {
            if (_options.CarriedHeaders.Contains(header.Key, StringComparer.OrdinalIgnoreCase))
            {
                carried[header.Key] = header.Value;
            }
        }

        return carried;
    }
}

/// <summary>
/// What this connector asks MediaMarkt for, and what an answer means.
/// </summary>
internal static class MediaMarktCalls
{
    /// <summary>
    /// Is this response the operation we are waiting for?
    /// </summary>
    /// <remarks>
    /// Matched on the path AND the operation name, because every call on this
    /// site goes to the same url and the orders page fires a dozen of them -
    /// the header, the consent categories, a recommendations block. A predicate
    /// on the path alone returns whichever arrived first.
    /// </remarks>
    public static bool IsOperation(string url, string operationName, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return url is not null
               && url.Contains(options.GraphQlPath, StringComparison.OrdinalIgnoreCase)
               && string.Equals(
                   Parameter(url, "operationName"), operationName, StringComparison.Ordinal);
    }

    /// <summary>
    /// The same call, asking for a different slice.
    /// </summary>
    /// <remarks>
    /// Only <c>variables</c> is rewritten. <c>extensions</c> carries the
    /// persisted-query hash and MediaMarkt's own channel configuration and is
    /// passed through untouched - it is the part that must stay exactly as the
    /// client sent it, and the part this connector deliberately does not
    /// understand.
    /// </remarks>
    public static string AtOffset(string url, int limit, int offset, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(url);
        ArgumentNullException.ThrowIfNull(options);

        var variables = options.VariablesTemplate
            .Replace("{0}", limit.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("{1}", offset.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);

        return Replace(url, "variables", variables);
    }

    /// <summary>Reads one query parameter, decoded. Null when it is not there.</summary>
    public static string? Parameter(string url, string name)
    {
        ArgumentNullException.ThrowIfNull(url);

        var query = url.IndexOf('?', StringComparison.Ordinal);
        if (query < 0) return null;

        foreach (var pair in url[(query + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = pair.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0) continue;

            if (pair[..equals].Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return WebUtility.UrlDecode(pair[(equals + 1)..]);
            }
        }

        return null;
    }

    private static string Replace(string url, string name, string value)
    {
        var query = url.IndexOf('?', StringComparison.Ordinal);

        if (query < 0) return url + "?" + name + "=" + WebUtility.UrlEncode(value);

        var found = false;

        var rebuilt = url[(query + 1)..]
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair =>
            {
                var equals = pair.IndexOf('=', StringComparison.Ordinal);
                if (equals < 0) return pair;
                if (!pair[..equals].Equals(name, StringComparison.OrdinalIgnoreCase)) return pair;

                found = true;
                return name + "=" + WebUtility.UrlEncode(value);
            })
            .ToList();

        if (!found) rebuilt.Add(name + "=" + WebUtility.UrlEncode(value));

        return url[..query] + "?" + string.Join("&", rebuilt);
    }

    /// <summary>
    /// Turns a reading into either a body or the right exception.
    /// </summary>
    /// <remarks>
    /// A signed-out browser does not get a 401 here - it gets bounced to
    /// <c>/myaccount/auth</c> and served the login page, which arrives as a
    /// perfectly successful response carrying HTML. A reader that only looked at
    /// the status would hand that to the JSON parser and report a changed
    /// provider when the truth is an expired session and a sign-in button.
    /// </remarks>
    public static string Body(
        MediaMarktCall call, MediaMarktOptions options, string what, Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        // THE REFUSAL ITSELF, QUOTED.
        //
        // A gateway that refuses a call usually says what was missing, and that
        // sentence is the difference between another live run and an answer.
        // This adapter's first fetch died on "page 2 answered 400 with 406
        // characters" - 406 characters that named the problem exactly and that
        // nobody could read. GraphQL states its errors in the body on a 400,
        // and they are error text rather than anybody's data.
        //
        // Capped and single-lined so a page of HTML cannot land in an
        // operator's terminal.
        if (call.Status is < 200 or > 299 && !string.IsNullOrWhiteSpace(call.Body))
        {
            var quoted = call.Body.Length > 400 ? call.Body[..400] : call.Body;

            note?.Invoke(
                $"{MediaMarktAdapter.ProviderId}: {what} refused with: {quoted.ReplaceLineEndings(" ")}");
        }

        if (call.Url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            throw ConnectorException.SessionExpired(
                $"{MediaMarktAdapter.ProviderId}: {what} was answered from the sign-in page rather than the " +
                "store, so the stored session is over.");
        }

        if (call.Status is 401 or 403)
        {
            throw ConnectorException.SessionExpired(
                $"{MediaMarktAdapter.ProviderId}: {what} answered {call.Status}. That is either an expired " +
                "session or Cloudflare refusing this browser; both need a person at a sign-in.");
        }

        if (call.Status is < 200 or > 299 || string.IsNullOrWhiteSpace(call.Body))
        {
            throw ConnectorException.ProviderChanged(
                $"{MediaMarktAdapter.ProviderId}: {what} answered {call.Status} with " +
                $"{call.Body?.Length ?? 0} characters");
        }

        return call.Body;
    }
}
