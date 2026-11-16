using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Validation;

namespace Munni.Api.Push;

/// <summary>Kind "webpush" (default): endpoint+keys. Kind "fcm": the device token rides Endpoint, keys stay null.</summary>
public sealed record SubscribeRequest(string Endpoint, string? P256dh = null, string? Auth = null, string Kind = "webpush", string? Lang = null);

public sealed record SpaceNotifyRequest(bool On);

/// <summary>#580: the moment up to which the caller cleared their in-app notifications on one device.
/// #614: with <c>Scopes</c> ("general", a space id) only those parts of the list; without, the whole list.</summary>
public sealed record NotificationsClearedRequest(DateTimeOffset ClearedAt, IReadOnlyList<string>? Scopes = null);

/// <summary>#614: the moments per part of the list, kept as one JSON map on the user's row.</summary>
public static class ClearedScopes
{
    public const int MaxPerRequest = 20;

    /// a person in dozens of spaces fits; the oldest moments go first
    private const int MaxKept = 100;

    private static readonly System.Text.RegularExpressions.Regex Name =
        new("^[A-Za-z0-9_:.-]{1,64}$", System.Text.RegularExpressions.RegexOptions.None, TimeSpan.FromMilliseconds(100));

    public static bool Valid(IReadOnlyList<string> scopes) => scopes.Count is > 0 and <= MaxPerRequest && scopes.All(Name.IsMatch);

    public static Dictionary<string, DateTimeOffset> Read(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return [];
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, DateTimeOffset>>(stored) ?? [];
        }
        catch (System.Text.Json.JsonException)
        {
            // an unreadable map is an empty one: the next clear writes a good one
            return [];
        }
    }

    /// each moment only moves forward; null when nothing moved
    public static string? Moved(string? stored, IReadOnlyList<string> scopes, DateTimeOffset at)
    {
        var map = Read(stored);
        var moved = false;
        foreach (var scope in scopes)
        {
            if (map.TryGetValue(scope, out var held) && held >= at) continue;
            map[scope] = at;
            moved = true;
        }
        if (!moved) return null;
        var kept = map.OrderByDescending(pair => pair.Value).Take(MaxKept).ToDictionary(pair => pair.Key, pair => pair.Value);
        return System.Text.Json.JsonSerializer.Serialize(kept);
    }
}

public static class PushEndpoints
{
    public static void MapPush(this IEndpointRouteBuilder app)
    {
        MapSpaceNotifications(app);
        MapNotificationsCleared(app);
        var group = app.MapGroup("/me/push-subscriptions").RequireAuthorization();

        group.MapPost("", async (SubscribeRequest request, AppDbContext db, HttpContext http) =>
        {
            var me = http.GetUserId();
            var existing = await db.PushSubscriptions.FirstOrDefaultAsync(s => s.Endpoint == request.Endpoint);
            if (existing is null)
            {
                db.PushSubscriptions.Add(new PushSubscriptionRow
                {
                    Id = Guid.NewGuid(),
                    UserId = me,
                    Kind = request.Kind,
                    Endpoint = request.Endpoint,
                    P256dh = request.P256dh,
                    Auth = request.Auth,
                    Lang = request.Lang ?? "en",
                });
            }
            else
            {
                // browser rotated keys for the same endpoint, or device changed hands
                existing.UserId = me;
                existing.Kind = request.Kind;
                existing.P256dh = request.P256dh;
                existing.Auth = request.Auth;
                existing.Lang = request.Lang ?? existing.Lang;
            }
            await db.SaveChangesAsync();
            return Results.Ok();
        }).WithValidation<SubscribeRequest>();

        // the Settings "Send a test notification": every registered device of the caller gets one.
        // the space it was sent from rides along
        group.MapPost("/test", async (string? spaceId, PushNotifier notifier, HttpContext http, CancellationToken ct) =>
            Results.Ok(new { sent = await notifier.NotifyTestAsync(http.GetUserId(), spaceId, ct) }));

        // endpoint passed as query param: DELETE bodies are unreliable across proxies
        group.MapDelete("", async (string endpoint, AppDbContext db, HttpContext http) =>
        {
            if (string.IsNullOrEmpty(endpoint) || endpoint.Length > 2048) return Results.BadRequest();
            var me = http.GetUserId();
            var subscription = await db.PushSubscriptions
                .FirstOrDefaultAsync(s => s.Endpoint == endpoint && s.UserId == me);
            if (subscription is not null)
            {
                db.PushSubscriptions.Remove(subscription);
                await db.SaveChangesAsync();
            }
            return Results.Ok();
        });
    }

    /// <summary>#549: notifications are chosen per space and per person, on every device of theirs — the list
    /// names the spaces switched off, everything else notifies.</summary>
    private static void MapSpaceNotifications(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/me/space-notifications").RequireAuthorization().WithSafeRouteParams();

        group.MapGet("", async (AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var me = http.GetUserId();
            var off = await db.SpaceMembers.Where(m => m.UserId == me && !m.Notify).Select(m => m.SpaceId).ToListAsync(ct);
            return Results.Ok(new { off });
        });

        group.MapPut("/{spaceId}", async (string spaceId, SpaceNotifyRequest request, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var me = http.GetUserId();
            var member = await db.SpaceMembers.FirstOrDefaultAsync(m => m.SpaceId == spaceId && m.UserId == me, ct);
            if (member is null) return Results.NotFound();
            member.Notify = request.On;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { spaceId, on = member.Notify });
        });
    }

    /// <summary>#580: clearing the in-app notifications on one device clears them on the others — they read the
    /// moment and drop what came before it.</summary>
    private static void MapNotificationsCleared(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/me/notifications").RequireAuthorization();

        group.MapGet("/cleared", async (AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            var user = await db.Users.FindAsync([http.GetUserId()], ct);
            return Results.Ok(new { clearedAt = user?.NotificationsClearedAt, scopes = ClearedScopes.Read(user?.NotificationsClearedScopes) });
        });

        group.MapPut("/cleared", async (NotificationsClearedRequest request, AppDbContext db, HttpContext http, CancellationToken ct) =>
        {
            if (request.Scopes is not null && !ClearedScopes.Valid(request.Scopes)) return Results.BadRequest(new { error = "scopes" });
            var user = await db.Users.FindAsync([http.GetUserId()], ct);
            if (user is null) return Results.NotFound();
            // the moment only moves forward (a late device never brings old notifications back), and never past the
            // server's clock — a device running ahead would otherwise hide what arrives after it
            var now = DateTimeOffset.UtcNow;
            // postgres refuses a timestamptz that is not at offset zero
            var asked = request.ClearedAt.ToUniversalTime();
            var at = asked > now ? now : asked;
            if (request.Scopes is not null)
            {
                // #614: a part of the list (what the bell showed) — the whole-list moment stays where it is
                var moved = ClearedScopes.Moved(user.NotificationsClearedScopes, request.Scopes, at);
                if (moved is not null)
                {
                    user.NotificationsClearedScopes = moved;
                    await db.SaveChangesAsync(ct);
                }
            }
            else if (user.NotificationsClearedAt is null || at > user.NotificationsClearedAt)
            {
                user.NotificationsClearedAt = at;
                await db.SaveChangesAsync(ct);
            }
            return Results.Ok(new { clearedAt = user.NotificationsClearedAt, scopes = ClearedScopes.Read(user.NotificationsClearedScopes) });
        });
    }
}
