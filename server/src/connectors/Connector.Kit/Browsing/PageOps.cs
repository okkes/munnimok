using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Microsoft.Playwright;

namespace Connector.Kit.Browsing;

// no login page has a published contract, so every selector is a guess: candidates ordered most-specific first;
// a miss on all is ProviderChanged with the list in the detail
public static class PageOps
{
    public static async Task<IElementHandle> RequireAsync(
        IPage page, IReadOnlyList<string> selectors, string providerId, string what, int timeoutMs, CancellationToken ct)
    {
        var handle = await FindAsync(page, selectors, timeoutMs, ct).ConfigureAwait(false);
        return handle ?? throw ConnectorException.ProviderChanged(
            $"{providerId}: no element for {what}; tried [{string.Join(", ", selectors)}]");
    }

    // Playwright .NET raises System.TimeoutException, not PlaywrightException, when a wait expires; catching only the latter
    // let a missing cookie banner take a whole login down (first live Albert Heijn attempt)
    public static bool IsSelectorMiss(Exception ex) =>
        ex is PlaywrightException or System.TimeoutException;

    // per-selector budget = whole budget / candidate count: five at ten seconds would outlive the job's own timeout
    public static async Task<IElementHandle?> FindAsync(
        IPage page, IReadOnlyList<string> selectors, int timeoutMs, CancellationToken ct)
    {
        if (selectors.Count == 0) return null;

        var perSelector = Math.Max(500, timeoutMs / selectors.Count);
        foreach (var selector in selectors)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var handle = await page.WaitForSelectorAsync(selector, new PageWaitForSelectorOptions
                {
                    Timeout = perSelector,
                    State = WaitForSelectorState.Visible,
                }).ConfigureAwait(false);

                if (handle is not null) return handle;
            }
            catch (Exception ex) when (IsSelectorMiss(ex))
            {
                // A selector that never appeared is the normal case here -
                // that is what a candidate list is for.
            }
        }

        return null;
    }

    public static async Task FillAsync(
        IPage page, IReadOnlyList<string> selectors, string value, string providerId, string what,
        int timeoutMs, CancellationToken ct)
    {
        var handle = await RequireAsync(page, selectors, providerId, what, timeoutMs, ct).ConfigureAwait(false);
        await handle.FillAsync(value, new() { Timeout = timeoutMs }).ConfigureAwait(false);
    }

    // the click runs on the caller's budget, not Playwright's 30 s default: DUO's chooser parks the real radio input
    // off-screen, so the click retried for 30 s against a caller that asked for four
    public static async Task ClickAsync(
        IPage page, IReadOnlyList<string> selectors, string providerId, string what, int timeoutMs, CancellationToken ct)
    {
        var handle = await RequireAsync(page, selectors, providerId, what, timeoutMs, ct).ConfigureAwait(false);
        await handle.ClickAsync(new() { Timeout = timeoutMs }).ConfigureAwait(false);
    }

    // everything outside the crop is obscured before an image leaves the agent
    public static async Task<CropRegion?> CropAsync(IElementHandle handle)
    {
        var box = await handle.BoundingBoxAsync().ConfigureAwait(false);
        if (box is null) return null;

        return new CropRegion((int)box.X, (int)box.Y, (int)box.Width, (int)box.Height);
    }

    public const int SettlePollMs = 150;

    // a frame with no images is Pending too: the widget swaps its picture in just after clearing the panel
    private const string DrawScript = @"
() => {
  const imgs = Array.from(document.images || []);
  if (imgs.length === 0) return 'pending';
  if (imgs.some(i => !i.complete)) return 'pending';
  return imgs.some(i => i.naturalWidth > 0) ? 'drawn' : 'broken';
}";

    // unreadable answers Broken, not Pending: a frame we cannot ask about is not waited on; the caller photographs regardless
    public static async Task<DrawState> IsDrawnAsync(
        IPage page, IReadOnlyList<string> selectors, CancellationToken ct)
    {
        try
        {
            var handle = await FindAsync(page, selectors, SettlePollMs, ct).ConfigureAwait(false);
            if (handle is null) return DrawState.Broken;

            var frame = await handle.ContentFrameAsync().ConfigureAwait(false);
            if (frame is null) return DrawState.Broken;

            var state = await frame.EvaluateAsync<string>(DrawScript).ConfigureAwait(false);
            return state switch
            {
                "drawn" => DrawState.Drawn,
                "pending" => DrawState.Pending,
                _ => DrawState.Broken,
            };
        }
        catch (Exception ex) when (IsSelectorMiss(ex) || ex is PlaywrightException)
        {
            return DrawState.Broken;
        }
    }
}

/// <summary>What a frame currently has in it. Only <c>Pending</c> is worth waiting on.</summary>
public enum DrawState
{
    Pending,

    Drawn,

    Broken,
}
