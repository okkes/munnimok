using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;

namespace Munni.Api.Tests;

/// <summary>
/// Split sessions (SP1): membership is the ONLY authorization boundary —
/// non-members get 404 (existence itself is private), shares freeze at
/// entry creation. Reuses the admin factory (test auth + in-memory db).
/// </summary>
public class SplitsEndpointsTests : IClassFixture<AdminApiFactory>
{
    private readonly AdminApiFactory _factory;

    public SplitsEndpointsTests(AdminApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        return client;
    }

    /// <summary>any authed request materializes the user row (test auth)</summary>
    private async Task<HttpClient> TouchAsync(string sub)
    {
        var client = ClientFor(sub);
        await client.GetAsync("/me");
        return client;
    }

    private async Task<Guid> UserIdOf(string sub)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return (await db.Users.SingleAsync(u => u.Sub == sub)).Id;
    }

    private async Task JoinAsync(string splitId, string sub)
    {
        var userId = await UserIdOf(sub);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.SplitMembers.Add(new SplitMember { SplitId = splitId, UserId = userId, Role = "member" });
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task MembershipGatesEverything_SharesFreezeAtCreation()
    {
        var anna = await TouchAsync("sp-anna");
        var ben = await TouchAsync("sp-ben");
        var carol = await TouchAsync("sp-carol");

        Assert.True((await anna.PostAsJsonAsync("/splits",
            new { id = "split-1", name = "Barcelona", currency = "EUR", spaceId = "s-anna" })).IsSuccessStatusCode);

        // outsiders learn nothing — not even that the split exists
        Assert.Equal(HttpStatusCode.NotFound, (await ben.GetAsync("/splits/split-1")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await ben.PostAsJsonAsync("/splits/split-1/entries",
                new { id = "e-intruder", kind = "expense", description = "nope", amountCents = 100, date = "2026-07-16" })).StatusCode);

        await JoinAsync("split-1", "sp-ben");

        // equal split of €10.01 over two members: 501/500, remainder deterministic
        Assert.True((await anna.PostAsJsonAsync("/splits/split-1/entries",
            new { id = "e-tapas", kind = "expense", description = "Tapas", amountCents = 1001, date = "2026-07-12" })).IsSuccessStatusCode);

        var detail = await ben.GetFromJsonAsync<System.Text.Json.JsonElement>("/splits/split-1");
        var entry = detail.GetProperty("entries").EnumerateArray().Single();
        var shares = entry.GetProperty("shares").EnumerateArray().Select(s => s.GetProperty("cents").GetInt64()).OrderBy(c => c).ToList();
        Assert.Equal([500L, 501L], shares);

        // Carol joins later: history must not drift — the old entry keeps 2 holders
        await JoinAsync("split-1", "sp-carol");
        var after = await carol.GetFromJsonAsync<System.Text.Json.JsonElement>("/splits/split-1");
        Assert.Equal(2, after.GetProperty("entries").EnumerateArray().Single().GetProperty("shares").GetArrayLength());
        Assert.Equal(3, after.GetProperty("members").GetArrayLength());

        // …but a NEW equal entry spans all three members
        Assert.True((await carol.PostAsJsonAsync("/splits/split-1/entries",
            new { id = "e-metro", kind = "expense", description = "Metro", amountCents = 900, date = "2026-07-13" })).IsSuccessStatusCode);
        var withMetro = await anna.GetFromJsonAsync<System.Text.Json.JsonElement>("/splits/split-1");
        var metro = withMetro.GetProperty("entries").EnumerateArray().Single(e => e.GetProperty("id").GetString() == "e-metro");
        Assert.Equal(3, metro.GetProperty("shares").GetArrayLength());

        // the list shows the split with counts
        var list = await ben.GetFromJsonAsync<System.Text.Json.JsonElement>("/splits");
        var summary = list.EnumerateArray().Single(s => s.GetProperty("id").GetString() == "split-1");
        Assert.Equal(3, summary.GetProperty("memberCount").GetInt32());
        Assert.Equal(2, summary.GetProperty("entryCount").GetInt32());
    }

    [Fact]
    public async Task EntryGuards_CustomSharesAndDeletion()
    {
        var owner = await TouchAsync("sp-owner");
        var member = await TouchAsync("sp-member");
        Assert.True((await owner.PostAsJsonAsync("/splits",
            new { id = "split-2", name = "Weekend", currency = "EUR" })).IsSuccessStatusCode);
        await JoinAsync("split-2", "sp-member");
        var ownerId = await UserIdOf("sp-owner");
        var memberId = await UserIdOf("sp-member");

        // custom shares must balance and belong to members
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/splits/split-2/entries",
            new { id = "e-bad", kind = "expense", description = "x", amountCents = 100, date = "2026-07-16",
                  shares = new[] { new { userId = ownerId, cents = 30L }, new { userId = memberId, cents = 30L } } })).StatusCode);
        Assert.True((await owner.PostAsJsonAsync("/splits/split-2/entries",
            new { id = "e-good", kind = "expense", description = "Dinner", amountCents = 100, date = "2026-07-16",
                  shares = new[] { new { userId = ownerId, cents = 25L }, new { userId = memberId, cents = 75L } } })).IsSuccessStatusCode);

        // the member cannot delete the owner's entry; the owner can delete any
        Assert.True((await member.PostAsJsonAsync("/splits/split-2/entries",
            new { id = "e-mine", kind = "expense", description = "Snacks", amountCents = 300, date = "2026-07-16" })).IsSuccessStatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await member.DeleteAsync("/splits/split-2/entries/e-good")).StatusCode);
        Assert.True((await member.DeleteAsync("/splits/split-2/entries/e-mine")).IsSuccessStatusCode);
        Assert.True((await owner.DeleteAsync("/splits/split-2/entries/e-good")).IsSuccessStatusCode);

        var detail = await owner.GetFromJsonAsync<System.Text.Json.JsonElement>("/splits/split-2");
        Assert.Equal(0, detail.GetProperty("entries").GetArrayLength());
    }
}
