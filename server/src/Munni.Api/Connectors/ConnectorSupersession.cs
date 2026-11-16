using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

// a reconnect that made a NEW session must not leave the old one scheduled: both would share one daily party budget
// (prod 2026-10-08, ING via GoCardless); the old one is ended without its bundle, so the party's consent stays
// and a device holding the old bundle is told to sign in again; a per-session-id reference proves nothing
public sealed class ConnectorSupersession(AppDbContext db, ConnectorClient client, SubjectMinter minter, ILogger<ConnectorSupersession> logger)
{
    private static readonly HashSet<string> AlreadyGone = new(StringComparer.Ordinal) { "unsupported_resource", "session_expired" };

    // each reference must name the account itself; the caller leaves out a card keyed by an id that may mean another account
    public async Task<int> RetireAsync(Guid userId, string provider, string connectionId, IReadOnlyCollection<string> accountRefs, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(accountRefs);
        var shared = accountRefs.Distinct().ToList();
        if (shared.Count == 0) return 0;

        var reached = await db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.Provider == provider && a.ConnectionId != null && a.ConnectionId != connectionId && shared.Contains(a.AccountRef))
            .ToListAsync(ct);
        if (reached.Count == 0) return 0;

        var connections = reached.Select(a => a.ConnectionId!).Distinct().ToList();
        var superseded = await db.ConnectorSessions
            .Where(s => s.UserId == userId && s.Provider == provider && connections.Contains(s.ConnectionId))
            .ToListAsync(ct);
        var successor = await db.ConnectorSessions
            .Where(s => s.UserId == userId && s.Provider == provider && s.ConnectionId == connectionId)
            .Select(s => s.Id)
            .FirstOrDefaultAsync(ct) ?? connectionId;

        foreach (var session in superseded)
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("connector session {Old} of {Provider} superseded by {New}: it reached the same accounts", session.Id, provider, successor);
            }
            await EndAsync(session, ct);
            db.ConnectorSessions.Remove(session);
        }

        // the reserved rows the old connection tracked go to the new one's references of
        // the same accounts, whose next complete pass settles them (#508)
        await PendingHandover.HandOverAsync(db, reached, ct);
        db.ConnectorAccountRefs.RemoveRange(reached);
        await db.SaveChangesAsync(ct);
        return superseded.Count;
    }

    // no logout upstream; resuming the old bundle answers session_expired. Best effort: an away control plane expires it itself
    private async Task EndAsync(ConnectorSession session, CancellationToken ct)
    {
        try
        {
            var reply = await client.DeleteAsync($"v1/{session.Provider}/sessions/{session.Id}", new ConnectorCall
            {
                Subject = minter.For(session.UserId),
                Body = new WireDisconnect(null),
            }, ct);
            if (!reply.IsSuccess && !AlreadyGone.Contains(reply.Error?.Code ?? string.Empty) && logger.IsEnabled(LogLevel.Warning))
            {
                logger.LogWarning("could not end superseded connector session {Session} of {Provider} at the control plane: {Code}",
                    session.Id, session.Provider, reply.Error?.Code ?? "-");
            }
        }
        // best effort includes a control plane that is too slow: its timeout arrives as a cancelled call
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "could not end superseded connector session {Session} of {Provider} at the control plane", session.Id, session.Provider);
        }
    }
}
