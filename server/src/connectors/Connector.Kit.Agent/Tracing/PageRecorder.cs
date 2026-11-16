using System.Collections.Concurrent;
using Connector.Kit.Tracing;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tracing;

// browser half of a recording (#441 L3), attached before the first navigation so the login's document request is first
// bodies only for documents, XHR and fetch; reads are async, gathered at disposal; an unreadable body is missing
internal sealed class PageRecorder : IAsyncDisposable
{
    private static readonly HashSet<string> ReadableTypes = new(StringComparer.Ordinal) { "document", "xhr", "fetch" };

    private static readonly TimeSpan GatherTimeout = TimeSpan.FromSeconds(5);

    private const int MaxPendingReads = 256;

    private readonly TraceBook _book;
    private readonly Func<IPage, CancellationToken, Task<string?>> _digest;
    private readonly ILogger _logger;
    private readonly ConcurrentDictionary<Task, byte> _pending = new();

    private IPage? _page;
    private int _detached;

    public PageRecorder(TraceBook book, Func<IPage, CancellationToken, Task<string?>> digest, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(book);
        ArgumentNullException.ThrowIfNull(digest);
        ArgumentNullException.ThrowIfNull(logger);

        _book = book;
        _digest = digest;
        _logger = logger;
    }

    public void Attach(IPage page)
    {
        ArgumentNullException.ThrowIfNull(page);
        if (Interlocked.CompareExchange(ref _page, page, null) is not null) return;

        page.Request += OnRequest;
        page.Response += OnResponse;
        page.Console += OnConsole;
        page.PageError += OnPageError;
        page.FrameNavigated += OnFrameNavigated;
        page.Load += OnLoad;

        _book.Note("the browser's recorder is attached");
    }

    public async Task<IReadOnlyList<TraceCookie>> CookiesAsync(CancellationToken ct)
    {
        if (_page is not { } page || page.IsClosed) return [];

        try
        {
            ct.ThrowIfCancellationRequested();
            var jar = await page.Context.CookiesAsync().ConfigureAwait(false);
            return
            [
                .. jar.Select(c => TraceBook.Cookie(
                    c.Name,
                    c.Value,
                    c.Domain,
                    c.Path,
                    new CookieAttributes(
                        c.Expires is > 0 ? DateTimeOffset.FromUnixTimeSeconds((long)c.Expires) : null,
                        c.HttpOnly,
                        c.Secure,
                        c.SameSite.ToString()))),
            ];
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "the recorder could not read the cookie jar");
            return [];
        }
    }

    // on a slow machine the adapter finishes before the reads do (CI 2026-10-06: requests and no answers)
    // a read outliving the wait is a missing body
    public async Task FlushAsync(CancellationToken ct)
    {
        var reads = _pending.Keys.ToArray();
        if (reads.Length == 0) return;

        try
        {
            await Task.WhenAll(reads).WaitAsync(GatherTimeout, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or AggregateException)
        {
            _logger.LogDebug(ex, "the recorder left {Count} body read(s) behind", reads.Length);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _detached, 1) == 1) return;

        if (_page is { } page)
        {
            page.Request -= OnRequest;
            page.Response -= OnResponse;
            page.Console -= OnConsole;
            page.PageError -= OnPageError;
            page.FrameNavigated -= OnFrameNavigated;
            page.Load -= OnLoad;
        }

        await FlushAsync(CancellationToken.None).ConfigureAwait(false);
    }

    private void OnRequest(object? sender, IRequest request) => Track(RecordRequestAsync(request));

    private void OnResponse(object? sender, IResponse response) => Track(RecordResponseAsync(response));

    private void OnConsole(object? sender, IConsoleMessage message) => _book.Console(message.Type, message.Text);

    private void OnPageError(object? sender, string error) => _book.Console("pageerror", error);

    private void OnFrameNavigated(object? sender, IFrame frame)
    {
        if (_page is { } page && ReferenceEquals(frame, page.MainFrame)) _book.Navigation(frame.Url);
    }

    private void OnLoad(object? sender, IPage page) => Track(SnapshotAsync(page));

    private void Track(Task work)
    {
        if (_pending.Count >= MaxPendingReads) return;

        _pending.TryAdd(work, 0);
        work.ContinueWith(t =>
        {
            _pending.TryRemove(t, out _);
            if (t.IsFaulted) _logger.LogDebug(t.Exception, "a recorder read failed");
        }, TaskScheduler.Default);
    }

    private async Task RecordRequestAsync(IRequest request)
    {
        var headers = await HeadersAsync(() => request.AllHeadersAsync(), request.Headers).ConfigureAwait(false);
        var contentType = headers.FirstOrDefault(h => h.Key.Equals("content-type", StringComparison.OrdinalIgnoreCase)).Value;
        var body = TraceRedaction.IsText(contentType) ? request.PostData : null;

        _book.Request(new TraceCall
        {
            Via = TraceBook.ViaBrowser,
            Method = request.Method,
            Url = request.Url,
            ResourceType = request.ResourceType,
            Headers = headers,
            ContentType = contentType,
            Body = body,
        });
    }

    private async Task RecordResponseAsync(IResponse response)
    {
        var request = response.Request;
        var headers = await HeadersAsync(() => response.AllHeadersAsync(), response.Headers).ConfigureAwait(false);
        var contentType = headers.FirstOrDefault(h => h.Key.Equals("content-type", StringComparison.OrdinalIgnoreCase)).Value;
        var declared = headers.FirstOrDefault(h => h.Key.Equals("content-length", StringComparison.OrdinalIgnoreCase)).Value;
        long? size = long.TryParse(declared, out var length) ? length : null;

        string? body = null;
        if (ReadableTypes.Contains(request.ResourceType) && TraceRedaction.IsWorthReading(contentType))
        {
            try
            {
                var bytes = await response.BodyAsync().ConfigureAwait(false);
                size = bytes.LongLength;
                body = System.Text.Encoding.UTF8.GetString(bytes);
            }
            catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
            {
                // A redirect, a cancelled load, a page that already moved on:
                // the body is not there to read, and that is the fact kept.
            }
        }

        _book.Response(
            new TraceCall
            {
                Via = TraceBook.ViaBrowser,
                Method = request.Method,
                Url = response.Url,
                ResourceType = request.ResourceType,
                Headers = headers,
                ContentType = contentType,
                Body = body,
            },
            response.Status,
            size);
    }

    private async Task SnapshotAsync(IPage page)
    {
        if (page.IsClosed) return;

        string? html = null;
        string? digest = null;
        try
        {
            digest = await _digest(page, CancellationToken.None).ConfigureAwait(false);
            html = await page.ContentAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            _logger.LogDebug(ex, "the recorder could not snapshot the document");
        }

        if (digest is null && html is null) return;
        _book.Dom(page.Url, digest, html);
    }

    private static async Task<List<KeyValuePair<string, string>>> HeadersAsync(
        Func<Task<Dictionary<string, string>>> all, IDictionary<string, string> fallback)
    {
        try
        {
            return [.. await all().ConfigureAwait(false)];
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            return [.. fallback];
        }
    }
}
