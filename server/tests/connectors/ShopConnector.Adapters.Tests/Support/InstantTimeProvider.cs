namespace ShopConnector.Adapters.Tests.Support;

// for counted polls (SessionProbe.OnPageAsync: 20 passes of 500 ms on Coolblue = 10 s a test): timers fire at once
// only safe where a COUNT bounds the loop: a deadline computed from the frozen GetUtcNow would spin forever
// the callback is queued, not run inside CreateTimer: Task.Delay finishes wiring itself after creating it
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
