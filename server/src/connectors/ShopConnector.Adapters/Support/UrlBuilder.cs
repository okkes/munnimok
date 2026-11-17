using System.Text;

namespace ShopConnector.Adapters.Support;

internal static class UrlBuilder
{
    /// hand-rolled: the alternatives live in ASP.NET packages this library must not reference,
    /// and concatenation mis-escapes redirect URIs and scopes
    public static string WithQuery(string baseUrl, IReadOnlyDictionary<string, string> query)
    {
        if (query.Count == 0) return baseUrl;

        var builder = new StringBuilder(baseUrl);
        builder.Append(baseUrl.Contains('?', StringComparison.Ordinal) ? '&' : '?');

        var first = true;
        foreach (var (key, value) in query)
        {
            if (!first) builder.Append('&');
            first = false;

            builder.Append(Uri.EscapeDataString(key)).Append('=').Append(Uri.EscapeDataString(value));
        }

        return builder.ToString();
    }
}
