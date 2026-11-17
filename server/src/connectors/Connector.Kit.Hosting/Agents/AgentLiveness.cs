using Connector.Kit.Hosting.Data;

namespace Connector.Kit.Hosting.Agents;

/// the one definition of online: three missed beats; every reader (listing, queue, /status, login refusal) uses it
/// a fixed number, not 3x the configured interval: agents keep the interval from their enrollment across restarts
public static class AgentLiveness
{
    /// coupled to ConnectorTimeouts.HeartbeatSeconds: ConnectorPlatform.Validate refuses to start when three beats
    /// outlast this, or healthy agents would be refused logins and fetches at random
    public const int OfflineAfterSeconds = 90;

    /// an instant, because the queue applies the rule inside a database query where a method cannot follow
    public static DateTimeOffset OnlineSince(DateTimeOffset now) => now.AddSeconds(-OfflineAfterSeconds);

    /// revoked wins over any heartbeat
    public static bool IsOnline(AgentRow agent, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(agent);
        return !agent.Revoked && agent.LastHeartbeatAt > OnlineSince(now);
    }
}
