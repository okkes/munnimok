using Connector.Kit.Browsing;

namespace RegistryConnector.Adapters.Duo;

// signed in = on a DUO portal page, out of the login chain: DigiD hands back via redirect_with_artifact, no token to catch
internal sealed class DuoSignedInWatcher(ILoginPage page, DuoOptions options, TimeProvider time) : IRedirectWaiter
{
    // both exclusions are guards: DUO's SAML entry on mijn.duo.nl carries the dashboard as Target=...:443, and only that :443
    // stops the chain's first url matching; the login.digid.nl one never fires on observed urls, but SAML carries targets
    // pinned by tests that mark observed vs constructed shapes, so neither is removed as dead code
    internal static bool SignedIn(string? url, DuoOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase);
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = time.GetUtcNow() + timeout;

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
