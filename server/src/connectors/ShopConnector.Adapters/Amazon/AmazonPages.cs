using System.Net;
using Connector.Kit.Errors;
using Microsoft.Playwright;
using ShopConnector.Adapters.Support;
using Connector.Kit.Adapters;

namespace ShopConnector.Adapters.Amazon;

/// <summary>
/// One page as it came back: where we ended up, what status the navigation
/// carried, and the markup.
///
/// Status is kept alongside the HTML rather than thrown away, because on this
/// provider the status is half the diagnosis: a 200 can be a bot wall and a
/// 503 can be one too, and the two need different answers.
/// </summary>
internal readonly record struct AmazonPage(string Url, int Status, string Html);

/// <summary>
/// The seam.
///
/// Everything below this interface needs a real Chromium and a real account;
/// everything above it - the year walk, the pagination guard, the challenge
/// policy, the parsing, the money - is drivable from a recorded page. That
/// division is the only reason any of this is testable at all, because
/// amazon.nl cannot be exercised offline in any other way: there is no API to
/// stub.
/// </summary>
internal interface IAmazonPages
{
    Task<AmazonPage> OpenAsync(string url, CancellationToken ct);

    /// <summary>
    /// Fetches a fragment the way the page itself would: an XHR, with the
    /// browser's cookies, without navigating.
    ///
    /// The invoice list is one of these. Navigating to
    /// <c>/your-orders/invoice/popover</c> directly returns nothing at all -
    /// it exists only as an AJAX response - so a fetch is not an optimisation
    /// here, it is the only thing that works.
    /// </summary>
    Task<string> FragmentAsync(string url, CancellationToken ct);

    /// <summary>
    /// Fetches a document as BYTES rather than navigating to it.
    ///
    /// Navigating a browser to a PDF hands the job to Chromium's download
    /// machinery, which either saves a file somewhere we then have to find or
    /// aborts the run with "Download is starting" - both observed. Reading it
    /// as bytes over the page's own session avoids the machinery entirely.
    /// </summary>
    Task<AmazonDownload> DownloadAsync(string url, CancellationToken ct);
}

/// <summary>
/// A document as it came back: the status, what the provider SAID it is, and
/// the bytes.
///
/// The media type is carried rather than assumed from the URL, because a
/// provider that answers a challenge to a document request sends HTML from a
/// path ending in <c>.pdf</c> - and a connector that trusted the extension
/// would hand the user a download that opens to nothing.
/// </summary>
internal readonly record struct AmazonDownload(int Status, string MediaType, byte[] Bytes);

/// <summary>
/// Turning an href on a page into an address a client can actually fetch.
///
/// One line of this was a real defect, live, and it is written down because the
/// wrong version looks obviously correct:
/// <code>
/// Uri.TryCreate(url, UriKind.Absolute, out var already) ? already.ToString() : ...
/// </code>
/// On Linux <c>/documents/download/x/invoice.pdf</c> IS a well-formed absolute
/// URI - a rooted FILE PATH - so that test returns true and hands back
/// <c>file:///documents/download/x/invoice.pdf</c>, with any <c>?</c> escaped to
/// <c>%3F</c> because it has become part of a filename. Every invoice fetch on a
/// real account then died on <c>Protocol "file:" not supported</c>, while every
/// navigation on the same page succeeded, because <c>GotoAsync</c> never asks
/// that question.
///
/// Being absolute is therefore not enough to trust. It has to be a scheme the
/// web speaks.
/// </summary>
internal static class AmazonUrl
{
    /// <summary>
    /// <paramref name="href"/> as an absolute http(s) address, resolved against
    /// the page that offered it.
    ///
    /// Against the PAGE rather than a configured base, so a storefront that
    /// ever answers from another host is followed rather than silently pointed
    /// home.
    /// </summary>
    public static string Resolve(string? pageUrl, string href)
    {
        ArgumentNullException.ThrowIfNull(href);

        // Absolute AND web-schemed. The second half is the whole fix.
        if (Uri.TryCreate(href, UriKind.Absolute, out var already) && IsWeb(already))
        {
            return already.ToString();
        }

        return Uri.TryCreate(pageUrl, UriKind.Absolute, out var page)
               && Uri.TryCreate(page, href, out var resolved)
               && IsWeb(resolved)
            ? resolved.ToString()
            // Unchanged rather than mangled: the caller's own error then quotes
            // what it was actually given, which is more use than a confidently
            // wrong address.
            : href;
    }

    private static bool IsWeb(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
}

/// <summary>
/// The live page source: navigate, and hand back what Amazon rendered.
///
/// Deliberately does no pacing of its own. Everything below this class needs a
/// real Chromium, so a gap enforced here would be a gap no test could observe -
/// and the pacing of this walk is a rule about how Amazon is treated, which is
/// exactly the kind of rule that has to be provable offline. It lives in
/// <see cref="AmazonAdapter"/>, above the seam, around every call to this.
/// </summary>
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
                // The order list is server-rendered; waiting for the network
                // to go idle on an Amazon page waits for advertising.
                WaitUntil = WaitUntilState.DOMContentLoaded,
            }).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            throw new ConnectorException(
                ErrorCode.ProviderUnavailable, $"{AmazonAdapter.ProviderId}: '{url}' did not load", ex);
        }

        var html = await _page.ContentAsync().ConfigureAwait(false);

        // A null response means Playwright served the navigation from a
        // same-document change and has no status to report. Zero is passed
        // through honestly rather than invented as 200: the guard reads it as
        // "no status was stated" and judges on the markup alone.
        return new AmazonPage(_page.Url, response?.Status ?? 0, html);
    }

    public async Task<string> FragmentAsync(string url, CancellationToken ct)
    {
        // No fallback to an in-page fetch here any more.
        //
        // There was one, added while a live failure had no known cause, and it
        // worked - it carried the whole feature for a run. It is gone because
        // the cause turned out to be ours: see AmazonUrl.Resolve, which was
        // turning every relative href into a file:// path. A second mechanism
        // that quietly succeeds where the first fails is exactly what let a
        // one-line bug of our own look like a provider problem.
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

        // Whatever it says, however it says it. A media type arrives as
        // "application/pdf;charset=UTF-8" on this provider - a charset on a
        // binary document, which is wrong of Amazon and not ours to correct,
        // but it does mean the parameters have to be trimmed off before
        // anything compares against "application/pdf".
        response.Headers.TryGetValue("content-type", out var contentType);

        return new AmazonDownload(response.Status, MediaType(contentType), body);
    }

    /// <summary>
    /// One request, over the browser's own session.
    ///
    /// <c>APIRequest</c> rather than an <c>HttpClient</c> of our own: it shares
    /// the context's cookie jar, so an Amazon session that took a human and a
    /// puzzle to establish is the session these calls go out on. A separate
    /// client would be signed out, and a jar copied across by hand would be a
    /// second copy of a credential for no reason.
    /// </summary>
    private async Task<IAPIResponse> RequestAsync(string url, bool xhr, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var options = new APIRequestContextOptions { Timeout = _timeoutMs };
        if (xhr) options.Headers = new Dictionary<string, string> { ["x-requested-with"] = "XMLHttpRequest" };

        // Resolved before the try, so the URL that was actually requested can
        // be named in the failure. An error that quotes the RELATIVE href
        // cannot distinguish a provider refusing us from a resolution that
        // produced something no client would accept.
        var absolute = Absolute(url);

        try
        {
            return await _page.APIRequest.GetAsync(absolute, options).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // The cause, carried rather than replaced.
            //
            // This message used to read "'{url}' could not be fetched" and
            // nothing else, and it cost a full round trip through a deploy and
            // a live fetch to learn what every one of these failures already
            // knew. Discarding the inner exception is the same mistake as
            // swallowing it, one level down.
            throw new ConnectorException(
                ErrorCode.ProviderUnavailable,
                $"{AmazonAdapter.ProviderId}: '{absolute}' could not be fetched " +
                $"(from page '{_page.Url}'): {ex.GetType().Name}: {One(ex.Message)}",
                ex);
        }
    }

    /// <summary>
    /// An exception message on one line. Playwright's run to several, and a
    /// multi-line detail is unreadable in a log that prefixes every line.
    /// </summary>
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

/// <summary>What a fetched page turned out to be.</summary>
internal enum AmazonPageKind
{
    /// <summary>Data. Parse it.</summary>
    Ok,

    /// <summary>The sign-in chain. During a fetch that is a dead session.</summary>
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

/// <summary>
/// Reads a fetched page and says what it is, before anything tries to parse
/// it as order history.
///
/// The ordering below is the whole of it. Bot protection is judged BEFORE the
/// sign-in chain, because Amazon serves its WAF challenge from inside that
/// chain and "you were challenged" is a different fact from "your session
/// died". And a challenge is never <c>invalid_credentials</c> under any
/// circumstances: telling somebody their password is wrong when the truth is
/// a bot wall sends them to reset a password that was fine and leaves the real
/// problem undiagnosed.
/// </summary>
internal static class AmazonGuard
{
    public static AmazonVerdict Inspect(AmazonPage page, HtmlNode dom, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(dom);
        ArgumentNullException.ThrowIfNull(options);

        // A stated non-success status is decided by the platform's own table,
        // widened by this provider's block list.
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

        // Interactive before image, always: the ACIC page draws pictures of
        // its own ("choose all the buckets"), and classifying a widget as a
        // photograph asks a human for something nobody can give.
        var picture = HtmlQuery.First(dom, options.ImageCaptchaSelectors);
        if (picture is not null)
        {
            // A picture with nowhere to type the answer is as far out of reach
            // as a widget, so it is treated as one rather than relayed to
            // somebody who would have nothing to do with it.
            var input = HtmlQuery.First(dom, options.CaptchaInputSelectors);
            return new AmazonVerdict(
                input is null ? AmazonPageKind.Interactive : AmazonPageKind.Image, "captcha image");
        }

        if (Marker(page.Html, options.ChallengeBodyMarkers) is { } challenge)
        {
            // A JS challenge with no DOM we recognise. Nothing here can be
            // relayed, so it goes down the same path as a widget.
            return new AmazonVerdict(AmazonPageKind.Interactive, challenge);
        }

        if (Marker(page.Url, options.SignInUrlMarkers) is { } signIn)
        {
            return new AmazonVerdict(AmazonPageKind.SignIn, signIn);
        }

        return new AmazonVerdict(AmazonPageKind.Ok, null);
    }

    /// <summary>
    /// Turns a verdict into the exception the platform expects. Returned
    /// rather than thrown so the caller's control flow stays visible: every
    /// site that gives up on a page does it with a <c>throw</c> of its own.
    /// </summary>
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

    /// <summary>
    /// The first of <paramref name="markers"/> that <paramref name="text"/> -
    /// a page's markup or its address - carries, or null.
    /// </summary>
    private static string? Marker(string text, IReadOnlyList<string> markers) =>
        markers.FirstOrDefault(marker => text.Contains(marker, StringComparison.OrdinalIgnoreCase));
}

// AmazonRawInvoice lived here: the print page, wrapped with its URL and
// status, as include=raw handed it back.
//
// Withdrawn rather than refined. Raw exists so a shape change can be diagnosed
// from the payload a record was derived from, and on a provider with an API
// that is a JSON object worth keeping. This provider has no API, so what it
// carried was 222KB of live Amazon markup per order whose visible text was
// under 3% - the rest layout and Amazon's own analytics, which is what a
// consumer actually saw when they opened it.
//
// The kit's own contract had said so all along: an adapter "that scraped a
// page... leaves it empty rather than inventing a shape, and the caller gets a
// normalised record with no raw beside it, which is the honest answer".
//
// What was really wanted is include=invoice, which hands back the PDF Amazon
// issues rather than the page we happened to read.
