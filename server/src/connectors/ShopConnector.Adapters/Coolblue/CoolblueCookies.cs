using System.Text.Json;
using Connector.Kit.Errors;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Coolblue;

/// Sent through the job's own politeness-limited client, not the browser's request context: that bypasses the rate limiter.
internal static class CoolblueCookies
{
    public static string? Header(string? storageState, string domainSuffix)
    {
        var pairs = Extract(storageState, domainSuffix);
        return pairs.Count == 0 ? null : string.Join("; ", pairs.Select(p => $"{p.Key}={p.Value}"));
    }

    public static IReadOnlyList<KeyValuePair<string, string>> Extract(string? storageState, string domainSuffix)
    {
        if (string.IsNullOrWhiteSpace(storageState)) return [];

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(storageState);
        }
        catch (JsonException ex)
        {
            throw new ConnectorException(
                ErrorCode.SessionExpired, $"{CoolblueAdapter.ProviderId}: stored browser session is unreadable", ex);
        }

        using (document)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var cookies = new List<KeyValuePair<string, string>>();

            foreach (var cookie in JsonAccess.Array(document.RootElement, "cookies"))
            {
                var name = JsonAccess.StrOf(cookie, "name");
                var value = JsonAccess.StrOf(cookie, "value");
                var domain = JsonAccess.StrOf(cookie, "domain");
                if (name is null || value is null || domain is null) continue;

                if (!domain.TrimStart('.').EndsWith(domainSuffix, StringComparison.OrdinalIgnoreCase)) continue;

                // a negative expiry marks a session cookie, which is what a login issues: not "already expired"
                var expires = JsonAccess.Quantity(cookie, "expires");
                if (expires is > 0 && expires < now) continue;

                cookies.Add(new KeyValuePair<string, string>(name, value));
            }

            return cookies;
        }
    }
}
