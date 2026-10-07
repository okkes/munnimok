using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Auth;
using Munni.Api.Data;
using Munni.Api.Push;
using Munni.Api.Social;
using Munni.Api.Tests.Admin;

namespace Munni.Api.Tests;

/// <summary>
/// The full account-deletion pipeline (approved decisions: shared
/// spaces leave-and-archive, immediate, Logto optional). Uses the admin
/// factory: test auth + in-memory database; a bank's consent ending at
/// its party is ConnectorOpenBankingTests' walk.
/// </summary>
public class AccountDeletionTests : IClassFixture<AdminApiFactory>
{
    private readonly AdminApiFactory _factory;

    public AccountDeletionTests(AdminApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub, string? scope = null)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    private sealed class CountingHttpFactory(HttpMessageHandler? handler = null) : IHttpClientFactory
    {
        public int Created;
        public HttpClient CreateClient(string name)
        {
            Created++;
            return new HttpClient(handler ?? new HttpClientHandler(), disposeHandler: false);
        }
    }

    private static IConfiguration LogtoSettings(bool deleteIdentity = true) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Logto:DeleteIdentityOnAccountDeletion"] = deleteIdentity ? "true" : "false",
                ["Logto:M2mAppId"] = "m2m-app",
                ["Logto:M2mAppSecret"] = "m2m-secret",
                ["Auth:Authority"] = "https://logto.test/oidc",
            })
            .Build();

    [Fact]
    public async Task Identity_deletion_can_be_disabled_per_environment()
    {
        // staging shares Logto with production — with the knob off, the
        // Logto Management API must never even be contacted
        var factory = new CountingHttpFactory();
        var config = LogtoSettings(deleteIdentity: false);
        var logto = new LogtoManagement(factory, config, TimeProvider.System);
        await AccountDeletion.DeleteLogtoUserAsync(
            logto, config, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, "sub-shared");
        Assert.Equal(0, factory.Created);
    }

    [Fact]
    public async Task The_identity_goes_through_the_shared_Logto_session_minted_once()
    {
        // one minting path with the admin portal's invitations (user
        // 2026-10-07): two deletions ride one token
        var logto = new FakeLogtoHandler();
        var config = LogtoSettings();
        var management = new LogtoManagement(new CountingHttpFactory(logto), config, TimeProvider.System);
        await AccountDeletion.DeleteLogtoUserAsync(management, config, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, "sub-gone");
        await AccountDeletion.DeleteLogtoUserAsync(management, config, Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance, "sub-gone-too");
        Assert.Equal(1, logto.TokenMints);
        Assert.Contains(logto.Requests, r => r.Method == HttpMethod.Delete && r.Path == "/api/users/sub-gone" && r.Bearer == "tok-1");
        Assert.Contains(logto.Requests, r => r.Method == HttpMethod.Delete && r.Path == "/api/users/sub-gone-too" && r.Bearer == "tok-1");
    }

    private async Task<(Guid LeaverId, Guid FriendId)> SeedWorldAsync(string leaverSub, string friendSub, string prefix)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var leaver = new User { Id = Guid.NewGuid(), Sub = leaverSub };
        var friend = new User { Id = Guid.NewGuid(), Sub = friendSub };
        db.Users.AddRange(leaver, friend);

        // solo space (dies) + shared space where the leaver is the only owner
        db.Spaces.AddRange(new Space { Id = $"{prefix}-solo" }, new Space { Id = $"{prefix}-shared" });
        db.SpaceMembers.AddRange(
            new SpaceMember { SpaceId = $"{prefix}-solo", UserId = leaver.Id, Role = SpaceRoles.Owner },
            new SpaceMember { SpaceId = $"{prefix}-shared", UserId = leaver.Id, Role = SpaceRoles.Owner },
            new SpaceMember { SpaceId = $"{prefix}-shared", UserId = friend.Id, Role = SpaceRoles.Contributor });
        db.EntityRows.Add(new EntityRow { SpaceId = $"{prefix}-solo", Entity = "transaction", EntityId = "t1", DataJson = "{}", FieldVersionsJson = "{}" });
        db.SyncOps.Add(new SyncOpRow { SpaceId = $"{prefix}-solo", Seq = 1, OpId = $"{prefix}-op1", Entity = "transaction", EntityId = "t1", Hlc = "1", PayloadJson = "{}" });

        // two owned feeds: one attached to the shared space (survives),
        // one only to the solo space (dies)
        db.FeedSpaces.AddRange(
            new FeedSpace { Id = $"{prefix}-feed-shared", OwnerUserId = leaver.Id, AccountRef = "NL01" },
            new FeedSpace { Id = $"{prefix}-feed-solo", OwnerUserId = leaver.Id, AccountRef = "NL02" });
        db.Spaces.AddRange(new Space { Id = $"{prefix}-feed-shared" }, new Space { Id = $"{prefix}-feed-solo" });
        db.EntityRows.Add(new EntityRow { SpaceId = $"{prefix}-feed-shared", Entity = "transaction", EntityId = "f1", DataJson = "{}", FieldVersionsJson = "{}" });
        db.SpaceAccountLinks.AddRange(
            new SpaceAccountLink { Id = Guid.NewGuid(), SpaceId = $"{prefix}-shared", FeedSpaceId = $"{prefix}-feed-shared", AccountId = "a1", AttachedBy = leaver.Id, HistoryFrom = "2026-01-01", Type = "checking" },
            new SpaceAccountLink { Id = Guid.NewGuid(), SpaceId = $"{prefix}-solo", FeedSpaceId = $"{prefix}-feed-solo", AccountId = "a2", AttachedBy = leaver.Id, HistoryFrom = "2026-01-01", Type = "checking" });

        // push + friendship
        db.PushSubscriptions.Add(new PushSubscriptionRow
        {
            Id = Guid.NewGuid(), UserId = leaver.Id, Endpoint = $"https://push/{prefix}",
            P256dh = "k", Auth = "a", Kind = "webpush",
        });
        db.Friendships.Add(new Friendship { Id = Guid.NewGuid(), UserAId = leaver.Id, UserBId = friend.Id, Status = "accepted" });
        await db.SaveChangesAsync();
        return (leaver.Id, friend.Id);
    }

    [Fact]
    public async Task DeleteMe_ErasesSoloData_LeavesSharedBehindForOthers()
    {
        var (leaverId, friendId) = await SeedWorldAsync("del-user", "del-friend", "d1");
        var client = ClientFor("del-user");

        var response = await client.DeleteAsync("/me");
        Assert.True(response.IsSuccessStatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // the user and their solo world are gone
        Assert.False(await db.Users.AnyAsync(u => u.Id == leaverId));
        Assert.False(await db.Spaces.AnyAsync(s => s.Id == "d1-solo"));
        Assert.False(await db.EntityRows.AnyAsync(r => r.SpaceId == "d1-solo"));
        Assert.False(await db.SyncOps.AnyAsync(o => o.SpaceId == "d1-solo"));
        Assert.False(await db.FeedSpaces.AnyAsync(f => f.Id == "d1-feed-solo"));

        // the shared space survives for the friend, ownership transferred
        var friendMembership = await db.SpaceMembers.SingleAsync(m => m.SpaceId == "d1-shared");
        Assert.Equal(friendId, friendMembership.UserId);
        Assert.Equal(SpaceRoles.Owner, friendMembership.Role);
        // decision ①: the shared feed stays readable (archived link)
        Assert.True(await db.FeedSpaces.AnyAsync(f => f.Id == "d1-feed-shared"));
        Assert.True(await db.EntityRows.AnyAsync(r => r.SpaceId == "d1-feed-shared"));
        var sharedLink = await db.SpaceAccountLinks.SingleAsync(l => l.FeedSpaceId == "d1-feed-shared");
        Assert.True(sharedLink.Archived);

        // push + friendship erased
        Assert.False(await db.PushSubscriptions.AnyAsync(p => p.UserId == leaverId));
        Assert.False(await db.Friendships.AnyAsync(f => f.UserAId == leaverId || f.UserBId == leaverId));
    }

    [Fact]
    public async Task AdminDeletesAUser_ButNeverThemselves()
    {
        await SeedWorldAsync("del-target", "del-witness", "d2");
        var admin = ClientFor("the-admin", "admin");

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.DeleteAsync("/admin/users/the-admin")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync("/admin/users/no-such-sub")).StatusCode);
        Assert.True((await admin.DeleteAsync("/admin/users/del-target")).IsSuccessStatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.Users.AnyAsync(u => u.Sub == "del-target"));
        Assert.True(await db.Users.AnyAsync(u => u.Sub == "del-witness"));

        // without the admin scope the operator path is closed
        var user = ClientFor("del-witness");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync("/admin/users/del-witness")).StatusCode);
    }
}
