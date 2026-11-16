using System.Threading.RateLimiting;

namespace Munni.Api;

public sealed record RateLimitBudgets(
    int GlobalTokens, int GlobalRefillPer10S, int LiveTokens, int LiveRefillPer10S, int LiveStreamOpens, int LiveStreamOpensPer10S);

// the streamed login is a long-poll per frame plus a POST per batch of taps: the global bucket would 429 it and
// drop keystrokes, so live routes get their own bucket, sized for the agent's shutter (12.5 frames/s burst) plus input
public static class ApiRateLimits
{
    public static string KeyFor(HttpContext http) =>
        http.User.FindFirst("sub")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "anon";

    public static bool IsLiveViewRoute(PathString path) =>
        (path.StartsWithSegments("/connectors") || path.StartsWithSegments("/lab/bench"))
        && (path.Value ?? string.Empty).Contains("/live/", StringComparison.Ordinal);

    // #429: the pushed live view is one request per login, so a per-frame bucket means nothing.
    // what is bounded is how often one opens, as each holds a stream to the control plane
    public static bool IsLiveStreamRoute(PathString path) =>
        IsLiveViewRoute(path) && (path.Value ?? string.Empty).EndsWith("/live/stream", StringComparison.Ordinal);

    public static RateLimitPartition<string> PartitionFor(HttpContext http, RateLimitBudgets budgets)
    {
        ArgumentNullException.ThrowIfNull(budgets);
        if (IsLiveStreamRoute(http.Request.Path))
        {
            return RateLimitPartition.GetTokenBucketLimiter("livestream:" + KeyFor(http), _ => Bucket(budgets.LiveStreamOpens, budgets.LiveStreamOpensPer10S));
        }

        if (IsLiveViewRoute(http.Request.Path))
        {
            return RateLimitPartition.GetTokenBucketLimiter("live:" + KeyFor(http), _ => Bucket(budgets.LiveTokens, budgets.LiveRefillPer10S));
        }

        return RateLimitPartition.GetTokenBucketLimiter(KeyFor(http), _ => Bucket(budgets.GlobalTokens, budgets.GlobalRefillPer10S));
    }

    /// <summary>Burst headroom (bootstrap pulls, imports) with a steady refill: 60/10s is 360 requests a minute sustained.</summary>
    private static TokenBucketRateLimiterOptions Bucket(int tokens, int refillPer10S) => new()
    {
        TokenLimit = tokens,
        TokensPerPeriod = refillPer10S,
        ReplenishmentPeriod = TimeSpan.FromSeconds(10),
        QueueLimit = 0,
        AutoReplenishment = true,
    };
}
