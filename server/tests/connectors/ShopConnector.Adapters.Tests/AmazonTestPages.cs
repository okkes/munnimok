using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Amazon;
using ShopConnector.Adapters.Fixtures;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Tests;

/// captures are { url, status, html }: the status is kept because a 200 and a 503 can each be a bot wall
internal static class AmazonFixture
{
    public static AmazonPage Page(string name)
    {
        using var document = JsonDocument.Parse(FixtureCatalog.Read($"amazon/{name}.json"));
        var root = document.RootElement;

        var html = string.Join(
            '\n', root.GetProperty("html").EnumerateArray().Select(line => line.GetString()));

        return new AmazonPage(
            root.GetProperty("url").GetString()!,
            root.GetProperty("status").GetInt32(),
            html);
    }
}

/// an unmapped URL is an assertion failure, not an empty page: an unexpected fetch is the bug being stood in for
internal sealed class StubAmazonPages : IAmazonPages
{
    private readonly Dictionary<string, string> _map = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Queue<string>> _once = new(StringComparer.Ordinal);
    private readonly List<string> _opened = [];

    public IReadOnlyList<string> Opened => _opened;

    public List<string>? Trace { get; init; }

    public string this[string url]
    {
        set => _map[url] = value;
    }

    public void Replace(string url, string fixture) => _map[url] = fixture;

    /// serves the fixture for the next request only, then the mapped page: a wall stands once
    public void Once(string url, string fixture)
    {
        if (!_once.TryGetValue(url, out var queue))
        {
            queue = new Queue<string>();
            _once[url] = queue;
        }

        queue.Enqueue(fixture);
    }

    public Task<AmazonPage> OpenAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        _opened.Add(url);
        Trace?.Add("open");

        if (_once.TryGetValue(url, out var queue) && queue.Count > 0)
        {
            return Task.FromResult(AmazonFixture.Page(queue.Dequeue()));
        }

        if (!_map.TryGetValue(url, out var fixture))
        {
            throw new InvalidOperationException(
                $"the adapter opened '{url}', which this test did not record; " +
                $"mapped urls are [{string.Join(", ", _map.Keys)}]");
        }

        // the capture keeps the URL it was recorded at: a dead session shows as a fetch landing on /ap/signin
        return Task.FromResult(AmazonFixture.Page(fixture));
    }

    private readonly Dictionary<string, string> _fragments = new(StringComparer.Ordinal);
    private readonly Dictionary<string, AmazonDownload> _downloads = new(StringComparer.Ordinal);

    public List<string> Fetched { get; } = [];

    public StubAmazonPages Fragment(string url, string fixture)
    {
        _fragments[url] = FixtureCatalog.Read($"amazon/{fixture}.html");
        return this;
    }

    public StubAmazonPages Document(string url, int status, string mediaType, byte[] bytes)
    {
        _downloads[url] = new AmazonDownload(status, mediaType, bytes);
        return this;
    }

    public Task<string> FragmentAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Fetched.Add(url);
        Trace?.Add("fragment");

        return _fragments.TryGetValue(url, out var body)
            ? Task.FromResult(body)
            : throw new ConnectorException(
                ErrorCode.ProviderUnavailable, $"no fragment recorded for '{url}'");
    }

    public Task<AmazonDownload> DownloadAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Fetched.Add(url);
        Trace?.Add("download");

        return _downloads.TryGetValue(url, out var download)
            ? Task.FromResult(download)
            : throw new ConnectorException(
                ErrorCode.ProviderUnavailable, $"no document recorded for '{url}'");
    }
}

internal sealed class AmazonStubPage : ILoginPage
{
    public const string OrderList = "https://www.amazon.nl/your-orders/orders?timeFilter=year-2026&startIndex=0";

    public static readonly CropRegion Box = new(20, 40, 320, 90);

    private readonly HashSet<string> _present;
    private readonly Dictionary<string, string[]> _reveals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _signInOnClick = new(StringComparer.Ordinal);
    private string? _signInOnAnswer;
    private readonly List<string> _clicked = [];
    private readonly List<string> _calls = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);
    private readonly List<string> _visited = [];

    private AmazonStubPage(HashSet<string> present) => _present = present;

    public string Url { get; set; } = "https://www.amazon.nl/ap/signin";

    /// <summary>True until the fields are cleared: the password is still in the DOM.</summary>
    public bool HoldsSecret { get; private set; } = true;

    public IReadOnlyList<string> Visited => _visited;

    public IReadOnlyList<string> Clicked => _clicked;

    public IReadOnlyList<string> Calls => _calls;

    public IReadOnlyDictionary<string, string> Filled => _filled;

    public string? Answered { get; private set; }

    public static AmazonStubPage Showing(params string[] selectors) =>
        new(new HashSet<string>(selectors, StringComparer.Ordinal));

    public AmazonStubPage RevealingAfter(string trigger, params string[] selectors)
    {
        _reveals[trigger] = selectors;
        return this;
    }

    /// URL changed and form gone together are the only thing the adapter treats as signed in
    public AmazonStubPage SignedInAfter(string trigger, string url = OrderList)
    {
        _signInOnClick[trigger] = url;
        return this;
    }

    public AmazonStubPage SignedInAfterAnswer(string url = OrderList)
    {
        _signInOnAnswer = url;
        return this;
    }

    public void SignIn(string url = OrderList)
    {
        _present.Clear();
        Url = url;
    }

    public Task GotoAsync(string url, CancellationToken ct)
    {
        _visited.Add(url);
        return Task.CompletedTask;
    }

    public Task ClearSecretsAsync(CancellationToken ct)
    {
        _calls.Add("clear-secrets");
        HoldsSecret = false;
        return Task.CompletedTask;
    }

    /// a look is recorded: the already-signed-in gate decides whether its two ProbeMs looks happen, so silence would hide it
    public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        _calls.Add("find");

        return Task.FromResult<PageMatch?>(Match(selectors) is null ? null : new PageMatch(Box));
    }

    public Task<bool> FillAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        _calls.Add("fill");
        _filled[hit] = value;
        return Task.FromResult(true);
    }

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        _calls.Add("click");
        _clicked.Add(hit);

        if (_reveals.TryGetValue(hit, out var revealed))
        {
            foreach (var selector in revealed) _present.Add(selector);
        }

        if (_signInOnClick.TryGetValue(hit, out var url)) SignIn(url);

        return Task.FromResult(true);
    }

    public Task<bool> AnswerAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is null) return Task.FromResult(false);

        _calls.Add("answer");
        Answered = value;

        if (_signInOnAnswer is { } url) SignIn(url);

        return Task.FromResult(true);
    }

    private string? Match(IReadOnlyList<string> selectors) => selectors.FirstOrDefault(_present.Contains);
}

/// a page holding a secret yields no bytes, like the redactor: a picture back proves the password left the DOM first
internal sealed class AmazonStubBrowser : IBrowserLease
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47];

    private readonly AmazonStubPage _page;

    public AmazonStubBrowser(AmazonStubPage page) => _page = page;

    public bool Started => true;

    public int Captures { get; private set; }

    public CropRegion? LastCrop { get; private set; }

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct)
    {
        Captures++;
        LastCrop = crop;

        return Task.FromResult(_page.HoldsSecret ? Array.Empty<byte>() : Png);
    }

    public Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct) => throw Refused();

    public Task<string> StorageStateAsync(CancellationToken ct) => throw Refused();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() =>
        new("this test drives the page through the adapter's seam and must not start a browser");
}
