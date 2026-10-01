using System.Web;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;

namespace BankConnector.Adapters.OpenBanking;

/// <summary>
/// The consent redirect as a challenge, and the bank's return as its answer.
/// The consumer sends where the bank should come back (<c>config.return_url</c>,
/// its own page), the adapter tells the aggregator, the person consents at
/// the bank, the bank lands on that page, and the page hands the landing URL
/// back as the answer; its query says which consent (<c>ref</c> or
/// <c>state</c>) and, for Enable Banking, carries the single-use code.
/// </summary>
internal static class OpenBankingReturn
{
    public const string PromptKey = "connect.open_banking.prompt.consent";

    public static string RequireReturnUrl(IJobContext ctx, string providerId)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        if (!ctx.Config.TryGetValue(OpenBankingManifests.ReturnUrlConfig, out var url) || string.IsNullOrWhiteSpace(url))
        {
            throw ConnectorException.InvalidRequest($"{providerId}: config '{OpenBankingManifests.ReturnUrlConfig}' is required - the bank has to be told where to return");
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp))
        {
            throw ConnectorException.InvalidRequest($"{providerId}: config '{OpenBankingManifests.ReturnUrlConfig}' must be an absolute http(s) url");
        }
        return url;
    }

    public static Challenge Redirect(string url, string returnUrl, string reference, DateTimeOffset expiresAt) => new()
    {
        Type = ChallengeType.Redirect,
        PromptKey = PromptKey,
        Url = url,
        ReturnPattern = returnUrl + "*",
        Code = reference,
        ExpiresAt = expiresAt,
    };

    /// <summary>The landing URL's query (and fragment) as a map; anything that is not a URL reads as empty.</summary>
    public static IReadOnlyDictionary<string, string> Landing(string answer)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(answer) || !Uri.TryCreate(answer.Trim(), UriKind.Absolute, out var uri)) return result;
        foreach (var part in new[] { uri.Query, uri.Fragment })
        {
            if (part.Length < 2) continue;
            var parsed = HttpUtility.ParseQueryString(part[1..]);
            foreach (var key in parsed.AllKeys)
            {
                if (key is null) continue;
                var value = parsed[key];
                if (!string.IsNullOrEmpty(value)) result[key] = value;
            }
        }
        return result;
    }

    /// <summary>The answer must be the return for THIS consent, and a bank that refused says so in the query.</summary>
    public static IReadOnlyDictionary<string, string> RequireReturn(
        string providerId, ChallengeAnswer answer, string reference, string referenceKey)
    {
        ArgumentNullException.ThrowIfNull(answer);
        var landing = Landing(answer.Value);
        if (landing.Count == 0)
        {
            throw ConnectorException.InvalidRequest($"{providerId}: the answer to the consent redirect must be the url the bank returned to");
        }
        if (landing.TryGetValue("error", out var error))
        {
            throw new ConnectorException(ErrorCode.ChallengeExpired, $"{providerId}: the bank returned an error instead of a consent ({error})");
        }
        if (landing.TryGetValue(referenceKey, out var got) && !string.Equals(got, reference, StringComparison.Ordinal))
        {
            throw ConnectorException.InvalidRequest($"{providerId}: the return belongs to another consent");
        }
        return landing;
    }
}
