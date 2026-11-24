using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Sync;
using Xunit;

namespace Munni.Api.Tests;

/// <summary>#648: a space that includes a receipt feed lets its members read it; nothing is copied into the space.</summary>
public class StoreLinkEndpointsTests : IClassFixture<FeedsApiFactory>
{
    private readonly FeedsApiFactory _factory;

    public StoreLinkEndpointsTests(FeedsApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static string FeedId()
    {
        var g = Guid.NewGuid().ToString();
        return g[..14] + '5' + g[15..];
    }

    private static SyncOpDto Row(string spaceId, string entity, string entityId) =>
        new(Guid.NewGuid().ToString(), spaceId, entity, entityId,
            new() { ["merchant"] = JsonSerializer.SerializeToElement("Shop") }, "000000100-0000-dev");

    private async Task AddMemberAsync(string spaceId, string sub, string role)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Sub == sub);
        if (user is null)
        {
            user = new User { Id = Guid.NewGuid(), Sub = sub };
            db.Users.Add(user);
        }
        db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = user.Id, Role = role });
        await db.SaveChangesAsync();
    }

    private async Task<Guid> UserIdAsync(string sub)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return (await db.Users.FirstAsync(u => u.Sub == sub)).Id;
    }

    /// <summary>The owner's shop feed with one receipt, and a space the owner writes.</summary>
    private async Task<(string Feed, string Space, HttpClient Owner, string OwnerSub)> ShopAsync()
    {
        var feed = FeedId();
        var spaceId = $"space_{Guid.NewGuid():N}";
        var ownerSub = $"owner_{Guid.NewGuid():N}";
        var owner = ClientFor(ownerSub);
        var accountRef = "STORE:" + Guid.NewGuid().ToString("N");
        Assert.True((await owner.PostAsJsonAsync("/feeds", new RegisterFeedRequest(feed, accountRef))).IsSuccessStatusCode);
        Assert.True((await owner.PostAsJsonAsync($"/sync/{feed}/push", new PushRequest("dev1", [Row(feed, "receipt", "r1")]))).IsSuccessStatusCode);
        Assert.True((await owner.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [Row(spaceId, "space", spaceId)]))).IsSuccessStatusCode);
        return (feed, spaceId, owner, ownerSub);
    }

    [Fact]
    public async Task A_member_reads_a_feed_only_while_a_space_of_theirs_includes_it()
    {
        var (feed, spaceId, owner, _) = await ShopAsync();
        var memberSub = $"member_{Guid.NewGuid():N}";
        var member = ClientFor(memberSub);
        await AddMemberAsync(spaceId, memberSub, SpaceRoles.Contributor);

        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/sync/{feed}/pull?since=0")).StatusCode);
        Assert.DoesNotContain(feed, await member.GetFromJsonAsync<List<string>>("/me/spaces") ?? []);

        var attached = await owner.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest(feed));
        Assert.Equal(HttpStatusCode.OK, attached.StatusCode);
        // attaching again answers with the same link
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest(feed))).StatusCode);
        var listed = await member.GetFromJsonAsync<List<StoreLinkDto>>($"/spaces/{spaceId}/stores");
        Assert.Equal(feed, Assert.Single(listed!).FeedSpaceId);

        var pull = await member.GetFromJsonAsync<PullResponse>($"/sync/{feed}/pull?since=0");
        Assert.Contains(pull!.Ops, op => op.Entity == "receipt" && op.EntityId == "r1");
        Assert.Contains(feed, await member.GetFromJsonAsync<List<string>>("/me/spaces") ?? []);
        var heads = await member.GetFromJsonAsync<List<SpaceHead>>("/sync/heads");
        Assert.Equal(SpaceRoles.Reader, heads!.Single(h => h.SpaceId == feed).Role);
        // reading is all it gives: the receipts stay their owner's to write
        Assert.Equal(HttpStatusCode.Forbidden,
            (await member.PostAsJsonAsync($"/sync/{feed}/push", new PushRequest("dev2", [Row(feed, "receipt", "r2")]))).StatusCode);

        Assert.True((await member.DeleteAsync($"/spaces/{spaceId}/stores/{feed}")).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/sync/{feed}/pull?since=0")).StatusCode);
        Assert.Empty(await member.GetFromJsonAsync<List<StoreLinkDto>>($"/spaces/{spaceId}/stores") ?? []);
    }

    [Fact]
    public async Task Only_the_feeds_owner_shares_it_and_only_into_a_space_they_may_write()
    {
        var (feed, spaceId, owner, ownerSub) = await ShopAsync();
        var memberSub = $"member_{Guid.NewGuid():N}";
        var member = ClientFor(memberSub);
        await AddMemberAsync(spaceId, memberSub, SpaceRoles.Contributor);
        var stranger = ClientFor($"stranger_{Guid.NewGuid():N}");

        // a member cannot share somebody else's feed, a stranger sees nothing of the space
        Assert.Equal(HttpStatusCode.Forbidden, (await member.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest(feed))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest(feed))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.GetAsync($"/spaces/{spaceId}/stores")).StatusCode);
        // a feed id is a feed id
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest("space_plain"))).StatusCode);

        // the owner reads a space they may not write: no sharing into it
        var readOnly = $"space_{Guid.NewGuid():N}";
        var host = ClientFor($"host_{Guid.NewGuid():N}");
        Assert.True((await host.PostAsJsonAsync($"/sync/{readOnly}/push", new PushRequest("dev1", [Row(readOnly, "space", readOnly)]))).IsSuccessStatusCode);
        await AddMemberAsync(readOnly, ownerSub, SpaceRoles.Reader);
        Assert.False((await owner.PostAsJsonAsync($"/spaces/{readOnly}/stores", new AttachStoreRequest(feed))).IsSuccessStatusCode);
        Assert.Empty(await host.GetFromJsonAsync<List<StoreLinkDto>>($"/spaces/{readOnly}/stores") ?? []);
    }

    [Fact]
    public async Task The_owner_leaving_takes_the_feed_along_and_a_deleted_feed_leaves_no_link()
    {
        var (feed, spaceId, owner, ownerSub) = await ShopAsync();
        var memberSub = $"member_{Guid.NewGuid():N}";
        var member = ClientFor(memberSub);
        await AddMemberAsync(spaceId, memberSub, SpaceRoles.Contributor);
        await owner.PostAsJsonAsync($"/spaces/{spaceId}/stores", new AttachStoreRequest(feed));
        Assert.True((await member.GetAsync($"/sync/{feed}/pull?since=0")).IsSuccessStatusCode);

        Assert.True((await owner.DeleteAsync($"/spaces/{spaceId}/members/{await UserIdAsync(ownerSub)}")).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.GetAsync($"/sync/{feed}/pull?since=0")).StatusCode);
        Assert.Empty(await member.GetFromJsonAsync<List<StoreLinkDto>>($"/spaces/{spaceId}/stores") ?? []);

        // shared again elsewhere, then the feed itself goes: its link goes with it
        var (feed2, space2, owner2, _) = await ShopAsync();
        await owner2.PostAsJsonAsync($"/spaces/{space2}/stores", new AttachStoreRequest(feed2));
        Assert.True((await owner2.DeleteAsync($"/me/feeds/{feed2}")).IsSuccessStatusCode);
        Assert.Empty(await owner2.GetFromJsonAsync<List<StoreLinkDto>>($"/spaces/{space2}/stores") ?? []);
    }
}
