using System.Collections.Concurrent;

namespace Connector.Kit.Hosting.Infrastructure;

// collapses a retried mutating call (above all POST /login) onto what it created:
// a retry must not submit a credential twice
// in memory with a TTL: a restart forgets (a duplicate session for seconds); a table would stop it being a pipe
public interface IIdempotencyStore
{
    bool TryGet(string scope, string key, out string value);

    /// <summary>Records the outcome. First writer wins, so a genuine race collapses too.</summary>
    string Remember(string scope, string key, string value);

    int Sweep();
}

public sealed class InMemoryIdempotencyStore(TimeProvider time) : IIdempotencyStore
{
    private static readonly TimeSpan Retention = TimeSpan.FromHours(1);

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public bool TryGet(string scope, string key, out string value)
    {
        value = string.Empty;
        if (!_entries.TryGetValue(Compose(scope, key), out var entry)) return false;

        if (entry.ExpiresAt <= time.GetUtcNow())
        {
            _entries.TryRemove(Compose(scope, key), out _);
            return false;
        }

        value = entry.Value;
        return true;
    }

    public string Remember(string scope, string key, string value)
    {
        var entry = _entries.GetOrAdd(Compose(scope, key), new Entry(value, time.GetUtcNow() + Retention));
        return entry.Value;
    }

    public int Sweep()
    {
        var now = time.GetUtcNow();
        var removed = 0;
        foreach (var (key, entry) in _entries)
        {
            if (entry.ExpiresAt <= now && _entries.TryRemove(key, out _)) removed++;
        }

        return removed;
    }

    // ASCII unit separator as a numeric escape, so the source carries no invisible control character
    private const char Separator = (char)0x1F;

    private static string Compose(string scope, string key) => scope + Separator + key;

    private readonly record struct Entry(string Value, DateTimeOffset ExpiresAt);
}
