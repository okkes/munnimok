using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Social;
using Munni.Api.Sync;

namespace Munni.Api.Tests;

/// <summary>
/// #615: a space its owner deleted is erased at once, for everyone, and its id is never used again.
/// </summary>
public class SpaceErasureTests : IClassFixture<SyncApiFactory>
{
    private readonly SyncApiFactory _factory;

    public SpaceErasureTests(SyncApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static async Task<Guid> UserIdOf(HttpClient client) => (await client.GetFromJsonAsync<MeResponse>("/me"))!.UserId;

    private static SyncOpDto Row(string spaceId, string entity, string entityId, string hlc, string name = "x") =>
        new(Guid.NewGuid().ToString(), spaceId, entity, entityId, new() { ["name"] = JsonSerializer.SerializeToElement(name) }, hlc);

    private static SyncOpDto DeleteSpace(string spaceId, string hlc) =>
        new(Guid.NewGuid().ToString(), spaceId, "space", spaceId, new(), hlc, Deleted: true);

    private static Task<HttpResponseMessage> Push(HttpClient client, string spaceId, params SyncOpDto[] ops) =>
        client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev", [.. ops]));

    private async Task InDb(Func<AppDbContext, Task> work)
    {
        using var scope = _factory.Services.CreateScope();
        await work(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private static async Task<string?> ErrorOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetString();

    /// <summary>alice's space with bob in it as a contributor: its own row and one category</summary>
    private async Task<(string SpaceId, HttpClient Alice, HttpClient Bob, Guid BobId)> SharedSpaceAsync(string tag)
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var alice = ClientFor($"alice-{tag}");
        var bob = ClientFor($"bob-{tag}");
        var bobId = await UserIdOf(bob);
        Assert.True((await Push(alice, spaceId, Row(spaceId, "space", spaceId, "000000100-0000-devA", "Trip"), Row(spaceId, "category", "c1", "000000101-0000-devA"))).IsSuccessStatusCode);
        await InDb(async db =>
        {
            db.SpaceMembers.Add(new SpaceMember { SpaceId = spaceId, UserId = bobId, Role = SpaceRoles.Contributor });
            await db.SaveChangesAsync();
        });
        return (spaceId, alice, bob, bobId);
    }

    [Fact]
    public async Task An_owners_delete_erases_the_space_for_everyone_and_its_id_is_never_born_again()
    {
        var (spaceId, alice, bob, bobId) = await SharedSpaceAsync("erase");
        var aliceId = await UserIdOf(alice);
        var friendship = Guid.NewGuid();
        await InDb(async db =>
        {
            db.SpaceAccountLinks.Add(new SpaceAccountLink { SpaceId = spaceId, FeedSpaceId = "feed-1", AccountId = "acc-1", AttachedBy = aliceId, HistoryFrom = "2026-01-01", Type = "checking" });
            db.SpaceInvites.Add(new SpaceInvite { SpaceId = spaceId, FromUserId = aliceId, ToUserId = Guid.NewGuid(), Role = "member", Status = "pending" });
            db.Friendships.Add(new Friendship { Id = friendship, UserAId = aliceId, UserBId = Guid.NewGuid(), RequestedBy = aliceId, Status = "pending", SpaceId = spaceId, SpaceRole = "member", SpaceName = "Trip" });
            db.SplitMembers.Add(new SplitMember { SplitId = $"split-{spaceId}", UserId = aliceId, Role = "owner", AttachedSpaceId = spaceId, AttachedEventId = "ev-1" });
            db.SplitEntries.Add(new SplitEntry { Id = $"entry-{spaceId}", SplitId = $"split-{spaceId}", PaidByUserId = aliceId, Description = "Dinner", Date = "2026-11-01", SharesJson = "[]", SourceSpaceId = spaceId, SourceTxId = "tx-1" });
            await db.SaveChangesAsync();
        });

        var deleted = await Push(alice, spaceId, DeleteSpace(spaceId, "000000200-0000-devA"));
        Assert.True(deleted.IsSuccessStatusCode, await deleted.Content.ReadAsStringAsync());
        Assert.Equal(1, (await deleted.Content.ReadFromJsonAsync<PushResponse>())!.Accepted);

        await InDb(async db =>
        {
            Assert.False(await db.Spaces.AnyAsync(s => s.Id == spaceId));
            Assert.False(await db.EntityRows.AnyAsync(r => r.SpaceId == spaceId));
            Assert.False(await db.SyncOps.AnyAsync(o => o.SpaceId == spaceId));
            Assert.False(await db.SpaceMembers.AnyAsync(m => m.SpaceId == spaceId));
            Assert.False(await db.SpaceAccountLinks.AnyAsync(l => l.SpaceId == spaceId));
            Assert.False(await db.SpaceInvites.AnyAsync(i => i.SpaceId == spaceId));
            Assert.True(await db.ErasedSpaces.AnyAsync(e => e.SpaceId == spaceId));
            // what pointed at the space from outside stays, without the pointer
            var request = await db.Friendships.SingleAsync(f => f.Id == friendship);
            Assert.Null(request.SpaceId);
            Assert.Null(request.SpaceName);
            var wired = await db.SplitMembers.SingleAsync(m => m.SplitId == $"split-{spaceId}");
            Assert.Null(wired.AttachedSpaceId);
            Assert.Null(wired.AttachedEventId);
            var entry = await db.SplitEntries.SingleAsync(e => e.Id == $"entry-{spaceId}");
            Assert.Null(entry.SourceSpaceId);
            Assert.Null(entry.SourceTxId);
        });

        // nobody is told to sync it any more
        Assert.DoesNotContain((await alice.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!, h => h.SpaceId == spaceId);
        Assert.DoesNotContain((await bob.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!, h => h.SpaceId == spaceId);
        Assert.DoesNotContain(spaceId, (await bob.GetFromJsonAsync<List<string>>("/me/spaces"))!);

        // a device that still holds it is told it is gone, by every door — and its push does not bring it back
        var pull = await bob.GetAsync($"/sync/{spaceId}/pull?since=0");
        Assert.Equal(HttpStatusCode.Forbidden, pull.StatusCode);
        Assert.Equal(SpaceErasure.GoneError, await ErrorOf(pull));
        Assert.Equal(SpaceErasure.GoneError, await ErrorOf(await alice.GetAsync($"/sync/{spaceId}/bootstrap")));
        var straggler = await Push(bob, spaceId, Row(spaceId, "category", "c2", "000000300-0000-devB"));
        Assert.Equal(HttpStatusCode.Forbidden, straggler.StatusCode);
        Assert.Equal(SpaceErasure.GoneError, await ErrorOf(straggler));
        await InDb(async db =>
        {
            Assert.False(await db.Spaces.AnyAsync(s => s.Id == spaceId));
            Assert.False(await db.SpaceMembers.AnyAsync(m => m.UserId == bobId && m.SpaceId == spaceId));
        });
    }

    [Fact]
    public async Task Only_an_owner_deletes_a_space_and_an_edit_after_the_delete_keeps_it()
    {
        var (spaceId, alice, bob, _) = await SharedSpaceAsync("keep");

        // a contributor's delete is not applied; what else that push carried is
        var byBob = await Push(bob, spaceId, DeleteSpace(spaceId, "000000200-0000-devB"), Row(spaceId, "category", "c2", "000000201-0000-devB"));
        Assert.True(byBob.IsSuccessStatusCode);
        Assert.Equal(1, (await byBob.Content.ReadFromJsonAsync<PushResponse>())!.Accepted);
        await InDb(async db =>
        {
            Assert.False((await db.EntityRows.SingleAsync(r => r.SpaceId == spaceId && r.Entity == "space")).Deleted);
            Assert.True(await db.EntityRows.AnyAsync(r => r.SpaceId == spaceId && r.EntityId == "c2"));
        });

        // the owner's delete arrives after a newer edit of the space: by the merge's rule the space lives
        Assert.True((await Push(alice, spaceId, Row(spaceId, "space", spaceId, "000000400-0000-devA", "Trip 2"))).IsSuccessStatusCode);
        Assert.True((await Push(alice, spaceId, DeleteSpace(spaceId, "000000300-0000-devC"))).IsSuccessStatusCode);
        await InDb(async db =>
        {
            Assert.True(await db.Spaces.AnyAsync(s => s.Id == spaceId));
            Assert.False(await db.ErasedSpaces.AnyAsync(e => e.SpaceId == spaceId));
        });
        Assert.Contains((await bob.GetFromJsonAsync<List<SpaceHead>>("/sync/heads"))!, h => h.SpaceId == spaceId);
    }

    [Fact]
    public async Task Every_start_erases_the_spaces_deleted_before_and_finishes_an_erase_cut_short()
    {
        await using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"erasure-{Guid.NewGuid():N}").Options);
        var owner = Guid.NewGuid();
        var contributor = Guid.NewGuid();
        // how a deleted space stood before: a tombstone on its own row, everything else in place
        void Deleted(string id, Guid author)
        {
            db.Spaces.Add(new Space { Id = id, LastSeq = 2 });
            db.SpaceMembers.Add(new SpaceMember { SpaceId = id, UserId = owner, Role = SpaceRoles.Owner });
            db.SpaceMembers.Add(new SpaceMember { SpaceId = id, UserId = contributor, Role = SpaceRoles.Contributor });
            db.EntityRows.Add(new EntityRow { SpaceId = id, Entity = "space", EntityId = id, Deleted = true, DataJson = "{}", FieldVersionsJson = "{}" });
            db.EntityRows.Add(new EntityRow { SpaceId = id, Entity = "category", EntityId = "c1", DataJson = "{}", FieldVersionsJson = "{}" });
            db.SyncOps.Add(new SyncOpRow { SpaceId = id, Seq = 1, OpId = $"{id}-1", UserId = owner, Entity = "category", EntityId = "c1", Hlc = "1", PayloadJson = "{}" });
            db.SyncOps.Add(new SyncOpRow { SpaceId = id, Seq = 2, OpId = $"{id}-2", UserId = author, Entity = "space", EntityId = id, Hlc = "2", PayloadJson = "{}", Deleted = true });
            db.SpaceAccountLinks.Add(new SpaceAccountLink { SpaceId = id, FeedSpaceId = $"feed-{id}", AccountId = "a", AttachedBy = owner, HistoryFrom = "2026-01-01", Type = "checking" });
        }
        Deleted("by-owner", owner);
        Deleted("by-contributor", contributor);
        // a space that lives, and one whose erase stopped after it was taken out of reach
        db.Spaces.Add(new Space { Id = "alive", LastSeq = 1 });
        db.SpaceMembers.Add(new SpaceMember { SpaceId = "alive", UserId = owner, Role = SpaceRoles.Owner });
        db.EntityRows.Add(new EntityRow { SpaceId = "alive", Entity = "space", EntityId = "alive", DataJson = "{}", FieldVersionsJson = "{}" });
        db.ErasedSpaces.Add(new ErasedSpace { SpaceId = "cut-short" });
        db.Spaces.Add(new Space { Id = "cut-short", LastSeq = 1 });
        db.EntityRows.Add(new EntityRow { SpaceId = "cut-short", Entity = "category", EntityId = "c1", DataJson = "{}", FieldVersionsJson = "{}" });
        await db.SaveChangesAsync();

        Assert.Equal(2, await SpaceErasure.SweepAsync(db, NullLogger.Instance, CancellationToken.None));

        Assert.Equal(["alive", "by-contributor"], await db.Spaces.Select(s => s.Id).OrderBy(id => id).ToListAsync());
        Assert.Equal(["alive", "by-contributor"], await db.EntityRows.Select(r => r.SpaceId).Distinct().OrderBy(id => id).ToListAsync());
        Assert.Equal(["by-contributor"], await db.SyncOps.Select(o => o.SpaceId).Distinct().ToListAsync());
        Assert.Equal(["by-contributor"], await db.SpaceAccountLinks.Select(l => l.SpaceId).ToListAsync());
        Assert.False(await db.SpaceMembers.AnyAsync(m => m.SpaceId == "by-owner"));
        Assert.Equal(["by-owner", "cut-short"], await db.ErasedSpaces.Select(e => e.SpaceId).OrderBy(id => id).ToListAsync());
        // nothing left to do the next time
        Assert.Equal(0, await SpaceErasure.SweepAsync(db, NullLogger.Instance, CancellationToken.None));
    }
}
