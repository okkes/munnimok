namespace Connector.Kit.Adapters;

// the gap between provider calls; Http's limiter paces HTTP only, a browser navigation is Chromium's socket and
// skips the handler. The gate is per PROVIDER, shared by every job in the agent, not a per-adapter Task.Delay: two
// users syncing one provider would double the rate bot protection watches
public interface IProviderPacer
{
    // disposal starts the next gap and releases whoever waits behind
    Task<IDisposable> EnterAsync(CancellationToken ct);

    // honours a provider's own back-off (429), the half of pacing a fixed delay cannot do; it protects the next run,
    // the one that met the 429 is usually lost
    void Backoff(TimeSpan delay);
}

// the default for a context with nothing to pace: an inline job's HTTP client already carries the limiter, and pacing it
// twice would charge two gaps for one request
public sealed class UnpacedProvider : IProviderPacer
{
    private static readonly IDisposable FreePass = new NoTicket();

    public static IProviderPacer Instance { get; } = new UnpacedProvider();

    public Task<IDisposable> EnterAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(FreePass);
    }

    public void Backoff(TimeSpan delay)
    {
        // nothing is paced
    }

    private sealed class NoTicket : IDisposable
    {
        public void Dispose()
        {
        }
    }
}
