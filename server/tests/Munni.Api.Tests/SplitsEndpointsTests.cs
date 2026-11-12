using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Push;
using Munni.Api.Social;
using Munni.Api.Splits;

namespace Munni.Api.Tests;

/// <summary>Keeps what the API pushed, by receiver: the tests read who was told what.</summary>
internal sealed class RecordingPushSender : IPushSender
{
    public List<(Guid UserId, JsonElement Payload)> Sent { get; } = [];

    public Task<bool> SendAsync(PushSubscriptionRow subscription, string payload, CancellationToken ct)
    {
        Sent.Add((subscription.UserId, JsonDocument.Parse(payload).RootElement.Clone()));
        return Task.FromResult(true);
    }
}

public class SplitsApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databaseName = $"splits-tests-{Guid.NewGuid():N}";
    internal HandClock Clock { get; } = new(new DateTimeOffset(2026, 11, 12, 10, 0, 0, TimeSpan.Zero));
    internal RecordingPushSender Push { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType == typeof(TimeProvider) ||
                             d.ServiceType == typeof(IPushSender) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
            services.AddSingleton<TimeProvider>(Clock);
            services.AddSingleton<IPushSender>(Push);
        });
    }
}

/// <summary>
/// Split events (#538): membership is the ONLY authorization boundary —
/// someone outside gets 404 (existence itself is private) — and roles,
/// link limits, the queue, "settled" and the countdown are the server's
/// to keep. One factory per test: every test starts with nobody in it.
/// </summary>
public class SplitsEndpointsTests
{
    private readonly SplitsApiFactory _factory = new();

    private async Task<HttpClient> PersonAsync(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        // any authed request materializes the user row (test auth); a device hears what the person is told
        await client.GetAsync("/me");
        var id = await IdOf(sub);
        Write(db => db.PushSubscriptions.Add(new PushSubscriptionRow { Id = Guid.NewGuid(), UserId = id, Endpoint = $"https://push.test/{sub}" }));
        return client;
    }

    private T Read<T>(Func<AppDbContext, T> query)
    {
        using var scope = _factory.Services.CreateScope();
        return query(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    private void Write(Action<AppDbContext> change)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        change(db);
        db.SaveChanges();
    }

    private Task<Guid> IdOf(string sub) => Task.FromResult(Read(db => db.Users.Single(u => u.Sub == sub).Id));

    private static async Task CreateAsync(HttpClient owner, string id, string name = "Ski trip") =>
        Assert.True((await owner.PostAsJsonAsync("/splits", new { id, name, currency = "EUR" })).IsSuccessStatusCode);

    private static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).Clone();
    }

    private static async Task<JsonElement> DetailAsync(HttpClient client, string id) => await JsonAsync(await client.GetAsync($"/splits/{id}"));

    private static async Task<string> LinkAsync(HttpClient owner, string id, object? options = null) =>
        (await JsonAsync(await owner.PostAsJsonAsync($"/splits/{id}/invites", options ?? new { }))).GetProperty("token").GetString()!;

    private static async Task<string> UseLinkAsync(HttpClient client, string token) =>
        (await JsonAsync(await client.PostAsJsonAsync($"/splits/invites/{token}/accept", new { }))).GetProperty("state").GetString()!;

    private static async Task<HttpStatusCode> ExpenseAsync(HttpClient client, string splitId, string id, long cents, Guid? paidBy = null, object? shares = null, string? mode = null) =>
        (await client.PostAsJsonAsync($"/splits/{splitId}/entries", new { id, kind = "expense", description = id, amountCents = cents, date = "2026-11-10", paidByUserId = paidBy, shares, shareMode = mode })).StatusCode;

    private List<string> ToldTo(Guid userId) =>
        [.. _factory.Push.Sent.Where(s => s.UserId == userId && s.Payload.GetProperty("type").GetString() == "split").Select(s => s.Payload.GetProperty("kind").GetString()!)];

    [Fact]
    public async Task An_event_has_a_name_a_look_dates_and_a_currency_and_only_owners_change_them()
    {
        var owner = await PersonAsync("ev-owner");
        var guest = await PersonAsync("ev-guest");
        var stranger = await PersonAsync("ev-stranger");

        async Task<HttpStatusCode> Create(object body) => (await owner.PostAsJsonAsync("/splits", body)).StatusCode;
        Assert.Equal(HttpStatusCode.BadRequest, await Create(new { id = "bad-1", name = "", currency = "EUR" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Create(new { id = "bad-2", name = "Trip", currency = "euro" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Create(new { id = "bad-3", name = "Trip", currency = "EUR", startDate = "2026-12-20", endDate = "2026-12-10" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Create(new { id = "bad-4", name = "Trip", currency = "EUR", picture = "https://example.com/a.png" }));
        Assert.Equal(HttpStatusCode.BadRequest, await Create(new { id = "bad id", name = "Trip", currency = "EUR" }));
        Assert.Equal(HttpStatusCode.OK, await Create(new { id = "ev-1", name = " Wintersport ", currency = "EUR", picture = "/events/ski.jpg", startDate = "2026-12-20", endDate = "2026-12-27" }));
        // the same create again changes nothing (a retry after a lost answer)
        Assert.Equal(HttpStatusCode.OK, await Create(new { id = "ev-1", name = "Other", currency = "USD" }));

        var split = (await DetailAsync(owner, "ev-1")).GetProperty("split");
        Assert.Equal("Wintersport", split.GetProperty("name").GetString());
        Assert.Equal("open", split.GetProperty("status").GetString());
        Assert.Equal("owner", split.GetProperty("role").GetString());
        Assert.Equal("/events/ski.jpg", split.GetProperty("picture").GetString());
        Assert.Equal("2026-12-27", split.GetProperty("endDate").GetString());
        // existence itself is private
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync("/splits/ev-1")).StatusCode);
        Assert.Equal(0, (await JsonAsync(await stranger.GetAsync("/splits"))).GetArrayLength());

        Assert.Equal("joined", await UseLinkAsync(guest, await LinkAsync(owner, "ev-1")));
        var facts = new { name = "Wintersport 2026", currency = "CHF", picture = "data:image/jpeg;base64,/9j/4AAQ", startDate = (string?)null, endDate = (string?)null };
        Assert.Equal(HttpStatusCode.Forbidden, (await guest.PutAsJsonAsync("/splits/ev-1", facts)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.PutAsJsonAsync("/splits/ev-1", facts)).StatusCode);
        split = (await DetailAsync(guest, "ev-1")).GetProperty("split");
        Assert.Equal("Wintersport 2026", split.GetProperty("name").GetString());
        Assert.Equal("CHF", split.GetProperty("currency").GetString());
        Assert.Equal(JsonValueKind.Null, split.GetProperty("startDate").ValueKind);
        Assert.Equal("contributor", split.GetProperty("role").GetString());

        // once something was entered the currency stands; the list says what the event cost and where each stands
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(owner, "ev-1", "ev-e1", 3000));
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PutAsJsonAsync("/splits/ev-1", facts with { currency = "EUR" })).StatusCode);
        var listed = (await JsonAsync(await guest.GetAsync("/splits")))[0];
        Assert.Equal(3000, listed.GetProperty("totalCents").GetInt64());
        Assert.Equal(-1500, listed.GetProperty("myBalanceCents").GetInt64());
        Assert.Equal(2, listed.GetProperty("memberCount").GetInt32());
    }

    [Fact]
    public async Task A_link_lets_in_as_many_as_its_owner_said_until_the_day_they_said()
    {
        var owner = await PersonAsync("ln-owner");
        var first = await PersonAsync("ln-first");
        var second = await PersonAsync("ln-second");
        await CreateAsync(owner, "ln-1");

        // nobody made a link yet; reading one never makes one
        Assert.Equal(JsonValueKind.Null, (await JsonAsync(await owner.GetAsync("/splits/ln-1/invites"))).GetProperty("token").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/splits/ln-1/invites", new { maxUses = -1 })).StatusCode);

        var once = await LinkAsync(owner, "ln-1", new { maxUses = 1 });
        var peek = await JsonAsync(await first.GetAsync($"/splits/invites/{once}"));
        Assert.Equal("Ski trip", peek.GetProperty("splitName").GetString());
        Assert.False(peek.GetProperty("member").GetBoolean());
        Assert.True((await JsonAsync(await owner.GetAsync($"/splits/invites/{once}"))).GetProperty("mine").GetBoolean());
        Assert.Equal("joined", await UseLinkAsync(first, once));
        // someone already in spends no use and stays as they are …
        Assert.Equal("member", await UseLinkAsync(first, once));
        // … but the one use is spent: the link is gone for the next person, and only owners see or replace it
        Assert.Equal(HttpStatusCode.NotFound, (await second.GetAsync($"/splits/invites/{once}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await second.PostAsJsonAsync($"/splits/invites/{once}/accept", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await first.GetAsync("/splits/ln-1/invites")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await first.PostAsJsonAsync("/splits/ln-1/invites", new { })).StatusCode);

        // a link for two days works for two days; a new link ends the one before it
        var dated = await LinkAsync(owner, "ln-1", new { validDays = 2 });
        var view = await JsonAsync(await owner.GetAsync("/splits/ln-1/invites"));
        Assert.Equal(dated, view.GetProperty("token").GetString());
        Assert.Equal(0, view.GetProperty("uses").GetInt32());
        _factory.Clock.Advance(TimeSpan.FromDays(3));
        Assert.Equal(HttpStatusCode.NotFound, (await second.GetAsync($"/splits/invites/{dated}")).StatusCode);

        var open = await LinkAsync(owner, "ln-1");
        Assert.Equal(HttpStatusCode.OK, (await second.GetAsync($"/splits/invites/{open}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.DeleteAsync("/splits/ln-1/invites")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await second.GetAsync($"/splits/invites/{open}")).StatusCode);
    }

    [Fact]
    public async Task A_link_that_asks_for_approval_puts_people_in_a_queue_an_owner_answers()
    {
        var owner = await PersonAsync("q-owner");
        var member = await PersonAsync("q-member");
        var welcome = await PersonAsync("q-welcome");
        var unwanted = await PersonAsync("q-unwanted");
        await CreateAsync(owner, "q-1");
        Assert.Equal("joined", await UseLinkAsync(member, await LinkAsync(owner, "q-1")));

        var token = await LinkAsync(owner, "q-1", new { needsApproval = true });
        Assert.Equal("waiting", await UseLinkAsync(welcome, token));
        // asking twice is one place in the queue
        Assert.Equal("waiting", await UseLinkAsync(welcome, token));
        Assert.Equal("waiting", await UseLinkAsync(unwanted, token));
        Assert.True((await JsonAsync(await welcome.GetAsync($"/splits/invites/{token}"))).GetProperty("waiting").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await welcome.GetAsync("/splits/q-1")).StatusCode);
        Assert.Contains("join-request", ToldTo(await IdOf("q-owner")));

        // owners see who waits; a contributor does not, and cannot answer
        var requests = (await DetailAsync(owner, "q-1")).GetProperty("requests");
        Assert.Equal(2, requests.GetArrayLength());
        Assert.Equal(JsonValueKind.Null, (await DetailAsync(member, "q-1")).GetProperty("requests").ValueKind);
        var welcomeId = await IdOf("q-welcome");
        string RequestOf(Guid userId) => requests.EnumerateArray().First(r => r.GetProperty("userId").GetGuid() == userId).GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.Forbidden, (await member.PostAsync($"/splits/q-1/requests/{RequestOf(welcomeId)}/approve", null)).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/splits/q-1/requests/{RequestOf(welcomeId)}/approve", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/splits/q-1/requests/{RequestOf(await IdOf("q-unwanted"))}/refuse", null)).StatusCode);
        Assert.Equal("contributor", (await DetailAsync(welcome, "q-1")).GetProperty("split").GetProperty("role").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await unwanted.GetAsync("/splits/q-1")).StatusCode);
        Assert.Empty((await DetailAsync(owner, "q-1")).GetProperty("requests").EnumerateArray());
        Assert.Contains("approved", ToldTo(welcomeId));
        Assert.Contains("refused", ToldTo(await IdOf("q-unwanted")));
    }

    [Fact]
    public async Task A_friend_an_owner_asks_is_in_the_moment_they_say_yes()
    {
        var owner = await PersonAsync("fr-owner");
        var friend = await PersonAsync("fr-friend");
        var other = await PersonAsync("fr-other");
        await CreateAsync(owner, "fr-1");
        var (ownerId, friendId, otherId) = (await IdOf("fr-owner"), await IdOf("fr-friend"), await IdOf("fr-other"));
        void Befriend(Guid a, Guid b) => Write(db => db.Friendships.Add(new Friendship { Id = Guid.NewGuid(), UserAId = a < b ? a : b, UserBId = a < b ? b : a, RequestedBy = a, Status = "accepted" }));

        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = friendId })).StatusCode);
        Befriend(ownerId, friendId);
        Befriend(ownerId, otherId);
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = friendId })).StatusCode);
        // asked twice is asked once
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = friendId })).StatusCode);
        Assert.Contains("invited", ToldTo(friendId));

        var mine = await JsonAsync(await friend.GetAsync("/splits/friend-invites"));
        Assert.Equal(1, mine.GetArrayLength());
        Assert.Equal("Ski trip", mine[0].GetProperty("splitName").GetString());
        var asked = (await DetailAsync(owner, "fr-1")).GetProperty("friendInvites");
        Assert.Equal("pending", asked[0].GetProperty("status").GetString());

        // taken back before an answer: the invitee has nothing left to answer
        var inviteId = mine[0].GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.OK, (await owner.DeleteAsync($"/splits/fr-1/friend-invites/{inviteId}")).StatusCode);
        Assert.Equal(0, (await JsonAsync(await friend.GetAsync("/splits/friend-invites"))).GetArrayLength());
        Assert.Equal(HttpStatusCode.NotFound, (await friend.PostAsync($"/splits/friend-invites/{inviteId}/accept", null)).StatusCode);

        // asked again, yes: in at once, as a contributor — and nobody else can answer for them
        await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = friendId });
        inviteId = (await JsonAsync(await friend.GetAsync("/splits/friend-invites")))[0].GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/splits/friend-invites/{inviteId}/accept", null)).StatusCode);
        Assert.Equal("fr-1", (await JsonAsync(await friend.PostAsync($"/splits/friend-invites/{inviteId}/accept", null))).GetProperty("splitId").GetString());
        Assert.Equal("contributor", (await DetailAsync(friend, "fr-1")).GetProperty("split").GetProperty("role").GetString());
        Assert.Contains("invite-accepted", ToldTo(ownerId));
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = friendId })).StatusCode);

        // no: the owner sees it was declined
        await owner.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = otherId });
        inviteId = (await JsonAsync(await other.GetAsync("/splits/friend-invites")))[0].GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.OK, (await other.PostAsync($"/splits/friend-invites/{inviteId}/decline", null)).StatusCode);
        Assert.Contains((await DetailAsync(owner, "fr-1")).GetProperty("friendInvites").EnumerateArray(), i => i.GetProperty("status").GetString() == "declined");
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync("/splits/fr-1")).StatusCode);
        // a contributor asks nobody
        Assert.Equal(HttpStatusCode.Forbidden, (await friend.PostAsJsonAsync("/splits/fr-1/friend-invites", new { toUserId = otherId })).StatusCode);
    }

    [Fact]
    public async Task Owners_promote_and_take_people_out_anyone_leaves_and_the_last_owner_hands_the_event_on()
    {
        var owner = await PersonAsync("ro-owner");
        var ann = await PersonAsync("ro-ann");
        var bob = await PersonAsync("ro-bob");
        await CreateAsync(owner, "ro-1");
        var token = await LinkAsync(owner, "ro-1");
        await UseLinkAsync(ann, token);
        await UseLinkAsync(bob, token);
        var (annId, bobId, ownerId) = (await IdOf("ro-ann"), await IdOf("ro-bob"), await IdOf("ro-owner"));

        // a contributor promotes and removes nobody
        Assert.Equal(HttpStatusCode.Forbidden, (await ann.PostAsync($"/splits/ro-1/members/{bobId}/promote", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ann.DeleteAsync($"/splits/ro-1/members/{bobId}")).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync($"/splits/ro-1/members/{annId}/promote", null)).StatusCode);
        Assert.Contains("made-owner", ToldTo(annId));
        // an owner takes out a contributor and another owner alike (user), but leaves by leaving
        Assert.Equal(HttpStatusCode.BadRequest, (await ann.DeleteAsync($"/splits/ro-1/members/{annId}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ann.DeleteAsync($"/splits/ro-1/members/{bobId}")).StatusCode);
        Assert.Contains("removed", ToldTo(bobId));

        // taken out: still reads (they may owe), adds nothing, and no link brings them back
        var seen = await DetailAsync(bob, "ro-1");
        Assert.Equal("removed", seen.GetProperty("split").GetProperty("state").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, await ExpenseAsync(bob, "ro-1", "ro-e1", 1000));
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.PostAsJsonAsync($"/splits/invites/{token}/accept", new { })).StatusCode);
        Assert.Equal(2, seen.GetProperty("split").GetProperty("memberCount").GetInt32());

        // the creator leaves: Ann is an owner already, so nothing is handed on; she then leaves too and is the last —
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsync("/splits/ro-1/leave", null)).StatusCode);
        Assert.Equal("left", (await DetailAsync(owner, "ro-1")).GetProperty("split").GetProperty("state").GetString());
        Assert.True((await JsonAsync(await ann.PostAsync("/splits/ro-1/leave", null))).GetProperty("deleted").GetBoolean());
        // — the event goes with its last member
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/splits/ro-1")).StatusCode);
        Assert.Equal(0, Read(db => db.SplitMembers.Count(m => m.SplitId == "ro-1")));

        // the only owner leaves while contributors stay: everybody who stays owns it
        await CreateAsync(owner, "ro-2");
        token = await LinkAsync(owner, "ro-2");
        await UseLinkAsync(ann, token);
        await UseLinkAsync(bob, token);
        Assert.False((await JsonAsync(await owner.PostAsync("/splits/ro-2/leave", null))).GetProperty("deleted").GetBoolean());
        Assert.All(new[] { ann, bob }, async person => Assert.Equal("owner", (await DetailAsync(person, "ro-2")).GetProperty("split").GetProperty("role").GetString()));
        // someone who left comes back through a link, as a contributor
        Assert.Equal("joined", await UseLinkAsync(owner, await LinkAsync(ann, "ro-2")));
        Assert.Equal("contributor", (await DetailAsync(owner, "ro-2")).GetProperty("split").GetProperty("role").GetString());
        Assert.Equal(ownerId, Read(db => db.SplitMembers.Single(m => m.SplitId == "ro-2" && m.UserId == ownerId && m.State == "active").UserId));
    }

    [Fact]
    public async Task An_entry_is_divided_equally_by_amounts_or_by_percentages_and_changed_only_by_its_people()
    {
        var owner = await PersonAsync("en-owner");
        var ann = await PersonAsync("en-ann");
        var bob = await PersonAsync("en-bob");
        await CreateAsync(owner, "en-1");
        var token = await LinkAsync(owner, "en-1");
        await UseLinkAsync(ann, token);
        await UseLinkAsync(bob, token);
        var (ownerId, annId, bobId) = (await IdOf("en-owner"), await IdOf("en-ann"), await IdOf("en-bob"));
        JsonElement Entry(JsonElement detail, string id) => detail.GetProperty("entries").EnumerateArray().First(e => e.GetProperty("id").GetString() == id);
        long Share(JsonElement entry, Guid userId) => entry.GetProperty("shares").EnumerateArray().First(s => s.GetProperty("userId").GetGuid() == userId).GetProperty("cents").GetInt64();

        // equal among everybody when nobody is named; among the named when some are — the payer need not share
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(owner, "en-1", "en-all", 1000));
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(owner, "en-1", "en-two", 1001, ownerId, new[] { new { userId = annId }, new { userId = bobId } }, "equal"));
        // exact amounts add up to the amount; percentages to a hundred, the odd cent to the largest remainder
        Assert.Equal(HttpStatusCode.BadRequest, await ExpenseAsync(owner, "en-1", "en-short", 1000, null, new[] { new { userId = annId, cents = 400L } }, "exact"));
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(ann, "en-1", "en-exact", 1000, annId, new[] { new { userId = annId, cents = 400L }, new { userId = bobId, cents = 600L } }, "exact"));
        Assert.Equal(HttpStatusCode.BadRequest, await ExpenseAsync(owner, "en-1", "en-pct90", 1000, null, new[] { new { userId = annId, pct = 40m }, new { userId = bobId, pct = 50m } }, "percent"));
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(owner, "en-1", "en-pct", 1000, null, new[] { new { userId = ownerId, pct = 33.33m }, new { userId = annId, pct = 33.33m }, new { userId = bobId, pct = 33.34m } }, "percent"));
        // a payer or a share holder from outside, a member named twice, a day that is none
        Assert.Equal(HttpStatusCode.BadRequest, await ExpenseAsync(owner, "en-1", "en-ghost", 1000, Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.BadRequest, await ExpenseAsync(owner, "en-1", "en-twice", 1000, null, new[] { new { userId = annId }, new { userId = annId } }, "equal"));
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/splits/en-1/entries", new { id = "en-day", kind = "expense", description = "x", amountCents = 100, date = "yesterday" })).StatusCode);

        var detail = await DetailAsync(owner, "en-1");
        // three ways of a thousand: the odd cent lands on one of them, and nothing is lost
        Assert.Equal([333L, 333L, 334L], new[] { ownerId, annId, bobId }.Select(id => Share(Entry(detail, "en-all"), id)).Order());
        Assert.Equal("equal", Entry(detail, "en-two").GetProperty("shareMode").GetString());
        Assert.Equal([500L, 501L], new[] { annId, bobId }.Select(id => Share(Entry(detail, "en-two"), id)).Order());
        Assert.Equal(2, Entry(detail, "en-two").GetProperty("shares").GetArrayLength());
        Assert.Equal(600, Share(Entry(detail, "en-exact"), bobId));
        Assert.Equal(334, Share(Entry(detail, "en-pct"), bobId));
        Assert.Equal(1000, Entry(detail, "en-pct").GetProperty("shares").EnumerateArray().Sum(s => s.GetProperty("cents").GetInt64()));

        // another currency rides along; the receipt lives apart and is fetched on its own; the backlink is its adder's
        const string photo = "data:image/jpeg;base64,/9j/4AAQ";
        Assert.Equal(HttpStatusCode.OK, (await ann.PostAsJsonAsync("/splits/en-1/entries", new
        {
            id = "en-chf", kind = "expense", description = "Fondue", amountCents = 5320, date = "2026-11-10",
            originalCurrency = "CHF", originalCents = 5000, receipt = photo, sourceTxId = "tx-ann", sourceSpaceId = "space-ann",
        })).StatusCode);
        var asAnn = Entry(await DetailAsync(ann, "en-1"), "en-chf");
        var asBob = Entry(await DetailAsync(bob, "en-1"), "en-chf");
        Assert.Equal(5000, asAnn.GetProperty("originalCents").GetInt64());
        Assert.True(asAnn.GetProperty("hasReceipt").GetBoolean());
        Assert.Equal("tx-ann", asAnn.GetProperty("sourceTxId").GetString());
        Assert.Equal(JsonValueKind.Null, asBob.GetProperty("sourceTxId").ValueKind);
        Assert.Equal(JsonValueKind.Null, asBob.GetProperty("sourceSpaceId").ValueKind);
        Assert.Equal(photo, (await JsonAsync(await bob.GetAsync("/splits/en-1/entries/en-chf/receipt"))).GetProperty("image").GetString());

        // its author, its payer and an owner change or take back an entry; another contributor does neither
        Assert.True(asAnn.GetProperty("canEdit").GetBoolean());
        Assert.False(asBob.GetProperty("canEdit").GetBoolean());
        var change = new { id = "en-chf", kind = "expense", description = "Fondue for three", amountCents = 6000, date = "2026-11-11", receipt = "" };
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.PutAsJsonAsync("/splits/en-1/entries/en-chf", change)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await bob.DeleteAsync("/splits/en-1/entries/en-chf")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await owner.PutAsJsonAsync("/splits/en-1/entries/en-chf", change)).StatusCode);
        var changed = Entry(await DetailAsync(ann, "en-1"), "en-chf");
        Assert.Equal("Fondue for three", changed.GetProperty("description").GetString());
        Assert.Equal(2000, Share(changed, bobId));
        Assert.False(changed.GetProperty("hasReceipt").GetBoolean());
        // the owner's change left the adder's backlink alone
        Assert.Equal("tx-ann", changed.GetProperty("sourceTxId").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await bob.GetAsync("/splits/en-1/entries/en-chf/receipt")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ann.DeleteAsync("/splits/en-1/entries/en-chf")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ann.PutAsJsonAsync("/splits/en-1/entries/en-chf", change)).StatusCode);
    }

    [Fact]
    public async Task Settling_asks_for_the_fewest_payments_tells_everyone_their_figure_and_archives_when_all_are_paid()
    {
        var x = await PersonAsync("st-x");
        var y = await PersonAsync("st-y");
        var z = await PersonAsync("st-z");
        await CreateAsync(y, "st-1");
        var token = await LinkAsync(y, "st-1");
        await UseLinkAsync(x, token);
        await UseLinkAsync(z, token);
        var (xId, yId, zId) = (await IdOf("st-x"), await IdOf("st-y"), await IdOf("st-z"));

        // the ticket's own case: x owes y 100 and z 100, z owes y 100 — one payment, x to y, 200
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(y, "st-1", "st-a", 10_000, yId, new[] { new { userId = xId, cents = 10_000L } }, "exact"));
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(z, "st-1", "st-b", 10_000, zId, new[] { new { userId = xId, cents = 10_000L } }, "exact"));
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(y, "st-1", "st-c", 10_000, yId, new[] { new { userId = zId, cents = 10_000L } }, "exact"));
        var peek = await JsonAsync(await x.GetAsync("/splits/st-1/settlement"));
        Assert.Equal(1, peek.GetArrayLength());
        Assert.Equal(xId, peek[0].GetProperty("fromUserId").GetGuid());
        Assert.Equal(yId, peek[0].GetProperty("toUserId").GetGuid());
        Assert.Equal(20_000, peek[0].GetProperty("amountCents").GetInt64());
        // looking changes nothing
        Assert.Equal("open", (await DetailAsync(x, "st-1")).GetProperty("split").GetProperty("status").GetString());

        Assert.Equal(HttpStatusCode.Forbidden, (await x.PostAsync("/splits/st-1/settle", null)).StatusCode);
        Assert.Equal("settled", (await JsonAsync(await y.PostAsync("/splits/st-1/settle", null))).GetProperty("status").GetString());
        // each hears their own figure, the link is gone and nothing is added any more
        var told = _factory.Push.Sent.Single(s => s.UserId == xId && s.Payload.GetProperty("kind").GetString() == "settled").Payload;
        Assert.Equal(-20_000, told.GetProperty("cents").GetInt64());
        Assert.Equal(0, _factory.Push.Sent.Single(s => s.UserId == zId && s.Payload.GetProperty("kind").GetString() == "settled").Payload.GetProperty("cents").GetInt64());
        Assert.Equal(HttpStatusCode.NotFound, (await x.GetAsync($"/splits/invites/{token}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, await ExpenseAsync(y, "st-1", "st-late", 100));
        Assert.Equal(HttpStatusCode.BadRequest, (await y.DeleteAsync("/splits/st-1/entries/st-a")).StatusCode);

        var payment = (await DetailAsync(z, "st-1")).GetProperty("payments")[0];
        var paymentId = payment.GetProperty("id").GetString();
        Assert.Equal(JsonValueKind.Null, payment.GetProperty("paidAt").ValueKind);
        // who is no party to a payment and no owner does not mark it; its payer does, and can take it back
        Assert.Equal(HttpStatusCode.Forbidden, (await z.PostAsJsonAsync($"/splits/st-1/payments/{paymentId}/paid", new { paid = true })).StatusCode);

        // an owner reopens: nothing was paid, so the plan is simply dropped
        Assert.Equal("open", (await JsonAsync(await y.PostAsync("/splits/st-1/reopen", null))).GetProperty("status").GetString());
        Assert.Empty((await DetailAsync(y, "st-1")).GetProperty("payments").EnumerateArray());
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(z, "st-1", "st-d", 3000, zId, new[] { new { userId = yId, cents = 3000L } }, "exact"));
        await y.PostAsync("/splits/st-1/settle", null);
        var payments = (await DetailAsync(y, "st-1")).GetProperty("payments");
        Assert.Equal(2, payments.GetArrayLength());
        var toY = payments.EnumerateArray().First(p => p.GetProperty("toUserId").GetGuid() == yId).GetProperty("id").GetString();
        var toZ = payments.EnumerateArray().First(p => p.GetProperty("toUserId").GetGuid() == zId).GetProperty("id").GetString();

        // the payer marks one paid; reopened, it stays as a payment made and settling again asks only for the rest
        Assert.Equal("settled", (await JsonAsync(await x.PostAsJsonAsync($"/splits/st-1/payments/{toY}/paid", new { paid = true }))).GetProperty("status").GetString());
        Assert.Contains("payment-paid", ToldTo(yId));
        await y.PostAsync("/splits/st-1/reopen", null);
        var reopened = await DetailAsync(y, "st-1");
        Assert.Contains(reopened.GetProperty("entries").EnumerateArray(), e => e.GetProperty("kind").GetString() == "settlement" && e.GetProperty("amountCents").GetInt64() == 17_000);
        await y.PostAsync("/splits/st-1/settle", null);
        var rest = (await DetailAsync(y, "st-1")).GetProperty("payments");
        Assert.Equal(1, rest.GetArrayLength());
        Assert.Equal(3000, rest[0].GetProperty("amountCents").GetInt64());
        Assert.NotEqual(toZ, rest[0].GetProperty("id").GetString());

        // the receiver marks the last one: everything is paid, the event archives itself
        var last = rest[0].GetProperty("id").GetString();
        Assert.Equal("archived", (await JsonAsync(await z.PostAsJsonAsync($"/splits/st-1/payments/{last}/paid", new { paid = true }))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await y.PostAsync("/splits/st-1/reopen", null)).StatusCode);

        // everybody even: settling has nothing to ask, the event is archived at once; an owner archives any time
        await CreateAsync(y, "st-2");
        Assert.Equal("archived", (await JsonAsync(await y.PostAsync("/splits/st-2/settle", null))).GetProperty("status").GetString());
        await CreateAsync(y, "st-3");
        Assert.Equal("archived", (await JsonAsync(await y.PostAsync("/splits/st-3/archive", null))).GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await y.PostAsJsonAsync("/splits/st-3/invites", new { })).StatusCode);
    }

    [Fact]
    public async Task Deleting_is_at_once_when_alone_and_a_weeks_countdown_any_owner_can_stop_when_not()
    {
        var owner = await PersonAsync("dl-owner");
        var ann = await PersonAsync("dl-ann");
        await CreateAsync(owner, "dl-alone");
        Assert.True((await JsonAsync(await owner.PostAsync("/splits/dl-alone/delete", null))).GetProperty("deleted").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/splits/dl-alone")).StatusCode);

        await CreateAsync(owner, "dl-1");
        await UseLinkAsync(ann, await LinkAsync(owner, "dl-1"));
        var annId = await IdOf("dl-ann");
        Assert.Equal(HttpStatusCode.OK, await ExpenseAsync(owner, "dl-1", "dl-e", 500));
        Assert.Equal(HttpStatusCode.Forbidden, (await ann.PostAsync("/splits/dl-1/delete", null)).StatusCode);

        var planned = await JsonAsync(await owner.PostAsync("/splits/dl-1/delete", null));
        Assert.False(planned.GetProperty("deleted").GetBoolean());
        Assert.Equal(_factory.Clock.GetUtcNow().AddDays(7), planned.GetProperty("deleteAt").GetDateTimeOffset());
        Assert.Contains("delete-planned", ToldTo(annId));
        Assert.Equal(JsonValueKind.String, (await DetailAsync(ann, "dl-1")).GetProperty("split").GetProperty("deleteAt").ValueKind);

        // another owner stops it; the event stays past the week
        await owner.PostAsync($"/splits/dl-1/members/{annId}/promote", null);
        Assert.Equal(HttpStatusCode.OK, (await ann.DeleteAsync("/splits/dl-1/delete")).StatusCode);
        Assert.Contains("delete-stopped", ToldTo(await IdOf("dl-owner")));
        _factory.Clock.Advance(TimeSpan.FromDays(8));
        Assert.Equal(HttpStatusCode.OK, (await ann.GetAsync("/splits/dl-1")).StatusCode);

        // not stopped: when the week is over the event is gone for everybody, with everything in it
        await owner.PostAsync("/splits/dl-1/delete", null);
        _factory.Clock.Advance(TimeSpan.FromDays(6));
        Assert.Equal(1, (await JsonAsync(await ann.GetAsync("/splits"))).GetArrayLength());
        _factory.Clock.Advance(TimeSpan.FromDays(2));
        Assert.Equal(0, (await JsonAsync(await ann.GetAsync("/splits"))).GetArrayLength());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync("/splits/dl-1")).StatusCode);
        Assert.Equal(0, Read(db => db.SplitEntries.Count(e => e.SplitId == "dl-1") + db.SplitMembers.Count(m => m.SplitId == "dl-1")));
    }

    [Fact]
    public async Task The_attachment_to_a_space_and_an_event_is_each_members_own()
    {
        var owner = await PersonAsync("at-owner");
        var ann = await PersonAsync("at-ann");
        await CreateAsync(owner, "at-1");
        await UseLinkAsync(ann, await LinkAsync(owner, "at-1"));
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync("/splits/at-1/attach", new { spaceId = "space-owner", eventId = "event-owner" })).StatusCode);
        Assert.Equal("event-owner", (await DetailAsync(owner, "at-1")).GetProperty("split").GetProperty("attachedEventId").GetString());
        Assert.Equal(JsonValueKind.Null, (await DetailAsync(ann, "at-1")).GetProperty("split").GetProperty("attachedEventId").ValueKind);
        // no event named clears the link, the space stays
        await owner.PostAsJsonAsync("/splits/at-1/attach", new { });
        var mine = (await DetailAsync(owner, "at-1")).GetProperty("split");
        Assert.Equal(JsonValueKind.Null, mine.GetProperty("attachedEventId").ValueKind);
        Assert.Equal("space-owner", mine.GetProperty("attachedSpaceId").GetString());
    }

    [Fact]
    public void The_fewest_payments_are_found_exactly_and_past_the_limit_never_more_than_one_each()
    {
        Guid Id(int n) => new($"00000000-0000-0000-0000-{n:D12}");
        Dictionary<Guid, long> Of(params long[] cents) => cents.Select((c, i) => (Id(i + 1), c)).ToDictionary(p => p.Item1, p => p.c);

        // +5 +7 −5 −4 −3: pairing the largest with the largest takes four payments, three are enough
        var plan = SplitSettlement.Plan(Of(500, 700, -500, -400, -300));
        Assert.Equal(3, plan.Count);
        Assert.Contains(plan, p => p.From == Id(3) && p.To == Id(1) && p.Cents == 500);
        Assert.Equal(1200, plan.Sum(p => p.Cents));
        // largest first, and the same balances give the same plan
        Assert.Equal(plan.Select(p => p.Cents).OrderByDescending(c => c), plan.Select(p => p.Cents));
        Assert.Equal(plan, SplitSettlement.Plan(Of(500, 700, -500, -400, -300)));

        Assert.Empty(SplitSettlement.Plan(Of(0, 0)));
        Assert.Empty(SplitSettlement.Plan(new Dictionary<Guid, long>()));
        Assert.Throws<InvalidOperationException>(() => SplitSettlement.Plan(Of(100, -50)));

        // two pairs and a triple among seven: 7 − 3 groups = 4 payments
        Assert.Equal(4, SplitSettlement.Plan(Of(1000, -1000, 250, -250, 900, -400, -500)).Count);

        // more people than the exact search takes: everyone still ends at zero, in fewer payments than people
        var many = Enumerable.Range(1, SplitSettlement.ExactLimit + 4).Select(i => i % 2 == 0 ? 100L * i : -100L * i).ToList();
        many.Add(-many.Sum());
        var balances = Of([.. many]);
        var wide = SplitSettlement.Plan(balances);
        Assert.True(wide.Count < balances.Count(b => b.Value != 0));
        foreach (var payment in wide)
        {
            balances[payment.From] += payment.Cents;
            balances[payment.To] -= payment.Cents;
        }
        Assert.All(balances.Values, cents => Assert.Equal(0, cents));
    }

    [Theory]
    [InlineData("en")]
    [InlineData("nl")]
    [InlineData("tr")]
    public void A_phone_shows_every_split_notice_in_its_language(string lang)
    {
        string? Body(string kind, long? cents = null) =>
            FcmTexts.Build(JsonSerializer.SerializeToElement(new { type = "split", kind, splitName = "Ski trip", currency = "EUR", fromName = "Ann", cents }), lang)?.Body;
        foreach (var kind in new[] { "invited", "join-request", "approved", "refused", "invite-accepted", "invite-declined", "payment-paid", "delete-planned", "delete-stopped", "removed", "made-owner" })
        {
            Assert.Contains("Ski trip", Body(kind));
        }
        // settled is worded by the receiver's own figure
        Assert.Contains("12.50 EUR", Body("settled", 1250));
        Assert.Contains("12.50 EUR", Body("settled", -1250));
        Assert.NotEqual(Body("settled", 1250), Body("settled", -1250));
        Assert.DoesNotContain("0.00", Body("settled", 0));
        Assert.Null(Body("something-new"));
    }
}
