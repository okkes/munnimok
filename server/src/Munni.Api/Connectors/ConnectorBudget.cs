using System.Collections.Concurrent;

namespace Munni.Api.Connectors;

/// <summary>
/// The per-user budget on the two calls that reach a provider — logins and
/// syncs — on top of the connector's own per-provider interval
/// (docs/connector-integration-plan.md §5.2). A sliding hour per user per
/// kind, in memory: the API is a single instance, and a budget that did
/// not survive a restart is a budget that resets on deploy, which is fine.
/// </summary>
public sealed class ConnectorBudget(ConnectorOptions options, TimeProvider time)
{
    public const string Login = "login";
    public const string Sync = "sync";

    private static readonly TimeSpan Window = TimeSpan.FromHours(1);

    private readonly ConcurrentDictionary<(Guid User, string Kind), Queue<DateTimeOffset>> _spent = new();

    /// <summary>Spends one unit when the budget allows it; otherwise says how long until it would.</summary>
    public bool TrySpend(Guid userId, string kind, out int retryAfterSeconds)
    {
        var limit = kind == Login ? options.LoginsPerHour : options.SyncsPerHour;
        var now = time.GetUtcNow();
        var queue = _spent.GetOrAdd((userId, kind), _ => new Queue<DateTimeOffset>());

        lock (queue)
        {
            while (queue.Count > 0 && queue.Peek() <= now - Window) queue.Dequeue();

            if (queue.Count >= limit)
            {
                retryAfterSeconds = Math.Max(1, (int)Math.Ceiling((queue.Peek() + Window - now).TotalSeconds));
                return false;
            }

            queue.Enqueue(now);
            retryAfterSeconds = 0;
            return true;
        }
    }
}
