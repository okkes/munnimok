using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Connectors;
using Munni.Api.Data;

namespace Munni.Api.Admin;

/// <summary>One session as the operator sees it: never the bundle, never an IBAN (those stay in the feed).</summary>
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

public sealed record AdminDisconnectDto(string SessionId, string Provider, string ConnectionId, string Party, string? PartyError, int AccountsForgotten);

public static class AdminBankConnectionEndpoints
{
    public const string Path = "/bank-connections";

    public const int Cap = 500;

    public const string ErrorUnavailable = "connectors-unavailable";

    /// <summary>The mock banks of a development environment play an open-banking party in this listing.</summary>
    private const string MockBankPrefix = "mock-bank-";

    public static void Map(RouteGroupBuilder admin)
    {
        admin.MapGet(Path, List);
        admin.MapDelete(Path + "/{sessionId}", Disconnect);
    }

    public static bool IsOpenBankingParty(string provider) =>
        ConnectorIngest.OpenBankingProviders.Contains(provider) || provider.StartsWith(MockBankPrefix, StringComparison.Ordinal);

    // stale: not active and no bundle kept for the scheduler, so nothing fetches it again.
    // an active row without a bundle is a device's own (client custody) and stays
    public static bool IsStale(ConnectorSession session)
    {
        ArgumentNullException.ThrowIfNull(session);
        return session.State != "active" && session.KeptBundle is null;
    }

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

    // best effort at the control plane: an away party cannot keep a row the operator asked to be rid of.
    // 503 without connectors
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
            logger.LogInformation("operator {Operator} disconnected connector session {Session} of {Provider}: party {Party}, {Accounts} account references forgotten",
                http.GetUserId(), session.Id, session.Provider, outcome.Party, outcome.AccountsForgotten);
        }
        return Results.Ok(new AdminDisconnectDto(session.Id, session.Provider, session.ConnectionId, outcome.Party, outcome.PartyError, outcome.AccountsForgotten));
    }

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
