using Connector.Kit.Adapters;
using Connector.Kit.Browsing;

namespace ShopConnector.Adapters.Bol;

/// <summary>
/// bol's cookie wall, out of the way before anything on the page is touched.
///
/// 2026-10-06 (prod, four logins in a day): bol serves the wall as a Radix
/// dialog over the whole page; the consent click found a button underneath
/// it and Playwright's click timed out on the dialog's own paragraph - and
/// that timeout took the whole login down as internal. Refusing comes first
/// (fewer trackers in a session that is the person's own), accepting is the
/// fallback; a wall that will not go away is noted and left to the next
/// step, never a failed login by itself. The same step guards the hash
/// probe's "Toon meer", which the wall swallowed just the same.
///
/// 2026-10-07 (prod, the user's lab link): behind the cookie wall bol now
/// raises a SECOND full-screen dialog - the language chooser, with
/// "Doorgaan" to carry on - and the login's click timed out on that one
/// instead. So the walls are taken down in rounds: a round presses the
/// first known button of either wall; a round that pressed nothing ends
/// the loop (nothing left standing, or nothing we know how to press).
/// </summary>
internal static class BolConsent
{
    /// <summary>How many walls bol gets to stack before the next step is tried through whatever is left.</summary>
    private const int MaxRounds = 3;

    public static async Task DismissAsync(IJobContext ctx, ILoginPage page, BolOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(options);

        for (var round = 0; round < MaxRounds; round++)
        {
            var pressed = await PressAsync(ctx, page, options.ConsentSelectors, options.ConsentMs, "the cookie wall", ct).ConfigureAwait(false);
            // the language chooser arrives BEHIND the cookie wall; a shorter wait,
            // because most sessions never see it and the budget is per round
            pressed |= await PressAsync(ctx, page, options.ContinueSelectors, options.ContinueMs, "the language chooser", ct).ConfigureAwait(false);
            if (!pressed) return;
        }
    }

    /// <summary>One wall's button: pressed, absent, or stuck - a stuck wall is noted and never a failed login by itself.</summary>
    private static async Task<bool> PressAsync(
        IJobContext ctx, ILoginPage page, IReadOnlyList<string> selectors, int timeoutMs, string wall, CancellationToken ct)
    {
        if (selectors.Count == 0) return false;
        try
        {
            if (!await page.ClickAsync(selectors, timeoutMs, ct).ConfigureAwait(false)) return false;
            ctx.Note($"{BolAdapter.ProviderId}: {wall} was dismissed");
            return true;
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            ctx.Note($"{BolAdapter.ProviderId}: {wall}'s button could not be pressed ({ex.GetType().Name}); carrying on without it");
            return false;
        }
    }
}
