namespace Connector.Kit.Agent.Execution;

// measured in WORK, not wall clock: it stops a wedged adapter, while a challenge has its own expiry; two clocks racing
// would kill the login of someone walking back to their desk. A run that never parks gets no extension
internal sealed class JobBudget : IDisposable
{
    // floor on re-checks WHILE PARKED: remaining time stands still, so a job parked with 1 ms left would wake every ms;
    // a working job dies exactly on its deadline
    private static readonly TimeSpan MinimumRecheck = TimeSpan.FromSeconds(1);

    private readonly TimeSpan _budget;
    private readonly TimeProvider _time;
    private readonly DateTimeOffset _startedAt;
    private readonly CancellationTokenSource _expired = new();
    private readonly Lock _gate = new();

    private TimeSpan _parked;
    private DateTimeOffset? _parkedSince;
    private int _parkDepth;
    private int _disposed;

    public JobBudget(TimeSpan budget, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(time);

        _budget = budget < TimeSpan.Zero ? TimeSpan.Zero : budget;
        _time = time;
        _startedAt = time.GetUtcNow();
    }

    public CancellationToken Token => _expired.Token;

    /// <summary>True when this budget, rather than anything else, ended the run.</summary>
    public bool Expired => _expired.IsCancellationRequested;

    // reported in the failure detail so a run that hits its budget is diagnosable
    public TimeSpan HumanWait
    {
        get { lock (_gate) return ParkedAt(_time.GetUtcNow()); }
    }

    // nesting is counted: an overlapping or unbalanced scope must not suspend the budget for the rest of the run
    public IDisposable Park()
    {
        lock (_gate)
        {
            if (_parkDepth++ == 0) _parkedSince = _time.GetUtcNow();
        }

        return new ParkScope(this);
    }

    // re-reads the deadline each pass instead of arming a timer once: parking moves it and nothing knows by how far
    public async Task WatchAsync(CancellationToken stop)
    {
        try
        {
            while (true)
            {
                var (remaining, parked) = Snapshot();
                if (remaining <= TimeSpan.Zero) break;

                await Task.Delay(parked && remaining < MinimumRecheck ? MinimumRecheck : remaining, _time, stop)
                    .ConfigureAwait(false);
            }

            // the job finished on the very last pass: cancelling now would dress an ordinary ending up as a timeout
            if (stop.IsCancellationRequested) return;

            await _expired.CancelAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // the job reached a terminal state first; there is nothing to kill
        }
        catch (ObjectDisposedException)
        {
            // same reason: already disposed after the job ended
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        _expired.Dispose();
    }

    private (TimeSpan Remaining, bool Parked) Snapshot()
    {
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            return (_budget - ((now - _startedAt) - ParkedAt(now)), _parkedSince is not null);
        }
    }

    /// <summary>Callers hold <see cref="_gate"/>.</summary>
    private TimeSpan ParkedAt(DateTimeOffset now) =>
        _parkedSince is { } since ? _parked + (now - since) : _parked;

    private void Unpark()
    {
        lock (_gate)
        {
            if (_parkDepth == 0 || --_parkDepth > 0) return;

            if (_parkedSince is { } since) _parked += _time.GetUtcNow() - since;
            _parkedSince = null;
        }
    }

    private sealed class ParkScope(JobBudget budget) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
            budget.Unpark();
        }
    }
}
