using System.Text.Json;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

// host match is deliberate, not a suffix test: JSESSIONID is set on login.bol.com, the orders page is on www.bol.com.
// a fetch that only works when we over-send lies about which cookie authenticates it
internal static class BolCookies
{
    public static string? Header(string? storageState, string host)
    {
        var pairs = For(storageState, host);
        return pairs.Count == 0 ? null : string.Join("; ", pairs.Select(p => $"{p.Key}={p.Value}"));
    }

    /// <summary>bol double-submits its CSRF token: the value sits in a cookie and is echoed in a header.</summary>
    public static string? Value(string? storageState, string host, string name) =>
        For(storageState, host)
            .Where(pair => string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase))
            .Select(pair => pair.Value)
            .FirstOrDefault();

    public static IReadOnlyList<KeyValuePair<string, string>> For(string? storageState, string host)
    {
        var cookies = new List<KeyValuePair<string, string>>();

        foreach (var (name, value, domain) in Read(storageState))
        {
            if (!DomainMatches(host, domain)) continue;
            cookies.Add(new KeyValuePair<string, string>(name, value));
        }

        return cookies;
    }

    /// <summary>Any session-looking cookie under bol.com: decides that a login landed, before host scoping matters.</summary>
    public static bool HasSession(string? storageState, BolOptions options)
    {
        var suffix = options.CookieDomainSuffix;

        foreach (var (name, _, domain) in Read(storageState))
        {
            var bare = domain.TrimStart('.');
            if (!string.Equals(bare, suffix, StringComparison.OrdinalIgnoreCase) &&
                !bare.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (options.SessionCookieNames.Contains(name, StringComparer.OrdinalIgnoreCase)) return true;
        }

        return false;
    }

    private static bool DomainMatches(string host, string domain)
    {
        var bare = domain.TrimStart('.');

        if (string.Equals(host, bare, StringComparison.OrdinalIgnoreCase)) return true;

        // A leading dot is the cookie asking to be sent to subdomains too.
        return domain.StartsWith('.') && host.EndsWith("." + bare, StringComparison.OrdinalIgnoreCase);
    }

    private static List<(string Name, string Value, string Domain)> Read(string? storageState)
    {
        if (string.IsNullOrWhiteSpace(storageState)) return [];

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(storageState);
        }
        catch (JsonException ex)
        {
            throw new ConnectorException(ErrorCode.SessionExpired, "bol: stored browser session is unreadable", ex);
        }

        using (document)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var cookies = new List<(string, string, string)>();

            foreach (var cookie in JsonAccess.Array(document.RootElement, "cookies"))
            {
                var name = JsonAccess.StrOf(cookie, "name");
                var value = JsonAccess.StrOf(cookie, "value");
                var domain = JsonAccess.StrOf(cookie, "domain");
                if (name is null || value is null || domain is null) continue;

                // a negative expiry marks a session cookie (what a Spring form login issues): not "already expired"
                var expires = JsonAccess.Quantity(cookie, "expires");
                if (expires is > 0 && expires < now) continue;

                cookies.Add((name, value, domain));
            }

            return cookies;
        }
    }
}
