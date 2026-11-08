using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Data;
using WebPush;

namespace Munni.Api.Push;

/// <summary>
/// One stored push subscription of a user (a device). Web Push rows
/// carry endpoint+keys; native (fcm) rows keep the device token in
/// Endpoint and leave the keys null.
/// </summary>
public class PushSubscriptionRow
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    /// <summary>"webpush" (browser) or "fcm" (native shell device token)</summary>
    public string Kind { get; set; } = "webpush";
    public required string Endpoint { get; set; }
    public string? P256dh { get; set; }
    public string? Auth { get; set; }
    /// <summary>the device's UI language at registration — native pushes
    /// carry a visible notification block (iOS shows nothing for
    /// data-only messages when the app is closed), and its text is
    /// localized server-side per device</summary>
    public string Lang { get; set; } = "en";
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
                new PushSubscription(subscription.Endpoint, subscription.P256dh!, subscription.Auth!),
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
/// Sends Web Push notifications: sync announcements (new transactions
/// arrived — the app preloads them the moment it opens) and social
/// events (friend requests, space invites). Payloads carry raw facts;
/// the service worker localizes the visible text.
/// </summary>
public sealed class PushNotifier(AppDbContext db, IPushSender sender, ILogger<PushNotifier> logger)
{
    /// <summary>"n new transactions arrived" to the members who keep the space's notifications on (#549), the space
    /// named (#551)</summary>
    public async Task NotifyNewTransactionsAsync(string spaceId, int count, CancellationToken ct)
    {
        var userIds = await db.SpaceMembers.Where(m => m.SpaceId == spaceId && m.Notify).Select(m => m.UserId).ToListAsync(ct);
        if (userIds.Count == 0) return;
        await SendToUsersAsync(userIds, new { type = "new-transactions", spaceId, spaceName = await SpaceNameAsync(spaceId, ct), count }, ct);
    }

    /// <summary>"{fromName} sent you a friend request"</summary>
    public Task NotifyFriendRequestAsync(Guid toUserId, string? fromName, CancellationToken ct) =>
        SendToUsersAsync([toUserId], new { type = "friend-request", fromName }, ct);

    /// <summary>"{fromName} accepted your friend request"</summary>
    public Task NotifyFriendAcceptedAsync(Guid toUserId, string? fromName, CancellationToken ct) =>
        SendToUsersAsync([toUserId], new { type = "friend-accept", fromName }, ct);

    /// <summary>"{fromName} invited you to {spaceName}"</summary>
    public Task NotifySpaceInviteAsync(Guid toUserId, string? fromName, string? spaceName, CancellationToken ct) =>
        SendToUsersAsync([toUserId], new { type = "space-invite", fromName, spaceName }, ct);

    /// <summary>"{fromName} joined {spaceName}" — closes the inviter's loop, unless the space's notifications are off
    /// for them (#549); the tap opens that space's members (#551)</summary>
    public async Task NotifySpaceJoinAsync(Guid toUserId, string? fromName, string spaceId, string? spaceName, CancellationToken ct)
    {
        if (!await WantsAsync(toUserId, spaceId, ct)) return;
        await SendToUsersAsync([toUserId], new { type = "space-join", fromName, spaceId, spaceName }, ct);
    }

    /// <summary>#172/#173: "You were removed from {spaceName} by {fromName}" — to the removed member, whose choice
    /// for that space left with the membership</summary>
    public Task NotifyMemberRemovedAsync(Guid toUserId, string? spaceName, string? actorName, CancellationToken ct) =>
        SendToUsersAsync([toUserId], new { type = "member-removed", fromName = actorName, spaceName }, ct);

    /// <summary>#172: "Your role in {spaceName} is now {role}" — to the affected member, unless the space's
    /// notifications are off for them (#549)</summary>
    public async Task NotifyMemberRoleChangedAsync(Guid toUserId, string spaceId, string? spaceName, string role, CancellationToken ct)
    {
        if (!await WantsAsync(toUserId, spaceId, ct)) return;
        await SendToUsersAsync([toUserId], new { type = "member-role", spaceId, spaceName, role }, ct);
    }

    /// <summary>"Test notification" to every device of ONE user — the Settings row that proves push works end to
    /// end (user request 2026-09-28); sent from a space's settings it names that space (#551). Returns how many
    /// devices were tried.</summary>
    public async Task<int> NotifyTestAsync(Guid userId, string? spaceId, CancellationToken ct)
    {
        var member = spaceId is { Length: > 0 and <= 64 }
            && await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == userId, ct);
        return member
            ? await SendToUsersAsync([userId], new { type = "test", spaceId, spaceName = await SpaceNameAsync(spaceId!, ct) }, ct)
            : await SendToUsersAsync([userId], new { type = "test" }, ct);
    }

    private Task<bool> WantsAsync(Guid userId, string spaceId, CancellationToken ct) =>
        db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId && m.UserId == userId && m.Notify, ct);

    /// <summary>The name off the space's own materialized row (the server relays it, it never owns one); null when
    /// the row is missing or unreadable — the device then says "munni".</summary>
    private async Task<string?> SpaceNameAsync(string spaceId, CancellationToken ct)
    {
        var json = await db.EntityRows
            .Where(r => r.SpaceId == spaceId && r.Entity == "space" && r.EntityId == spaceId && !r.Deleted)
            .Select(r => r.DataJson)
            .FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var name = doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("name", out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()?.Trim()
                : null;
            // a push payload is small (web push caps it at 4 kB) — a long name is cut, never the push
            return string.IsNullOrEmpty(name) ? null : name[..Math.Min(name.Length, 80)];
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<int> SendToUsersAsync(IReadOnlyCollection<Guid> userIds, object payload, CancellationToken ct)
    {
        var subscriptions = await db.PushSubscriptions.Where(s => userIds.Contains(s.UserId)).ToListAsync(ct);
        if (subscriptions.Count == 0) return 0;

        var json = JsonSerializer.Serialize(payload);
        foreach (var subscription in subscriptions)
        {
            try
            {
                if (!await sender.SendAsync(subscription, json, ct))
                {
                    db.PushSubscriptions.Remove(subscription);
                }
            }
            catch (Exception ex)
            {
                // one broken push service must not block the caller
                logger.LogWarning(ex, "push send failed for user {UserId}", subscription.UserId);
            }
        }
        await db.SaveChangesAsync(ct);
        return subscriptions.Count;
    }
}
