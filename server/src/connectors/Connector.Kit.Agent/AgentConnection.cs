using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Execution;
using Connector.Kit.Agent.Transport;

namespace Connector.Kit.Agent;

// what this process holds per connector; AgentHost's other parameters are the machine's, shared by every connection.
// The identity is per connector: each control plane issues its own agent id and token, and sharing one would
// put one connector's bearer token in another's Authorization header
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

    public ConnectorConnection Settings { get; }

    public AgentIdentity Identity { get; }

    public ControlPlaneClient Control { get; }

    public ProfileStore Profiles { get; }

    public JobRunner Runner { get; }

    public string Name => Settings.Name;

    // the control plane as the state file keys it: base address with its trailing slash, as the enrollment records it
    public string ControlPlane => Settings.RequireBaseAddress().AbsoluteUri;
}
