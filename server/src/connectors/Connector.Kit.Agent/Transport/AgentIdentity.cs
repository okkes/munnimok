using System.Text.Json.Serialization;

namespace Connector.Kit.Agent.Transport;

public sealed class AgentIdentity
{
    private AgentEnrollment? _current;

    public AgentEnrollment? Current => Volatile.Read(ref _current);

    public bool IsEnrolled => Current is not null;

    public string AgentId =>
        Current?.AgentId ?? throw new InvalidOperationException("the agent has not enrolled yet");

    public void Set(AgentEnrollment enrollment)
    {
        ArgumentNullException.ThrowIfNull(enrollment);
        Volatile.Write(ref _current, enrollment);
    }

    public void Clear() => Volatile.Write(ref _current, null);
}

/// the token is the only secret held at rest; scoped to /agent/v1/* and revocable on its own
public sealed record AgentEnrollment
{
    [JsonPropertyName("agent_id")]
    public required string AgentId { get; init; }

    public required string Token { get; init; }

    /// a different control plane forces a fresh enrollment: one service's token is never sent to another
    [JsonPropertyName("control_plane")]
    public required string ControlPlane { get; init; }

    [JsonPropertyName("enrolled_at")]
    public required DateTimeOffset EnrolledAt { get; init; }

    [JsonPropertyName("heartbeat_seconds")]
    public int HeartbeatSeconds { get; init; } = 30;
}
