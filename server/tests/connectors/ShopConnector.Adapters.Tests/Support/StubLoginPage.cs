using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Tests.Support;

/// records every call: two guarded fixes are orderings (the password leaves the DOM before any screenshot; a username
/// goes into the box its shape belongs in, or none). Shared by Albert Heijn and Lidl Plus like ILoginPage
internal sealed class StubLoginPage : ILoginPage
{
    public static readonly CropRegion Box = new(12, 34, 300, 80);

    private readonly HashSet<string> _present;
    private readonly List<string> _calls = [];
    private readonly List<string> _visited = [];
    private readonly List<string> _clicked = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);

    private StubLoginPage(HashSet<string> present) => _present = present;

    /// settable: a test about an already-signed-in browser sets the address the provider left it on
    /// (on Coolblue the whole answer)
    public string Url { get; set; } = "https://login.example.test/login";

    /// the page changing under the adapter (a widget escalating); settable so a handler can Reveal on the page it is attached to
    public Action<StubLoginPage, string>? WhenClicked { get; set; }

    /// <summary>The page reacting to a navigation - what bol's overview does when it is opened: it fires its operation.</summary>
    public Action<StubLoginPage, string>? WhenVisited { get; set; }

    public bool HoldsSecret { get; private set; } = true;

    public IReadOnlyList<string> Calls => _calls;

    public IReadOnlyList<string> Visited => _visited;

    public IReadOnlyDictionary<string, string> Filled => _filled;

    public IReadOnlyList<string> Clicked => _clicked;

    public string? Answered { get; private set; }

    public static StubLoginPage Showing(params string[] selectors) =>
        new(new HashSet<string>(selectors, StringComparer.Ordinal));

    public void Record(string call) => _calls.Add(call);

    public void Reveal(params string[] selectors) => _present.UnionWith(selectors);

    public void Hide(params string[] selectors) => _present.ExceptWith(selectors);

    public Task GotoAsync(string url, CancellationToken ct)
    {
        _visited.Add(url);
        WhenVisited?.Invoke(this, url);
        return Task.CompletedTask;
    }

    public Task ClearSecretsAsync(CancellationToken ct)
    {
        Record("clear-secrets");
        HoldsSecret = false;
        return Task.CompletedTask;
    }

    public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
        Task.FromResult<PageMatch?>(Match(selectors) is null ? null : new PageMatch(Box));

    /// recorded, never simulated: only a browser knows if a frame has finished drawing;
    /// what is pinned is that the gate asks before it photographs
    public Task SettleAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct)
    {
        Record("settle");
        return Task.CompletedTask;
    }

    /// what Playwright raises when a navigation or wait outlives its budget; thrown by the next fill
    public Exception? FillThrows { get; set; }

    public Task<bool> FillAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (FillThrows is { } thrown)
        {
            FillThrows = null;
            return Task.FromException<bool>(thrown);
        }

        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        Record("fill");
        _filled[hit] = value;
        return Task.FromResult(true);
    }

    /// what Playwright raises when something intercepts the pointer until the click's budget runs out
    /// (bol's cookie dialog, 2026-10-06)
    public Exception? ClickThrows { get; set; }

    public int ClickThrowsTimes { get; set; } = 1;

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        if (ClickThrows is { } thrown)
        {
            if (--ClickThrowsTimes <= 0) ClickThrows = null;
            return Task.FromException<bool>(thrown);
        }

        Record("click");
        _clicked.Add(hit);
        WhenClicked?.Invoke(this, hit);
        return Task.FromResult(true);
    }

    public Task<bool> AnswerAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is null) return Task.FromResult(false);

        Record("answer");
        Answered = value;
        return Task.FromResult(true);
    }

    /// the first candidate on the page, in the real helper's most-specific-first order
    private string? Match(IReadOnlyList<string> selectors) => selectors.FirstOrDefault(_present.Contains);
}

/// the redirect arrives after a set number of waits, or never: a wall nobody can pass
internal sealed class StubRedirectWaiter : IRedirectWaiter
{
    private readonly string? _redirect;
    private readonly int _afterWaits;

    public StubRedirectWaiter(string? redirect, int afterWaits)
    {
        _redirect = redirect;
        _afterWaits = afterWaits;
    }

    /// <summary>How many polls the login cost. The live AH hang was 300s of these.</summary>
    public int Waits { get; private set; }

    public Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        Waits++;
        return Task.FromResult(Waits > _afterWaits ? _redirect : null);
    }
}

/// reproduces ScreenshotRedactor's refusal: a page still holding a secret yields no bytes,
/// so a picture proves the password was gone first
internal sealed class StubBrowserLease : IBrowserLease
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    private readonly StubLoginPage _page;

    public StubBrowserLease(StubLoginPage page) => _page = page;

    public bool Started => true;

    public int Captures { get; private set; }

    public CropRegion? LastCrop { get; private set; }

    /// the redactor also declines whatever it cannot verify, not only a page still holding a secret
    public bool Refuses { get; init; }

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        Captures++;
        LastCrop = crop;
        _page.Record("screenshot");

        return Task.FromResult(Refuses || _page.HoldsSecret ? Array.Empty<byte>() : Png);
    }

    public Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct) => throw Refused();

    /// null refuses the call like a lease with no browser; set for a provider whose session IS the cookie jar (Coolblue)
    public string? StorageState { get; init; }

    /// asserted ZERO by a login that never signed in: Coolblue gives anonymous visitors session cookies,
    /// so reading early mistakes one for a real session
    public int StorageReads { get; private set; }

    public Task<string> StorageStateAsync(CancellationToken ct)
    {
        if (StorageState is null) throw Refused();

        StorageReads++;
        return Task.FromResult(StorageState);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() =>
        new("this test drives the page through the adapter's seam and must not start a browser");
}

/// recorded, not dispatched: the browser's own mouse is what no fixture can stand in for;
/// asserts a click was asked for, at which page pixel, in order
internal sealed class StubTapSurface : ITapSurface
{
    private readonly StubLoginPage? _page;
    private readonly List<(double X, double Y)> _points = [];

    public StubTapSurface(StubLoginPage? page = null) => _page = page;

    public int Dispatches { get; private set; }

    public IReadOnlyList<(double X, double Y)> Points => _points;

    public Task TapAsync(IReadOnlyList<(double X, double Y)> points, CancellationToken ct)
    {
        Dispatches++;
        _points.AddRange(points);

        // into the page's own log so the ordering (password gone, picture taken, then click) is asserted as a sequence
        _page?.Record("tap");

        return Task.CompletedTask;
    }
}
