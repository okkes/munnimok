using BankConnector.Adapters.Asn;

namespace BankConnector.Adapters.Tests.Support;

// records every call in order: on this provider the order is most of what can go wrong (cookie wall first, format chosen
// before the download click, a date typed after the format modal opens goes into the modal)
internal sealed class StubAsnPortal : IAsnPortal
{
    private readonly List<string> _calls = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _checked = new(StringComparer.Ordinal);

    public string Url { get; set; } = "https://www.asnbank.nl/online/web/onlinebankieren/inloggen/";

    public HashSet<string> Labels { get; } = new(StringComparer.Ordinal);

    public string? Download { get; set; }

    public string? ArrivesAt { get; set; }

    public IReadOnlyList<string> Calls => _calls;

    public IReadOnlyDictionary<string, string> Filled => _filled;

    public IReadOnlyDictionary<string, bool> Checked => _checked;

    public static StubAsnPortal SignedIn(params string[] labels)
    {
        var portal = new StubAsnPortal { ArrivesAt = "https://www.asnbank.nl/online/web/onlinebankieren/" };
        portal.Labels.UnionWith(labels);

        return portal;
    }

    // a browser that has been nowhere, as a logout job gets: at about:blank the adapter must navigate first; ASN's sign-out
    // once hunted "Uitloggen" on a blank page and blamed the bank
    public static StubAsnPortal Blank(params string[] labels)
    {
        var portal = new StubAsnPortal { Url = "about:blank", LabelsNeedNavigation = true };
        portal.Labels.UnionWith(labels);

        return portal;
    }

    public bool LabelsNeedNavigation { get; set; }

    private bool _navigated;

    // a bank answers a signed-in address with its sign-in page once the session is gone: an expired session must not look
    // like a missing button
    public string? RedirectsTo { get; set; }

    // a page that loads, checks its session and moves itself on: the address is unchanged when the navigation returns and
    // changed later, so reading it right after goto is wrong
    public string? ThenMovesTo { get; set; }

    private string? _pendingMove;

    public Task GotoAsync(string url, CancellationToken ct)
    {
        _calls.Add($"goto:{url}");
        Url = RedirectsTo ?? url;
        _pendingMove = ThenMovesTo;
        _navigated = true;

        Uncover();

        return Task.CompletedTask;
    }

    private void Settle()
    {
        if (_pendingMove is null) return;

        Url = _pendingMove;
        _pendingMove = null;
    }

    // exact matching, as live: ASN's select-all reads "Alles selecteren (3)" and an exact "Alles selecteren" misses it
    public Task<bool> ClickLabelAsync(string label, LabelMatch match, CancellationToken ct)
    {
        var hit = (!LabelsNeedNavigation || _navigated)
                  && (match == LabelMatch.Prefix
                      ? Labels.Any(l => l.StartsWith(label, StringComparison.Ordinal))
                      : Labels.Contains(label));

        var call = $"click:{label}{(hit ? string.Empty : ":missed")}";
        _calls.Add(call);

        if (hit) Reveal(call);

        return Task.FromResult(hit);
    }

    public HashSet<string> Headings { get; } = new(StringComparer.Ordinal);

    // only the right click opens a dialog: a click on the wrong button opens nothing, as on the bank
    public Dictionary<string, string> Opens { get; } = new(StringComparer.Ordinal);

    // ASN's "Uitloggen" is inside the hamburger menu and not rendered at the agent's phone width until the menu is opened
    public Dictionary<string, string> RevealsLabel { get; } = new(StringComparer.Ordinal);

    // a ladder must reset between rungs: a positional handle counts what is on the page, so after a panel opens "the second
    // header control" is the panel's (ASN's search replaces the header with links, a search box and three buttons)
    public Dictionary<string, IReadOnlyList<string>> Covers { get; } = new(StringComparer.Ordinal);

    private List<string>? _uncovered;
    private readonly List<string> _revealed = [];

    private void Reveal(string call)
    {
        if (Opens.TryGetValue(call, out var heading)) Headings.Add(heading);

        if (RevealsLabel.TryGetValue(call, out var label) && Labels.Add(label)) _revealed.Add(label);

        if (Covers.TryGetValue(call, out var panel))
        {
            _uncovered ??= [.. ButtonsInOrder];

            ButtonsInOrder.Clear();
            ButtonsInOrder.AddRange(panel);
        }
    }

    private void Uncover()
    {
        if (_uncovered is not null)
        {
            ButtonsInOrder.Clear();
            ButtonsInOrder.AddRange(_uncovered);
            _uncovered = null;
        }

        // a fresh page has no menu open
        foreach (var label in _revealed) Labels.Remove(label);

        _revealed.Clear();
    }

    public Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"heading?:{text}");
        Settle();

        // substring, as Playwright's heading match is: a fixture must not pass on an exactness the live page does not enforce
        return Task.FromResult(Headings.Any(h => h.Contains(text, StringComparison.Ordinal)));
    }

    public Task<bool> HasLabelAsync(string label, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"label?:{label}");
        Settle();

        return Task.FromResult((!LabelsNeedNavigation || _navigated) && Labels.Contains(label));
    }

    /// <summary>ASN's outdated-browser notice (#562): a page shows it only where a test says so.</summary>
    public static readonly string BrowserNotice = new AsnOptions().BrowserNoticeContinueSelectors[0];

    /// <summary>Selectors this page does NOT have. Everything else is present - but the outdated-browser notice.</summary>
    public HashSet<string> AbsentSelectors { get; } = new(StringComparer.Ordinal) { BrowserNotice };

    // a probe with a shorter budget misses: pins that the option is what gets spent (the settle window's length is unmeasured)
    public Dictionary<string, TimeSpan> AppearsAfter { get; } = new(StringComparer.Ordinal);

    public Task<bool> HasAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"has?:{selectors[0]}");

        // A probe takes time, and time is when a client-side bounce lands.
        Settle();

        var hit = !AbsentSelectors.Contains(selectors[0])
                  && (!AppearsAfter.TryGetValue(selectors[0], out var after) || budget >= after);

        return Task.FromResult(hit);
    }

    public Dictionary<string, int> Counts { get; } = new(StringComparer.Ordinal);

    public Task<int> CountAsync(IReadOnlyList<string> selectors, CancellationToken ct)
    {
        _calls.Add($"count:{selectors[0]}");

        return Task.FromResult(Counts.TryGetValue(selectors[0], out var n) ? n : 0);
    }

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, CancellationToken ct)
    {
        var hit = !AbsentSelectors.Contains(selectors[0])
                  && !ForceOnlySelectors.Contains(selectors[0]);

        var call = $"click:{selectors[0]}{(hit ? string.Empty : ":missed")}";
        _calls.Add(call);

        if (hit) Reveal(call);
        // the notice's button goes on to online banking: the notice is behind us
        if (hit && string.Equals(selectors[0], BrowserNotice, StringComparison.Ordinal)) AbsentSelectors.Add(BrowserNotice);

        return Task.FromResult(hit);
    }

    // a list, not a count: the account picker's label changes underneath it while its position does not
    public List<string> ButtonsInOrder { get; } = [];

    // ASN's account select is in every capture of its form but Playwright refuses a plain click: a native control behind a
    // styled wrapper
    public HashSet<string> ForceOnlySelectors { get; } = new(StringComparer.Ordinal);

    public Task<bool> ClickForceAsync(IReadOnlyList<string> selectors, CancellationToken ct)
    {
        var hit = !AbsentSelectors.Contains(selectors[0]);

        var call = $"force:{selectors[0]}{(hit ? string.Empty : ":missed")}";
        _calls.Add(call);

        if (hit) Reveal(call);

        return Task.FromResult(hit);
    }

    public Task<bool> ClickNthAsync(IReadOnlyList<string> selectors, int index, CancellationToken ct)
    {
        var hit = index >= 0 && index < ButtonsInOrder.Count;

        var call = $"click:{selectors[0]}#{index}{(hit ? string.Empty : ":missed")}";
        _calls.Add(call);

        if (hit)
        {
            _clickedByPosition.Add(ButtonsInOrder[index]);

            Reveal(call);

            // keyed also by what was pressed: keyed by index alone, a ladder that never resets is indistinguishable from one that does
            Reveal($"press:{ButtonsInOrder[index]}");
        }

        return Task.FromResult(hit);
    }

    private readonly List<string> _clickedByPosition = [];

    public IReadOnlyList<string> ClickedByPosition => _clickedByPosition;

    // a fill misses when the page has no such input: ASN's sign-in shows a browsercode box to a registered browser and three
    // method buttons to another, so "is this profile trusted" is "is that box there"
    public Task<bool> FillNthAsync(
        IReadOnlyList<string> selectors, int index, string value, CancellationToken ct)
    {
        var hit = !AbsentSelectors.Contains(selectors[0]);

        _calls.Add($"fill:{index}{(hit ? string.Empty : ":missed")}");

        if (!hit) return Task.FromResult(false);

        _filled[$"{selectors[0]}#{index}"] = value;

        return Task.FromResult(true);
    }

    // de Volksbank parks the real input behind a styled label, so Playwright reports the same miss as for an absent control
    // (a live fetch: "no radio at index 2" with five radios visible)
    public HashSet<string> UnreachableControls { get; } = new(StringComparer.Ordinal);

    public Task<string?> SetCheckedNthAsync(
        IReadOnlyList<string> selectors, int index, bool value, CancellationToken ct)
    {
        var key = $"{selectors[0]}#{index}";

        _calls.Add($"check:{index}={value}");

        if (_checked.TryGetValue(key, out var already) && already == value)
        {
            return Task.FromResult<string?>("already");
        }

        if (AbsentSelectors.Contains(selectors[0])) return Task.FromResult<string?>(null);

        // unreachable controls yield to the box around them, as on the bank; the adapter must not believe the plain way worked
        var how = UnreachableControls.Contains(key) ? "by the box around it" : "directly";

        _checked[key] = value;
        _calls.Add($"check:{index}:{how}");

        return Task.FromResult<string?>(how);
    }

    // a relayed QR must be live WHILE the adapter waits for the scan: raised and cancelled in the same breath would pass the
    // raised and cancelled assertions
    public Action? OnWait { get; set; }

    // a bank checking a credential and serving an overview is given its own budget, not the ten seconds a selector gets
    public TimeSpan ArrivesAfter { get; set; }

    // Playwright's URL wait matches on commit and then waits for load on the same clock: a budget can run out with the address
    // already right (a slow overview was once reported as a changed bank); zero is instant
    public TimeSpan LoadsAfter { get; set; }

    public Task<bool> WaitForPathAsync(
        string contains, string? without, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"wait:{contains}");
        OnWait?.Invoke();

        Settle();

        if (ArrivesAt is null || budget < ArrivesAfter)
        {
            return Task.FromResult(false);
        }

        // the address moves either way and only the answer says whether it was the wanted one: a bank may send the browser elsewhere
        Url = ArrivesAt;

        // the exclusion is honoured too: this bank's sign-in path sits beneath its signed-in one
        var arrived = ArrivesAt.Contains(contains, StringComparison.OrdinalIgnoreCase)
                      && (without is null || !ArrivesAt.Contains(without, StringComparison.OrdinalIgnoreCase));

        // arrived is not answered yes: a load that outlasts the budget is the wait giving up on a page the browser is already on
        return Task.FromResult(arrived && budget >= LoadsAfter);
    }

    public string Shape { get; set; } = "at: https://www.asnbank.nl/ | buttons: none";

    public Task<string> DescribeAsync(CancellationToken ct)
    {
        _calls.Add("describe");
        return Task.FromResult(Shape);
    }

    public Task<string?> DownloadTextAsync(string triggerLabel, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"download:{triggerLabel}");
        return Task.FromResult(Download);
    }
}
