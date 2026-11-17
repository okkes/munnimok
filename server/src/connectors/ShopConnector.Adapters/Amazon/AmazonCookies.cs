using System.Text.Json;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

/// did the sign-in leave an authenticated session? A page can look finished with nothing signed in; the reference's
/// marker is COOKIES_SET_WHEN_AUTHENTICATED = ["x-main"], and a bundle without it fails on its first scheduled fetch
internal static class AmazonCookies
{
    public static bool HasAny(string? storageState, IReadOnlyList<string> names)
    {
        ArgumentNullException.ThrowIfNull(names);

        if (string.IsNullOrWhiteSpace(storageState) || names.Count == 0) return false;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(storageState);
        }
        catch (JsonException)
        {
            // an unreadable storage state cannot be vouched for: false, never an optimistic true
            return false;
        }

        using (document)
        {
            foreach (var cookie in JsonAccess.Array(document.RootElement, "cookies"))
            {
                var name = JsonAccess.StrOf(cookie, "name");
                if (name is not null && names.Contains(name, StringComparer.OrdinalIgnoreCase)) return true;
            }
        }

        return false;
    }
}
