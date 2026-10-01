using Connector.Kit.Browsing;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// A sign-in page with only the boxes it was told it has.
///
/// The point is the WIZARD. BKR asks for the e-mail and the password on two
/// screens, so the password box genuinely does not exist until the first
/// button is clicked - and an adapter that filled both up front looked
/// perfectly correct offline against a stub that showed everything at once.
/// This one reveals the second screen only when the button is pressed, which
/// is what the live page does and what the first version failed against.
/// </summary>
internal sealed class StubLoginPage : ILoginPage
{
    private readonly HashSet<string> _present;
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);
    private readonly List<string> _clicked = [];
    private readonly List<string> _visited = [];

    private readonly Dictionary<string, Dictionary<string, string>> _attributes =
        new(StringComparer.Ordinal);

    private readonly HashSet<string> _unclickable = new(StringComparer.Ordinal);

    private StubLoginPage(HashSet<string> present) => _present = present;

    public string Url { get; set; } = "https://login.mijnkredietregistratie.nl/";

    /// <summary>Called on every click, so a test can advance the wizard.</summary>
    public Action<StubLoginPage, string>? WhenClicked { get; set; }

    /// <summary>True until the page is cleared for a photograph.</summary>
    public bool HoldsSecret { get; private set; } = true;

    public IReadOnlyDictionary<string, string> Filled => _filled;

    public IReadOnlyList<string> Clicked => _clicked;

    public IReadOnlyList<string> Visited => _visited;

    public static StubLoginPage Showing(params string[] selectors) =>
        new([.. selectors]);

    public void Reveal(params string[] selectors) => _present.UnionWith(selectors);

    public void Hide(params string[] selectors) => _present.ExceptWith(selectors);

    /// <summary>
    /// Puts an element on the page carrying one attribute.
    ///
    /// Needed because DUO's QR is read rather than clicked: DigiD draws it as a
    /// PNG inline in the markup, so what an adapter relays is the value of an
    /// attribute and not a screenshot.
    /// </summary>
    public void Carrying(string selector, string attribute, string value)
    {
        _present.Add(selector);

        if (!_attributes.TryGetValue(selector, out var attributes))
        {
            attributes = new Dictionary<string, string>(StringComparer.Ordinal);
            _attributes[selector] = attributes;
        }

        attributes[attribute] = value;
    }

    public Task<string?> AttributeAsync(
        IReadOnlyList<string> selectors, string attribute, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult<string?>(null);

        return Task.FromResult(
            _attributes.TryGetValue(hit, out var attributes) && attributes.TryGetValue(attribute, out var value)
                ? value
                : null);
    }

    public Task GotoAsync(string url, CancellationToken ct)
    {
        _visited.Add(url);
        return Task.CompletedTask;
    }

    public Task ClearSecretsAsync(CancellationToken ct)
    {
        HoldsSecret = false;
        return Task.CompletedTask;
    }

    public Task<PageMatch?> FindAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct) =>
        Task.FromResult<PageMatch?>(Match(selectors) is null ? null : new PageMatch(null));

    public Task<bool> FillAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        _filled[hit] = value;
        return Task.FromResult(true);
    }

    /// <summary>
    /// Selectors that are on the page but cannot be clicked.
    /// </summary>
    /// <remarks>
    /// A real state, and one a stub that only knows "present" or "absent"
    /// cannot express: DUO styles its sign-in radios as cards and parks the
    /// real input off-screen, so Playwright finds the element, scrolls to it,
    /// reports "element is outside of the viewport" and eventually raises a
    /// TimeoutException. That is not a missing element and must not be tested
    /// as one.
    /// </remarks>
    public void Unclickable(params string[] selectors)
    {
        _present.UnionWith(selectors);
        _unclickable.UnionWith(selectors);
    }

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        if (Match(selectors) is not { } hit) return Task.FromResult(false);

        if (_unclickable.Contains(hit))
        {
            // The type Playwright for .NET really raises, which is NOT a
            // PlaywrightException - the distinction that let this escape a
            // catch clause and fail a login live.
            throw new TimeoutException(
                $"Timeout {timeoutMs}ms exceeded.\nCall log:\n  - attempting click action\n" +
                "    - element is outside of the viewport");
        }

        _clicked.Add(hit);
        WhenClicked?.Invoke(this, hit);

        return Task.FromResult(true);
    }

    public Task<bool> AnswerAsync(IReadOnlyList<string> selectors, string value, int timeoutMs, CancellationToken ct) =>
        FillAsync(selectors, value, timeoutMs, ct);

    private string? Match(IReadOnlyList<string> selectors)
    {
        foreach (var selector in selectors)
        {
            if (_present.Contains(selector)) return selector;
        }

        return null;
    }
}

/// <summary>Reports the sign-in as landed after a stated number of checks.</summary>
internal sealed class StubSignedIn(string? url, int afterWaits) : IRedirectWaiter
{
    private int _waits;

    public int Waits => _waits;

    public Task<string?> WaitAsync(TimeSpan patience, CancellationToken ct) =>
        Task.FromResult(_waits++ >= afterWaits ? url : null);
}
