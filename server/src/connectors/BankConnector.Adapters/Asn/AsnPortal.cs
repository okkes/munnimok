using System.Text.RegularExpressions;
using Connector.Kit.Browsing;
using Microsoft.Playwright;

namespace BankConnector.Adapters.Asn;

/// <summary>How much of a button's label has to match.</summary>
internal enum LabelMatch
{
    /// <summary>All of it, so "Inloggen" does not also hit "Hulp bij inloggen".</summary>
    Exact,

    /// <summary>
    /// The beginning of it, for a label that carries a count.
    /// </summary>
    /// <remarks>
    /// ASN's select-all button reads "Alles selecteren (3)" - the number of
    /// accounts is IN the label, so the whole string is unknowable before the
    /// page is open. Matching it exactly is what broke the first live fetch:
    /// the click missed, spent its ten seconds missing, and took the export
    /// down with it.
    /// </remarks>
    Prefix,
}

/// <summary>
/// The handful of things this adapter does to de Volksbank's pages.
///
/// <para>
/// A seam rather than raw Playwright, for the reason every adapter here has
/// one: the whole login and the whole export are then drivable offline, and on
/// a bank whose sign-in costs a real attempt that is the difference between
/// finding a mistake in a test and finding it in somebody's account.
/// </para>
///
/// <para>
/// Narrower than <c>ILoginPage</c> on purpose. ASN needs three things that
/// selector-and-timeout interface cannot express: clicking a button by the word
/// on it, finding an element by its SHAPE, and capturing a download. Each is
/// here because the discovery session proved it necessary.
/// </para>
/// </summary>
internal interface IAsnPortal
{
    /// <summary>Where the browser is. The signed-in test is a path, not a word.</summary>
    string Url { get; }

    Task GotoAsync(string url, CancellationToken ct);

    /// <summary>
    /// Clicks the first visible button whose label reads this.
    /// </summary>
    /// <remarks>
    /// BY THE WORD ON IT, which this codebase avoids everywhere else and cannot
    /// avoid here. ASN's three sign-in methods are three <c>button.ap-button</c>
    /// elements distinguished by nothing but their text, and the same is true
    /// of "Downloaden", "Opslaan" and "Uitloggen". They are the provider's own
    /// product and action names rather than prose, which is the most that can
    /// be said for it.
    /// </remarks>
    Task<bool> ClickLabelAsync(string label, LabelMatch match, CancellationToken ct);

    Task<bool> ClickAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// <summary>Clicks the nth match, because ASN names every button alike.</summary>
    Task<bool> ClickNthAsync(IReadOnlyList<string> selectors, int index, CancellationToken ct);

    /// <summary>
    /// How many of these there are, which is how this bank states its own
    /// account count without being asked for a single account detail.
    /// </summary>
    /// <remarks>
    /// The account dialog holds one checkbox per account. Counting them is a
    /// number, not a name or an IBAN, and it is the only thing that makes "did
    /// this export cover everything" a question with an answer.
    /// </remarks>
    Task<int> CountAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// <summary>
    /// Clicks without asking whether the element looks clickable.
    /// </summary>
    /// <remarks>
    /// FOR A CONTROL THAT IS REAL BUT UNREACHABLE. ASN's account select is in
    /// every capture of its export form and Playwright refuses to click it, the
    /// signature of a native element parked behind a styled wrapper. A forced
    /// click dispatches at the element's own box, which is where that wrapper
    /// is - so it reaches the thing a person presses.
    /// <para>
    /// Only ever used where the RESULT is checked afterwards. Skipping
    /// actionability means skipping the checks that would otherwise catch a
    /// click going somewhere unintended, so it is worth nothing without the
    /// question "did that do what I wanted".
    /// </para>
    /// </remarks>
    Task<bool> ClickForceAsync(IReadOnlyList<string> selectors, CancellationToken ct);

    /// <summary>Types into the nth match, because ASN names every input alike.</summary>
    Task<bool> FillNthAsync(IReadOnlyList<string> selectors, int index, string value, CancellationToken ct);

    /// <summary>
    /// Gets the nth tickable control into a state, however this page allows,
    /// and answers which way worked.
    /// </summary>
    /// <remarks>
    /// A LADDER, BECAUSE THE REAL INPUT IS OFTEN NOT THE THING YOU PRESS.
    /// De Volksbank styles a label and parks the actual control behind it, so
    /// Playwright finds the input, refuses to act on it, and reports the same
    /// miss it would report for an element that is not there at all. That cost
    /// a live fetch: "the format modal has no radio at index 2" was raised
    /// against a modal the probe could see five radios in.
    /// <para>
    /// VERIFIED BY THE CONTROL ITSELF. Reading whether a box is ticked needs no
    /// actionability at all, so unlike a click, this can be checked exactly
    /// rather than inferred from something else on the page moving.
    /// </para>
    /// </remarks>
    /// <returns>How it was set, or null if nothing worked.</returns>
    Task<string?> SetCheckedNthAsync(
        IReadOnlyList<string> selectors, int index, bool value, CancellationToken ct);

    /// <summary>
    /// Waits until the address contains one marker and is rid of another.
    /// </summary>
    /// <remarks>
    /// BOTH, BECAUSE ONE IS A PREFIX OF THE OTHER. ASN signs people in at
    /// <c>/online/web/onlinebankieren/inloggen/</c> and lands them on
    /// <c>/online/web/onlinebankieren/</c> - so "contains the signed-in path"
    /// is already true on the sign-in page, and a wait built on it alone
    /// returns instantly, before anybody has scanned anything.
    /// <para>
    /// ENDS WHEN THE TOKEN DOES, not only when the budget does. This is the
    /// wait that holds a browser open on somebody's bank for twelve minutes
    /// while they register it, so it is the one wait here where a lost lease,
    /// a spent budget or a shutdown has to be able to get in.
    /// </para>
    /// </remarks>
    Task<bool> WaitForPathAsync(string contains, string? without, TimeSpan budget, CancellationToken ct);

    /// <summary>
    /// Whether one of these is on the page yet.
    /// </summary>
    /// <remarks>
    /// THE SAME QUESTION <see cref="HasLabelAsync"/> ASKS, for a selector
    /// rather than a word. It exists because this bank answers "who are you"
    /// with which controls it renders: a sign-in page with a five-digit box on
    /// it is a registered browser, and one with method buttons is not. Until
    /// this the adapter found that out by trying to TYPE into the box, which
    /// needs something to type - and a registered browser that arrived with
    /// no code had no way to ask.
    /// <para>
    /// Present is enough; nothing here is pressed. A control that is on the
    /// page but not yet reachable still answers yes, and whatever acts on it
    /// afterwards is what finds out whether it can.
    /// </para>
    /// </remarks>
    Task<bool> HasAsync(IReadOnlyList<string> selectors, TimeSpan budget, CancellationToken ct);

    /// <summary>
    /// Clicks something and hands back whatever file it produced.
    /// </summary>
    /// <remarks>
    /// THE QUESTION THIS MAKES MOOT. Whether ASN's export is served as an
    /// ordinary response or assembled in the browser as a blob was the last
    /// open item on this provider, and it turns out not to matter: Playwright's
    /// download event fires for both, and hands over a file either way. ING's
    /// blob was only fatal there because that adapter was trying to REQUEST a
    /// URL.
    /// </remarks>
    Task<string?> DownloadTextAsync(string triggerLabel, TimeSpan budget, CancellationToken ct);

    /// <summary>
    /// Waits for one of the page's own headings to read this.
    /// </summary>
    /// <remarks>
    /// HOW A CLICK IS CHECKED TO HAVE LANDED. Every failure this adapter has
    /// had on a real account has the same shape: something was clicked, nobody
    /// asked whether it did what was wanted, and the next step went hunting on
    /// a page that had moved on - once onto a different URL entirely. A dialog
    /// announces itself with a heading, so opening one is a claim that can be
    /// tested rather than assumed.
    /// </remarks>
    Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct);

    /// <summary>
    /// Whether a button reading this is on the page yet.
    /// </summary>
    /// <remarks>
    /// ASKING IS CHEAP; CLICKING AND MISSING IS NOT. A click that finds
    /// nothing spends the full ten seconds first, so a search over three
    /// candidate menus costs half a minute of nothing happening - which is how
    /// a courtesy sign-out gets cancelled mid-hunt and reports nothing at all.
    /// <para>
    /// The same question the click would ask, with its own budget and without
    /// the actionability wait: a control that is present but covered still
    /// answers yes here, and it is the click afterwards that decides whether it
    /// can be pressed.
    /// </para>
    /// </remarks>
    Task<bool> HasLabelAsync(string label, TimeSpan budget, CancellationToken ct);

    /// <summary>
    /// What the page is made of, for the moment something did not work.
    /// </summary>
    /// <remarks>
    /// The same probe the discovery run is built on - selectors, roles and
    /// counts, no values. A login that fails here fails on somebody's real
    /// bank, where the run cannot simply be repeated with more logging, so the
    /// diagnosis has to travel with the first failure.
    /// </remarks>
    Task<string> DescribeAsync(CancellationToken ct);
}

/// <summary>The real one, over a Playwright page.</summary>
internal sealed class AsnPortal(IPage page) : IAsnPortal
{
    /// <summary>
    /// "Starts with this label", in a form BOTH regex engines agree on.
    /// </summary>
    /// <remarks>
    /// A regex rather than Playwright's <c>Exact = false</c>, which is a
    /// SUBSTRING match and would let a label ending in the wanted words answer
    /// for one beginning with them.
    /// <para>
    /// AND THE SPACES ARE UNESCAPED AGAIN ON PURPOSE. This pattern does not
    /// stay in .NET - Playwright serialises it to the driver, where a JavaScript
    /// engine compiles it. <see cref="Regex.Escape"/> turns a space into
    /// <c>\ </c>, which .NET reads as a literal space, JavaScript accepts only
    /// as a legacy identity escape, and a unicode-mode JavaScript regex rejects
    /// outright. A bare space means one space in every engine there is. The
    /// difference would not have shown up until a label with a space in it was
    /// hunted for on a real bank - which is every label this bank has.
    /// </para>
    /// </remarks>
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
        FirstAsync(selectors, ct, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        });

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
            }
        }

        return 0;
    }

    public Task<bool> ClickForceAsync(IReadOnlyList<string> selectors, CancellationToken ct) =>
        FirstAsync(selectors, ct, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000, Force = true })
                .ConfigureAwait(false);

            return true;
        });

    public Task<bool> ClickNthAsync(IReadOnlyList<string> selectors, int index, CancellationToken ct) =>
        NthAsync(selectors, index, ct, async locator =>
        {
            await locator.ClickAsync(new LocatorClickOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        });

    public Task<bool> FillNthAsync(
        IReadOnlyList<string> selectors, int index, string value, CancellationToken ct) =>
        NthAsync(selectors, index, ct, async locator =>
        {
            await locator.FillAsync(value, new LocatorFillOptions { Timeout = 10_000 }).ConfigureAwait(false);
            return true;
        });

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
                    // The next way up the ladder. A control that cannot be
                    // reached one way is the normal case on this bank.
                }
            }
        }

        return null;
    }

    /// <summary>
    /// The ways to tick something, least violent first.
    /// </summary>
    /// <remarks>
    /// The last one CLICKS THE BOX AROUND IT, which is what a person presses -
    /// the same discovery that got this adapter past the account select. It is
    /// last because a click TOGGLES rather than sets, so it is only ever right
    /// when the control is not already in the wanted state; every rung here is
    /// guarded by a read of that state before and after.
    /// </remarks>
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
        // Before the wait exists, so a token that is already cancelled leaves
        // nothing running in the driver.
        ct.ThrowIfCancellationRequested();

        return await UntilCancelledAsync(
                page.WaitForURLAsync(
                    url => url.Contains(contains, StringComparison.OrdinalIgnoreCase)
                           && (without is null || !url.Contains(without, StringComparison.OrdinalIgnoreCase)),
                    new PageWaitForURLOptions { Timeout = (float)budget.TotalMilliseconds }),
                ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// A Playwright wait, raced against the token it was handed.
    /// </summary>
    /// <remarks>
    /// PLAYWRIGHT'S WAITS TAKE A TIMEOUT AND NOTHING ELSE. There is no token
    /// to pass, so a wait for the address to change ran until the address
    /// changed or the budget ran out, and a cancellation arriving in between
    /// changed nothing: the handler for it sat below a call that could never
    /// throw it. On a ten-second wait that is a rounding error. On the
    /// twelve-minute wait for somebody to register a browser it meant a lost
    /// lease, a spent budget or an agent shutting down could not end the run,
    /// and the browser stayed open on their bank until ASN moved it or the
    /// clock did.
    /// <para>
    /// So the token gets a task of its own and whichever finishes first
    /// decides. When it is the token, the Playwright wait is left to run out
    /// on its own - there is no way to stop it - and its eventual timeout is
    /// observed so that it does not surface as an unobserved fault later.
    /// The seam is static and takes any task, which is what lets the race be
    /// tested without a browser.
    /// </para>
    /// </remarks>
    /// <returns>True when the wait landed, false when it ran out of budget.</returns>
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
        // THE WHOLE BUDGET SPLIT ACROSS THE CANDIDATES, the way PageOps does
        // it: five selectors at the full budget each would turn a page that
        // has none of them into a wait five times longer than anyone asked
        // for.
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
                // The next candidate, exactly as a click would move on.
            }
        }

        return false;
    }

    public async Task<bool> HasHeadingAsync(string text, TimeSpan budget, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        // Substring rather than exact: the dialog reads "Kies een rekening"
        // while the form beneath it permanently reads "Kies je rekening(en)",
        // and neither contains the other - so the looser match costs nothing
        // and survives a heading that grows a count.
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

        // EXACTLY AS THE CLICK WILL ASK FOR IT, or this answers for a different
        // control than the one that gets pressed.
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
        IReadOnlyList<string> selectors, CancellationToken ct, Func<ILocator, Task<bool>> act)
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
                // The next candidate. A provider renames an id between
                // releases and the list is what survives it.
            }
        }

        return false;
    }

    private async Task<bool> NthAsync(
        IReadOnlyList<string> selectors, int index, CancellationToken ct, Func<ILocator, Task<bool>> act)
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
            }
        }

        return false;
    }
}
