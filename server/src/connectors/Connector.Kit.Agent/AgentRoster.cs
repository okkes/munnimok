using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent;

// a connector that cannot enroll or is revoked retires alone: stopping the application was right for one connector, but with
// several a 401 from a restored-from-backup bank connector would take DUO (no pooled fleet to fall back to) off the air.
// The last one retiring stops the process: a container healthy but serving nobody is the failure avoided
public sealed class AgentRoster
{
    private readonly int _total;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly ILogger<AgentRoster> _logger;
    private readonly Lock _gate = new();
    private readonly HashSet<string> _retired = new(StringComparer.Ordinal);

    public AgentRoster(int connections, IHostApplicationLifetime lifetime, ILogger<AgentRoster> logger)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(connections, 1);
        ArgumentNullException.ThrowIfNull(lifetime);
        ArgumentNullException.ThrowIfNull(logger);

        _total = connections;
        _lifetime = lifetime;
        _logger = logger;
    }

    public IReadOnlyCollection<string> Retired
    {
        get { lock (_gate) return [.. _retired]; }
    }

    public bool AnyServed
    {
        get { lock (_gate) return _retired.Count < _total; }
    }

    // idempotent per connection is load-bearing: the lease and heartbeat loops meet the same 401 and both revoke,
    // and a counter would tick twice and stop a process still serving other connectors
    public void Retire(string connection, string why)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connection);

        bool last;
        lock (_gate)
        {
            if (!_retired.Add(connection)) return;
            last = _retired.Count >= _total;
        }

        if (!last)
        {
            _logger.LogWarning("{Connection}: no longer served: {Why}", connection, why);
            return;
        }

        _logger.LogWarning("{Connection}: no longer served: {Why}; no connector is left to serve, stopping", connection, why);
        _lifetime.StopApplication();
    }
}
