namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The clock the agent reads, with the test holding the hands.
/// </summary>
/// <remarks>
/// This suite's habit is real time in hundreds of milliseconds, and for most
/// of it that is the right habit: a budget that suspends can only be proved by
/// letting time pass. It does not reach the keepalives. The numbers those are
/// about belong to the control plane - a two-minute lease, a thirty-second
/// beat, a ninety-second liveness window - and a case that waited them out
/// would cost minutes and still not be able to say WHEN anything happened.
/// <para>
/// The alternative is the one that was here: shrink the agent's own timeouts
/// until the test is quick. A renewal test written against a 250ms client
/// timeout passes exactly as happily when the production bound is seventy
/// seconds, which is the defect it was written for. So time is virtual and
/// every number under test stays the production one.
/// </para>
/// <para>
/// Everything in the path reads a <see cref="TimeProvider"/> - the runner's
/// delays, the job budget, the host's two loops, and through
/// <see cref="FakeControlPlane"/> the client timeout that stands in for
/// HttpClient's own - so advancing this is the whole of "a minute went by".
/// </para>
/// <para>
/// It starts where the machine's clock is, because a leased job carries a
/// <c>LeaseExpiresAt</c> stamped from <c>DateTimeOffset.UtcNow</c> and the two
/// have to mean the same thing.
/// </para>
/// </remarks>
internal sealed class TestClock : TimeProvider
{
    /// <summary>
    /// How far <see cref="RunUntilAsync"/> jumps per step, and therefore how
    /// late a stamp taken by the code under test can be.
    /// </summary>
    public static readonly TimeSpan Step = TimeSpan.FromSeconds(1);

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

    /// <summary>
    /// Moves the clock, firing everything that falls due on the way AT the
    /// instant it falls due.
    /// </summary>
    /// <remarks>
    /// Not at the end of the step: a caller that armed a ten-second wait has to
    /// read exactly ten seconds when it wakes, or a test cannot assert a bound
    /// as a number. Callbacks run outside the lock because one of them will arm
    /// the next wait, and the continuation it releases may run inline and arm
    /// three more.
    /// </remarks>
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

    /// <summary>
    /// Runs time forward until <paramref name="done"/> holds, or answers false
    /// once <paramref name="budget"/> of virtual time has been spent.
    /// </summary>
    /// <remarks>
    /// In steps rather than one leap, because the code under test arms its next
    /// wait only after the last one fired, and on a thread of its own: a single
    /// jump to the end would fire one timer and leave the rest unarmed. The
    /// short REAL pause between steps is what lets that thread get as far as
    /// its next wait; a whole test of these costs a few hundred milliseconds of
    /// wall clock for minutes of agent time.
    /// </remarks>
    public async Task<bool> RunUntilAsync(Func<bool> done, TimeSpan budget)
    {
        ArgumentNullException.ThrowIfNull(done);

        for (var spent = TimeSpan.Zero; !done(); spent += Step)
        {
            if (spent >= budget) return false;

            Advance(Step);
            await Task.Delay(2).ConfigureAwait(false);
        }

        return true;
    }

    /// <summary>One armed wait; a <c>Task.Delay</c> on this clock is one of these.</summary>
    private sealed class Waiter(TestClock clock, TimerCallback callback, object? state) : ITimer
    {
        private TimeSpan _period = Timeout.InfiniteTimeSpan;

        /// <summary>When this next comes due, or null while it is not armed.</summary>
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
