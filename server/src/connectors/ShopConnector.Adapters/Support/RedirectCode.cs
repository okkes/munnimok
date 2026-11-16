using System.Text.RegularExpressions;

namespace ShopConnector.Adapters.Support;

/// OAuth ends in a scheme the browser cannot open (appie://login-exit); what reaches us is a full URL,
/// a pasted address with a stray space or newline, or the bare code - all accepted,
/// so a successful sign-in never fails on the shape of a paste
internal static partial class RedirectCode
{
    [GeneratedRegex(@"[?&]code=([^&\s]+)")]
    private static partial Regex InUrl { get; }

    /// RFC 3986 unreserved set; 8+ characters is below any real code and above accidental typing
    [GeneratedRegex(@"^[A-Za-z0-9._~-]{8,}$")]
    private static partial Regex Bare { get; }

    public static string? Extract(string? candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate)) return null;

        var trimmed = candidate.Trim();

        var match = InUrl.Match(trimmed);
        if (match.Success) return Uri.UnescapeDataString(match.Groups[1].Value);

        return Bare.IsMatch(trimmed) ? trimmed : null;
    }
}
