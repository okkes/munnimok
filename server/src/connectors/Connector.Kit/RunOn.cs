namespace Connector.Kit;

/// <summary>
/// The one value of a login's <c>prefer_agent</c> that is not an agent id:
/// the operator's fleet, asked for by name.
/// </summary>
/// <remarks>
/// SAYING NOTHING IS NOT THE SAME AS SAYING "THE FLEET", and until this
/// existed the platform had no way to tell the two apart. On 2026-09-21 the
/// account holder connected DUO twice. The first time they picked their own
/// machine and it ran there. The second time they picked "the operator's
/// fleet" from the same dropdown and it ran on their own machine again -
/// session <c>ses_a8dc2d7b4a14782f3050773c610e0f53</c>, whose row carries no
/// pin at all, while <c>connector-byo-registry-1</c> logged
/// <c>job_98ef049e691d586ed949be7f819500ad (Login/duo) succeeded</c> and the
/// fleet agent, online throughout, logged nothing. The dropdown sent no
/// <c>prefer_agent</c> for the fleet, the queue read that as "no preference",
/// and its head start then gives the caller's own live machine first refusal -
/// so for any provider their own machine can serve, the fleet could never win
/// inside that window and the two options were not two options.
/// <para>
/// A RESERVED VALUE RATHER THAN A SECOND FIELD, which is the part worth
/// arguing. A sibling <c>prefer_fleet</c> would be honest about its own type
/// and would create a state the platform has no answer for - a body naming a
/// machine AND asking for the fleet - which somebody then has to resolve, test
/// and remember. One field means one answer: whatever is in <c>prefer_agent</c>
/// is where the run goes, absent means what it has always meant, and the demo
/// client's one dropdown maps to it without the relay learning a new field.
/// </para>
/// <para>
/// IT CANNOT COLLIDE WITH AN AGENT ID, and that is a property of the id
/// scheme rather than of this word being unlikely. Every agent id is minted
/// by <see cref="Ids.New"/> as <c>agt_</c> and 128 bits of hex - an agent
/// never names itself, the enrollment endpoint mints the id from the one-time
/// code - so a value carrying no prefix is provably not one of them:
/// <c>Ids.Is(RunOn.Fleet, Ids.Agent)</c> is false, and a test pins it there
/// rather than here.
/// </para>
/// </remarks>
public static class RunOn
{
    /// <summary>
    /// What a caller sends as <c>prefer_agent</c> to mean "the operator's
    /// fleet, not a machine of mine".
    /// </summary>
    public const string Fleet = "fleet";

    /// <summary>Whether this <c>prefer_agent</c> asks for the operator's fleet by name.</summary>
    public static bool IsFleet(string? preferAgent) =>
        string.Equals(preferAgent, Fleet, StringComparison.Ordinal);

    /// <summary>
    /// Whether this <c>prefer_agent</c> names a machine at all - which is
    /// every value but the reserved one and nothing.
    /// </summary>
    /// <remarks>
    /// An unknown id is still an id as far as this is concerned: whether a
    /// given agent exists, and whether it belongs to the caller, are the login's
    /// questions and it answers them by looking. This one is only ever about
    /// which KIND of answer arrived.
    /// </remarks>
    public static bool IsAgentId(string? preferAgent) =>
        !string.IsNullOrWhiteSpace(preferAgent) && !IsFleet(preferAgent);
}
