using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace BankConnector.Adapters;

/// <summary>Inclusive at both ends, exactly like the query parameters.</summary>
public readonly record struct FetchWindow(DateOnly From, DateOnly To)
{
    public bool Contains(DateOnly day) => day >= From && day <= To;
}

// the window asked of the bank is wider than since/until: a booked row can settle late and appear dated before the
// cursor, so fetching strictly since the last sync loses it for good; widen by the settlement lag, hashes absorb the overlap
public static class BankWindow
{
    /// when since is not named: short enough for a first connect, long enough for a monthly credit-card statement
    public const int DefaultSinceDays = 90;

    public static FetchWindow Resolve(
        ResourceRequest request,
        ProviderManifest manifest,
        DateOnly today)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(manifest);

        var maxHistoryDays = manifest.Resource(request.ResourceId)?.MaxHistoryDays
                             ?? manifest.Limits.MaxHistoryDays;

        var to = request.Until ?? today;
        var from = (request.Since ?? today.AddDays(-DefaultSinceDays))
            .AddDays(-manifest.Limits.SettlementLagDays);

        var floor = today.AddDays(-maxHistoryDays);
        if (from < floor) from = floor;

        // widening only moves `from` earlier, so an inverted window is the caller's own doing
        if (to < from)
        {
            throw ConnectorException.InvalidRequest(
                $"until '{to:yyyy-MM-dd}' precedes since '{request.Since:yyyy-MM-dd}' after the provider's history limit was applied");
        }

        return new FetchWindow(from, to);
    }
}
