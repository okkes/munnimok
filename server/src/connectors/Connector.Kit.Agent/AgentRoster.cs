using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Agent;

/// <summary>
/// Which connectors this process is still serving, and the one decision that
/// depends on knowing: when there is nothing left to serve, stop.
/// </summary>
/// <remarks>
/// <b>An agent that could not enroll, or that was revoked, used to stop the
/// application - and that was right when the process served one connector.</b>
/// It is wrong the moment it serves several: a bank connector that has been
/// restored from a backup taken before this agent enrolled answers 401, and the
/// agent would have torn down the registry lease loop beside it, taking DUO -
/// which has no pooled fleet to fall back to - off the air over somebody else's
/// database restore.
/// <para>
/// So a connection retires on its own, and the process goes on. When the last
/// one retires there is genuinely nothing left to do, and stopping is still an
/// honest exit code for an operator or a container runtime - a container that
/// sits up healthy and serves nobody is the failure this whole file exists to
/// avoid.
/// </para>
/// </remarks>
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

    /// <summary>Connectors this process has given up on, by name.</summary>
    public IReadOnlyCollection<string> Retired
    {
        get { lock (_gate) return [.. _retired]; }
    }

    /// <summary>Whether any connector is still being served.</summary>
    public bool AnyServed
    {
        get { lock (_gate) return _retired.Count < _total; }
    }

    /// <summary>
    /// This connector is no longer served, for the reason given.
    /// </summary>
    /// <remarks>
    /// Idempotent per connection, and that is load-bearing rather than
    /// defensive: the lease loop and the heartbeat loop both meet the same 401
    /// and both revoke, so a counter would tick twice for one connector and
    /// stop a process that is still serving two others perfectly well.
    /// </remarks>
    public void Retire(string connection, string why)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(connection);

        bool last;
        lock (_gate)
        {
            if (!_retired.Add(connection)) return;
            last = _retired.Count >= _total;
        }

        _logger.LogWarning("{Connection}: no longer served: {Why}", connection, why);

        if (!last) return;

        _logger.LogWarning("no connector is left to serve; stopping");
        _lifetime.StopApplication();
    }
}
