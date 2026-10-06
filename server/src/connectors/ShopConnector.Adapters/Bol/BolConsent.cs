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
/// </summary>
internal static class BolConsent
{
    public static async Task DismissAsync(IJobContext ctx, ILoginPage page, BolOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(options);

        try
        {
            if (await page.ClickAsync(options.ConsentSelectors, options.ConsentMs, ct).ConfigureAwait(false))
            {
                ctx.Note($"{BolAdapter.ProviderId}: the cookie wall was dismissed");
            }
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            ctx.Note($"{BolAdapter.ProviderId}: the cookie wall's button could not be pressed ({ex.GetType().Name}); carrying on without it");
        }
    }
}
