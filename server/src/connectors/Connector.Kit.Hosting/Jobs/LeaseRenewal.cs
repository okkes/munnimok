using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Jobs;

/// <summary>
/// Keeps an in-process run's lease alive for as long as the run lasts, and
/// ends with it in the right order: the loop is told to stop, waited for,
/// and only then is its stop source disposed.
/// </summary>
/// <remarks>
/// Until 2026-10-09 the runner disposed the source the moment the job's
/// scope closed, while the loop was still awaiting the token: the next
/// delay or renewal touched a disposed source, threw
/// <see cref="ObjectDisposedException"/> into a task nobody awaited, and
/// the finalizer re-raised it as an unobserved
/// <see cref="AggregateException"/> - 98 events in production's GlitchTip
/// in three days (#23, #29), one per inline job. Awaiting the loop here is
/// what observes it; the loop itself never faults, so the await never
/// throws into the run's own disposal.
/// </remarks>
internal sealed class LeaseRenewal : IAsyncDisposable
{
    private readonly CancellationTokenSource _stop;

    private LeaseRenewal(CancellationTokenSource stop, Task loop)
    {
        _stop = stop;
        Loop = loop;
    }

    /// <summary>The loop itself: completed once the renewal has ended, never faulted.</summary>
    public Task Loop { get; }

    /// <summary>
    /// Starts renewing <paramref name="jobId"/>'s lease for <paramref name="owner"/>
    /// every third of <paramref name="ttl"/>, until disposed or until the
    /// queue says the lease is no longer this owner's.
    /// </summary>
    public static LeaseRenewal Start(
        IServiceScopeFactory scopes, string jobId, string owner, TimeSpan ttl, ILogger logger, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(scopes);
        ArgumentException.ThrowIfNullOrWhiteSpace(jobId);
        ArgumentException.ThrowIfNullOrWhiteSpace(owner);
        ArgumentNullException.ThrowIfNull(logger);

        var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = stop.Token;
        var loop = Task.Run(() => RenewAsync(scopes, jobId, owner, ttl, logger, token), CancellationToken.None);
        return new LeaseRenewal(stop, loop);
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        await Loop;
        _stop.Dispose();
    }

    private static async Task RenewAsync(
        IServiceScopeFactory scopes, string jobId, string owner, TimeSpan ttl, ILogger logger, CancellationToken stop)
    {
        var interval = ttl / 3;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                await Task.Delay(interval, stop);

                try
                {
                    using var scope = scopes.CreateScope();
                    var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
                    if (await queue.RenewLeaseAsync(jobId, owner, ttl, stop) is not null) continue;

                    // The sweeper or another owner has the job now; its
                    // outcome will be refused when this run reports it,
                    // and the runner says so there.
                    logger.LogWarning(
                        "job {JobId}: the lease could not be renewed - the queue took the job back while the run was still going",
                        jobId);
                    return;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // A database that did not answer this round is not the
                    // end of the lease: the next round is a third of the
                    // ttl away, and the lease holds until the whole of it.
                    logger.LogWarning(ex,
                        "job {JobId}: the lease renewal failed this round; tried again in {Seconds:0}s",
                        jobId, interval.TotalSeconds);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal: the job finished.
        }
        catch (ObjectDisposedException)
        {
            // The stop source went before the loop did - the same end, and
            // observed here rather than by the finalizer.
        }
    }
}
