using Connector.Kit.Adapters;
using Connector.Kit.Browsing;

namespace ShopConnector.Adapters.Bol;

// the cookie wall (Radix dialog) goes first: a click under it timed out and failed the login as internal (2026-10-06 prod)
// the language chooser is a second dialog behind it (2026-10-07), so walls come down in rounds; a stuck wall is only noted
internal static class BolConsent
{
    private const int MaxRounds = 3;

    public static async Task DismissAsync(IJobContext ctx, ILoginPage page, BolOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(options);

        for (var round = 0; round < MaxRounds; round++)
        {
            var pressed = await PressAsync(ctx, page, options.ConsentSelectors, options.ConsentMs, "the cookie wall", ct).ConfigureAwait(false);
            // the language chooser arrives BEHIND the cookie wall; a shorter wait because most sessions never see it
            pressed |= await PressAsync(ctx, page, options.ContinueSelectors, options.ContinueMs, "the language chooser", ct).ConfigureAwait(false);
            if (!pressed) return;
        }
    }

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
