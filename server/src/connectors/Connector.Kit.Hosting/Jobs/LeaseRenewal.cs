using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Connector.Kit.Hosting.Jobs;

// stops in order: loop told to stop, awaited, then its source disposed
// disposing first threw ObjectDisposedException into an unawaited task: 98 GlitchTip events in 3 days (#23, #29)
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
