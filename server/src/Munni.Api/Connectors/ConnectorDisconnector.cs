using Microsoft.EntityFrameworkCore;

namespace Munni.Api.Connectors;

// Party: ended, gone (the control plane no longer had it), refused (with the code) or unreachable
public sealed record SessionDisconnectOutcome(string Party, string? PartyError, int AccountsForgotten)
{
    public const string Ended = "ended";
    public const string Gone = "gone";
    public const string Refused = "refused";
    public const string Unreachable = "unreachable";
}

// a connection ends at the party as well as here (§15): deleting a feed ends the consent only when it was the last account,
// deleting the munni account ends every consent; where the relay keeps the bundle the party is told with it,
// a client-custody session is told without and expires on its own
public sealed class ConnectorDisconnector(ConnectorRelay relay, ILogger<ConnectorDisconnector> logger)
{
    public async Task DisconnectFeedAsync(Guid userId, string feedSpaceId, CancellationToken ct = default)
    {
        var leaving = await relay.Db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.FeedSpaceId == feedSpaceId && !a.Excluded)
            .ToListAsync(ct);
        if (leaving.Count == 0) return;
        var connections = leaving.Select(r => r.ConnectionId).OfType<string>().Distinct().ToList();
        var leavingIds = leaving.Select(r => r.Id).ToList();
        var staying = await relay.Db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.ConnectionId != null && connections.Contains(a.ConnectionId) && !a.Excluded && !leavingIds.Contains(a.Id))
            .Select(a => a.ConnectionId!)
            .Distinct()
            .ToListAsync(ct);
        var ending = connections.Where(c => !staying.Contains(c)).ToList();

        foreach (var session in await relay.Db.ConnectorSessions.Where(s => s.UserId == userId && ending.Contains(s.ConnectionId)).ToListAsync(ct))
        {
            await EndAsync(session, ct);
        }
        // a consent that ends takes every reference it ever made with it, the excluded ones included
        var forgotten = await relay.Db.ConnectorAccountRefs
            .Where(a => a.UserId == userId && a.ConnectionId != null && ending.Contains(a.ConnectionId))
            .ToListAsync(ct);
        forgotten.AddRange(leaving.Where(r => r.ConnectionId is null));
        await ForgetAsync(forgotten.DistinctBy(r => r.Id).ToList(), ct);
        foreach (var kept in leaving.Where(r => r.ConnectionId is not null && staying.Contains(r.ConnectionId)))
        {
            kept.Excluded = true;
        }
        await relay.Db.SaveChangesAsync(ct);
    }

    public async Task DisconnectAllAsync(Guid userId, CancellationToken ct = default)
    {
        var sessions = await relay.Db.ConnectorSessions.Where(s => s.UserId == userId).ToListAsync(ct);
        foreach (var session in sessions) await EndAsync(session, ct);
        await ForgetAsync(await relay.Db.ConnectorAccountRefs.Where(a => a.UserId == userId).ToListAsync(ct), ct);
    }

    // best effort at the party; the binding and account references go either way, so nothing is scheduled or settled
    // the feed's account rows stay: a reconnect lands on them, history included (#445)
    public async Task<SessionDisconnectOutcome?> DisconnectSessionAsync(string sessionId, CancellationToken ct = default)
    {
        var session = await relay.Db.ConnectorSessions.FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null) return null;
        var (party, error) = await EndAsync(session, ct);
        var refs = await relay.Db.ConnectorAccountRefs
            .Where(a => a.UserId == session.UserId && a.Provider == session.Provider && a.ConnectionId == session.ConnectionId)
            .ToListAsync(ct);
        await ForgetAsync(refs, ct);
        await relay.Db.SaveChangesAsync(ct);
        return new SessionDisconnectOutcome(party, error, refs.Count);
    }

    private async Task<(string Party, string? Error)> EndAsync(ConnectorSession session, CancellationToken ct)
    {
        (string Party, string? Error) outcome;
        try
        {
            var reply = await relay.Client.DeleteAsync($"v1/{session.Provider}/sessions/{session.Id}", new ConnectorCall
            {
                Subject = relay.Minter.For(session.UserId),
                Body = new WireDisconnect(session.KeptBundle),
            }, ct);
            if (reply.IsSuccess)
            {
                outcome = (SessionDisconnectOutcome.Ended, null);
            }
            else if (reply.Error?.Code is "unsupported_resource" or "session_expired")
            {
                // the control plane no longer had it: nothing to end, nothing to warn about
                outcome = (SessionDisconnectOutcome.Gone, reply.Error.Code);
            }
            else
            {
                var code = reply.Error?.Code ?? "-";
                outcome = (SessionDisconnectOutcome.Refused, code);
                if (logger.IsEnabled(LogLevel.Warning))
                {
                    logger.LogWarning("could not end connector session {Session} of {Provider} at the party: {Code}", session.Id, session.Provider, code);
                }
            }
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // the party being away — or too slow, which arrives as a cancelled call — is no reason to keep a row the person asked to be rid of
            logger.LogWarning(ex, "could not end connector session {Session} of {Provider} at the party", session.Id, session.Provider);
            outcome = (SessionDisconnectOutcome.Unreachable, null);
        }
        relay.Db.ConnectorSessions.Remove(session);
        return outcome;
    }

    private async Task ForgetAsync(List<ConnectorAccountRef> refs, CancellationToken ct)
    {
        if (refs.Count == 0) return;
        // the reserved rows they tracked go to another live reference of the account, or are
        // tombstoned: nothing would ever settle them once the bank books them (#508)
        await PendingHandover.HandOverAsync(relay.Db, refs, ct);
        relay.Db.ConnectorAccountRefs.RemoveRange(refs);
        await relay.Db.SaveChangesAsync(ct);
    }
}
