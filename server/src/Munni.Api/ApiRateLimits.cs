using System.Threading.RateLimiting;

namespace Munni.Api;

/// <summary>The buckets a person gets: the global one, and the streamed login's own.</summary>
public sealed record RateLimitBudgets(int GlobalTokens, int GlobalRefillPer10S, int LiveTokens, int LiveRefillPer10S);

/// <summary>
/// The abuse guard's partitions, per user (per IP before auth).
///
/// The global bucket is sized for the sync engine polling every ten seconds
/// across many spaces. The streamed login is different traffic: one long-poll
/// per frame and a POST per batch of taps — a minute of signing in is more
/// requests than the global bucket allows a person, and a 429 there drops
/// keystrokes on the floor (the Amazon puzzle and the DUO page "froze", user
/// ss 2026-10-01). So the live routes ride their own bucket, sized for the
/// agent's shutter (12.5 frames/s in a burst) plus the input batches, and
/// still bounded.
/// </summary>
public static class ApiRateLimits
{
    public static string KeyFor(HttpContext http) =>
        http.User.FindFirst("sub")?.Value ?? http.Connection.RemoteIpAddress?.ToString() ?? "anon";

    public static bool IsLiveViewRoute(PathString path) =>
        path.StartsWithSegments("/connectors") && (path.Value ?? string.Empty).Contains("/live/", StringComparison.Ordinal);

    public static RateLimitPartition<string> PartitionFor(HttpContext http, RateLimitBudgets budgets)
    {
        ArgumentNullException.ThrowIfNull(budgets);
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
