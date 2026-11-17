using System.Collections.Concurrent;
using Connector.Kit.Security;

namespace Connector.Kit.Hosting.Tickets;

/// the unsealed material lives here until a job is created from it: a credential never rides a URL or access log
public sealed record TicketGrant
{
    public required string Subject { get; init; }

    public required string SessionId { get; init; }

    public required string ProviderId { get; init; }

    public required SessionMaterial Material { get; init; }

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public required DateTimeOffset ExpiresAt { get; init; }
}

/// in memory only: a restart invalidates every ticket and the caller resumes again from its bundle
public interface ITicketStore
{
    string Mint(TicketGrant grant);

    /// a ticket presented on another provider's route is not a ticket; the grant carries the subject it was minted for
    bool TryRedeem(string? ticketId, string providerId, out TicketGrant grant);

    void Revoke(string ticketId);

    void RevokeSession(string sessionId);

    int Sweep();
}

public sealed class InMemoryTicketStore(TimeProvider time) : ITicketStore
{
    private readonly ConcurrentDictionary<string, TicketGrant> _tickets = new(StringComparer.Ordinal);

    public string Mint(TicketGrant grant)
    {
        ArgumentNullException.ThrowIfNull(grant);
        var id = Ids.New(Ids.Ticket);
        _tickets[id] = grant;
        return id;
    }

    public bool TryRedeem(string? ticketId, string providerId, out TicketGrant grant)
    {
        grant = null!;
        if (string.IsNullOrWhiteSpace(ticketId)) return false;
        if (!_tickets.TryGetValue(ticketId, out var found)) return false;

        if (found.ExpiresAt <= time.GetUtcNow())
        {
            _tickets.TryRemove(ticketId, out _);
            return false;
        }

        if (!string.Equals(found.ProviderId, providerId, StringComparison.Ordinal)) return false;

        grant = found;
        return true;
    }

    public void Revoke(string ticketId) => _tickets.TryRemove(ticketId, out _);

    public void RevokeSession(string sessionId)
    {
        foreach (var (id, grant) in _tickets)
        {
            if (string.Equals(grant.SessionId, sessionId, StringComparison.Ordinal))
            {
                _tickets.TryRemove(id, out _);
            }
        }
    }

    public int Sweep()
    {
        var now = time.GetUtcNow();
        var removed = 0;
        foreach (var (id, grant) in _tickets)
        {
            if (grant.ExpiresAt <= now && _tickets.TryRemove(id, out _)) removed++;
        }

        return removed;
    }
}
