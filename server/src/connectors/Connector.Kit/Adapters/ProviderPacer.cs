namespace Connector.Kit.Adapters;

/// <summary>
/// The gap between one call to a provider and the next.
///
/// The platform has always had this, and adapters have never been able to
/// reach it. It was installed on <see cref="IJobContext.Http"/> as a delegating
/// handler, which paces every adapter that talks to a provider over HTTP and
/// none of the ones that drive a page - a browser navigation is Chromium's
/// socket, not ours, and it walks straight past the handler. So Bol's fetch
/// runs at one request per gap and Amazon's runs at whatever Chromium can
/// manage, which on a first sync is one order list plus a hundred-odd invoices
/// back to back, with nothing between them.
///
/// This is that same gate, handed to the adapter as something it can hold open
/// around work the handler cannot see.
/// </summary>
/// <remarks>
/// Pacing is deliberately NOT a per-adapter <c>Task.Delay</c>. The gate behind
/// this is per PROVIDER and shared by every job in the agent: two users syncing
/// Amazon at the same moment are two sessions and one Amazon, and serialising
/// only within a job would let them double the rate that provider sees - which
/// is the cadence bot protection is built to notice.
/// </remarks>
public interface IProviderPacer
{
    /// <summary>
    /// Waits for this provider's turn, then for the remaining gap. Dispose the
    /// ticket when the call is done: disposal is what starts the next gap and
    /// releases whoever is waiting behind it.
    /// </summary>
    Task<IDisposable> EnterAsync(CancellationToken ct);

    /// <summary>
    /// Pushes the next call further out than the normal gap, because the
    /// provider said so.
    ///
    /// Backing off when told to is the difference between a rate limit and a
    /// block, and it is the half of pacing a fixed delay cannot do. It is also
    /// the half that survives the job: the run that met the 429 is usually
    /// already lost, and what the penalty protects is the next one.
    /// </summary>
    void Backoff(TimeSpan delay);
}

/// <summary>
/// No pacing at all: every call goes straight through.
///
/// The default for a context that has nothing to pace rather than a convenient
/// stub. An inline job has no browser (see <c>NoBrowserLease</c>), so its only
/// outbound traffic is the HTTP client, and that client already carries the
/// limiter - pacing it twice would charge one gap for one request. A test fake
/// gets this for the same reason: no provider is being called.
/// </summary>
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
        // Nothing is being paced, so there is nothing to push out.
    }

    private sealed class NoTicket : IDisposable
    {
        public void Dispose()
        {
        }
    }
}
