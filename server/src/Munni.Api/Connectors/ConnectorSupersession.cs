using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;

namespace Munni.Api.Connectors;

/// <summary>
/// A reconnect that made a NEW session must not leave the old one scheduled
/// beside it.
/// </summary>
/// <remarks>
/// Prod 2026-10-08: a friend's ING consent through GoCardless ended on the
/// party's budget, the reconnect bound a second session for the same
/// accounts, and from then on the two shared one daily budget — the nightly
/// run of either burnt what the other needed, and "auto syncing keeps
/// stopping". When a connection's accounts pass lands an account, every
/// other session of the same person and party that reached the same account
/// (the same IBAN; a card or wallet without one is keyed per session and
/// proves nothing) is superseded: its binding goes, the way a re-login of
/// the same connection replaces it in <c>BindAsync</c>, its references to
/// those accounts go with it, and the control plane is told to end it —
/// without its bundle, so the party's consent is left alone (the new one
/// reaches the same accounts) and a device still holding the old bundle is
/// answered "sign in again" instead of resuming a session nothing schedules
/// any more.
/// </remarks>
public sealed class ConnectorSupersession(AppDbContext db, ConnectorClient client, SubjectMinter minter, ILogger<ConnectorSupersession> logger)
{
    private const string CardPrefix = "CONN:";

    /// <summary>The codes the control plane answers for a session it no longer has: nothing to end, nothing to say.</summary>
    private static readonly HashSet<string> AlreadyGone = new(StringComparer.Ordinal) { "unsupported_resource", "session_expired" };

    /// <summary>
    /// Retires every other session of the user and party whose references
    /// share one of <paramref name="accountRefs"/>; returns how many went.
    /// </summary>
    public async Task<int> RetireAsync(Guid userId, string provider, string connectionId, IReadOnlyCollection<string> accountRefs, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(accountRefs);
        var shared = accountRefs.Where(r => !r.StartsWith(CardPrefix, StringComparison.Ordinal)).Distinct().ToList();
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

        var ids = reached.Select(a => a.Id).ToList();
        db.ConnectorPendingTxs.RemoveRange(await db.ConnectorPendingTxs.Where(p => ids.Contains(p.AccountRefId)).ToListAsync(ct));
        db.ConnectorAccountRefs.RemoveRange(reached);
        await db.SaveChangesAsync(ct);
        return superseded.Count;
    }

    /// <summary>
    /// Ends the session at the control plane without its bundle: no logout
    /// upstream, and a resume of the old bundle answers <c>session_expired</c>
    /// from here on. Best effort — the binding goes either way, and a control
    /// plane that is away expires the session by itself.
    /// </summary>
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
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "could not end superseded connector session {Session} of {Provider} at the control plane", session.Id, session.Provider);
        }
    }
}
