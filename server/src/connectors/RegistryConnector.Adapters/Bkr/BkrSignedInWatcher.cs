using Connector.Kit.Browsing;

namespace RegistryConnector.Adapters.Bkr;

/// <summary>
/// Watches for the sign-in landing back on the portal.
///
/// BKR has no redirect to a custom scheme and no token to catch - a completed
/// B2C sign-in POSTs an id_token to /signin-oidc and the portal answers with a
/// cookie and its own page. So "signed in" means "the browser is on the portal
/// and no longer on the login host", and nothing else can stand in for it.
///
/// Both halves are required. The portal's own address appears on the login
/// host too - B2C's page embeds it as a redirect_uri parameter and pulls a
/// template from /login-template - so a check for the portal's name alone
/// would report success while the password box was still on screen.
/// </summary>
internal sealed class BkrSignedInWatcher(ILoginPage page, BkrOptions options, TimeProvider time) : IRedirectWaiter
{
    /// <summary>
    /// Whether a URL is a signed-in one. Static and pure so the decision is
    /// exercised offline rather than only through a live browser, and so the
    /// same rule serves the settle loop below and the already-signed-in check
    /// in <see cref="BkrAdapter"/> - two places that must never disagree about
    /// what "in" means.
    /// </summary>
    internal static bool SignedIn(string? url, BkrOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHost, StringComparison.OrdinalIgnoreCase);
    }

    public async Task<string?> WaitAsync(TimeSpan patience, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + patience;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var url = page.Url ?? string.Empty;

            if (SignedIn(url, options))
            {
                return url;
            }

            if (time.GetUtcNow() >= deadline) return null;

            await Task.Delay(
                TimeSpan.FromMilliseconds(Math.Min(500, Math.Max(1, (deadline - time.GetUtcNow()).TotalMilliseconds))),
                ct).ConfigureAwait(false);
        }
    }
}
