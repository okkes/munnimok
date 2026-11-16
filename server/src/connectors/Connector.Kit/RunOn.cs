namespace Connector.Kit;

// the one prefer_agent value that is not an agent id: the operator's fleet by name. Absent means "no preference", which
// gives the caller's own live machine first refusal, so the fleet could not be chosen. A reserved value, not a second
// prefer_fleet field (that allows a contradictory body). It cannot collide: agent ids are always agt_ + hex (Ids.New)
public static class RunOn
{
    public const string Fleet = "fleet";

    public static bool IsFleet(string? preferAgent) =>
        string.Equals(preferAgent, Fleet, StringComparison.Ordinal);

    // every value but the reserved one and nothing; whether the agent exists and is the caller's is the login's question
    public static bool IsAgentId(string? preferAgent) =>
        !string.IsNullOrWhiteSpace(preferAgent) && !IsFleet(preferAgent);
}
