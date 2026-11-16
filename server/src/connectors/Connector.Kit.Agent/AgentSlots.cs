namespace Connector.Kit.Agent;

// one slot count per MACHINE: a host-level semaphore would mean three Chromiums on a NAS configured MaxConcurrency 1.
// Taken BEFORE the lease poll, so a connector without a slot never leases a job and parks it until its lease runs out;
// each control plane is told the machine's limit, which slightly over-promises when several connectors are idle
public sealed class AgentSlots : IDisposable
{
    private readonly SemaphoreSlim _slots;

    public AgentSlots(int limit)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(limit, 1);

        Limit = limit;
        _slots = new SemaphoreSlim(limit, limit);
    }

    public int Limit { get; }

    public Task WaitAsync(CancellationToken cancellationToken) => _slots.WaitAsync(cancellationToken);

    // a release after disposal is a shutdown race, not an error: throwing would surface as an unobserved task exception
    public void Release()
    {
        try
        {
            _slots.Release();
        }
        catch (ObjectDisposedException)
        {
            // The process is going; there is nothing left to admit.
        }
    }

    public void Dispose() => _slots.Dispose();
}
