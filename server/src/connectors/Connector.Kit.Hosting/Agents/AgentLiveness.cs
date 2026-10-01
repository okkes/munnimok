using Connector.Kit.Hosting.Data;

namespace Connector.Kit.Hosting.Agents;

/// <summary>
/// The one definition of an agent being ONLINE.
/// </summary>
/// <remarks>
/// Three missed beats, not one. An agent beats every thirty seconds, and a
/// machine that misses a single one on a busy network has not gone away.
/// <para>
/// ONE DEFINITION, because there used to be three. The agent listing, the
/// fleet's head start in the job queue and the <c>/status</c> pool count each
/// carried their own ninety seconds, and they agreed only because each had
/// been copied from the last. That was tolerable while the rule only ever
/// decided what a page SAID. It stopped being tolerable the moment a login
/// naming an agent was refused by it: a consumer offers the machines this
/// rule calls online, and if the refusal used a window of its own, the
/// picker would offer a machine the login then turned away - or turn away one
/// the picker called live. Every reader takes the rule from here and none
/// restates it, so the two cannot drift.
/// </para>
/// <para>
/// A NUMBER, NOT THREE TIMES THE CONFIGURED INTERVAL, and the reason is on
/// the agent's side. An agent learns its interval from the enrollment
/// response and keeps it across restarts - see <c>AgentHost</c>, which stores
/// <c>HeartbeatSeconds</c> with the enrollment - so a window derived from
/// whatever <c>ConnectorTimeouts.HeartbeatSeconds</c> says TODAY would judge
/// a machine enrolled last month by an interval it was never told about.
/// </para>
/// </remarks>
public static class AgentLiveness
{
    /// <summary>
    /// How long an agent may have been silent and still count as online: three
    /// of the interval the enrollment response hands out, at its default.
    /// </summary>
    /// <remarks>
    /// COUPLED TO <see cref="ConnectorTimeouts.HeartbeatSeconds"/>, and the
    /// coupling is enforced rather than remembered: <c>ConnectorPlatform.Validate</c>
    /// refuses to start, in every mode, when three of the configured interval
    /// outlast this number. A constant here and a knob there is only safe
    /// while the knob stays under a third of it - raise the interval past
    /// thirty seconds and every agent alive falls outside this window for part
    /// of every cycle, which since this became a refusal rather than a label
    /// means logins and fetches turned away at random while the fleet is
    /// healthy. Change one of the two and the start-up check will tell you
    /// about the other.
    /// </remarks>
    public const int OfflineAfterSeconds = 90;

    /// <summary>
    /// The instant a heartbeat has to be LATER than, as of
    /// <paramref name="now"/>, for its agent to be online. Exposed on its own
    /// because the queue applies the rule inside a query the database
    /// evaluates, where a method cannot follow and a constant instant can.
    /// </summary>
    public static DateTimeOffset OnlineSince(DateTimeOffset now) => now.AddSeconds(-OfflineAfterSeconds);

    /// <summary>
    /// Revoked wins over any heartbeat: a revoked agent that is still running
    /// is not a usable one.
    /// </summary>
    public static bool IsOnline(AgentRow agent, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(agent);
        return !agent.Revoked && agent.LastHeartbeatAt > OnlineSince(now);
    }
}
