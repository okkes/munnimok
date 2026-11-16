using System.Text.RegularExpressions;
using Connector.Kit.Browsing;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Asn;

internal enum LabelMatch
{
    /// <summary>All of it, so "Inloggen" does not also hit "Hulp bij inloggen".</summary>
    Exact,

    /// The beginning of it, for a label with a count ("Alles selecteren (3)") unknowable before the page is open.
    Prefix,
}

/// A seam over Playwright so the login and export run offline: a sign-in costs a real attempt on a real account.
internal interface IAsnPortal
{
    /// <summary>Where the browser is. The signed-in test is a path, not a word.</summary>
    string Url { get; }

    Task GotoAsync(string url, CancellationToken ct);

    /// By the word on it: ASN's sign-in methods and actions (Downloaden, Opslaan, Uitloggen) differ by text alone.
    Task<bool> ClickLabelAsync(string label, LabelMatch match, CancellationToken ct);

    Task<bool> ClickAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// <summary>Clicks the nth match, because ASN names every button alike.</summary>
    Task<bool> ClickNthAsync(IReadOnlyList<string> selectors, int index, CancellationToken ct);

    /// A number, not a name or IBAN: the dialog's checkbox count is the only way
    /// "did this export cover everything" has an answer.
    Task<int> CountAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// For a control that is real but unreachable (ASN's account select: a native element behind a styled wrapper).
    /// Only where the result is checked afterwards: skipping actionability skips the checks that catch a stray click.
    Task<bool> ClickForceAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// <summary>Types into the nth match, because ASN names every input alike.</summary>
    Task<bool> FillNthAsync(IReadOnlyList<string> selectors, int index, string value, CancellationToken ct);

    /// A ladder: de Volksbank parks the real input behind a styled label, so Playwright reports the same miss as for an absent
    /// element. Verified by reading the control's own checked state.
    Task<string?> SetCheckedNthAsync(
        IReadOnlyList<string> selectors, int index, bool value, CancellationToken ct);

    /// Both markers, since one is a prefix of the other: the sign-in path sits under the signed-in one,
    /// so a wait on it alone returns at once. Ends when the token does: this wait holds a browser open for twelve minutes.
    Task<bool> WaitForPathAsync(string contains, string? without, TimeSpan budget, CancellationToken ct);

    /// ASN says "who are you" by which controls it renders (five-digit box = registered, method buttons = not).
    /// Present is enough; nothing is pressed.
    Task<bool> HasAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct);

    /// Playwright's download event fires for a response or an in-browser blob alike, so which ASN serves does not matter.
    Task<string?> DownloadTextAsync(string triggerLabel, TimeSpan budget, CancellationToken ct);

    /// How a click is checked to have landed: a dialog announces itself with a heading; past failures were unverified clicks.
    Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct);

    /// Asking is cheap, clicking and missing is not: a miss spends ten seconds, so searching three menus would get a courtesy
    /// sign-out cancelled. Present-but-covered answers yes; the click afterwards decides.
    Task<bool> HasLabelAsync(string label, TimeSpan budget, CancellationToken ct);

    /// The discovery probe's output (selectors, roles, counts, no values), for a failure that cannot be re-run.
    Task<string> DescribeAsync(CancellationToken ct);
}

internal sealed class AsnPortal(IPage page) : IAsnPortal
{
    /// A regex, since Exact = false is a substring match. Spaces are unescaped again: Playwright sends the pattern to
    /// a JavaScript engine, where Regex.Escape's "\ " is a legacy escape that unicode-mode regexes reject.
    internal static Regex PrefixPattern(string label) =>
        new(
            "^" + Regex.Escape(label).Replace("\\ ", " ", StringComparison.Ordinal),
            RegexOptions.None,
            TimeSpan.FromSeconds(1));

    public string Url => page.Url;

    public async Task GotoAsync(string url, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await page.GotoAsync(url).ConfigureAwait(false);
    }

    public async Task<bool> ClickLabelAsync(string label, LabelMatch match, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var options = match == LabelMatch.Prefix
            ? new PageGetByRoleOptions { NameRegex = PrefixPattern(label) }
            : new PageGetByRoleOptions { Name = label, Exact = true };

        var button = page.GetByRole(AriaRole.Button, options).First;

        try
        {
            await button.ClickAsync(new LocatorClickOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
        }
    }

    public Task<bool> ClickAsync(IReadOnlyList<string> selectors, CancellationToken ct) =>
        FirstAsync(selectors, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        }, ct);

    public async Task<int> CountAsync(IReadOnlyList<string> selectors, CancellationToken ct)
    {
        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                var found = await page.Locator(selector).CountAsync().ConfigureAwait(false);
                if (found > 0) return found;
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // next candidate: no match is the ordinary case, and zero is then the honest count
            }
        }

        return 0;
    }

    public Task<bool> ClickForceAsync(IReadOnlyList<string> selectors, CancellationToken ct) =>
        FirstAsync(selectors, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000, Force = true })
                .ConfigureAwait(false);

            return true;
        }, ct);

    public Task<bool> ClickNthAsync(IReadOnlyList<string> selectors, int index, CancellationToken ct) =>
        NthAsync(selectors, index, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        }, ct);

    public Task<bool> FillNthAsync(
        IReadOnlyList<string> selectors, int index, string value, CancellationToken ct) =>
        NthAsync(selectors, index, async locator =>
        {
            await locator.FillAsync(value, new LocatorFillOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        }, ct);

    public async Task<string?> SetCheckedNthAsync(
        IReadOnlyList<string> selectors, int index, bool value, CancellationToken ct)
    {
        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();

            var control = page.Locator(selector).Nth(index);

            foreach (var (how, act) in Ways(control, value))
            {
                try
                {
                    if (await control.IsCheckedAsync().ConfigureAwait(false) == value) return "already";

                    await act().ConfigureAwait(false);

                    if (await control.IsCheckedAsync().ConfigureAwait(false) == value) return how;
                }
                catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
                {
                    // next way up the ladder: a control unreachable one way is normal on this bank
                }
            }
        }

        return null;
    }

    /// Least violent first; the last clicks the box around it, which toggles rather than sets, so each rung is guarded by reads
    /// of the state before and after.
    private static IEnumerable<(string How, Func<Task> Act)> Ways(ILocator control, bool value)
    {
        yield return ("directly", () =>
            control.SetCheckedAsync(value, new LocatorSetCheckedOptions { Timeout = 10_000 }));

        yield return ("forced", () =>
            control.SetCheckedAsync(value, new LocatorSetCheckedOptions { Timeout = 10_000, Force = true }));

        yield return ("by the box around it", () =>
            control.Locator("xpath=..").ClickAsync(new LocatorClickOptions { Timeout = 10_000 }));
    }

    public async Task<bool> WaitForPathAsync(
        string contains, string? without, TimeSpan budget, CancellationToken ct)
    {
        // before the wait exists, so an already-cancelled token leaves nothing running in the driver
        ct.ThrowIfCancellationRequested();

        return await UntilCancelledAsync(
                page.WaitForURLAsync(
                    url => url.Contains(contains, StringComparison.OrdinalIgnoreCase)
                           && (without is null || !url.Contains(without, StringComparison.OrdinalIgnoreCase)),
                    new PageWaitForURLOptions { Timeout = (float)budget.TotalMilliseconds }),
                ct)
            .ConfigureAwait(false);
    }

    /// Playwright waits take a timeout and no token: without this race a lost lease or shutdown could not end
    /// the twelve-minute wait. When the token wins, the wait runs out on its own (it cannot be stopped).
    internal static async Task<bool> UntilCancelledAsync(Task wait, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        using var stop = ct.Register(static s => ((TaskCompletionSource)s!).TrySetResult(), cancelled);

        if (await Task.WhenAny(wait, cancelled.Task).ConfigureAwait(false) == cancelled.Task)
        {
            _ = wait.ContinueWith(static t => t.Exception, TaskScheduler.Default);

            ct.ThrowIfCancellationRequested();
        }

        try
        {
            await wait.ConfigureAwait(false);

            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
        }
    }

    public async Task<bool> HasAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct)
    {
        // the budget split across the candidates, as PageOps does: five at the full budget would wait five times longer than asked
        var each = TimeSpan.FromMilliseconds(
            Math.Max(500, budget.TotalMilliseconds / Math.Max(1, selectors.Count)));

        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                await page.Locator(selector).First.WaitForAsync(new LocatorWaitForOptions
                {
                    State = WaitForSelectorState.Visible,
                    Timeout = (float)each.TotalMilliseconds,
                }).ConfigureAwait(false);

                return true;
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // next candidate
            }
        }

        return false;
    }

    public async Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // substring: the dialog heading and the form's "Kies je rekening(en)" do not contain each other.
        // survives a count in the heading
        var heading = page.GetByRole(AriaRole.Heading, new() { Name = text, Exact = false }).First;

        try
        {
            await heading.WaitForAsync(new LocatorWaitForOptions
            {
                State = WaitForSelectorState.Visible,
                Timeout = (float)budget.TotalMilliseconds,
            }).ConfigureAwait(false);

            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
        }
    }

    public async Task<bool> HasLabelAsync(string label, TimeSpan budget, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // exactly as the click asks for it, or this answers for another control
        var button = page.GetByRole(AriaRole.Button, new() { Name = label, Exact = true }).First;

        try
        {
            await button.WaitForAsync(new LocatorWaitForOptions
            {
                State = WaitForSelectorState.Visible,
                Timeout = (float)budget.TotalMilliseconds,
            }).ConfigureAwait(false);

            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return false;
        }
    }

    public async Task<string?> DownloadTextAsync(string triggerLabel, TimeSpan budget, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            var download = await page.RunAndWaitForDownloadAsync(
                async () => await ClickLabelAsync(triggerLabel, LabelMatch.Exact, ct).ConfigureAwait(false),
                new PageRunAndWaitForDownloadOptions { Timeout = (float)budget.TotalMilliseconds })
                .ConfigureAwait(false);

            var path = await download.PathAsync().ConfigureAwait(false);

            return path is null ? null : await File.ReadAllTextAsync(path, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return null;
        }
    }

    public async Task<string> DescribeAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        try
        {
            return PageShape.Describe(
                await page.EvaluateAsync<System.Text.Json.JsonElement>(PageShape.Script).ConfigureAwait(false));
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return $"the page could not be described ({ex.GetType().Name})";
        }
    }

    private async Task<bool> FirstAsync(
        IReadOnlyList<string> selectors, Func<ILocator, Task<bool>> act, CancellationToken ct)
    {
        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                return await act(page.Locator(selector).First).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // next candidate: a renamed id survives via the list
            }
        }

        return false;
    }

    private async Task<bool> NthAsync(
        IReadOnlyList<string> selectors, int index, Func<ILocator, Task<bool>> act, CancellationToken ct)
    {
        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                return await act(page.Locator(selector).Nth(index)).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // next candidate
            }
        }

        return false;
    }
}
