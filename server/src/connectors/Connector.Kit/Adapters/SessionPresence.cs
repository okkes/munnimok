using Connector.Kit.Browsing;

namespace Connector.Kit.Adapters;

// three answers, CannotTell the default: only SignedIn skips anything, and an adapter that cannot ask must not say
// "signed out", which means the opposite. CannotTell is zero so default(...) changes nothing: skipping a sign-in
// takes saying so on purpose
public enum SessionPresence
{
    CannotTell = 0,

    SignedOut,

    SignedIn,
}

// asked before sign-in: a BYO agent's kept profile is often already inside, and a needless sign-in spends a login
// 1: a URL right after navigation proves nothing (ASN, DUO bounce to sign-in later): give the page a window to say no
// 2: the provider's answer wins; confirm by what only signed-in reaches, never cookies (Coolblue sets one anonymously)
public static class SessionProbe
{
    // KeepsSession is checked first, before the adapter: a browser handed nothing from a previous run cannot be signed in, and
    // asking would buy a guaranteed "no" at lesson 1's whole window on every first connect
    public static Task<SessionPresence> AskAsync(
        IProviderAdapter adapter, IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(adapter);

        return AskAsync(ctx, adapter.AlreadySignedInAsync, ct);
    }

    // the same gate for an adapter's internal page-seam entry point, which the offline suite drives: asking any other way
    // would hide the gate from the suite
    public static async Task<SessionPresence> AskAsync(
        IJobContext ctx,
        Func<IJobContext, CancellationToken, Task<SessionPresence>> witness,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(witness);

        if (!ctx.KeepsSession) return SessionPresence.CannotTell;

        return await witness(ctx, ct).ConfigureAwait(false);
    }

    // saysSignedOut: a URL only a signed-out browser is sent to; confirms: asked only after a window with no refusal.
    // the window is counted, not clock-bound: a frozen TimeProvider (every test) would never reach a deadline.
    // no refusal and no confirmation is CannotTell, not SignedOut: "never said" is not "said no"
    public static async Task<SessionPresence> OnPageAsync(
        ILoginPage page,
        Func<string, bool> saysSignedOut,
        Func<CancellationToken, Task<bool>> confirms,
        TimeSpan window,
        TimeSpan poll,
        TimeProvider time,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(saysSignedOut);
        ArgumentNullException.ThrowIfNull(confirms);
        ArgumentNullException.ThrowIfNull(time);

        var interval = poll <= TimeSpan.Zero ? TimeSpan.FromMilliseconds(1) : poll;
        var passes = Math.Max(1, (int)(window.TotalMilliseconds / interval.TotalMilliseconds));

        for (var pass = 0; pass < passes; pass++)
        {
            ct.ThrowIfCancellationRequested();

            // checked before the first delay too: a browser already on the sign-in page answers at once and pays no window
            if (saysSignedOut(page.Url ?? string.Empty)) return SessionPresence.SignedOut;

            if (pass + 1 >= passes) break;

            await Task.Delay(interval, time, ct).ConfigureAwait(false);
        }

        return await confirms(ct).ConfigureAwait(false)
            ? SessionPresence.SignedIn
            : SessionPresence.CannotTell;
    }
}
