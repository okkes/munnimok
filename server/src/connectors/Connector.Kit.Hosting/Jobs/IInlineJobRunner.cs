using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;

namespace Connector.Kit.Hosting.Jobs;

// lets a pure-HTTP provider (Albert Heijn) need no agent; the adapter sees the same IJobContext as on a real agent
// only Inline-class Http-runtime providers: the control plane has no browser and its egress is the wrong address
public interface IInlineJobRunner
{
    bool CanRun(ProviderManifest manifest);

    IReadOnlyList<string> Providers { get; }

    AgentCapabilities Capabilities { get; }

    void Dispatch();

    Task RunAsync(LeasedJob job, CancellationToken ct);
}
