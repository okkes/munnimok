using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Data;
using Munni.Api.Push;
using Munni.Api.Social;
using Xunit;

namespace Munni.Api.Tests;

public class PushTests : IClassFixture<SyncApiFactory>
{
    private readonly SyncApiFactory _factory;

    public PushTests(SyncApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        return client;
    }

    [Fact]
    public async Task Subscribe_upserts_by_endpoint_and_unsubscribe_removes()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var client = ClientFor($"push-{suffix}");
        var endpoint = $"https://push.example/{suffix}";

        var create = await client.PostAsJsonAsync("/me/push-subscriptions", new SubscribeRequest(endpoint, "p256", "auth1"));
        Assert.True(create.IsSuccessStatusCode);
        // same endpoint again with rotated keys -> updated, not duplicated
        await client.PostAsJsonAsync("/me/push-subscriptions", new SubscribeRequest(endpoint, "p256-rotated", "auth2"));

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var row = Assert.Single(await db.PushSubscriptions.Where(s => s.Endpoint == endpoint).ToListAsync());
            Assert.Equal("p256-rotated", row.P256dh);
        }

        Assert.True((await client.DeleteAsync($"/me/push-subscriptions?endpoint={Uri.EscapeDataString(endpoint)}")).IsSuccessStatusCode);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Empty(await db.PushSubscriptions.Where(s => s.Endpoint == endpoint).ToListAsync());
        }
    }

    [Fact]
    public async Task Subscribe_rejects_non_https_endpoints()
    {
        var client = ClientFor($"push-bad-{Guid.NewGuid():N}");
        var response = await client.PostAsJsonAsync("/me/push-subscriptions",
            new SubscribeRequest("http://insecure.example/x", "p", "a"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    private sealed class FakeSender : IPushSender
    {
        public List<(Guid UserId, string Payload)> Sent { get; } = [];
        public HashSet<string> DeadEndpoints { get; } = [];

        public Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
        {
            if (DeadEndpoints.Contains(subscription.Endpoint)) return Task.FromResult(false);
            Sent.Add((subscription.UserId, payload));
            return Task.FromResult(true);
        }
    }

    [Fact]
    public async Task Notifier_sends_to_all_members_and_prunes_dead_subscriptions()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var spaceId = $"space_push_{suffix}";
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var userA = new User { Id = Guid.NewGuid(), Sub = $"pa-{suffix}" };
        var userB = new User { Id = Guid.NewGuid(), Sub = $"pb-{suffix}" };
        db.Users.AddRange(userA, userB);
        db.Spaces.Add(new Space { Id = spaceId });
        db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = userA.Id, Role = SpaceRoles.Owner });
        db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = userB.Id, Role = SpaceRoles.Reader });
        db.PushSubscriptions.Add(new PushSubscriptionRow { Id = Guid.NewGuid(), UserId = userA.Id, Endpoint = $"https://p/{suffix}/a", P256dh = "k", Auth = "a" });
        db.PushSubscriptions.Add(new PushSubscriptionRow { Id = Guid.NewGuid(), UserId = userB.Id, Endpoint = $"https://p/{suffix}/b-dead", P256dh = "k", Auth = "a" });
        await db.SaveChangesAsync();

        var sender = new FakeSender();
        sender.DeadEndpoints.Add($"https://p/{suffix}/b-dead");
        await new PushNotifier(db, sender, NullLogger<PushNotifier>.Instance)
            .NotifyNewTransactionsAsync(spaceId, 3, CancellationToken.None);

        var sent = Assert.Single(sender.Sent);
        Assert.Equal(userA.Id, sent.UserId);
        Assert.Contains("\"count\":3", sent.Payload);
        Assert.Contains(spaceId, sent.Payload);
        // dead subscription pruned
        Assert.Empty(await db.PushSubscriptions.Where(s => s.UserId == userB.Id).ToListAsync());
    }
}
