using System.Net;
using Connector.Kit.Errors;
using Microsoft.Playwright;
using ShopConnector.Adapters.Support;
using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.Amazon;

// status is kept: on this provider a 200 can be a bot wall and so can a 503, and they need different answers
internal readonly record struct AmazonPage(string Url, int Status, string Html);

// the seam: below it needs a real Chromium and account, above it (walk, guard, challenge policy, parsing, money)
// runs from a recorded page
internal interface IAmazonPages
{
    Task<AmazonPage> OpenAsync(string url, CancellationToken ct);

    // an XHR with the browser's cookies: /your-orders/invoice/popover exists only as an AJAX response,
    // navigating to it returns nothing
    Task<string> FragmentAsync(string url, CancellationToken ct);

    // bytes, not navigation: navigating to a PDF hits Chromium's download machinery
    // (a saved file, or "Download is starting" aborting the run)
    Task<AmazonDownload> DownloadAsync(string url, CancellationToken ct);
}

// the media type is carried, not assumed from the URL: a challenge answers HTML from a path ending in .pdf
internal readonly record struct AmazonDownload(int Status, string MediaType, byte[] Bytes);

// Uri.TryCreate(url, Absolute) is true for "/documents/x/invoice.pdf" on Linux (a rooted file path -> file:///…, ? escaped),
// so every invoice fetch died on 'Protocol "file:"' while navigation worked: an absolute URI must also be http(s)
internal static class AmazonUrl
{
    // resolved against the page, not a configured base, so a storefront answering from another host is followed
    public static string Resolve(string? pageUrl, string href)
    {
        ArgumentNullException.ThrowIfNull(href);

        if (Uri.TryCreate(href, UriKind.Absolute, out var already) && IsWeb(already))
        {
            return already.ToString();
        }

        return Uri.TryCreate(pageUrl, UriKind.Absolute, out var page)
               && Uri.TryCreate(page, href, out var resolved)
               && IsWeb(resolved)
            ? resolved.ToString()
            // unchanged, so the caller's error quotes what it was given
            : href;
    }

    private static bool IsWeb(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
}

// no pacing here: it lives in AmazonAdapter above the seam, where the rule can be proved offline
internal sealed class PlaywrightAmazonPages : IAmazonPages
{
    private readonly IPage _page;
    private readonly int _timeoutMs;

    public PlaywrightAmazonPages(IPage page, int timeoutMs)
    {
        ArgumentNullException.ThrowIfNull(page);

        _page = page;
        _timeoutMs = timeoutMs;
    }

    public async Task<AmazonPage> OpenAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        IResponse? response;
        try
        {
            response = await _page.GotoAsync(url, new PageGotoOptions
            {
                Timeout = _timeoutMs,
                // DOMContentLoaded: network idle on an Amazon page waits for advertising
                WaitUntil = WaitUntilState.DOMContentLoaded,
            }).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            throw new ConnectorException(
                ErrorCode.ProviderUnavailable, $"{AmazonAdapter.ProviderId}: '{url}' did not load", ex);
        }

        var html = await _page.ContentAsync().ConfigureAwait(false);

        // a null response (same-document navigation) has no status: 0 is passed, not 200, and the guard judges on the markup alone
        return new AmazonPage(_page.Url, response?.Status ?? 0, html);
    }

    public async Task<string> FragmentAsync(string url, CancellationToken ct)
    {
        // no in-page fetch fallback: it hid our own bug (AmazonUrl.Resolve turned relative hrefs into file:// paths)
        // as a provider problem
        var response = await RequestAsync(url, xhr: true, ct).ConfigureAwait(false);

        return response.Ok
            ? await response.TextAsync().ConfigureAwait(false)
            : throw new ConnectorException(
                ErrorCode.ProviderUnavailable,
                $"{AmazonAdapter.ProviderId}: '{url}' answered {response.Status}");
    }

    public async Task<AmazonDownload> DownloadAsync(string url, CancellationToken ct)
    {
        var response = await RequestAsync(url, xhr: false, ct).ConfigureAwait(false);
        var body = await response.BodyAsync().ConfigureAwait(false);

        // the media type arrives with parameters ("application/pdf;charset=UTF-8"): trimmed before comparing
        response.Headers.TryGetValue("content-type", out var contentType);

        return new AmazonDownload(response.Status, MediaType(contentType), body);
    }

    // APIRequest shares the context's cookie jar, so the human-established session is the one used;
    // a separate client would be signed out
    private async Task<IAPIResponse> RequestAsync(string url, bool xhr, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var options = new APIRequestContextOptions { Timeout = _timeoutMs };
        if (xhr) options.Headers = new Dictionary<string, string> { ["x-requested-with"] = "XMLHttpRequest" };

        // resolved before the try so the failure names the URL actually requested, not the relative href
        var absolute = Absolute(url);

        try
        {
            return await _page.APIRequest.GetAsync(absolute, options).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // the inner exception is carried: the bare message once cost a deploy and a live fetch to learn the cause
            throw new ConnectorException(
                ErrorCode.ProviderUnavailable,
                $"{AmazonAdapter.ProviderId}: '{absolute}' could not be fetched " +
                $"(from page '{_page.Url}'): {ex.GetType().Name}: {One(ex.Message)}",
                ex);
        }
    }

    // one line: Playwright's multi-line messages are unreadable in a log that prefixes every line
    private static string One(string message)
    {
        var flat = string.Join(' ', message.Split('\n', '\r', StringSplitOptions.RemoveEmptyEntries));
        return flat.Length <= 300 ? flat : flat[..300] + "...";
    }

    private string Absolute(string url) => AmazonUrl.Resolve(_page.Url, url);

    private static string MediaType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType)) return string.Empty;

        var end = contentType.IndexOf(';', StringComparison.Ordinal);
        return (end < 0 ? contentType : contentType[..end]).Trim();
    }
}

internal enum AmazonPageKind
{
    Ok,

    SignIn,

    /// <summary>A refusal with nothing to solve. blocked_by_provider.</summary>
    Blocked,

    /// <summary>The status itself was the answer; map it through the platform's table.</summary>
    HttpFailure,

    /// <summary>A widget: WAF or ACIC. Only a human at the browser can pass it.</summary>
    Interactive,

    /// <summary>A picture and a box: the one captcha a relay can carry.</summary>
    Image,
}

internal readonly record struct AmazonVerdict(AmazonPageKind Kind, string? Marker);

// order is the point: bot protection before the sign-in chain (WAF is served from inside it);
// a challenge is never invalid_credentials, which would send somebody to reset a fine password
internal static class AmazonGuard
{
    public static AmazonVerdict Inspect(AmazonPage page, HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        // a stated non-success status goes to the platform's table, widened by this provider's block list
        if (page.Status is > 0 and (< 200 or >= 300))
        {
            return new AmazonVerdict(AmazonPageKind.HttpFailure, page.Status.ToString(
                System.Globalization.CultureInfo.InvariantCulture));
        }

        if (Marker(page.Html, options.BlockedBodyMarkers) is { } refusal)
        {
            return new AmazonVerdict(AmazonPageKind.Blocked, refusal);
        }

        if (HtmlQuery.First(dom, options.InteractiveCaptchaSelectors) is not null)
        {
            return new AmazonVerdict(AmazonPageKind.Interactive, "challenge container");
        }

        // interactive before image: the ACIC page draws pictures of its own,
        // and relaying a widget as a photo asks a human for the impossible
        var picture = HtmlQuery.First(dom, options.ImageCaptchaSelectors);
        if (picture is not null)
        {
            // a picture with nowhere to type is as out of reach as a widget
            var input = HtmlQuery.First(dom, options.CaptchaInputSelectors);
            return new AmazonVerdict(
                input is null ? AmazonPageKind.Interactive : AmazonPageKind.Image, "captcha image");
        }

        if (Marker(page.Html, options.ChallengeBodyMarkers) is { } challenge)
        {
            // a JS challenge with no recognised DOM cannot be relayed: same path as a widget
            return new AmazonVerdict(AmazonPageKind.Interactive, challenge);
        }

        if (Marker(page.Url, options.SignInUrlMarkers) is { } signIn)
        {
            return new AmazonVerdict(AmazonPageKind.SignIn, signIn);
        }

        return new AmazonVerdict(AmazonPageKind.Ok, null);
    }

    // returned, not thrown, so each site that gives up keeps its own visible throw
    public static ConnectorException Failure(
        AmazonVerdict verdict, AmazonPage page, string what, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        return verdict.Kind switch
        {
            AmazonPageKind.HttpFailure => ProviderHttp.Failure(
                (HttpStatusCode)page.Status, AmazonAdapter.ProviderId, what, options.BlockStatuses),

            AmazonPageKind.Blocked => ConnectorException.Blocked(
                $"{AmazonAdapter.ProviderId}: {what} was refused by bot protection " +
                $"(marker '{verdict.Marker}'); this is a wall, not a credential problem"),

            AmazonPageKind.SignIn => ConnectorException.SessionExpired(
                $"{AmazonAdapter.ProviderId}: {what} landed on the sign-in chain " +
                $"('{verdict.Marker}'); the stored session is no longer accepted"),

            AmazonPageKind.Interactive or AmazonPageKind.Image => ConnectorException.Blocked(
                $"{AmazonAdapter.ProviderId}: {what} met a challenge ('{verdict.Marker}') and no human is " +
                "attending this browser; the widget can only be passed in a browser somebody can see and touch"),

            _ => new ConnectorException(
                ErrorCode.Internal, $"{AmazonAdapter.ProviderId}: {what} produced no verdict"),
        };
    }

    private static string? Marker(string text, IReadOnlyList<string> markers) =>
        markers.FirstOrDefault(marker => text.Contains(marker, StringComparison.OrdinalIgnoreCase));
}

// AmazonRawInvoice (include=raw) was withdrawn: 222KB of markup per order with under 3% visible text,
// and the kit says a scraping adapter leaves raw empty; include=invoice hands back the issued PDF instead
