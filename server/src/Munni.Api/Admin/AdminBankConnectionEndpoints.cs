using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Connectors;
using Munni.Api.Data;

namespace Munni.Api.Admin;

/// <summary>
/// One connector session as the operator sees it (user 2026-10-09): ids
/// and state, the scheduler's last word, whether the relay keeps a bundle
/// for it, how many accounts the connection reached — never the bundle,
/// never an IBAN (those stay in the feed). <c>Stale</c> marks the rows
/// nothing fetches any more, the ones to clear.
/// </summary>
public sealed record AdminConnectorSessionDetailDto(
    string SessionId,
    string Provider,
    string ConnectionId,
    string State,
    string? Label,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt,
    bool KeptBundle,
    DateTimeOffset? LastScheduledSyncAt,
    string? LastScheduleError,
    DateTimeOffset? ScheduleNotBefore,
    int Accounts,
    bool Stale);

/// <summary>A session on the Bank connections dashboard: the detail above with the person it belongs to.</summary>
public sealed record AdminBankConnectionDto(
    string SessionId,
    string UserSub,
    string UserName,
    string Provider,
    string ConnectionId,
    string State,
    string? Label,
    DateTimeOffset CreatedAt,
    DateTimeOffset LastSeenAt,
    bool KeptBundle,
    DateTimeOffset? LastScheduledSyncAt,
    string? LastScheduleError,
    DateTimeOffset? ScheduleNotBefore,
    int Accounts,
    bool Stale);

/// <summary>What a disconnect came to: the party's side and what was forgotten here (see <see cref="SessionDisconnectOutcome"/>).</summary>
public sealed record AdminDisconnectDto(string SessionId, string Provider, string ConnectionId, string Party, string? PartyError, int AccountsForgotten);

/// <summary>
/// The Bank connections dashboard (user 2026-10-09: "I can't find any more
/// where I could see all the connections made so far with Enable Banking
/// and GoCardless … build it for Enable Banking too so we can disconnect
/// those from there"). The api's own open-banking tables went with #414;
/// what is left is the relay's binding table, one row per connection and
/// party, which the Users diagnosis showed one user at a time. This lists
/// every open-banking session across users — every party on request — and
/// ends one the way the person's own hub would: at the control plane with
/// the consent it keeps, the binding and its account references forgotten.
/// </summary>
public static class AdminBankConnectionEndpoints
{
    public const string Path = "/bank-connections";

    /// <summary>More rows than an operator reads on one page; the list says when it was cut.</summary>
    public const int Cap = 500;

    public const string ErrorUnavailable = "connectors-unavailable";

    /// <summary>The mock banks of a development environment play an open-banking party in this listing.</summary>
    private const string MockBankPrefix = "mock-bank-";

    public static void Map(RouteGroupBuilder admin)
    {
        admin.MapGet(Path, List);
        admin.MapDelete(Path + "/{sessionId}", Disconnect);
    }

    /// <summary>An open-banking party (§15: GoCardless, Enable Banking) — or a mock bank standing in for one.</summary>
    public static bool IsOpenBankingParty(string provider) =>
        ConnectorIngest.OpenBankingProviders.Contains(provider) || provider.StartsWith(MockBankPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Nothing will fetch this row again by itself: it is not active and the
    /// relay keeps no bundle for the scheduler (a consent the bank ended loses
    /// its bundle with <c>needs_reauth</c>; a failed or questioning sign-in
    /// never had one). An active row without a bundle is a device's own
    /// (client custody) and is left alone.
    /// </summary>
    public static bool IsStale(ConnectorSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        return session.State != "active" && session.KeptBundle is null;
    }

    /// <summary>Every open-banking session, or every party's with <c>?all=true</c>, grouped by person; at most <see cref="Cap"/> rows.</summary>
    private static async Task<IResult> List(AppDbContext db, bool all = false)
    {
        var sessions = await db.ConnectorSessions.OrderBy(s => s.CreatedAt).ToListAsync();
        if (!all) sessions = sessions.Where(s => IsOpenBankingParty(s.Provider)).ToList();
        var total = sessions.Count;
        sessions = sessions.Take(Cap).ToList();

        var userIds = sessions.Select(s => s.UserId).Distinct().ToList();
        var users = await db.Users.Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id);
        var accounts = await AccountCountsAsync(db, userIds);

        var rows = sessions
            .Select(s =>
            {
                var user = users.GetValueOrDefault(s.UserId);
                return new AdminBankConnectionDto(
                    s.Id, user?.Sub ?? s.UserId.ToString(), NameOf(user, s.UserId), s.Provider, s.ConnectionId, s.State, s.Label,
                    s.CreatedAt, s.LastSeenAt, s.KeptBundle is not null, s.LastScheduledSyncAt, s.LastScheduleError, s.ScheduleNotBefore,
                    accounts.GetValueOrDefault((s.UserId, s.Provider, s.ConnectionId)), IsStale(s));
            })
            .OrderBy(r => r.UserName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r.CreatedAt)
            .ToList();
        return Results.Ok(new { all, total, capped = total > Cap, connections = rows });
    }

    /// <summary>
    /// Ends one session: at the control plane (best effort — a party that is
    /// away cannot keep a row an operator asked to be rid of), then the
    /// binding and the account references it made. The answer says what the
    /// party did. 503 where this environment runs no connectors.
    /// </summary>
    private static async Task<IResult> Disconnect(string sessionId, HttpContext http, CancellationToken ct)
    {
        var disconnector = http.RequestServices.GetService<ConnectorDisconnector>();
        if (disconnector is null) return Results.Json(new { error = ErrorUnavailable }, statusCode: StatusCodes.Status503ServiceUnavailable);

        var db = http.RequestServices.GetRequiredService<AppDbContext>();
        var session = await db.ConnectorSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null) return Results.NotFound();

        var outcome = await disconnector.DisconnectSessionAsync(session.Id, ct) ?? new SessionDisconnectOutcome(SessionDisconnectOutcome.Gone, null, 0);
        var logger = http.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AdminBankConnectionEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            // the row's own values, never the route's: the operator and the session are what the log names
            logger.LogInformation("operator {Operator} disconnected connector session {Session} of {Provider}: party {Party}, {Accounts} account references forgotten",
                http.GetUserId(), session.Id, session.Provider, outcome.Party, outcome.AccountsForgotten);
        }
        return Results.Ok(new AdminDisconnectDto(session.Id, session.Provider, session.ConnectionId, outcome.Party, outcome.PartyError, outcome.AccountsForgotten));
    }

    /// <summary>One user's sessions, detailed — the Users diagnosis lists these.</summary>
    internal static async Task<List<AdminConnectorSessionDetailDto>> SessionsOfAsync(AppDbContext db, Guid userId)
    {
        var sessions = await db.ConnectorSessions.Where(s => s.UserId == userId).OrderBy(s => s.CreatedAt).ToListAsync();
        var accounts = await AccountCountsAsync(db, [userId]);
        return sessions
            .Select(s => new AdminConnectorSessionDetailDto(
                s.Id, s.Provider, s.ConnectionId, s.State, s.Label, s.CreatedAt, s.LastSeenAt, s.KeptBundle is not null,
                s.LastScheduledSyncAt, s.LastScheduleError, s.ScheduleNotBefore,
                accounts.GetValueOrDefault((s.UserId, s.Provider, s.ConnectionId)), IsStale(s)))
            .ToList();
    }

    /// <summary>How many accounts each connection reached, by (user, party, connection) — a count, never the references themselves.</summary>
    private static async Task<Dictionary<(Guid UserId, string Provider, string ConnectionId), int>> AccountCountsAsync(AppDbContext db, List<Guid> userIds)
    {
        var refs = await db.ConnectorAccountRefs
            .Where(a => userIds.Contains(a.UserId) && a.ConnectionId != null)
            .Select(a => new { a.UserId, a.Provider, a.ConnectionId })
            .ToListAsync();
        return refs
            .GroupBy(a => (a.UserId, a.Provider, ConnectionId: a.ConnectionId!))
            .ToDictionary(g => g.Key, g => g.Count());
    }

    /// <summary>The name the Users list shows: display name, else e-mail, else the sub — a deleted user keeps a readable id.</summary>
    private static string NameOf(User? user, Guid userId) =>
        user?.DisplayName ?? user?.Email ?? user?.Sub ?? userId.ToString();
}
