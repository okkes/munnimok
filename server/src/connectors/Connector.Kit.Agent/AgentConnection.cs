using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Transport;

namespace Connector.Kit.Agent;

/// <summary>
/// Everything this process holds for ONE connector: who it is over there, how
/// it calls, where that connector's browsers live, and what runs its jobs.
/// </summary>
/// <remarks>
/// It exists to make the split visible in a constructor signature. What is
/// here is per connector and there is one of each per connection;
/// <see cref="AgentHost"/>'s remaining parameters - the adapters, the slots,
/// the scratch root, the state file, the clock - are the machine's, and are
/// the same objects for every connection. When the next thing is added to the
/// agent, which side of that line it belongs on is the question to answer, and
/// this is where the answer is written down.
/// <para>
/// The identity in particular is per connector and not per machine: each
/// control plane issues its own agent id and its own token, the profile ids a
/// BYO agent derives carry that id, and two connectors sharing one would put
/// one connector's bearer token in the other's Authorization header.
/// </para>
/// </remarks>
public sealed class AgentConnection
{
    public AgentConnection(
        ConnectorConnection settings,
        AgentIdentity identity,
        ControlPlaneClient control,
        ProfileStore profiles,
        JobRunner runner)
    {
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentNullException.ThrowIfNull(identity);
        ArgumentNullException.ThrowIfNull(control);
        ArgumentNullException.ThrowIfNull(profiles);
        ArgumentNullException.ThrowIfNull(runner);

        Settings = settings;
        Identity = identity;
        Control = control;
        Profiles = profiles;
        Runner = runner;
    }

    /// <summary>Where this connector is and how this machine was admitted to it.</summary>
    public ConnectorConnection Settings { get; }

    /// <summary>The agent id and token THIS connector issued.</summary>
    public AgentIdentity Identity { get; }

    /// <summary>Bound to this connector's two HTTP clients and nobody else's.</summary>
    public ControlPlaneClient Control { get; }

    /// <summary>This connector's browser profiles, under its own root.</summary>
    public ProfileStore Profiles { get; }

    public JobRunner Runner { get; }

    /// <summary>The name every log line and error about this connector carries.</summary>
    public string Name => Settings.Name;

    /// <summary>
    /// The control plane as the state file keys it: the base address with its
    /// trailing slash, which is also what the enrollment records.
    /// </summary>
    public string ControlPlane => Settings.RequireBaseAddress().AbsoluteUri;
}
