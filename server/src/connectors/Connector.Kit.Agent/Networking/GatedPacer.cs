using Connector.Kit.Adapters;

namespace Connector.Kit.Agent.Networking;

/// <summary>
/// The adapter-facing half of <see cref="PolitenessGate"/>: one provider, one
/// gap, handed to an adapter so it can pace work the HTTP limiter cannot see.
///
/// The limiter and this are two doors into the same room. That is the whole
/// design - a browser navigation and an HTTP call are both a request to the
/// same provider, and a provider that is being called twice as often because
/// the second call went through Chromium does not care which door it came from.
/// </summary>
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
