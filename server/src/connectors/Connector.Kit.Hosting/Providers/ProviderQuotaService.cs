using System.Collections.Concurrent;
using Connector.Kit.Adapters;

namespace Connector.Kit.Hosting.Providers;

/// a party's last reported budget (an aggregator's per-account daily allowance)
/// in memory: gone with the process, back with the next fetch
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
