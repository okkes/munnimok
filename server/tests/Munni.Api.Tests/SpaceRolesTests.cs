using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Munni.Api.Accounts;
using Munni.Api.Social;
using Munni.Api.Sync;

namespace Munni.Api.Tests;

public class SpaceRolesTests : IClassFixture<SyncApiFactory>
{
    private readonly SyncApiFactory _factory;

    public SpaceRolesTests(SyncApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static async Task<Guid> UserIdOf(HttpClient client) =>
        (await client.GetFromJsonAsync<MeResponse>("/me"))!.UserId;

    private static PushRequest Push(string spaceId, string device) => new(device,
        [new SyncOpDto(Guid.NewGuid().ToString(), spaceId, "space", spaceId,
            new() { ["name"] = JsonSerializer.SerializeToElement("S") }, $"000000100-0000-{device}")]);

    private static async Task Befriend(HttpClient a, HttpClient b, Guid bId)
    {
        await a.PostAsJsonAsync("/friends/requests", new SendFriendRequest(bId));
        var pending = (await b.GetFromJsonAsync<FriendsResponse>("/friends"))!.ReceivedPending.Single();
        await b.PostAsync($"/friends/requests/{pending.Id}/accept", null);
    }

    private static async Task<string> InviteAndAccept(HttpClient owner, HttpClient invitee, string spaceId, Guid inviteeId, string role)
    {
        await owner.PostAsJsonAsync($"/spaces/{spaceId}/invites", new SendSpaceInvite(inviteeId, role, "S"));
        var invite = (await invitee.GetFromJsonAsync<List<SpaceInviteDto>>("/me/invites"))!.Single(i => i.SpaceId == spaceId);
        await invitee.PostAsync($"/spaces/invites/{invite.Id}/accept", null);
        return invite.Role;
    }

    [Fact]
    public async Task Readers_can_pull_but_never_push()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var owner = ClientFor($"owner-{suffix}");
        var reader = ClientFor($"reader-{suffix}");
        var readerId = await UserIdOf(reader);
        var spaceId = $"space_r_{suffix}";

        await owner.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devO"));
        await Befriend(owner, reader, readerId);
        Assert.Equal("reader", await InviteAndAccept(owner, reader, spaceId, readerId, "reader"));

        var pull = await reader.GetAsync($"/sync/{spaceId}/pull?since=0");
        Assert.Equal(HttpStatusCode.OK, pull.StatusCode);
        var head = (await pull.Content.ReadFromJsonAsync<PullResponse>())!.LatestSeq;
        var push = await reader.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devR"));
        Assert.Equal(HttpStatusCode.Forbidden, push.StatusCode);
        // #505: the refusal names why, and nothing landed
        Assert.Equal(SpaceRoles.ReadOnlyError, await ErrorOf(push));
        Assert.Equal(head, (await owner.GetFromJsonAsync<PullResponse>($"/sync/{spaceId}/pull?since=0"))!.LatestSeq);
    }

    /// <summary>uuid with version nibble 5 — feed-shaped, unique per call</summary>
    private static string FeedId()
    {
        var g = Guid.NewGuid().ToString();
        return g[..14] + '5' + g[15..];
    }

    /// <summary>an owner's space with a reader in it</summary>
    private async Task<(HttpClient Owner, HttpClient Reader, string SpaceId)> SpaceWithReader(string tag)
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var owner = ClientFor($"{tag}-owner-{suffix}");
        var reader = ClientFor($"{tag}-reader-{suffix}");
        var readerId = await UserIdOf(reader);
        var spaceId = $"space_{tag}_{suffix}";
        await owner.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devO"));
        await Befriend(owner, reader, readerId);
        await InviteAndAccept(owner, reader, spaceId, readerId, "reader");
        return (owner, reader, spaceId);
    }

    private static async Task<string?> ErrorOf(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(body)) return null;
        using var json = JsonDocument.Parse(body);
        return json.RootElement.TryGetProperty("error", out var error) ? error.GetString() : null;
    }

    [Fact]
    public async Task A_strangers_push_is_refused_without_the_read_only_answer()
    {
        var (_, _, spaceId) = await SpaceWithReader("st");
        var stranger = ClientFor($"stranger-{Guid.NewGuid():N}");

        var push = await stranger.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devX"));

        Assert.Equal(HttpStatusCode.Forbidden, push.StatusCode);
        Assert.Null(await ErrorOf(push));
    }

    [Fact]
    public async Task Heads_name_the_callers_role_in_each_space()
    {
        var (owner, reader, spaceId) = await SpaceWithReader("hd");
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var friend = ClientFor($"hd-friend-{suffix}");
        var friendId = await UserIdOf(friend);
        await Befriend(owner, friend, friendId);
        await InviteAndAccept(owner, friend, spaceId, friendId, "contributor");

        async Task<string> RoleOf(HttpClient who) =>
            (await who.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!.Single(h => h.SpaceId == spaceId).Role;

        Assert.Equal(SpaceRoles.Owner, await RoleOf(owner));
        Assert.Equal(SpaceRoles.Contributor, await RoleOf(friend));
        Assert.Equal(SpaceRoles.Reader, await RoleOf(reader));
    }

    [Fact]
    public async Task A_feed_reached_only_through_an_attachment_reads_as_reader_in_heads()
    {
        var (owner, reader, spaceId) = await SpaceWithReader("hf");
        var feed = FeedId();
        await owner.PostAsJsonAsync("/feeds", new RegisterFeedRequest(feed, "NL69INGB0123456789"));
        Assert.True((await owner.PostAsJsonAsync($"/spaces/{spaceId}/accounts", new AttachAccountRequest(feed, "acct1", "2026-01-01"))).IsSuccessStatusCode);

        var readers = (await reader.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!.Single(h => h.SpaceId == feed);
        var owners = (await owner.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!.Single(h => h.SpaceId == feed);

        Assert.Equal(SpaceRoles.Reader, readers.Role);
        Assert.Equal(SpaceRoles.Owner, owners.Role);
    }

    [Fact]
    public async Task Readers_can_neither_attach_nor_detach_accounts()
    {
        var (owner, reader, spaceId) = await SpaceWithReader("ad");
        var ownersFeed = FeedId();
        await owner.PostAsJsonAsync("/feeds", new RegisterFeedRequest(ownersFeed, "NL69INGB0123456789"));
        var link = await (await owner.PostAsJsonAsync($"/spaces/{spaceId}/accounts", new AttachAccountRequest(ownersFeed, "acct1", "2026-01-01")))
            .Content.ReadFromJsonAsync<AccountLinkDto>();
        var readersFeed = FeedId();
        await reader.PostAsJsonAsync("/feeds", new RegisterFeedRequest(readersFeed, "NL91ABNA0417164300"));

        var detach = await reader.DeleteAsync($"/spaces/{spaceId}/accounts/{link!.Id}");
        var attach = await reader.PostAsJsonAsync($"/spaces/{spaceId}/accounts", new AttachAccountRequest(readersFeed, "acct2", "2026-01-01"));

        Assert.Equal(HttpStatusCode.Forbidden, detach.StatusCode);
        Assert.Equal(SpaceRoles.ReadOnlyError, await ErrorOf(detach));
        Assert.Equal(HttpStatusCode.Forbidden, attach.StatusCode);
        Assert.Equal(SpaceRoles.ReadOnlyError, await ErrorOf(attach));
        var links = await owner.GetFromJsonAsync<List<AccountLinkDto>>($"/spaces/{spaceId}/accounts");
        Assert.Equal(ownersFeed, Assert.Single(links!).FeedSpaceId);
    }

    [Fact]
    public async Task Readers_cannot_manage_members_but_may_leave()
    {
        var (owner, reader, spaceId) = await SpaceWithReader("mm");
        var ownerId = await UserIdOf(owner);
        var readerId = await UserIdOf(reader);

        Assert.Equal(HttpStatusCode.Forbidden,
            (await reader.PostAsJsonAsync($"/spaces/{spaceId}/invites", new SendSpaceInvite(ownerId, "reader", "S"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.GetAsync($"/spaces/{spaceId}/invites")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await reader.PutAsJsonAsync($"/spaces/{spaceId}/members/{readerId}/role", new ChangeRoleRequest("contributor"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await reader.DeleteAsync($"/spaces/{spaceId}/members/{ownerId}")).StatusCode);

        Assert.True((await reader.DeleteAsync($"/spaces/{spaceId}/members/{readerId}")).IsSuccessStatusCode);
        var members = await owner.GetFromJsonAsync<List<MemberDto>>($"/spaces/{spaceId}/members");
        Assert.Equal(ownerId, Assert.Single(members!).UserId);
    }

    [Fact]
    public async Task Contributors_can_push()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var owner = ClientFor($"owner2-{suffix}");
        var friend = ClientFor($"friend2-{suffix}");
        var friendId = await UserIdOf(friend);
        var spaceId = $"space_m_{suffix}";

        await owner.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devO"));
        await Befriend(owner, friend, friendId);
        await InviteAndAccept(owner, friend, spaceId, friendId, "contributor");

        var members = await owner.GetFromJsonAsync<List<MemberDto>>($"/spaces/{spaceId}/members");
        Assert.Equal("contributor", members!.Single(m => m.UserId == friendId).Role);
        Assert.True((await friend.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devF"))).IsSuccessStatusCode);
    }

    [Fact]
    public async Task Ownership_transfer_and_last_owner_guard()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var owner = ClientFor($"owner3-{suffix}");
        var friend = ClientFor($"friend3-{suffix}");
        var ownerId = await UserIdOf(owner);
        var friendId = await UserIdOf(friend);
        var spaceId = $"space_t_{suffix}";

        await owner.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devO"));
        await Befriend(owner, friend, friendId);
        await InviteAndAccept(owner, friend, spaceId, friendId, "contributor");

        // sole owner cannot demote themself
        var selfDemote = await owner.PutAsJsonAsync($"/spaces/{spaceId}/members/{ownerId}/role", new ChangeRoleRequest("reader"));
        Assert.Equal(HttpStatusCode.BadRequest, selfDemote.StatusCode);

        // non-owner cannot change roles
        Assert.Equal(HttpStatusCode.Forbidden,
            (await friend.PutAsJsonAsync($"/spaces/{spaceId}/members/{friendId}/role", new ChangeRoleRequest("owner"))).StatusCode);

        // transfer: promote friend to owner, then the original owner may step down
        Assert.True((await owner.PutAsJsonAsync($"/spaces/{spaceId}/members/{friendId}/role", new ChangeRoleRequest("owner"))).IsSuccessStatusCode);
        Assert.True((await owner.PutAsJsonAsync($"/spaces/{spaceId}/members/{ownerId}/role", new ChangeRoleRequest("reader"))).IsSuccessStatusCode);

        var roles = (await friend.GetFromJsonAsync<List<MemberDto>>($"/spaces/{spaceId}/members"))!
            .ToDictionary(m => m.UserId, m => m.Role);
        Assert.Equal("owner", roles[friendId]);
        Assert.Equal("reader", roles[ownerId]);

        // invalid role rejected by validation
        Assert.Equal(HttpStatusCode.BadRequest,
            (await friend.PutAsJsonAsync($"/spaces/{spaceId}/members/{ownerId}/role", new ChangeRoleRequest("admin"))).StatusCode);
    }

    [Fact]
    public async Task Last_owner_leaving_promotes_a_successor()
    {
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var owner = ClientFor($"owner4-{suffix}");
        var friend = ClientFor($"friend4-{suffix}");
        var ownerId = await UserIdOf(owner);
        var friendId = await UserIdOf(friend);
        var spaceId = $"space_l_{suffix}";

        await owner.PostAsJsonAsync($"/sync/{spaceId}/push", Push(spaceId, "devO"));
        await Befriend(owner, friend, friendId);
        await InviteAndAccept(owner, friend, spaceId, friendId, "contributor");

        // owner leaves -> the remaining contributor becomes owner
        Assert.True((await owner.DeleteAsync($"/spaces/{spaceId}/members/{ownerId}")).IsSuccessStatusCode);
        var members = await friend.GetFromJsonAsync<List<MemberDto>>($"/spaces/{spaceId}/members");
        var only = Assert.Single(members!);
        Assert.Equal(friendId, only.UserId);
        Assert.Equal("owner", only.Role);
    }
}
