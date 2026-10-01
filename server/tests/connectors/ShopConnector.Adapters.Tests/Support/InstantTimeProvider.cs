namespace ShopConnector.Adapters.Tests.Support;

/// <summary>
/// A clock that does not move and timers that do not wait.
///
/// For the one shape of loop this suite could otherwise not drive at its real
/// settings: a counted poll. <c>SessionProbe.OnPageAsync</c> watches the
/// address for <c>SignedOutBounceSeconds</c> at <c>SessionPollMs</c> a pass,
/// which is twenty passes of half a second on Coolblue's shipped options - ten
/// real seconds per test if the delays are real, and every one of them spent
/// waiting for a fixture that cannot change.
/// </summary>
/// <remarks>
/// SEPARATE FROM <c>FixedTimeProvider</c> ON PURPOSE. That one leaves
/// <c>CreateTimer</c> on the system timer, so a test wanting a delay to elapse
/// has to drive it to zero rather than pretend time passed - which is the right
/// default and what the streamed-login tests here rely on. This one is the
/// exception, and it is only safe where the loop is bounded by a COUNT rather
/// than by the clock: firing the timers of a loop whose deadline is computed
/// from a frozen <c>GetUtcNow</c> would spin for ever.
/// <para>
/// The callback is queued rather than invoked inside <c>CreateTimer</c>:
/// <c>Task.Delay</c> creates its timer and then finishes wiring itself up, and
/// completing it from inside its own constructor is re-entrancy nobody
/// promised.
/// </para>
/// </remarks>
internal sealed class InstantTimeProvider : TimeProvider
{
    private readonly DateTimeOffset _now;

    public InstantTimeProvider(DateTimeOffset now) => _now = now;

    public override DateTimeOffset GetUtcNow() => _now;

    public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
        new AtOnce(callback, state);

    private sealed class AtOnce : ITimer
    {
        private readonly TimerCallback _callback;
        private readonly object? _state;
        private int _disposed;

        public AtOnce(TimerCallback callback, object? state)
        {
            _callback = callback;
            _state = state;

            Fire();
        }

        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            Fire();
            return true;
        }

        public void Dispose() => Volatile.Write(ref _disposed, 1);

        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }

        private void Fire() =>
            ThreadPool.QueueUserWorkItem(_ =>
            {
                if (Volatile.Read(ref _disposed) == 1) return;
                _callback(_state);
            });
    }
}
