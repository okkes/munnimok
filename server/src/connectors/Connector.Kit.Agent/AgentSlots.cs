namespace Connector.Kit.Agent;

/// <summary>
/// How many jobs this MACHINE will run at once, held in one place for every
/// connector it serves.
/// </summary>
/// <remarks>
/// <b>This used to be a semaphore inside <see cref="AgentHost"/>, which was
/// correct for exactly as long as a process held one host.</b> A household that
/// reaches the bank, the shopping and the registry connectors now runs one
/// agent with three lease loops in it; three hosts each holding their own slot
/// would be three Chromiums on a NAS whose configuration says
/// <c>MaxConcurrency: 1</c> - and the BYO compose file explains what that
/// setting is for: "Two jobs on one agent are two browsers in one process, and
/// a fault in the process is a fault across both".
/// <para>
/// A slot is taken BEFORE the lease poll, not after a job arrives. So a
/// connector with no slot does not ask its control plane for work at all, and
/// nothing is ever leased and then left parked waiting for a browser while its
/// lease runs out. What each control plane is told about capacity is the
/// machine's limit, which slightly over-promises when several connectors are
/// idle at once; the cost of that is a job offered a moment before this agent
/// asks for it, and the alternative - dividing one browser between three
/// connectors on paper - would idle the machine for most of every day.
/// </para>
/// </remarks>
public sealed class AgentSlots : IDisposable
{
    private readonly SemaphoreSlim _slots;

    public AgentSlots(int limit)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(limit, 1);

        Limit = limit;
        _slots = new SemaphoreSlim(limit, limit);
    }

    /// <summary>Jobs this machine runs at once, across every connector.</summary>
    public int Limit { get; }

    public Task WaitAsync(CancellationToken cancellationToken) => _slots.WaitAsync(cancellationToken);

    /// <summary>
    /// Releasing a slot after the machine has been disposed is a shutdown
    /// race, not an error - and throwing here would surface as an unobserved
    /// task exception rather than anything anyone can act on.
    /// </summary>
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
