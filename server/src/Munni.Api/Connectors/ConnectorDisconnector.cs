using Microsoft.EntityFrameworkCore;

namespace Munni.Api.Connectors;

/// <summary>
/// What ending one session came to (user 2026-10-09: the operator's Bank
/// connections dashboard says it instead of a bare 200): the party's side
/// — <c>ended</c>, <c>gone</c> (the control plane no longer had it),
/// <c>refused</c> with the code, <c>unreachable</c> — and how many account
/// references went with the binding.
/// </summary>
public sealed record SessionDisconnectOutcome(string Party, string? PartyError, int AccountsForgotten)
{
    public const string Ended = "ended";
    public const string Gone = "gone";
    public const string Refused = "refused";
    public const string Unreachable = "unreachable";
}

/// <summary>
/// A connection ends at the party as well as here (§15). Deleting a feed
/// takes its account out of the consent that reaches it — the consent ends
/// at the party when that was its last account, and lives on for the
/// others otherwise, the account left where the party lists it; deleting
/// the munni account ends every consent the person made — the way the
/// api's own bank ingest revoked its requisitions. Where the relay keeps
/// the bundle (a household agent's pointer, an open-banking consent) the
/// party is told with it; a client-custody session is told without, and
/// expires on its own.
/// </summary>
public sealed class ConnectorDisconnector(ConnectorRelay relay, ILogger<ConnectorDisconnector> logger)
{
    /// <summary>The feed's accounts leave their consents; a consent with no account left ends at the party.</summary>
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

    /// <summary>Everything the user connected: revoked at the party, forgotten here.</summary>
    public async Task DisconnectAllAsync(Guid userId, CancellationToken ct = default)
    {
        var sessions = await relay.Db.ConnectorSessions.Where(s => s.UserId == userId).ToListAsync(ct);
        foreach (var session in sessions) await EndAsync(session, ct);
        await ForgetAsync(await relay.Db.ConnectorAccountRefs.Where(a => a.UserId == userId).ToListAsync(ct), ct);
    }

    /// <summary>
    /// One session, as an operator ends it from the admin portal (user
    /// 2026-10-09: "too many active connections that are not used any
    /// more", with no place to see them): told to the control plane with
    /// the bundle the relay keeps — an open-banking consent is revoked at
    /// the bank by it — best effort, the way a feed's deletion tells it; the
    /// binding goes either way, and so do the account references the
    /// connection made, so nothing is scheduled or settled against it any
    /// more. The account rows in the feed stay: a reconnect lands on them,
    /// history included (#445). Null when no session carries the id.
    /// </summary>
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

    /// <summary>Tells the control plane, with whatever bundle the relay keeps, and removes the binding whatever it answered.</summary>
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
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // the party being away is no reason to keep a row the person asked to be rid of
            logger.LogWarning(ex, "could not end connector session {Session} of {Provider} at the party", session.Id, session.Provider);
            outcome = (SessionDisconnectOutcome.Unreachable, null);
        }
        relay.Db.ConnectorSessions.Remove(session);
        return outcome;
    }

    private async Task ForgetAsync(List<ConnectorAccountRef> refs, CancellationToken ct)
    {
        if (refs.Count == 0) return;
        var ids = refs.Select(r => r.Id).ToList();
        relay.Db.ConnectorPendingTxs.RemoveRange(await relay.Db.ConnectorPendingTxs.Where(p => ids.Contains(p.AccountRefId)).ToListAsync(ct));
        relay.Db.ConnectorAccountRefs.RemoveRange(refs);
        await relay.Db.SaveChangesAsync(ct);
    }
}
