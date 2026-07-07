using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;
using WebPush;

namespace Munni.Api.Push;

/// <summary>One stored browser push subscription of a user (a device).</summary>
public class PushSubscriptionRow
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public required string Endpoint { get; set; }
    public required string P256dh { get; set; }
    public required string Auth { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Transport abstraction so tests can fake the push service.</summary>
public interface IPushSender
{
    /// <returns>false when the subscription is gone (410/404) and should be deleted</returns>
    Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct);
}

/// <summary>Used when no VAPID keys are configured — notifications silently off.</summary>
public sealed class NoopPushSender : IPushSender
{
    public Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct) =>
        Task.FromResult(true);
}

public sealed class WebPushSender(IConfiguration config) : IPushSender
{
    private readonly VapidDetails _vapid = new(
        config["Push:Subject"] ?? "mailto:admin@localhost",
        config["Push:VapidPublicKey"],
        config["Push:VapidPrivateKey"]);

    public async Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        using var client = new WebPushClient();
        try
        {
            await client.SendNotificationAsync(
                new PushSubscription(subscription.Endpoint, subscription.P256dh, subscription.Auth),
                payload, _vapid, ct);
            return true;
        }
        catch (WebPushException ex) when (ex.StatusCode is System.Net.HttpStatusCode.Gone or System.Net.HttpStatusCode.NotFound)
        {
            return false; // expired/unsubscribed — caller removes the row
        }
    }
}

/// <summary>
/// Notifies every member of a space (all their devices) that new
/// transactions arrived — the app preloads them the moment it opens.
/// </summary>
public sealed class PushNotifier(AppDbContext db, IPushSender sender, ILogger<PushNotifier> logger)
{
    public async Task NotifyNewTransactionsAsync(string spaceId, int count, CancellationToken ct)
    {
        var userIds = await db.SpaceMembers.Where(m => m.SpaceId == spaceId).Select(m => m.UserId).ToListAsync(ct);
        var subscriptions = await db.PushSubscriptions.Where(s => userIds.Contains(s.UserId)).ToListAsync(ct);
        if (subscriptions.Count == 0) return;

        var payload = JsonSerializer.Serialize(new { type = "new-transactions", spaceId, count });
        foreach (var subscription in subscriptions)
        {
            try
            {
                if (!await sender.SendAsync(subscription, payload, ct))
                {
                    db.PushSubscriptions.Remove(subscription);
                }
            }
            catch (Exception ex)
            {
                // one broken push service must not block the fetch cycle
                logger.LogWarning(ex, "push send failed for user {UserId}", subscription.UserId);
            }
        }
        await db.SaveChangesAsync(ct);
    }
}
