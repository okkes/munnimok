using Microsoft.Playwright;

namespace Connector.Kit.Browsing;

// an interface so the waiting, which decides whether a job finishes or hangs, is reachable offline
public interface IRedirectWaiter
{
    // null (the wait ran out) is not a failure: only the page can say "still loading" versus "a captcha is in the way"
    Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct);
}

// a native OAuth client redirects to its own scheme (appie://login-exit), which Chromium cannot navigate to; which surface
// shows it varies by Chromium build, so all four are watched, and the listeners must exist BEFORE the form is submitted
public sealed class RedirectWatcher : IRedirectWaiter, IDisposable
{
    private const int PollMilliseconds = 250;

    private readonly IPage _page;
    private readonly string _prefix;
    private readonly TimeProvider _time;

    private readonly TaskCompletionSource<string> _captured =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public RedirectWatcher(IPage page, string redirectUri, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(page);

        _page = page;
        _prefix = redirectUri;
        _time = time;

        _page.Response += OnResponse;
        _page.Request += OnRequest;
        _page.RequestFailed += OnRequest;
        _page.FrameNavigated += OnFrame;
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow() + timeout;

        while (true)
        {
            if (_captured.Task.IsCompleted) return await _captured.Task.ConfigureAwait(false);

            try
            {
                // last resort: on some builds a blocked scheme raises no event and only the page's own URL moves
                Offer(_page.Url);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // the page can close mid-redirect; the event handlers stay the primary signal
            }

            if (_captured.Task.IsCompleted) return await _captured.Task.ConfigureAwait(false);
            if (_time.GetUtcNow() >= deadline) return null;

            var poll = Task.Delay(TimeSpan.FromMilliseconds(PollMilliseconds), _time, ct);
            await Task.WhenAny(_captured.Task, poll).ConfigureAwait(false);
        }
    }

    public void Dispose()
    {
        _page.Response -= OnResponse;
        _page.Request -= OnRequest;
        _page.RequestFailed -= OnRequest;
        _page.FrameNavigated -= OnFrame;
    }

    // the most dependable of the four: the header is readable even if Chromium then refuses to act on it
    private void OnResponse(object? sender, IResponse response)
    {
        try
        {
            foreach (var header in response.Headers.Where(h => string.Equals(h.Key, "location", StringComparison.OrdinalIgnoreCase)))
            {
                Offer(header.Value);
            }
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a response whose headers are gone tells nothing, and throwing out of an event handler would take the dispatch loop down
        }
    }

    private void OnRequest(object? sender, IRequest request) => Offer(request.Url);

    private void OnFrame(object? sender, IFrame frame) => Offer(frame.Url);

    private void Offer(string? url)
    {
        if (url is not null && url.StartsWith(_prefix, StringComparison.OrdinalIgnoreCase))
        {
            _captured.TrySetResult(url);
        }
    }
}
