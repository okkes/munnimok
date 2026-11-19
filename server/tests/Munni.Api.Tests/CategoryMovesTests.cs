using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Sync;
using Xunit;

namespace Munni.Api.Tests;

// #653: the catalog's groceries main. Counted per space: the test database is shared with the other repair specs
public class CategoryMovesTests : IClassFixture<FeedsApiFactory>
{
    private static readonly string[] OldMain = ["consumption"];
    private static readonly string[] OldMainAndMerged = ["consumption", "softDrinks"];
    private static readonly string[] TobaccoAndMerged = ["tobacco", "softDrinks"];
    private static readonly string[] Entertainment = ["entertainment"];
    private static readonly string[] Tobacco = ["tobacco"];
    private static readonly string[] Coffee = ["coffee"];

    private readonly FeedsApiFactory _factory;

    public CategoryMovesTests(FeedsApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static SyncOpDto Op(string spaceId, string entity, string entityId, string hlc, object fields) =>
        new(Guid.NewGuid().ToString("N"), spaceId, entity, entityId,
            JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(fields))!, hlc);

    private async Task<int> RepairAsync(string spaceId)
    {
        using var scope = _factory.Services.CreateScope();
        return await CategoryMoves.RepairSpaceAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), spaceId, CancellationToken.None);
    }

    private JsonElement Data(string spaceId, string entity, string entityId)
    {
        using var scope = _factory.Services.CreateScope();
        var row = scope.ServiceProvider.GetRequiredService<AppDbContext>().EntityRows.AsNoTracking()
            .Single(r => r.SpaceId == spaceId && r.Entity == entity && r.EntityId == entityId);
        return JsonSerializer.Deserialize<JsonElement>(row.DataJson);
    }

    private string Stamp(string spaceId, string entity, string entityId, string field)
    {
        using var scope = _factory.Services.CreateScope();
        var row = scope.ServiceProvider.GetRequiredService<AppDbContext>().EntityRows.AsNoTracking()
            .Single(r => r.SpaceId == spaceId && r.Entity == entity && r.EntityId == entityId);
        return JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson)![field];
    }

    private static string[] Ids(JsonElement list) => [.. list.EnumerateArray().Select(id => id.GetString()!)];

    [Fact]
    public async Task A_merged_sub_is_replaced_wherever_a_row_names_it_and_what_listed_the_old_main_keeps_what_it_counted()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var client = ClientFor($"catmoves_{Guid.NewGuid():N}");
        const string hlc = "000000200-0000-dev1";
        var push = await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
        [
            Op(spaceId, "space", spaceId, "000000100-0000-dev1", new
            {
                name = "Home",
                hiddenMains = OldMain,
                trendGraphs = new object[]
                {
                    new { id = "g1", name = "Food", catIds = OldMainAndMerged },
                    new { id = "g2", name = "Fun", catIds = Entertainment },
                },
            }),
            Op(spaceId, "transaction", "t-soft", hlc, new { amountCents = -250, catId = "softDrinks" }),
            Op(spaceId, "transaction", "t-parts", hlc, new
            {
                amountCents = -1000,
                catId = "restaurants",
                cats = new[] { new { catId = "softDrinks", amountCents = 300 }, new { catId = "restaurants", amountCents = 700 } },
                splits = new object[]
                {
                    new { catId = "softDrinks", amountCents = 400 },
                    new { catId = "groceries", amountCents = 600, cats = new[] { new { catId = "softDrinks", amountCents = 100 }, new { catId = "groceries", amountCents = 500 } } },
                },
            }),
            Op(spaceId, "transaction", "t-plain", hlc, new { amountCents = -900, catId = "groceries" }),
            Op(spaceId, "txMeta", "m1", hlc, new { txId = "feed-tx", catId = "softDrinks", needsReview = 0 }),
            Op(spaceId, "recurring", "r1", hlc, new { name = "Cola", catId = "softDrinks" }),
            Op(spaceId, "budget", "b-food", hlc, new { name = "Food", catIds = OldMainAndMerged }),
            Op(spaceId, "budget", "b-smoke", hlc, new { name = "Smoke", catIds = Tobacco }),
            Op(spaceId, "budget", "b-subs", hlc, new { name = "Coffee", catIds = Coffee }),
            Op(spaceId, "planSubject", "ps-food", hlc, new { planId = "p1", name = "Food", catIds = OldMain, excludeCatIds = TobaccoAndMerged }),
            Op(spaceId, "planSubject", "ps-other-plan", hlc, new { planId = "p2", name = "Food", catIds = OldMain }),
            Op(spaceId, "receiptLink", "l1", hlc, new
            {
                source = "photo",
                items = new[] { new { name = "Cola", totalCents = 250, catId = "softDrinks" } },
                picks = new Dictionary<string, object[]> { ["t-soft"] = [new { line = 0, catId = "softDrinks", amountCents = 250 }] },
            }),
        ]));
        push.EnsureSuccessStatusCode();

        // the untouched rows are not counted: t-plain names an id that only moved, b-smoke and b-subs list no old main
        Assert.Equal(9, await RepairAsync(spaceId));

        Assert.Equal("coffee", Data(spaceId, "transaction", "t-soft").GetProperty("catId").GetString());
        var parts = Data(spaceId, "transaction", "t-parts");
        Assert.Equal("restaurants", parts.GetProperty("catId").GetString());
        Assert.Equal(-1000, parts.GetProperty("amountCents").GetInt32());
        Assert.Equal(["coffee", "restaurants"], parts.GetProperty("cats").EnumerateArray().Select(c => c.GetProperty("catId").GetString()));
        Assert.Equal([300, 700], parts.GetProperty("cats").EnumerateArray().Select(c => c.GetProperty("amountCents").GetInt32()));
        var split = parts.GetProperty("splits").EnumerateArray().ToList();
        Assert.Equal("coffee", split[0].GetProperty("catId").GetString());
        Assert.Equal("groceries", split[1].GetProperty("catId").GetString());
        Assert.Equal(["coffee", "groceries"], split[1].GetProperty("cats").EnumerateArray().Select(c => c.GetProperty("catId").GetString()));
        Assert.Equal("groceries", Data(spaceId, "transaction", "t-plain").GetProperty("catId").GetString());
        Assert.Equal("coffee", Data(spaceId, "txMeta", "m1").GetProperty("catId").GetString());
        Assert.Equal("coffee", Data(spaceId, "recurring", "r1").GetProperty("catId").GetString());

        // the budget on the old main keeps the grocery payments; tobacco is another budget's and stays there
        Assert.Equal(["consumption", "coffee", "groceries"], Ids(Data(spaceId, "budget", "b-food").GetProperty("catIds")));
        Assert.Equal(["tobacco"], Ids(Data(spaceId, "budget", "b-smoke").GetProperty("catIds")));
        // a subject keeps what it counted, minus what it left out; another plan's subject is no rival
        var subject = Data(spaceId, "planSubject", "ps-food");
        Assert.Equal(["consumption", "groceries"], Ids(subject.GetProperty("catIds")));
        Assert.Equal(["tobacco", "coffee"], Ids(subject.GetProperty("excludeCatIds")));
        Assert.Equal(["consumption", "groceries", "tobacco"], Ids(Data(spaceId, "planSubject", "ps-other-plan").GetProperty("catIds")));

        var space = Data(spaceId, "space", spaceId);
        Assert.Equal(["consumption", "grocery"], Ids(space.GetProperty("hiddenMains")));
        var graphs = space.GetProperty("trendGraphs").EnumerateArray().ToList();
        Assert.Equal(["consumption", "coffee", "groceries", "tobacco"], Ids(graphs[0].GetProperty("catIds")));
        Assert.Equal(["entertainment"], Ids(graphs[1].GetProperty("catIds")));

        var link = Data(spaceId, "receiptLink", "l1");
        Assert.Equal("coffee", link.GetProperty("items")[0].GetProperty("catId").GetString());
        Assert.Equal("coffee", link.GetProperty("picks").GetProperty("t-soft")[0].GetProperty("catId").GetString());

        // each field sits right behind the value it replaced, and a second run finds nothing
        Assert.Equal($"{hlc}~", Stamp(spaceId, "transaction", "t-soft", "catId"));
        Assert.Equal(hlc, Stamp(spaceId, "transaction", "t-soft", "amountCents"));
        Assert.Equal(0, await RepairAsync(spaceId));
    }

    [Fact]
    public async Task A_later_write_of_a_device_keeps_its_say()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var client = ClientFor($"catmoves_{Guid.NewGuid():N}");
        (await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
        [
            Op(spaceId, "space", spaceId, "000000100-0000-dev1", new { name = "Home" }),
            Op(spaceId, "budget", "b1", "000000200-0000-dev1", new { name = "Food", catIds = OldMain }),
        ]))).EnsureSuccessStatusCode();
        Assert.Equal(1, await RepairAsync(spaceId));
        // a device that had not pulled yet narrows the budget: its stamp is later than the repair's
        (await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [Op(spaceId, "budget", "b1", "000000201-0000-dev1", new { catIds = OldMain })]))).EnsureSuccessStatusCode();
        Assert.Equal(["consumption"], Ids(Data(spaceId, "budget", "b1").GetProperty("catIds")));
        // the repair's op is known: nothing is added a second time
        Assert.Equal(0, await RepairAsync(spaceId));
        Assert.Equal(["consumption"], Ids(Data(spaceId, "budget", "b1").GetProperty("catIds")));
    }
}
