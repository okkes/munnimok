using System.Collections.Concurrent;

namespace Connector.Kit.Hosting.Infrastructure;

// a nudge, not a bus: waiters re-read the database themselves and every caller has a fallback poll, so a missed signal
// costs latency only, and a second instance does not turn this into a distributed queue
public sealed class ConnectorSignals
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource> _waiters =
        new(StringComparer.Ordinal);

    public static string Session(string sessionId) => "ses:" + sessionId;

    public static string Job(string jobId) => "job:" + jobId;

    public const string Queue = "queue";

    // own key namespace per direction: a live view signals dozens of times a second, and sharing Job's key would wake every
    // parked challenge poll at frame rate, each wake costing a database read
    public static string LiveFrame(string jobId) => "livef:" + jobId;

    public static string LiveInput(string jobId) => "livei:" + jobId;

    public void Signal(string key)
    {
        if (_waiters.TryRemove(key, out var waiter)) waiter.TrySetResult();
    }

    public async Task<bool> WaitAsync(string key, TimeSpan window, CancellationToken ct)
    {
        var waiter = _waiters.GetOrAdd(key, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var delay = Task.Delay(window, timeout.Token);
        var finished = await Task.WhenAny(waiter.Task, delay).ConfigureAwait(false);

        if (finished == waiter.Task)
        {
            await timeout.CancelAsync().ConfigureAwait(false);
            return true;
        }

        // nobody signalled: drop the registration so a never-signalled key cannot accumulate
        _waiters.TryRemove(new KeyValuePair<string, TaskCompletionSource>(key, waiter));
        return false;
    }
}
