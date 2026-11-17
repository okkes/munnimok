using System.Collections.Concurrent;

namespace Connector.Kit.Agent.Networking;

// per PROVIDER, not per job: two concurrent sessions for one provider would double its call rate
public sealed class PolitenessGate
{
    // jitter as a fraction of the gap: calls on an exact interval look machine-shaped
    private const double JitterFraction = 0.5;

    private readonly ConcurrentDictionary<string, Slot> _slots = new(StringComparer.Ordinal);
    private readonly TimeProvider _time;

    public PolitenessGate(TimeProvider? time = null) => _time = time ?? TimeProvider.System;

    // disposing the ticket stamps the next allowed time and releases the next caller
    public async Task<IDisposable> EnterAsync(string providerId, TimeSpan minGap, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);

        var slot = _slots.GetOrAdd(providerId, static _ => new Slot());
        await slot.Gate.WaitAsync(ct).ConfigureAwait(false);

        try
        {
            var wait = slot.NextAllowedAt - _time.GetUtcNow();
            if (wait > TimeSpan.Zero)
            {
                await Task.Delay(wait, _time, ct).ConfigureAwait(false);
            }
        }
        catch
        {
            // A cancelled wait must not leave the provider's gate held forever.
            slot.Gate.Release();
            throw;
        }

        return new Ticket(this, slot, minGap < TimeSpan.Zero ? TimeSpan.Zero : minGap);
    }

    // what a provider's own Retry-After asked for: backing off when told to is the difference between a rate limit and a block
    public void Penalise(string providerId, TimeSpan delay)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(providerId);
        if (delay <= TimeSpan.Zero) return;

        var slot = _slots.GetOrAdd(providerId, static _ => new Slot());
        Extend(slot, _time.GetUtcNow() + delay);
    }

    private static void Extend(Slot slot, DateTimeOffset until)
    {
        if (until > slot.NextAllowedAt) slot.NextAllowedAt = until;
    }

    private sealed class Slot
    {
        public SemaphoreSlim Gate { get; } = new(1, 1);

        /// <summary>Only ever mutated by the holder of <see cref="Gate"/>.</summary>
        public DateTimeOffset NextAllowedAt { get; set; } = DateTimeOffset.MinValue;
    }

    private sealed class Ticket : IDisposable
    {
        private readonly PolitenessGate _owner;
        private readonly Slot _slot;
        private readonly TimeSpan _gap;
        private int _disposed;

        public Ticket(PolitenessGate owner, Slot slot, TimeSpan gap)
        {
            _owner = owner;
            _slot = slot;
            _gap = gap;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1) return;

            var jitter = TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * _gap.TotalMilliseconds * JitterFraction);
            Extend(_slot, _owner._time.GetUtcNow() + _gap + jitter);
            _slot.Gate.Release();
        }
    }
}
