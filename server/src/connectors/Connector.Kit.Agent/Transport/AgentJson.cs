using System.Text.Json;

namespace Connector.Kit.Agent.Transport;

/// delegates to ConnectorWireJson: a hand-copied options set once diverged and broke every agent-served fetch, not logins
internal static class AgentJson
{
    public static JsonSerializerOptions Options => ConnectorWireJson.Options;
}
