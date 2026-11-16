using System.Net.Http.Headers;

namespace Connector.Kit.Tracing;

// the book is resolved per request, so one handler in a shared pipeline records only the runs that asked.
// A text answer is buffered so the adapter can still read it; a binary one stays streaming (size and type only)
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

        // a request body is small and buffered by the client anyway; reading it here does not consume it
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

// the ambient book for a shared pipeline that cannot be handed one per job
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
