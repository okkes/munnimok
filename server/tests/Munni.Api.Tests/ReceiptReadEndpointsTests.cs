using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Shopping;

namespace Munni.Api.Tests;

/// <summary>A reader that answers what the test tells it to, and remembers what it was asked.</summary>
internal sealed class ScriptedReceiptReader : IReceiptReader
{
    public int Reads;
    public IReadOnlyList<ReceiptPhoto>? LastPhotos;
    public IReadOnlyList<ReadCategory>? LastCategories;
    public Func<ReadReceipt?> Answer = () => new ReadReceipt("Albert Heijn", "2026-11-12", "eur", 1000,
        [new ReadLine("Melk", 1, 129, 129, "item", "groceries"), new ReadLine("Brood", 1, 871, 871, "item", null)]);

    public string? LastModel;

    public string Provider => "scripted";

    public string DefaultModel => "scripted-default";

    public Task<ReadReceipt?> ReadAsync(IReadOnlyList<ReceiptPhoto> photos, IReadOnlyList<ReadCategory> categories, string? model, CancellationToken ct)
    {
        Reads++;
        LastModel = model;
        LastPhotos = photos;
        LastCategories = categories;
        return Task.FromResult(Answer());
    }
}

public class ReceiptReadApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databaseName = $"receipt-read-tests-{Guid.NewGuid():N}";
    internal ScriptedReceiptReader Reader { get; } = new();
    internal HandClock Clock { get; } = new(new DateTimeOffset(2026, 11, 12, 10, 0, 0, TimeSpan.Zero));
    public string? Key { get; init; } = "test-key";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("ReceiptAi:ApiKey", Key);
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType == typeof(TimeProvider) ||
                             d.ServiceType == typeof(IReceiptReader) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
            services.AddSingleton<TimeProvider>(Clock);
            if (!string.IsNullOrEmpty(Key)) services.AddSingleton<IReceiptReader>(Reader);
        });
    }
}

/// <summary>
/// #567: a receipt photo read by a vision model through the API. One
/// factory per test — the per-person counts live in the API's memory.
/// </summary>
public class ReceiptReadEndpointsTests
{
    private const string Jpeg = "data:image/jpeg;base64,/9j/4AAQ";
    private static readonly object[] Categories = [new { id = "groceries", name = "Groceries" }, new { id = "household", name = "Household" }];

    private static HttpClient ClientFor(ReceiptReadApiFactory factory, string sub, string? scope = null)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    private static async Task<JsonElement> ReadAsync(HttpClient client, params string[] images)
    {
        var response = await client.PostAsJsonAsync("/receipts/read", new { images, categories = Categories });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task The_reader_gets_the_photos_and_the_categories_and_the_app_gets_a_checked_receipt()
    {
        await using var factory = new ReceiptReadApiFactory();
        var client = ClientFor(factory, "shopper");

        var reply = await ReadAsync(client, Jpeg, "data:image/png;base64,iVBORw0KGgo=");
        Assert.Equal("ok", reply.GetProperty("state").GetString());
        var receipt = reply.GetProperty("receipt");
        Assert.Equal("Albert Heijn", receipt.GetProperty("merchant").GetString());
        Assert.Equal("2026-11-12", receipt.GetProperty("date").GetString());
        Assert.Equal("EUR", receipt.GetProperty("currency").GetString());
        Assert.Equal(1000, receipt.GetProperty("totalCents").GetInt32());
        Assert.True(receipt.GetProperty("reconciled").GetBoolean());
        var lines = receipt.GetProperty("lines").EnumerateArray().ToList();
        Assert.Equal(2, lines.Count);
        Assert.Equal("groceries", lines[0].GetProperty("categoryId").GetString());
        Assert.Equal(JsonValueKind.Null, lines[1].GetProperty("categoryId").ValueKind);

        Assert.Equal(2, factory.Reader.LastPhotos!.Count);
        Assert.Equal(["image/jpeg", "image/png"], factory.Reader.LastPhotos.Select(p => p.MediaType));
        Assert.Equal(["groceries", "household"], factory.Reader.LastCategories!.Select(c => c.Id));
        var health = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
        Assert.True(health.GetProperty("capabilities").GetProperty("receiptAi").GetBoolean());
    }

    [Fact]
    public async Task What_is_no_receipt_photo_is_refused_before_a_read_is_spent()
    {
        await using var factory = new ReceiptReadApiFactory();
        var client = ClientFor(factory, "shopper");
        async Task<HttpStatusCode> Post(object body) => (await client.PostAsJsonAsync("/receipts/read", body)).StatusCode;

        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().PostAsJsonAsync("/receipts/read", new { images = new[] { Jpeg } })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { images = Array.Empty<string>() }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { images = new[] { Jpeg, Jpeg, Jpeg, Jpeg, Jpeg } }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { images = new[] { "data:application/pdf;base64,JVBERi0=" } }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { images = new[] { "data:image/jpeg;base64,not base64!" } }));
        Assert.Equal(HttpStatusCode.BadRequest, await Post(new { images = new[] { "https://example.com/receipt.jpg" } }));
        Assert.Equal(0, factory.Reader.Reads);
    }

    [Fact]
    public async Task A_person_reads_as_many_receipts_a_day_as_the_operator_allows_twenty_unless_set()
    {
        await using var factory = new ReceiptReadApiFactory();
        var shopper = ClientFor(factory, "shopper");
        var admin = ClientFor(factory, "the-admin", "admin");

        var before = await admin.GetFromJsonAsync<JsonElement>("/admin/receipt-reading");
        Assert.True(before.GetProperty("enabled").GetBoolean());
        Assert.Equal("scripted", before.GetProperty("provider").GetString());
        Assert.Equal(20, before.GetProperty("dailyPerUser").GetInt32());
        Assert.Equal(1000, before.GetProperty("monthlyCap").GetInt32());
        Assert.Equal(HttpStatusCode.Forbidden, (await shopper.GetAsync("/admin/receipt-reading")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = 0, monthlyCap = 5 })).StatusCode);

        // the model is the operator's choice too: none named is the reader's own default; a sentence is no model
        Assert.Equal("scripted-default", before.GetProperty("defaultModel").GetString());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("model").ValueKind);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = 2, monthlyCap = 1000, model = "the cheap one please" })).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = 2, monthlyCap = 1000, model = "claude-haiku-5-5" })).StatusCode);
        Assert.Equal("claude-haiku-5-5", (await admin.GetFromJsonAsync<JsonElement>("/admin/receipt-reading")).GetProperty("model").GetString());
        Assert.Equal("ok", (await ReadAsync(shopper, Jpeg)).GetProperty("state").GetString());
        Assert.Equal("claude-haiku-5-5", factory.Reader.LastModel);
        Assert.Equal("ok", (await ReadAsync(shopper, Jpeg)).GetProperty("state").GetString());
        var limited = await ReadAsync(shopper, Jpeg);
        Assert.Equal("limited", limited.GetProperty("state").GetString());
        Assert.Equal(new DateTimeOffset(2026, 11, 13, 0, 0, 0, TimeSpan.Zero), limited.GetProperty("until").GetDateTimeOffset());
        // the limit is each person's own, and tomorrow it starts over
        Assert.Equal("ok", (await ReadAsync(ClientFor(factory, "somebody-else"), Jpeg)).GetProperty("state").GetString());
        factory.Clock.Advance(TimeSpan.FromDays(1));
        Assert.Equal("ok", (await ReadAsync(shopper, Jpeg)).GetProperty("state").GetString());

        // no limit at all is an answer too — told apart from "never set"
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = (int?)null, monthlyCap = (int?)null })).StatusCode);
        var open = await admin.GetFromJsonAsync<JsonElement>("/admin/receipt-reading");
        Assert.Equal(JsonValueKind.Null, open.GetProperty("dailyPerUser").ValueKind);
        Assert.Equal(JsonValueKind.Null, open.GetProperty("monthlyCap").ValueKind);
        Assert.Equal(4, open.GetProperty("readThisMonth").GetInt32());
    }

    [Fact]
    public async Task The_month_is_capped_for_the_whole_environment_and_the_count_is_kept_in_the_database()
    {
        await using var factory = new ReceiptReadApiFactory();
        var admin = ClientFor(factory, "the-admin", "admin");
        await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = (int?)null, monthlyCap = 2 });

        Assert.Equal("ok", (await ReadAsync(ClientFor(factory, "one"), Jpeg)).GetProperty("state").GetString());
        // a photo the reader makes no receipt of was still read: it is paid for and counts
        factory.Reader.Answer = () => new ReadReceipt(null, null, null, null, []);
        Assert.Equal("unreadable", (await ReadAsync(ClientFor(factory, "two"), Jpeg)).GetProperty("state").GetString());
        factory.Reader.Answer = () => null;
        var capped = await ReadAsync(ClientFor(factory, "three"), Jpeg);
        Assert.Equal("capped", capped.GetProperty("state").GetString());
        Assert.Equal(new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero), capped.GetProperty("until").GetDateTimeOffset());
        Assert.Equal(2, factory.Reader.Reads);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal("2", (await db.AppSettings.FindAsync(ReceiptReadEndpoints.MonthCountPrefix + "2026-11"))?.Value);
        }

        // December starts at nothing
        factory.Clock.Advance(TimeSpan.FromDays(20));
        Assert.Equal("unreadable", (await ReadAsync(ClientFor(factory, "three"), Jpeg)).GetProperty("state").GetString());
    }

    [Fact]
    public async Task A_reader_that_fails_is_not_available_and_costs_nobody_a_read()
    {
        await using var factory = new ReceiptReadApiFactory();
        var shopper = ClientFor(factory, "shopper");
        var admin = ClientFor(factory, "the-admin", "admin");
        await admin.PutAsJsonAsync("/admin/receipt-reading", new { dailyPerUser = 1, monthlyCap = 1000 });

        factory.Reader.Answer = () => throw new HttpRequestException("the provider is away");
        Assert.Equal("unavailable", (await ReadAsync(shopper, Jpeg)).GetProperty("state").GetString());
        Assert.Equal(0, (await admin.GetFromJsonAsync<JsonElement>("/admin/receipt-reading")).GetProperty("readThisMonth").GetInt32());
        // the one read of the day is still there
        factory.Reader.Answer = () => new ReadReceipt("Shop", null, null, 100, [new ReadLine("Thing", null, null, 100, "item", null)]);
        Assert.Equal("ok", (await ReadAsync(shopper, Jpeg)).GetProperty("state").GetString());
    }

    [Fact]
    public async Task Without_a_key_there_is_no_reader_and_the_portal_can_say_so()
    {
        await using var factory = new ReceiptReadApiFactory { Key = "" };
        Assert.Equal(HttpStatusCode.NotFound, (await ClientFor(factory, "shopper").PostAsJsonAsync("/receipts/read", new { images = new[] { Jpeg } })).StatusCode);
        var health = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
        Assert.False(health.GetProperty("capabilities").GetProperty("receiptAi").GetBoolean());
        var status = await ClientFor(factory, "the-admin", "admin").GetFromJsonAsync<JsonElement>("/admin/receipt-reading");
        Assert.False(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("provider").ValueKind);
    }

    [Fact]
    public void Nothing_a_reader_says_is_taken_at_its_word()
    {
        ReadCategory[] categories = [new("groceries", "Groceries")];
        var checkedReceipt = ReceiptReadCheck.Normalize(
            new ReadReceipt("  Jumbo \n Supermarkten ", "12-11-2026", "euro", 1500,
            [
                new ReadLine("  Kaas   jong  belegen ", 0.456m, null, 547, "item", "groceries"),
                new ReadLine("Korting", null, null, 100, "discount", "groceries"),
                new ReadLine("Statiegeld", 2, 25, 50, "deposit", "made-up"),
                new ReadLine("Tas", null, null, 25, "bag", "nowhere"),
                new ReadLine("", null, null, 999, "item", null),
                new ReadLine("No amount", null, null, null, "item", null),
            ]),
            categories)!;

        Assert.Equal("Jumbo Supermarkten", checkedReceipt.Merchant);
        // not a date, not a currency code: left out rather than guessed
        Assert.Null(checkedReceipt.Date);
        Assert.Null(checkedReceipt.Currency);
        Assert.Equal(4, checkedReceipt.Lines.Count);
        Assert.Equal(new ReceiptLine("Kaas jong belegen", 0.456m, 1200, 547, "item", "groceries"), checkedReceipt.Lines[0]);
        // a discount takes off whatever sign it came with, and files under nothing
        Assert.Equal(new ReceiptLine("Korting", 1, 100, -100, "discount", null), checkedReceipt.Lines[1]);
        Assert.Equal(new ReceiptLine("Statiegeld", 2, 25, 50, "deposit", null), checkedReceipt.Lines[2]);
        // a kind and a category the reader made up fall back to an item without a category
        Assert.Equal(new ReceiptLine("Tas", 1, 25, 25, "item", null), checkedReceipt.Lines[3]);
        // 547 − 100 + 50 + 25 is not the printed 1500: said, never hidden
        Assert.False(checkedReceipt.Reconciled);
        Assert.Equal(1500, checkedReceipt.TotalCents);

        // no printed total: the receipt is worth its lines
        var summed = ReceiptReadCheck.Normalize(new ReadReceipt(null, "2026-11-12", "EUR", null, [new ReadLine("A", null, null, 300, "item", null)]), categories)!;
        Assert.Equal((300, true, "2026-11-12", "EUR"), (summed.TotalCents, summed.Reconciled, summed.Date, summed.Currency));
        Assert.Null(ReceiptReadCheck.Normalize(null, categories));
        Assert.Null(ReceiptReadCheck.Normalize(new ReadReceipt("Shop", null, null, 100, []), categories));
    }

    [Fact]
    public void The_model_reads_the_categories_as_a_list_and_its_answer_only_as_the_agreed_json()
    {
        Assert.Equal("Categories (id — name):\n- groceries — Groceries\n", ClaudeReceiptReader.CategoryList([new("groceries", "Groceries")]));
        Assert.Contains("no category list", ClaudeReceiptReader.CategoryList([]));

        var read = ClaudeReceiptReader.Parse(
            """{"merchant":"AH","date":"2026-11-12","currency":"EUR","total_cents":129,"lines":[{"name":"Melk","quantity":1,"unit_cents":129,"total_cents":129,"kind":"item","category_id":"groceries"}]}""")!;
        Assert.Equal("AH", read.Merchant);
        Assert.Equal(new ReadLine("Melk", 1, 129, 129, "item", "groceries"), Assert.Single(read.Lines!));
        Assert.Null(ClaudeReceiptReader.Parse("I could not read this receipt."));
        Assert.Null(ClaudeReceiptReader.Parse(""));
    }
}
