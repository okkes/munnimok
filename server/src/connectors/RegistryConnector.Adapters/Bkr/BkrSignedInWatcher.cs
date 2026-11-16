using Connector.Kit.Browsing;

namespace RegistryConnector.Adapters.Bkr;

/// signed in = on the portal and off the login host: a B2C sign-in leaves only a cookie, no token or custom-scheme redirect
/// both halves are needed: the portal's address also appears on the login host (redirect_uri, /login-template)
internal sealed class BkrSignedInWatcher(ILoginPage page, BkrOptions options, TimeProvider time) : IRedirectWaiter
{
    /// static and pure so one rule serves the settle loop and BkrAdapter's already-signed-in check, which must never disagree
    internal static bool SignedIn(string? url, BkrOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHost, StringComparison.OrdinalIgnoreCase);
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + timeout;

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
