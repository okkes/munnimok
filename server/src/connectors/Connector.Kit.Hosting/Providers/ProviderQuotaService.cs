using System.Collections.Concurrent;
using Connector.Kit.Adapters;

namespace Connector.Kit.Hosting.Providers;

/// <summary>
/// What each party last said about its budget — an aggregator's per-account
/// daily allowance, read from its response headers by the adapter and
/// reported through <see cref="IJobContext.ReportQuota"/>. A fact about the
/// provider as of its last answer: kept in memory, shown to the operator on
/// the status document, gone with the process and back with the next fetch.
/// </summary>
public sealed class ProviderQuotaService
{
    private readonly ConcurrentDictionary<string, ProviderQuota> _last = new(StringComparer.Ordinal);

    public void Report(string providerId, ProviderQuota quota)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);
        ArgumentNullException.ThrowIfNull(quota);
        _last[providerId] = quota;
    }

    public ProviderQuota? Get(string providerId) =>
        _last.TryGetValue(providerId, out var quota) ? quota : null;
}
