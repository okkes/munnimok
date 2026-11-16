using Connector.Kit.Adapters;

namespace Connector.Kit.Agent.Networking;

// two doors into one room with the limiter: a browser navigation and an HTTP call are both requests to one provider
public sealed class GatedPacer : IProviderPacer
{
    private readonly PolitenessGate _gate;
    private readonly string _providerId;
    private readonly TimeSpan _minGap;

    public GatedPacer(PolitenessGate gate, string providerId, TimeSpan minGap)
    {
        ArgumentNullException.ThrowIfNull(gate);
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);

        _gate = gate;
        _providerId = providerId;
        _minGap = minGap;
    }

    public Task<IDisposable> EnterAsync(CancellationToken ct) => _gate.EnterAsync(_providerId, _minGap, ct);

    public void Backoff(TimeSpan delay) => _gate.Penalise(_providerId, delay);
}
