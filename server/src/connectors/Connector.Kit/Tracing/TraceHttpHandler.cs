using System.Net.Http.Headers;

namespace Connector.Kit.Tracing;

/// <summary>
/// The HTTP client's half of a recording: a handler that writes every call
/// the adapter makes into whatever book is open for the current run, and
/// nothing when none is. The book is resolved per request rather than fixed
/// at construction, so one handler in a shared pipeline (the control
/// plane's inline client) records exactly the runs that asked for it, and
/// the agent's per-job client hands it the job's own book.
///
/// A text answer is buffered so the book can keep it and the adapter can
/// still read it; a binary one (a PDF, an image) is left streaming and only
/// its size and type are written down.
/// </summary>
public sealed class TraceHttpHandler(Func<TraceBook?> book) : DelegatingHandler
{
    /// <summary>The most a response is buffered for the book; past this, size and type only.</summary>
    public const long MaxBufferedBytes = 2 * 1024 * 1024;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var open = book();
        if (open is null) return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        var url = request.RequestUri?.ToString() ?? string.Empty;
        var method = request.Method.Method;

        open.Request(new TraceCall
        {
            Via = TraceBook.ViaHttp,
            Method = method,
            Url = url,
            ResourceType = "http",
            Headers = Flatten(request.Headers, request.Content?.Headers),
            ContentType = request.Content?.Headers.ContentType?.ToString(),
            Body = await RequestBodyAsync(request.Content, cancellationToken).ConfigureAwait(false),
        });

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        var contentType = response.Content.Headers.ContentType?.ToString();
        var length = response.Content.Headers.ContentLength;
        string? body = null;

        if (TraceRedaction.IsWorthReading(contentType) && (length is null || length <= MaxBufferedBytes))
        {
            // Read once into memory and hand the adapter the same bytes: the
            // book keeps its copy, the adapter reads as if nothing happened.
            var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            if (bytes.LongLength <= MaxBufferedBytes)
            {
                body = System.Text.Encoding.UTF8.GetString(bytes);
                length = bytes.LongLength;
            }

            var replacement = new ByteArrayContent(bytes);
            foreach (var header in response.Content.Headers)
            {
                replacement.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            response.Content.Dispose();
            response.Content = replacement;
        }

        open.Response(
            new TraceCall
            {
                Via = TraceBook.ViaHttp,
                Method = method,
                Url = url,
                ResourceType = "http",
                Headers = Flatten(response.Headers, response.Content.Headers),
                ContentType = contentType,
                Body = body,
            },
            (int)response.StatusCode,
            length);

        return response;
    }

    private static async Task<string?> RequestBodyAsync(HttpContent? content, CancellationToken ct)
    {
        if (content is null) return null;
        if (!TraceRedaction.IsText(content.Headers.ContentType?.ToString())) return null;

        // A request body is small by nature (a form, a JSON command) and is
        // buffered by the client anyway; reading it here does not consume it.
        await content.LoadIntoBufferAsync(ct).ConfigureAwait(false);
        return await content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    private static IEnumerable<KeyValuePair<string, string>> Flatten(HttpHeaders headers, HttpHeaders? content)
    {
        foreach (var header in headers)
        {
            yield return new KeyValuePair<string, string>(header.Key, string.Join(", ", header.Value));
        }

        if (content is null) yield break;

        foreach (var header in content)
        {
            yield return new KeyValuePair<string, string>(header.Key, string.Join(", ", header.Value));
        }
    }
}

/// <summary>
/// The book open for the current asynchronous flow, for a shared pipeline
/// that cannot be handed one per job. Set around the adapter's run, read by
/// <see cref="TraceHttpHandler"/> on every call made inside it.
/// </summary>
public static class TraceScope
{
    private static readonly AsyncLocal<TraceBook?> Current = new();

    public static TraceBook? Book => Current.Value;

    public static IDisposable Open(TraceBook book)
    {
        ArgumentNullException.ThrowIfNull(book);

        var previous = Current.Value;
        Current.Value = book;
        return new Closer(previous);
    }

    private sealed class Closer(TraceBook? previous) : IDisposable
    {
        public void Dispose() => Current.Value = previous;
    }
}
