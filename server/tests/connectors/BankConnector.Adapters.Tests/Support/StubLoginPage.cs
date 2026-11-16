using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;

namespace BankConnector.Adapters.Tests.Support;

// tests say which option-list candidates are on the page, so operator-editable selectors are what is asserted through.
// order matters: the password leaves the DOM before anything photographs it, the credential is declared submitted first
internal sealed class StubLoginPage : ILoginPage
{
    private static readonly CropRegion Box = new(12, 34, 300, 80);

    private readonly HashSet<string> _present;
    private readonly List<string> _calls = [];
    private readonly List<string> _visited = [];
    private readonly List<string> _clicked = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);

    private StubLoginPage(HashSet<string> present) => _present = present;

    // settable: a click changes the address, and for a sign-out that is the evidence anything happened
    public string Url { get; set; } = "https://mijn.ing.nl/login/";

    // ING's sign-in form is absent until the button naming it is pressed
    public Action<StubLoginPage, string>? WhenClicked { get; set; }

    public bool HoldsSecret { get; private set; } = true;

    public IReadOnlyList<string> Calls => _calls;

    public IReadOnlyList<string> Visited => _visited;

    public IReadOnlyDictionary<string, string> Filled => _filled;

    public IReadOnlyList<string> Clicked => _clicked;

    public static StubLoginPage Showing(params string[] selectors) =>
        new(new HashSet<string>(selectors, StringComparer.Ordinal));

    public void Reveal(params string[] selectors) => _present.UnionWith(selectors);

    public void Hide(params string[] selectors) => _present.ExceptWith(selectors);

    public Task GotoAsync(string url, CancellationToken ct)
    {
        _visited.Add(url);
        _calls.Add("goto");
        return Task.CompletedTask;
    }

    public Task ClearSecretsAsync(CancellationToken ct)
    {
        _calls.Add("clear-secrets");
        HoldsSecret = false;
        return Task.CompletedTask;
    }

    public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
        Task.FromResult<PageMatch?>(Match(selectors) is null ? null : new PageMatch(Box));

    // the interface defaults this to null, which would fail every attribute read.
    // a provider that shows a human something to type needs the value
    public Dictionary<string, string> Attributes { get; } = new(StringComparer.Ordinal);

    public Task<string?> AttributeAsync(
        IReadOnlyList<string> selectors, string attribute, int timeoutMs, CancellationToken ct)
    {
        _calls.Add("attribute");

        return Task.FromResult(
            Match(selectors) is { } hit && Attributes.TryGetValue(hit, out var value) ? value : null);
    }

    // ING ships a phone and a desktop layout in one document and hides one with CSS: a selector matches an element nobody can
    // press, and Playwright times out waiting for actionability, which is not a missing element
    public void Unclickable(params string[] selectors)
    {
        _present.UnionWith(selectors);
        _unactionable.UnionWith(selectors);
    }

    private readonly HashSet<string> _unactionable = new(StringComparer.Ordinal);

    public Task<bool> FillAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        _calls.Add("fill");

        if (_unactionable.Contains(hit)) return Task.FromResult(false);

        _filled[hit] = value;
        return Task.FromResult(true);
    }

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        _calls.Add("click");

        // found and refused: nothing is recorded as pressed, as after a timed-out actionability wait
        if (_unactionable.Contains(hit)) return Task.FromResult(false);

        _clicked.Add(hit);
        WhenClicked?.Invoke(this, hit);
        return Task.FromResult(true);
    }

    public Task<bool> AnswerAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
        Task.FromResult(false);

    // most-specific-first, as the real helper resolves
    private string? Match(IReadOnlyList<string> selectors) => selectors.FirstOrDefault(_present.Contains);
}

// StorageReads is asserted zero by a login that never signed in: reading the jar before the session is confirmed makes an
// anonymous session look real, which shipped once
internal sealed class StubBrowserLease : IBrowserLease
{
    public bool Started { get; init; } = true;

    public string StorageState { get; init; } = """{"cookies":[],"origins":[]}""";

    public int StorageReads { get; private set; }

    public Task<string> StorageStateAsync(CancellationToken ct)
    {
        StorageReads++;
        return Task.FromResult(StorageState);
    }

    public Task<Microsoft.Playwright.IPage> PageAsync(CancellationToken ct) => throw Refused();

    public byte[]? Screenshot { get; init; }

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) =>
        Screenshot is { } bytes ? Task.FromResult(bytes) : throw Refused();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() =>
        new("this test drives the page through the adapter's seam and must not start a browser");
}
