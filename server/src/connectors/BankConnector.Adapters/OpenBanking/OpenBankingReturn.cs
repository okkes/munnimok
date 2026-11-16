using System.Web;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;

namespace BankConnector.Adapters.OpenBanking;

// the consent redirect as a challenge; its answer is the landing URL, whose query names the consent (ref or state)
// and, for Enable Banking, carries the single-use code
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
