using Connector.Kit.Browsing;

namespace Connector.Kit.Adapters;

/// <summary>
/// What a provider's own pages say about whether this browser is still signed
/// in - asked BEFORE a sign-in is driven, so one that is not needed is not
/// driven at all.
/// </summary>
/// <remarks>
/// THREE ANSWERS, AND THE THIRD IS THE DEFAULT. Two would have done for the
/// callers - only <see cref="SignedIn"/> skips anything - and the third is
/// here because the callers are not the only readers. An adapter that has no
/// way to ask must be able to say so, and it must not be forced to say "signed
/// out" instead: the two have the same effect today and opposite meanings, and
/// a catalogue of providers reporting "signed out" for the ones that were never
/// asked is a catalogue nobody can read.
/// <para>
/// <see cref="CannotTell"/> IS ZERO deliberately. A <c>default</c> of this type
/// - a field nobody set, a record built with the property left off, a mock
/// returning <c>default</c> - is then the answer that changes nothing, and the
/// only way to skip a sign-in is to have said so on purpose.
/// </para>
/// </remarks>
public enum SessionPresence
{
    /// <summary>
    /// Nothing here knows. The ordinary sign-in runs, exactly as it would have
    /// without the question being asked.
    /// </summary>
    CannotTell = 0,

    /// <summary>
    /// The provider says this browser is nobody. The ordinary sign-in runs.
    /// </summary>
    SignedOut,

    /// <summary>
    /// The provider says this browser is already inside. Nothing is typed,
    /// nothing is relayed to a human, and no login attempt is spent.
    /// </summary>
    SignedIn,
}

/// <summary>
/// The one place "is this browser still signed in?" gets asked.
///
/// <para>
/// <b>Why it is worth asking at all.</b> A BYO agent is somebody's own
/// computer. It keeps a browser profile per provider
/// (<c>JobRunner.ResolveProfile</c>), and since the kept-session store it
/// carries the SESSION cookies across the browser closing too - measured
/// against the real DUO, where without it a login and a fetch 29 seconds apart
/// were two signed-out browsers. So on that machine the second connect to a
/// provider usually opens a browser that is already inside, and driving a whole
/// sign-in at it is not merely wasteful: it spends a login attempt the provider
/// counts, relays a QR or a one-time code to a human who did not need to be
/// disturbed, and on DigiD it is an authentication Logius scores.
/// </para>
///
/// <para>
/// <b>And why it is asked HERE rather than in each adapter.</b> Four adapters
/// had grown their own version of this question by the time it was worth
/// writing down - ASN's, DUO's, Amazon's, and bol's cookie-jar watcher - and
/// each had paid separately for the same two lessons. The lessons belong beside
/// the question, not scattered across the adapters that happened to learn them
/// first.
/// </para>
/// </summary>
/// <remarks>
/// <b>LESSON ONE: A URL READ THE INSTANT A NAVIGATION RETURNS IS NOT PROOF.</b>
/// Observed on a live ASN account on 2026-09-19, on a profile created minutes
/// earlier: the bank answered its OVERVIEW address for a signed-out browser,
/// with a visible profile menu on the page, and only bounced to
/// <c>/inloggen/</c> a moment later. DUO's portal does the same - opening it
/// lands on a <c>/particulier/portaal/</c> address and enters the SAML chain
/// afterwards, which reported a finished login 80ms after the live view opened.
/// Taking the first positive sign therefore told a user "nothing was asked of
/// you" about a browser that was signed out, and the fetch that followed drove
/// a form against a sign-in page and reported the provider as changed - which
/// degrades it in the catalogue for everybody.
/// <para>
/// So the page is given a BOUNDED CHANCE TO SAY NO before anything positive is
/// believed. The cost is that a browser which really is signed in pays that
/// window on every check, because the bounce it is waiting for never comes.
/// That is the right way round: the window is seconds, and the answer it buys
/// is the difference between a fetch that works and a provider degraded for
/// everybody.
/// </para>
/// <para>
/// <b>LESSON TWO: THE PROVIDER'S OWN ANSWER BEATS OURS, AND A POSITIVE IS
/// CONFIRMED RATHER THAN ASSUMED.</b> Where a provider will state it - DUO's
/// session endpoint, ASN's user menu - that statement decides, because it is
/// the provider answering about its own session instead of us inferring one
/// from an address. Where it will not, the confirmation is whatever else only a
/// signed-in browser reaches, and NEVER the mere presence of cookies: a
/// signed-out request to any Coolblue page is answered with
/// <c>Set-Cookie: Coolblue-Session=...</c>, so a jar full of a shop's cookies
/// is simply what an anonymous visitor holds. Not saying no is not the same as
/// saying yes.
/// </para>
/// </remarks>
public static class SessionProbe
{
    /// <summary>
    /// Asks the adapter, if there is anything to ask about.
    /// </summary>
    /// <remarks>
    /// The gate is <see cref="IJobContext.KeepsSession"/> and it is checked
    /// FIRST, before the adapter is touched at all. A browser that was handed
    /// nothing from a previous run cannot be signed in already, so asking would
    /// buy a guaranteed "no" at the price of lesson one's whole window - on
    /// every first connect, which is the run a person is sitting and watching.
    /// </remarks>
    public static Task<SessionPresence> AskAsync(
        IProviderAdapter adapter, IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(adapter);

        return AskAsync(ctx, adapter.AlreadySignedInAsync, ct);
    }

    /// <summary>
    /// The same gate, for an adapter asking through its own page seam.
    /// </summary>
    /// <remarks>
    /// Every browser adapter here keeps an <c>internal</c> entry point taking
    /// the page or portal it drives, so the offline suite can run a whole login
    /// without a Chromium or an account. Those entry points must ask the
    /// question through the SAME gate as the public capability, or the gate
    /// would be the one thing the suite could never see.
    /// </remarks>
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

    /// <summary>
    /// Both lessons, for a provider whose whole answer is its address: watch
    /// for the page to say NO for a bounded window, and only a page that never
    /// says it may then be confirmed.
    /// </summary>
    /// <param name="page">The page, already navigated to the protected address.</param>
    /// <param name="saysSignedOut">
    /// A URL only a signed-out browser is sent to - the sign-in host or path.
    /// Arriving there is proof, and it is the only thing either page does that
    /// the other does not.
    /// </param>
    /// <param name="confirms">
    /// What a signed-in browser reaches and a signed-out one cannot. Asked ONLY
    /// after the window has passed without a refusal, so whatever answers it is
    /// a page that has settled.
    /// </param>
    /// <remarks>
    /// The window is COUNTED RATHER THAN CLOCK-BOUNDED, the same way every
    /// watcher in this repo is. A caller holding a frozen
    /// <see cref="TimeProvider"/> - which every test here does - would never
    /// reach a deadline computed from it, and the loop would spin until the
    /// job's own budget ran out.
    /// <para>
    /// A window that passes with no refusal AND no confirmation is
    /// <see cref="SessionPresence.CannotTell"/> rather than
    /// <see cref="SessionPresence.SignedOut"/>. Both drive the ordinary
    /// sign-in, so nothing behaves differently; what differs is what an
    /// operator reading the answer is told, and "the provider never said"
    /// is not "the provider said no".
    /// </para>
    /// </remarks>
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

            // Checked before the first delay as well as after every one, so a
            // browser that was ALREADY sitting on the sign-in page when this
            // was called answers at once and pays no window at all.
            if (saysSignedOut(page.Url ?? string.Empty)) return SessionPresence.SignedOut;

            if (pass + 1 >= passes) break;

            await Task.Delay(interval, time, ct).ConfigureAwait(false);
        }

        return await confirms(ct).ConfigureAwait(false)
            ? SessionPresence.SignedIn
            : SessionPresence.CannotTell;
    }
}
