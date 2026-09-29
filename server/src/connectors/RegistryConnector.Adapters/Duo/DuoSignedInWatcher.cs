using Connector.Kit.Browsing;

namespace RegistryConnector.Adapters.Duo;

/// <summary>
/// Watches for DigiD handing the browser back to DUO.
///
/// There is no redirect to a custom scheme to catch and no token to read: the
/// SAML round trip ends with <c>login.digid.nl/saml/v4/idp/redirect_with_artifact</c>
/// sending the browser to the portal, which answers with its own cookie. So
/// "signed in" means "the browser is on a DUO portal page and is no longer
/// anywhere in the login chain", and nothing else can stand in for it.
/// </summary>
internal sealed class DuoSignedInWatcher(ILoginPage page, DuoOptions options, TimeProvider time) : IRedirectWaiter
{
    /// <summary>
    /// Whether a URL means the sign-in is over. Static and pure so the
    /// decision is exercised offline rather than only through a live browser.
    /// </summary>
    /// <remarks>
    /// BOTH EXCLUSIONS ARE GUARDS RATHER THAN FIXES, and saying so precisely
    /// matters more here than anywhere else in this adapter, because the thing
    /// that actually saves the observed login is an accident.
    /// <para>
    /// DUO's SAML entry point is on <c>mijn.duo.nl</c> itself and carries the
    /// dashboard's own address inside it:
    /// <code>
    /// mijn.duo.nl/isam/sps/MijnDUO-2-DigiDCC/saml20/logininitial
    ///   ?Target=https://mijn.duo.nl:443/particulier/portaal/dashboard&amp;ForceAuthn=true
    /// </code>
    /// So the very first url of the login chain very nearly contains the
    /// string a check for the portal alone would call success. It escapes by
    /// one detail: DUO writes <c>mijn.duo.nl:443</c>, and the marker has no
    /// port in it. Drop the <c>:443</c> - which is how most SAML deployments
    /// write a default port, and a configuration change away - and a login
    /// would be reported as finished before DigiD had even been reached,
    /// sealing a session that is not one. That failure says "Connected" and
    /// then fails on every fetch; BKR met it from one direction and Coolblue
    /// from another.
    /// </para>
    /// <para>
    /// The <c>login.digid.nl</c> exclusion has less grounding still. Both
    /// captures were searched and not a single DigiD url mentions <c>duo</c>
    /// at all, so on the evidence available it never fires. It is kept because
    /// SAML round trips routinely carry their target along - a
    /// <c>RelayState</c> is exactly that - and the cost is asymmetric: an idle
    /// string comparison against a session that does not exist.
    /// </para>
    /// <para>
    /// Both are pinned by tests that state which shapes are observed and which
    /// are constructed, so neither can be removed as dead code by somebody
    /// reading only the captured urls.
    /// </para>
    /// </remarks>
    internal static bool SignedIn(string? url, DuoOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase);
    }

    public async Task<string?> WaitAsync(TimeSpan patience, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + patience;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var url = page.Url;

            if (SignedIn(url, options)) return url;

            if (time.GetUtcNow() >= deadline) return null;

            await Task.Delay(
                TimeSpan.FromMilliseconds(
                    Math.Min(500, Math.Max(1, (deadline - time.GetUtcNow()).TotalMilliseconds))),
                ct).ConfigureAwait(false);
        }
    }
}
