using BankConnector.Adapters.Asn;

namespace BankConnector.Adapters.Tests.Support;

/// <summary>
/// de Volksbank's pages, as a fixture.
///
/// Records every call in order, because on this provider the ORDER is most of
/// what can go wrong offline: the cookie wall stands in front of everything,
/// the format has to be chosen before the download is clicked, and a date typed
/// after the format modal opens goes into the modal.
/// </summary>
internal sealed class StubAsnPortal : IAsnPortal
{
    private readonly List<string> _calls = [];
    private readonly Dictionary<string, string> _filled = new(StringComparer.Ordinal);
    private readonly Dictionary<string, bool> _checked = new(StringComparer.Ordinal);

    public string Url { get; set; } = "https://www.asnbank.nl/online/web/onlinebankieren/inloggen/";

    /// <summary>Labels this page will accept a click on. Everything else misses.</summary>
    public HashSet<string> Labels { get; } = new(StringComparer.Ordinal);

    /// <summary>What a download hands back. Null means nothing arrived.</summary>
    public string? Download { get; set; }

    /// <summary>Where the browser goes when a path is waited for.</summary>
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

    /// <summary>
    /// A browser that has been NOWHERE, which is what a logout job gets.
    /// </summary>
    /// <remarks>
    /// The lease is fresh: a logout job opens a page at about:blank and the
    /// adapter has to navigate before any of the bank's controls exist. ASN's
    /// sign-out was written without that and hunted "Uitloggen" on a blank
    /// page, then reported the miss as "no sign-out button was on the page" -
    /// blaming the bank for a page nobody had asked it for.
    /// <para>
    /// A fixture whose labels are present before it has navigated cannot tell
    /// that apart from a working sign-out, which is why both existing logout
    /// tests passed over it.
    /// </para>
    /// </remarks>
    public static StubAsnPortal Blank(params string[] labels)
    {
        var portal = new StubAsnPortal { Url = "about:blank", LabelsNeedNavigation = true };
        portal.Labels.UnionWith(labels);

        return portal;
    }

    /// <summary>Whether this page's controls exist only after a navigation.</summary>
    public bool LabelsNeedNavigation { get; set; }

    private bool _navigated;

    /// <summary>
    /// Where this page sends the browser instead of where it asked to go.
    /// </summary>
    /// <remarks>
    /// A bank answers a signed-in address with its sign-in page once the
    /// session is gone, and a stub whose goto always lands where it aimed
    /// cannot model that - it makes an expired session look identical to a
    /// missing button, which is how a live disconnect came to report ASN as
    /// having no sign-out.
    /// </remarks>
    public string? RedirectsTo { get; set; }

    /// <summary>
    /// Where this page sends the browser AFTER the navigation has returned.
    /// </summary>
    /// <remarks>
    /// The other kind of bounce. <see cref="RedirectsTo"/> is a server that
    /// answers the request with a different page, so the address has changed
    /// by the time the navigation returns; this is a page that loads, looks
    /// at its session and moves itself on, so the address has NOT changed yet
    /// when the navigation returns and has by the time anything else is
    /// asked. An adapter that reads the address the instant a goto comes
    /// back is right about the first kind and wrong about the second, and a
    /// stub with only the first kind cannot say so.
    /// </remarks>
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

    /// <summary>
    /// Time passing, which is when a client-side bounce lands.
    /// </summary>
    private void Settle()
    {
        if (_pendingMove is null) return;

        Url = _pendingMove;
        _pendingMove = null;
    }

    /// <summary>
    /// Matches the way the live page does, EXACTNESS INCLUDED.
    /// </summary>
    /// <remarks>
    /// The stub used to hold the labels the adapter asks for rather than the
    /// ones the bank renders, so every click hit and the suite could not tell
    /// the two apart. ASN's select-all reads "Alles selecteren (3)" - the count
    /// is in the label - and an exact match on "Alles selecteren" misses it.
    /// A fixture that cannot miss cannot model that.
    /// </remarks>
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

    /// <summary>
    /// Headings this page shows. A dialog is modelled by its heading, because
    /// that is how the adapter checks one opened.
    /// </summary>
    public HashSet<string> Headings { get; } = new(StringComparer.Ordinal);

    /// <summary>
    /// Which click reveals which heading. ONLY the right control opens a dialog.
    /// </summary>
    /// <remarks>
    /// The fixture used to hold the dialog's heading from the start, so the
    /// adapter's check that it opened passed no matter what had been clicked -
    /// which is the same failure the select-all fixture had: a page that cannot
    /// say no cannot test a claim. Keyed by the recorded call, so a click on
    /// the wrong button opens nothing, exactly as on the bank.
    /// </remarks>
    public Dictionary<string, string> Opens { get; } = new(StringComparer.Ordinal);

    /// <summary>
    /// Which click puts which BUTTON on the page.
    /// </summary>
    /// <remarks>
    /// The same idea as <see cref="Opens"/>, for a control rather than a
    /// dialog, and it exists because of the one this fixture could not state:
    /// ASN's "Uitloggen" is inside the hamburger menu, so at the phone width
    /// the agent emulates it is not rendered until the menu is opened. A stub
    /// holding the label from the start cannot tell a sign-out that opened the
    /// menu from one that never did - and both sign-out tests passed while the
    /// live one had never once worked.
    /// </remarks>
    public Dictionary<string, string> RevealsLabel { get; } = new(StringComparer.Ordinal);

    /// <summary>
    /// What a press puts OVER the page: the buttons it then counts.
    /// </summary>
    /// <remarks>
    /// THE REASON A LADDER HAS TO RESET BETWEEN RUNGS. A positional handle
    /// counts what is on the page, and a panel opened by the rung before is on
    /// the page - so pressing "the second header control" after something has
    /// opened presses the second control of the PANEL. ASN's search does
    /// exactly this: the first press replaced the header with "Veel gebruikte
    /// links", a search box and three buttons, and the enumeration that
    /// followed was over the wrong set entirely.
    /// <para>
    /// Without this a fixture cannot tell a ladder that resets from one that
    /// does not, and both read as working.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// Puts the page back, which is what a navigation does.
    /// </summary>
    private void Uncover()
    {
        if (_uncovered is not null)
        {
            ButtonsInOrder.Clear();
            ButtonsInOrder.AddRange(_uncovered);
            _uncovered = null;
        }

        // And whatever a press had revealed is shut again - a fresh page has no
        // menu open on it.
        foreach (var label in _revealed) Labels.Remove(label);

        _revealed.Clear();
    }

    public Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"heading?:{text}");
        Settle();

        // Substring, as Playwright's own heading match is - so a fixture cannot
        // pass on an exactness the live page does not enforce.
        return Task.FromResult(Headings.Any(h => h.Contains(text, StringComparison.Ordinal)));
    }

    /// <summary>
    /// The same question <see cref="ClickLabelAsync"/> asks, answered the same
    /// way - so a fixture cannot say a button is there and then miss it.
    /// </summary>
    public Task<bool> HasLabelAsync(string label, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"label?:{label}");
        Settle();

        return Task.FromResult((!LabelsNeedNavigation || _navigated) && Labels.Contains(label));
    }

    /// <summary>Selectors this page does NOT have. Everything else is present.</summary>
    public HashSet<string> AbsentSelectors { get; } = new(StringComparer.Ordinal);

    /// <summary>
    /// How long a selector takes to turn up, for the ones that are not there
    /// at once.
    /// </summary>
    /// <remarks>
    /// A probe with a budget shorter than this misses; one with a budget at
    /// least this long hits. It is the only way a fixture can state that a
    /// budget is the right LENGTH rather than merely present - and the
    /// signed-in test's settle window is a length nobody has measured, so
    /// the one thing worth pinning is that the option is what gets spent.
    /// </remarks>
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

    /// <summary>How many of a thing this page has, for the ones that are counted.</summary>
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

        return Task.FromResult(hit);
    }

    /// <summary>
    /// Buttons this page has, in order, for the positional handle.
    /// </summary>
    /// <remarks>
    /// A list rather than a count, because the thing that made the account
    /// picker hard to hold on to is that its label changes underneath it while
    /// its position does not.
    /// </remarks>
    public List<string> ButtonsInOrder { get; } = [];

    /// <summary>Selectors this page has that only a FORCED click can reach.</summary>
    /// <remarks>
    /// ASN's account select is listed by every capture of its form and
    /// Playwright refuses to click it - a native control behind a styled
    /// wrapper. A stub where every selector answers an ordinary click cannot
    /// tell a reachable control from an unreachable one, which is the whole
    /// distinction that sent the last attempt wrong.
    /// </remarks>
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

            // AND BY WHAT WAS PRESSED, not only by where it was pressed.
            //
            // A control has an identity; an index is just how it is reached
            // this time. Keying only on the index made a positional ladder that
            // never reset indistinguishable from one that did - press 0 opens a
            // panel, press 1 lands inside the panel, and the fixture still
            // reported the header control being revealed because the CALL was
            // the same either way.
            Reveal($"press:{ButtonsInOrder[index]}");
        }

        return Task.FromResult(hit);
    }

    private readonly List<string> _clickedByPosition = [];

    /// <summary>Which buttons a positional click actually landed on.</summary>
    public IReadOnlyList<string> ClickedByPosition => _clickedByPosition;

    /// <summary>
    /// Types into a box, IF THE PAGE HAS ONE.
    /// </summary>
    /// <remarks>
    /// This used to answer true unconditionally, which made an absent input
    /// unsayable - and an absent input is not an edge case on this bank, it is
    /// how ASN tells you something. Its sign-in page shows a browsercode box to
    /// a browser it has registered and three method buttons to one it has not,
    /// so "is this profile still trusted" IS the question "is that box there".
    /// <para>
    /// A stub whose every fill lands cannot test either answer, and the adapter
    /// that depends on the distinction would have been written against a
    /// fixture that agrees with it whatever it does.
    /// </para>
    /// </remarks>
    public Task<bool> FillNthAsync(
        IReadOnlyList<string> selectors, int index, string value, CancellationToken ct)
    {
        var hit = !AbsentSelectors.Contains(selectors[0]);

        _calls.Add($"fill:{index}{(hit ? string.Empty : ":missed")}");

        if (!hit) return Task.FromResult(false);

        _filled[$"{selectors[0]}#{index}"] = value;

        return Task.FromResult(true);
    }

    /// <summary>
    /// Controls that exist but refuse to be set the ordinary way.
    /// </summary>
    /// <remarks>
    /// De Volksbank styles a label and parks the real input behind it, so
    /// Playwright reports the same miss for an unreachable control as for one
    /// that is not there. A live fetch raised "the format modal has no radio at
    /// index 2" against a modal the probe could see five radios in. A fixture
    /// where everything is settable cannot model that, and it is the single
    /// most repeated fact about this bank.
    /// </remarks>
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

        // Unreachable ones still yield - to the box around them, exactly as on
        // the bank. What must not happen is the adapter believing the plain way
        // worked.
        var how = UnreachableControls.Contains(key) ? "by the box around it" : "directly";

        _checked[key] = value;
        _calls.Add($"check:{index}:{how}");

        return Task.FromResult<string?>(how);
    }

    /// <summary>
    /// Run the moment the adapter starts waiting for the page to move.
    /// </summary>
    /// <remarks>
    /// The hook exists for one claim: a relayed QR has to still be live WHILE
    /// the adapter waits for the scan to land. Asserting the challenge was
    /// raised, and asserting it was cancelled, both pass if it is raised and
    /// cancelled in the same breath - which is precisely the bug this caught.
    /// </remarks>
    public Action? OnWait { get; set; }

    /// <summary>
    /// How long the browser takes to get to <see cref="ArrivesAt"/>.
    /// </summary>
    /// <remarks>
    /// A wait whose budget is shorter than this runs out first, and the
    /// browser has not arrived anywhere when it does. It exists for one
    /// claim: that a bank checking a credential and serving an overview is
    /// given a budget for THAT, rather than the ten seconds a selector gets -
    /// a distinction no fixture where every arrival is instant can draw.
    /// </remarks>
    public TimeSpan ArrivesAfter { get; set; }

    /// <summary>
    /// How long the arrived-at page then takes to FINISH LOADING, which the
    /// real wait also waits for and which it also fails on.
    /// </summary>
    /// <remarks>
    /// Playwright's URL wait matches the address when the navigation commits
    /// and then keeps waiting, on the same clock, for the page's
    /// <c>load</c> event. So a budget can run out with the address already
    /// correct - the one outcome no fixture could produce before this, because
    /// a miss here left the address alone and therefore always meant "the
    /// browser never went". Read that way, a signed-in overview slow to finish
    /// loading was reported as a bank that had changed its pages.
    /// <para>
    /// Zero means the load is instant, which is every other fixture.
    /// </para>
    /// </remarks>
    public TimeSpan LoadsAfter { get; set; }

    public Task<bool> WaitForPathAsync(
        string contains, string? without, TimeSpan budget, CancellationToken ct)
    {
        _calls.Add($"wait:{contains}");
        OnWait?.Invoke();

        Settle();

        // Ran out before the browser got anywhere, so the address is whatever
        // it was.
        if (ArrivesAt is null || budget < ArrivesAfter)
        {
            return Task.FromResult(false);
        }

        // THE BROWSER WENT WHERE IT WENT, whether or not that was the place
        // waited for - so the address moves either way, and only the answer
        // says whether it was the wanted one. A stub that left the address
        // alone on a miss could not model a bank sending the browser
        // somewhere third, which is neither "refused" nor "signed in".
        Url = ArrivesAt;

        // The exclusion is honoured as well as the match, because the real trap
        // on this bank is that its sign-in path sits BENEATH its signed-in one.
        // A stub that tested only "contains" would model a wait that cannot
        // fail the way the live one did.
        var arrived = ArrivesAt.Contains(contains, StringComparison.OrdinalIgnoreCase)
                      && (without is null || !ArrivesAt.Contains(without, StringComparison.OrdinalIgnoreCase));

        // ARRIVED IS NOT THE SAME AS ANSWERED YES. The address moved above
        // whatever this returns; a load that outlasts the budget is the real
        // wait giving up on a page the browser is already on. See LoadsAfter.
        return Task.FromResult(arrived && budget >= LoadsAfter);
    }

    /// <summary>What DescribeAsync hands back, for the failure-diagnosis path.</summary>
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
