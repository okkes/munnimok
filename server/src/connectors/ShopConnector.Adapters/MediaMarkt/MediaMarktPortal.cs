using System.Net;
using System.Text.Json;
using Connector.Kit.Browsing;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Microsoft.Playwright;

namespace ShopConnector.Adapters.MediaMarkt;

/// Url is whole: the client asks with GET, so a later page is this url with one parameter changed.
/// Headers never hold a cookie or authorization: the session stays in the browser's jar.
internal readonly record struct MediaMarktCall(
    int Status,
    string Url,
    string? Body,
    IReadOnlyDictionary<string, string>? Headers = null);

/// the media type is carried, not assumed from the name: an expired session answers a .pdf link with a sign-in page
internal sealed record MediaMarktDocument(int Status, string MediaType, byte[] Bytes, string? Filename)
{
    /// no invoice offered is NORMAL, not a drift: "Factuur aanvragen" exists on recent orders only (#430)
    public static MediaMarktDocument NotOffered { get; } = new(204, string.Empty, [], null);
}

/// behind an interface so paging, refusal and session-liveness decisions are testable without a browser or account
internal interface IMediaMarktPortal
{
    /// isPersistedQueryManifestActive is true: the server accepts only hashes from its own bundle's manifest, and the
    /// bundle id moved (ec9060f to de0feeb) within two weeks. So nothing here knows a hash: the page's own JS asks, we listen.
    Task<MediaMarktCall?> ObserveAsync(string url, string operationName, int timeoutMs, CancellationToken ct);

    /// null when the page did not do what it should, with the reason handed to note; NotOffered when the order has none
    Task<MediaMarktDocument?> InvoiceAsync(string orderId, Action<string> note, CancellationToken ct);

    /// waits WITHOUT navigating: navigating over an in-flight sign-in cancels it and reads as refused credentials;
    /// the form's redirectURL moves the app on by itself
    Task<MediaMarktCall?> WatchAsync(string operationName, int timeoutMs, CancellationToken ct);

    /// MediaMarkt renders a message into the form: quoting it tells refused credentials from a changed form
    Task<string> DescribeAsync(CancellationToken ct);

    /// through the page's own fetch: the session is the browser's cookie jar and must not be copied out
    Task<MediaMarktCall> ReadAsync(
        string url, IReadOnlyDictionary<string, string> headers, CancellationToken ct);
}

internal sealed class PageMediaMarktPortal : IMediaMarktPortal
{
    private readonly IPage _page;
    private readonly MediaMarktOptions _options;

    /// a latch, not a wait: the app fires the orders query right after sign-in, before any listener is armed;
    /// subscribed in the constructor, cleared before a navigation meant to provoke a fresh one
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

        // the body must be read while the response is alive; fire-and-forget, a gone body is latched without one
        _ = Task.Run(async () =>
        {
            string? body = null;

            try
            {
                body = await response.TextAsync().ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // the body went with the page (navigated away or torn down): latched without one
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

        // cleared so the answer is this navigation's, not an earlier latch
        _seen.TryRemove(operationName, out _);

        try
        {
            await _page.GotoAsync(url, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a superseded navigation is no failure: the latch decides whether the call happened
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

    /// capped and single-lined so a page of markup cannot land in an operator's log
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

    public async Task<MediaMarktDocument?> InvoiceAsync(string orderId, Action<string> note, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(note);
        ct.ThrowIfCancellationRequested();

        var url = _options.OrderDetailsUrlTemplate.Replace("{id}", Uri.EscapeDataString(orderId), StringComparison.Ordinal);

        try
        {
            await _page.GotoAsync(url, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded })
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            note($"order '{orderId}': its page did not open ({ex.Message})");
            return null;
        }

        if (_page.Url.Contains(_options.LoginPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            throw ConnectorException.SessionExpired(
                $"{MediaMarktAdapter.ProviderId}: the order page was answered from the sign-in page, so the " +
                "stored session is over.");
        }

        // client-rendered app: at DOMContentLoaded it is a shell, and asking for "Factuur aanvragen" then said no on
        // every order (#430); the order itself is waited for first
        if (!await AppearsAsync(Any(_options.OrderPageSelectors), _options.OrderPageMs).ConfigureAwait(false))
        {
            note($"order '{orderId}': its page never showed the order; " + await DescribeAsync(ct).ConfigureAwait(false));
            return null;
        }

        // no invoice is normal (recent orders only) and silent; the controls can trail the order block
        var request = Any(_options.RequestInvoiceSelectors);
        var link = Any(_options.DownloadInvoiceSelectors);
        if (!await AppearsAsync(Any([.. _options.RequestInvoiceSelectors, .. _options.DownloadInvoiceSelectors]), _options.InvoiceControlsMs)
                .ConfigureAwait(false))
        {
            return MediaMarktDocument.NotOffered;
        }

        if (!await VisibleAsync(link).ConfigureAwait(false) && await VisibleAsync(request).ConfigureAwait(false))
        {
            await request.ClickAsync(new LocatorClickOptions { Timeout = _options.StepProbeMs }).ConfigureAwait(false);
        }

        if (!await AppearsAsync(link, _options.InvoiceProbeMs).ConfigureAwait(false))
        {
            // the page as it stands, so a drifted selector is one log line from its fix
            note($"order '{orderId}': the invoice was asked for and no download appeared within {_options.InvoiceProbeMs} ms; " +
                 await DescribeAsync(ct).ConfigureAwait(false));
            return null;
        }

        var href = await link.GetAttributeAsync("href").ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(href)
            && !href.StartsWith('#')
            && !href.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase))
        {
            return await FetchDocumentAsync(href).ConfigureAwait(false);
        }

        try
        {
            var download = await _page.RunAndWaitForDownloadAsync(
                () => link.ClickAsync(new LocatorClickOptions { Timeout = _options.StepProbeMs }),
                new PageRunAndWaitForDownloadOptions { Timeout = _options.InvoiceProbeMs }).ConfigureAwait(false);

            var path = await download.PathAsync().ConfigureAwait(false);
            var bytes = path is null ? [] : await File.ReadAllBytesAsync(path, ct).ConfigureAwait(false);
            var name = download.SuggestedFilename;
            var mediaType = name.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)
                ? "application/pdf"
                : "application/octet-stream";

            return new MediaMarktDocument(bytes.Length > 0 ? 200 : 0, mediaType, bytes, name);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            note($"order '{orderId}': the download never started ({ex.Message})");
            return null;
        }
    }

    /// rides the browser's cookie jar, so the sign-in just done carries the download
    private async Task<MediaMarktDocument> FetchDocumentAsync(string href)
    {
        var absolute = Uri.TryCreate(href, UriKind.Absolute, out var already)
            ? already
            : new Uri(new Uri(_page.Url), href);

        var response = await _page.APIRequest
            .GetAsync(absolute.ToString(), new APIRequestContextOptions { Timeout = _options.InvoiceProbeMs })
            .ConfigureAwait(false);
        var body = await response.BodyAsync().ConfigureAwait(false);
        response.Headers.TryGetValue("content-type", out var contentType);
        var mediaType = (contentType ?? string.Empty).Split(';')[0].Trim().ToLowerInvariant();

        return new MediaMarktDocument(response.Status, mediaType, body, Path.GetFileName(absolute.AbsolutePath));
    }

    private ILocator Any(IEnumerable<string> selectors) => _page.Locator(string.Join(", ", selectors)).First;

    /// <summary>Whether it turns up visible within the budget - a wait, where <see cref="VisibleAsync"/> is a glance.</summary>
    private static async Task<bool> AppearsAsync(ILocator locator, int timeoutMs)
    {
        try
        {
            await locator.WaitForAsync(new LocatorWaitForOptions { State = WaitForSelectorState.Visible, Timeout = timeoutMs })
                .ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
        }
    }

    private static async Task<bool> VisibleAsync(ILocator locator)
    {
        try
        {
            return await locator.CountAsync().ConfigureAwait(false) > 0
                   && await locator.IsVisibleAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
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
            // page navigated or left MediaMarkt's origin: a status-less reading, not a throw, which a user would
            // see as "HTTP 500, our side"
            return new MediaMarktCall(0, url, $"<not reached: {ex.Message}>");
        }

        return new MediaMarktCall(
            answer.Int32("status") ?? 0,
            answer.Text("url") ?? url,

            // untrimmed: the response itself, a parser downstream is entitled to the provider's bytes
            answer.Child("body") is { ValueKind: JsonValueKind.String } body ? body.GetString() : null);
    }

    /// names compared case-insensitively: a browser lowercases them, a capture may not
    private Dictionary<string, string> Carried(IRequest request)
    {
        var carried = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var header in request.Headers
                     .Where(header => _options.CarriedHeaders.Contains(header.Key, StringComparer.OrdinalIgnoreCase)))
        {
            carried[header.Key] = header.Value;
        }

        return carried;
    }
}

internal static class MediaMarktCalls
{
    /// matched on path AND operation name: every call goes to one url and the orders page fires a dozen
    public static bool IsOperation(string url, string operationName, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return url is not null
               && url.Contains(options.GraphQlPath, StringComparison.OrdinalIgnoreCase)
               && string.Equals(
                   Parameter(url, "operationName"), operationName, StringComparison.Ordinal);
    }

    /// only variables is rewritten; extensions (persisted-query hash, channel config) passes through untouched
    public static string AtOffset(string url, int limit, int offset, MediaMarktOptions options)
    {
        ArgumentNullException.ThrowIfNull(url);
        ArgumentNullException.ThrowIfNull(options);

        var variables = options.VariablesTemplate
            .Replace("{0}", limit.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("{1}", offset.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);

        return Replace(url, "variables", variables);
    }

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

    /// a signed-out browser is bounced to /myaccount/auth and gets a 200 login page in HTML; judging by status alone
    /// would report a changed provider instead of an expired session
    public static string Body(
        MediaMarktCall call, MediaMarktOptions options, string what, Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        // the refusal is quoted: a gateway's 400 (GraphQL errors) names what was missing; capped and single-lined
        // so HTML cannot land in an operator's terminal
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
