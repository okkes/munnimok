using System.Globalization;
using Sentry;

namespace Connector.Api;

/// <summary>
/// Which of the control plane's requests become performance transactions
/// (docs/observability.md). A trace the api continued keeps its decision.
/// </summary>
public static class ConnectorTracing
{
    /// <summary>a number in 0..1, else the platform default of a fifth</summary>
    public static double SampleRate(string? configured) =>
        double.TryParse(configured, NumberStyles.Float, CultureInfo.InvariantCulture, out var rate) && rate is >= 0 and <= 1 ? rate : 0.2;

    public static double Sample(ITransactionContext context, double rate)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (rate <= 0 || IsNeverTraced(context.Name)) return 0;
        if (context.IsParentSampled is { } parentSampled) return parentSampled ? 1 : 0;
        return rate;
    }

    // probes, heartbeats, and the long polls and streams that wait by design (#429, #554) —
    // as transactions they would read as the slowest routes
    public static bool IsNeverTraced(string name) =>
        name.Contains("/health", StringComparison.OrdinalIgnoreCase)
        || name.Contains("/heartbeat", StringComparison.OrdinalIgnoreCase)
        || name.Contains("/live/stream", StringComparison.OrdinalIgnoreCase)
        || name.Contains("/jobs/lease", StringComparison.OrdinalIgnoreCase)
        || name.EndsWith("/events", StringComparison.OrdinalIgnoreCase);
}
