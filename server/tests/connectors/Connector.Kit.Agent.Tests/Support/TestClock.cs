namespace Connector.Kit.Agent.Tests;

// virtual time keeps every number under test the production one (lease, beat, liveness window): shrunk agent
// timeouts pass at a 70s bound too; starts at the machine's clock because LeaseExpiresAt is stamped from UtcNow
internal sealed class TestClock : TimeProvider
{
    public static readonly TimeSpan Step = TimeSpan.FromSeconds(1);

    private static readonly TimeSpan StepPause = TimeSpan.FromMilliseconds(5);

    private readonly Lock _gate = new();
    private readonly List<Waiter> _waiting = [];

    private DateTimeOffset _now = DateTimeOffset.UtcNow;

    public override DateTimeOffset GetUtcNow()
    {
        lock (_gate) return _now;
    }

    public override long TimestampFrequency => TimeSpan.TicksPerSecond;

    public override long GetTimestamp() => GetUtcNow().UtcTicks;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
    {
        ArgumentNullException.ThrowIfNull(callback);

        var waiter = new Waiter(this, callback, state);
        waiter.Change(dueTime, period);
        return waiter;
    }

    // fires due callbacks AT the instant they fall due so a wait reads exactly its bound; callbacks run outside
    // the lock because they arm the next wait
    public void Advance(TimeSpan by)
    {
        var target = GetUtcNow() + by;

        while (true)
        {
            Waiter? due = null;

            lock (_gate)
            {
                foreach (var waiter in _waiting)
                {
                    if (waiter.DueAt is { } at && at <= target && (due is null || at < due.DueAt)) due = waiter;
                }

                if (due is null)
                {
                    _now = target;
                    return;
                }

                _now = due.DueAt!.Value;
                due.Rearm();
            }

            due.Fire();
        }
    }

    // steps, not one leap: the code under test arms its next wait on its own thread after the last fired;
    // the short real pause lets it get there; five ms, not two: at two the ten-virtual-second keepalive bound
    // was 20 real ms, which a loaded CI runner spent in one pause
    public async Task<bool> RunUntilAsync(Func<bool> done, TimeSpan budget)
    {
        ArgumentNullException.ThrowIfNull(done);

        for (var spent = TimeSpan.Zero; !done(); spent += Step)
        {
            if (spent >= budget) return false;

            Advance(Step);
            await Task.Delay(StepPause).ConfigureAwait(false);
        }

        return true;
    }

    private sealed class Waiter(TestClock clock, TimerCallback callback, object? state) : ITimer
    {
        private TimeSpan _period = Timeout.InfiniteTimeSpan;

        public DateTimeOffset? DueAt { get; private set; }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            lock (clock._gate)
            {
                DueAt = dueTime == Timeout.InfiniteTimeSpan ? null : clock._now + dueTime;
                _period = period;

                if (!clock._waiting.Contains(this)) clock._waiting.Add(this);
            }

            return true;
        }

        /// <summary>A periodic timer's next turn, or nothing for a one-shot. Under the clock's lock.</summary>
        public void Rearm() =>
            DueAt = _period > TimeSpan.Zero && _period != Timeout.InfiniteTimeSpan
                ? clock._now + _period
                : null;

        public void Fire() => callback(state);

        public void Dispose()
        {
            lock (clock._gate) clock._waiting.Remove(this);
        }

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
