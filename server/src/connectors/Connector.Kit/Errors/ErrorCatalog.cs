namespace Connector.Kit.Errors;

// retry policy lives here so an adapter cannot override it: a failed login is never retried automatically
// (three retries lock a real bank account, a support incident nothing else makes up for)
public static class ErrorCatalog
{
    private static readonly Dictionary<ErrorCode, ErrorBehaviour> Behaviours = new()
    {
        [ErrorCode.InvalidCredentials] = new(401, Retriable: false, UserAction.Reauth),
        [ErrorCode.SessionExpired] = new(401, Retriable: false, UserAction.Reauth),
        [ErrorCode.MfaFailed] = new(401, Retriable: false, UserAction.Reauth),
        [ErrorCode.MfaTimeout] = new(408, Retriable: true, UserAction.Retry),
        [ErrorCode.ChallengeExpired] = new(410, Retriable: true, UserAction.Retry),
        [ErrorCode.BlockedByProvider] = new(403, Retriable: false, UserAction.Wait),
        [ErrorCode.ProviderChanged] = new(502, Retriable: false, UserAction.Wait),
        [ErrorCode.ProviderUnavailable] = new(503, Retriable: true, UserAction.Retry),
        [ErrorCode.RateLimited] = new(429, Retriable: true, UserAction.Wait),
        [ErrorCode.AgentUnavailable] = new(503, Retriable: true, UserAction.StartYourAgent),
        // 403 and never retried, unlike an unavailable agent (503): the machine was de-authorised, not switched off;
        // Reconnect is the only exit
        [ErrorCode.AgentRevoked] = new(403, Retriable: false, UserAction.Reconnect),
        [ErrorCode.UnsupportedResource] = new(400, Retriable: false, UserAction.None),
        [ErrorCode.InvalidRequest] = new(400, Retriable: false, UserAction.None),
        [ErrorCode.ConsentExpired] = new(403, Retriable: false, UserAction.Reconnect),
        [ErrorCode.ReconciliationFailed] = new(502, Retriable: false, UserAction.Wait),
        [ErrorCode.Internal] = new(500, Retriable: true, UserAction.Retry),
    };

    // never retried by any mechanism (job queue, agent, scheduler, lease expiry, deploy); tests assert the list cannot shrink
    public static readonly IReadOnlySet<ErrorCode> NeverRetry = new HashSet<ErrorCode>
    {
        ErrorCode.InvalidCredentials,
        ErrorCode.SessionExpired,
        ErrorCode.MfaFailed,
        ErrorCode.BlockedByProvider,
        ErrorCode.ProviderChanged,
        ErrorCode.AgentRevoked,
        ErrorCode.UnsupportedResource,
        ErrorCode.InvalidRequest,
        ErrorCode.ConsentExpired,
        ErrorCode.ReconciliationFailed,
    };

    public static ErrorBehaviour Behaviour(ErrorCode code) =>
        Behaviours.TryGetValue(code, out var b)
            ? b
            : throw new ArgumentOutOfRangeException(nameof(code), code, "no behaviour registered");

    public static bool IsRetriable(ErrorCode code) => Behaviour(code).Retriable;

    public static int HttpStatus(ErrorCode code) => Behaviour(code).HttpStatus;

    public static UserAction ActionFor(ErrorCode code) => Behaviour(code).UserAction;

    // a connector never emits user-facing prose; it names a key and the consuming app translates it
    public static string MessageKey(ErrorCode code) => $"connect.error.{SnakeCase(code)}";

    public static string Wire(ErrorCode code) => SnakeCase(code);

    private static string SnakeCase(ErrorCode code)
    {
        var name = code.ToString();
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]) && i > 0) sb.Append('_');
            sb.Append(char.ToLowerInvariant(name[i]));
        }
        return sb.ToString();
    }
}

public readonly record struct ErrorBehaviour(int HttpStatus, bool Retriable, UserAction UserAction);
