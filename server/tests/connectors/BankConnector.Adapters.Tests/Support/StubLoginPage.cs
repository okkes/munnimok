using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;

namespace BankConnector.Adapters.Tests.Support;

/// <summary>
/// A bank's login page, as a fixture.
///
/// A test says which of the option lists' candidates are on the page, so the
/// selectors an operator can edit are the same ones the behaviour is asserted
/// through. Every call that touches the page is recorded, because the orderings
/// matter more here than anywhere: the password leaves the DOM before anything
/// photographs it, and the credential is declared submitted before the waiting
/// starts.
/// </summary>
internal sealed class StubLoginPage : ILoginPage
{
    private static readonly CropRegion Box = new(12, 34, 300, 80);

    private readonly HashSet<string> _present;
    private readonly List<string> _calls = [];
    private readonly List<string> _visited = [];
    private readonly List<string> _clicked = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);

    private StubLoginPage(HashSet<string> present) => _present = present;

    /// <summary>
    /// Settable, because a page's address is one of the things a click
    /// changes - and for a sign-out it is the evidence that anything happened.
    /// </summary>
    public string Url { get; set; } = "https://mijn.ing.nl/login/";

    /// <summary>
    /// The page changing under the adapter, which is what ING's sign-in screen
    /// does: the form is not there until the button naming it has been pressed.
    /// </summary>
    public Action<StubLoginPage, string>? WhenClicked { get; set; }

    /// <summary>
    /// True until the fields are cleared: the form was filled and submitted, so
    /// the password is still sitting in the DOM.
    /// </summary>
    public bool HoldsSecret { get; private set; } = true;

    /// <summary>Every page operation, in order.</summary>
    public IReadOnlyList<string> Calls => _calls;

    public IReadOnlyList<string> Visited => _visited;

    /// <summary>What went into which input, keyed by the candidate that matched.</summary>
    public IReadOnlyDictionary<string, string> Filled => _filled;

    public IReadOnlyList<string> Clicked => _clicked;

    public static StubLoginPage Showing(params string[] selectors) =>
        new(new HashSet<string>(selectors, StringComparer.Ordinal));

    /// <summary>Puts a selector on the page.</summary>
    public void Reveal(params string[] selectors) => _present.UnionWith(selectors);

    /// <summary>Takes one off it, for the case where a step did not land.</summary>
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

    /// <summary>
    /// What a selector's attribute reads as, keyed by selector.
    /// </summary>
    /// <remarks>
    /// The interface DEFAULTS this to null - "not there" is an ordinary answer
    /// for the caller it was written for - so a stub that inherited the default
    /// would make every attribute read fail. A provider that shows a human
    /// something to type needs the opposite: the value on the page is the whole
    /// exchange.
    /// </remarks>
    public Dictionary<string, string> Attributes { get; } = new(StringComparer.Ordinal);

    public Task<string?> AttributeAsync(
        IReadOnlyList<string> selectors, string attribute, int timeoutMs, CancellationToken ct)
    {
        _calls.Add("attribute");

        return Task.FromResult(
            Match(selectors) is { } hit && Attributes.TryGetValue(hit, out var value) ? value : null);
    }

    /// <summary>
    /// Selectors that are ON the page and cannot be acted on.
    /// </summary>
    /// <remarks>
    /// A REAL STATE THIS STUB COULD NOT EXPRESS, and one ING has already
    /// served: it ships a phone layout and a desktop layout in the same
    /// document and hides one with CSS, so a selector matches an element nobody
    /// can ever press. Playwright finds it, waits for it to become actionable
    /// and times out - which is not a missing element and must not be modelled
    /// as one.
    /// <para>
    /// A stub that knows only "present" and "absent" makes those two failures
    /// identical, so an adapter reporting "could not find the sign-in button"
    /// about a button plainly on the screen passes its tests. The registry
    /// suite's stub has had this since DUO's off-screen radios; the bank's had
    /// not.
    /// </para>
    /// </remarks>
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

        // Found, reached, and refused - the click never lands and nothing is
        // recorded as pressed, exactly as a timed-out actionability wait leaves
        // the page.
        if (_unactionable.Contains(hit)) return Task.FromResult(false);

        _clicked.Add(hit);
        WhenClicked?.Invoke(this, hit);
        return Task.FromResult(true);
    }

    public Task<bool> AnswerAsync(
        IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
        Task.FromResult(false);

    /// <summary>
    /// The first candidate that is on the page - the same most-specific-first
    /// order the real helper resolves in, so a test that puts two of a list's
    /// candidates on the page learns which one an adapter actually reaches.
    /// </summary>
    private string? Match(IReadOnlyList<string> selectors) => selectors.FirstOrDefault(_present.Contains);
}

/// <summary>
/// A browser lease that hands back a cookie jar without starting anything.
/// </summary>
/// <remarks>
/// <see cref="StorageReads"/> is asserted as ZERO by a login that never signed
/// in: reading the jar before the session is confirmed is how an adapter
/// convinces itself an anonymous session is a real one, which this project has
/// shipped once already.
/// </remarks>
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

    /// <summary>
    /// A picture, when one has been supplied - null means this lease was never
    /// meant to be photographed, and says so rather than answering with bytes
    /// nobody put there.
    /// </summary>
    public byte[]? Screenshot { get; init; }

    public Task<byte[]> ScreenshotAsync(CropRegion? crop, CancellationToken ct) =>
        Screenshot is { } bytes ? Task.FromResult(bytes) : throw Refused();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static InvalidOperationException Refused() =>
        new("this test drives the page through the adapter's seam and must not start a browser");
}
