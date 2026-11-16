using Connector.Kit.Challenges;

namespace Connector.Kit.Hosting.Live;

// memory only, deliberately: frames are photos of a provider login and events carry keystrokes
// bounds: ONE frame per job (replaced, not queued), bounded events, a job cap, an idle window; worst case ~40 MB
// instance-local for now: a second replica needs routing, not shared storage
public sealed class LiveChannel(TimeProvider time)
{
    // a refusal, not a tuning knob: a phone-sized login JPEG is tens of KB, near 1 MB is not a frame
    public const int MaxFrameBytes = 1024 * 1024;

    // four batches: a drag survives an agent a poll behind, yet a consumer cannot make the connector hold gestures indefinitely
    public const int MaxQueuedEvents = 4 * LiveInputBatch.MaxEvents;

    // far above what one browser slot serves; bounds memory by construction, not by the sweeper running
    public const int MaxJobs = 32;

    // a streamed login writes several times a second, so this much silence means the stream is over
    public static readonly TimeSpan IdleWindow = TimeSpan.FromMinutes(2);

    // one lock for the whole map: every critical section is a reference swap or a bounded list walk
    private readonly Lock _gate = new();

    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    // stream waiters (#429), beside the entries: a waiter must not admit an entry, as reads never keep a login alive
    private readonly Dictionary<string, Pulse> _pulses = new(StringComparer.Ordinal);

    // false when the frame is older than the held one: POSTs can overtake on mobile, and the human would act on a stale picture
    public bool Publish(string jobId, LiveFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);

        lock (_gate)
        {
            var entry = Admit(jobId);
            if (entry.Frame is { } held && frame.Sequence <= held.Sequence) return false;

            entry.Frame = frame;
            entry.WrittenAt = time.GetUtcNow();
            Wake(jobId, ended: false);
            return true;
        }
    }

    public LiveFrame? Frame(string jobId)
    {
        lock (_gate)
        {
            return _entries.TryGetValue(jobId, out var entry) ? entry.Frame : null;
        }
    }

    // check and registration run under Publish's lock, so a frame landing between "nothing newer" and "wait" still wakes (#429)
    // no frame when the window passed or the entry went (Ended), so the caller re-reads the run instead of waiting
    public async Task<LiveWait> NextFrameAsync(string jobId, long after, TimeSpan window, CancellationToken ct)
    {
        Pulse pulse;
        lock (_gate)
        {
            if (Newer(jobId, after) is { } ready) return new LiveWait(ready, Ended: false);

            if (!_pulses.TryGetValue(jobId, out var existing))
            {
                existing = new Pulse();
                _pulses[jobId] = existing;
            }

            pulse = existing;
            pulse.Waiters++;
        }

        try
        {
            await pulse.Source.Task.WaitAsync(window, time, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // The window, not a failure: the caller writes a keep-alive.
        }
        finally
        {
            lock (_gate)
            {
                pulse.Waiters--;
                if (pulse.Waiters == 0 && _pulses.TryGetValue(jobId, out var current) && ReferenceEquals(current, pulse))
                {
                    _pulses.Remove(jobId);
                }
            }
        }

        lock (_gate)
        {
            return new LiveWait(Newer(jobId, after), pulse.Ended);
        }
    }

    // the batch is taken whole (a gesture is refused or dispatched whole), then trimmed from the front, oldest Move first
    // refusing the newest events would drop the tap just made in favour of stale hover positions
    // only a count comes back: events carry password characters, and no log may hold one
    public int Enqueue(string jobId, LiveInputBatch batch)
    {
        ArgumentNullException.ThrowIfNull(batch);

        lock (_gate)
        {
            var entry = Admit(jobId);
            entry.WrittenAt = time.GetUtcNow();
            entry.Pending.AddRange(batch.Events);

            var dropped = 0;
            while (entry.Pending.Count > MaxQueuedEvents)
            {
                var victim = entry.Pending.FindIndex(e => e.Kind is LiveInputKind.Move);
                entry.Pending.RemoveAt(victim < 0 ? 0 : victim);
                dropped++;
            }

            return dropped;
        }
    }

    // after is the CONSUMER's counter (LiveInput.Sequence): the wire batch has no field a cursor could ride back on
    // asking acknowledges everything <= after; the rest stays queued so a lost response is re-delivered
    public LiveInputBatch Collect(string jobId, long after)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(jobId, out var entry)) return Empty;

            entry.Pending.RemoveAll(e => e.Sequence <= after);
            if (entry.Pending.Count == 0) return Empty;

            return new LiveInputBatch
            {
                Events = [.. entry.Pending.Take(LiveInputBatch.MaxEvents)],
            };
        }
    }

    // the prompt path, not the guarantee: a job can die in the queue on an expired lease without the outcome service
    // (hence Sweep and the cap)
    public bool Drop(string jobId)
    {
        lock (_gate)
        {
            // A stream waiting on this job wakes to find nothing, and ends.
            Wake(jobId, ended: true);
            return _entries.Remove(jobId);
        }
    }

    // closes the abandoned login (tab shut, half-typed form left in memory); reads deliberately do not count as traffic
    public int Sweep()
    {
        var cutoff = time.GetUtcNow() - IdleWindow;

        lock (_gate)
        {
            var stale = _entries.Where(e => e.Value.WrittenAt <= cutoff).Select(e => e.Key).ToList();
            foreach (var jobId in stale)
            {
                _entries.Remove(jobId);
                Wake(jobId, ended: true);
            }

            return stale.Count;
        }
    }

    /// <summary>Entries currently held. For tests and for a health figure; never the contents.</summary>
    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _entries.Count;
            }
        }
    }

    private Entry Admit(string jobId)
    {
        if (_entries.TryGetValue(jobId, out var existing)) return existing;

        // the cap evicts rather than refuses: a new login has a human in front of it; the displaced entry is the longest unwritten
        while (_entries.Count >= MaxJobs)
        {
            var oldest = _entries.MinBy(e => e.Value.WrittenAt).Key;
            _entries.Remove(oldest);
            Wake(oldest, ended: true);
        }

        var entry = new Entry { WrittenAt = time.GetUtcNow() };
        _entries[jobId] = entry;
        return entry;
    }

    private LiveFrame? Newer(string jobId, long after) =>
        _entries.TryGetValue(jobId, out var entry) && entry.Frame is { } frame && frame.Sequence > after ? frame : null;

    // under the lock; the continuations run elsewhere, never inside it
    private void Wake(string jobId, bool ended)
    {
        if (!_pulses.Remove(jobId, out var pulse)) return;

        pulse.Ended = ended;
        pulse.Source.TrySetResult();
    }

    private static readonly LiveInputBatch Empty = new();

    private sealed class Pulse
    {
        public TaskCompletionSource Source { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Waiters { get; set; }

        public bool Ended { get; set; }
    }

    // a list, not a queue: the drop policy removes from the middle (oldest Move, not oldest event)
    private sealed class Entry
    {
        public LiveFrame? Frame { get; set; }

        public List<LiveInput> Pending { get; } = [];

        public DateTimeOffset WrittenAt { get; set; }
    }
}

public readonly record struct LiveWait(LiveFrame? Frame, bool Ended);
