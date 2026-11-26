using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Sync;
using Xunit;

namespace Munni.Api.Tests;

// #536: an account fetched before the party's own type was stamped gets it from the type it was seeded with, once
// counted per space: the test database is shared with the other repair specs, which run alongside
public class PartyTypeRepairTests : IClassFixture<FeedsApiFactory>
{
    private readonly FeedsApiFactory _factory;

    public PartyTypeRepairTests(FeedsApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    /// <summary>valid uuid with version nibble 5 — feed-shaped, unique per call</summary>
    private static string FeedId()
    {
        var g = Guid.NewGuid().ToString();
        return g[..14] + '5' + g[15..];
    }

    private static SyncOpDto Account(string feed, string id, params (string Name, string Value)[] fields) =>
        new(Guid.NewGuid().ToString("N"), feed, "account", id, fields.ToDictionary(f => f.Name, f => JsonSerializer.SerializeToElement(f.Value)), "000000100-0000-dev");

    private async Task<int> RepairAsync(string feed)
    {
        using var scope = _factory.Services.CreateScope();
        return await PartyTypeRepair.RepairSpaceAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), feed, CancellationToken.None);
    }

    private JsonElement Row(string feed, string id)
    {
        using var scope = _factory.Services.CreateScope();
        var row = scope.ServiceProvider.GetRequiredService<AppDbContext>().EntityRows.Single(r => r.SpaceId == feed && r.Entity == "account" && r.EntityId == id);
        return JsonDocument.Parse(row.DataJson).RootElement.Clone();
    }

    private static string? Stated(JsonElement row) => row.TryGetProperty("partyType", out var value) ? value.GetString() : null;

    [Fact]
    public async Task Accounts_a_party_typed_say_so_from_now_on_and_the_others_stay_the_space_s_choice()
    {
        var feed = FeedId();
        var client = ClientFor($"partytype_{Guid.NewGuid():N}");
        await client.PostAsJsonAsync("/feeds", new RegisterFeedRequest(feed, "NL55INGB0123456781"));
        var push = await client.PostAsJsonAsync($"/sync/{feed}/push", new PushRequest("dev1",
        [
            Account(feed, "loan", ("source", "connector"), ("provider", "ing-nl"), ("type", "loan")),
            Account(feed, "savings", ("source", "connector"), ("provider", "asn"), ("type", "savings")),
            Account(feed, "debt", ("source", "connector"), ("provider", "duo"), ("type", "loan")),
            Account(feed, "home", ("source", "connector"), ("provider", "bkr"), ("type", "mortgage")),
            // a current account is the space's to type; an open-banking row was typed by a guess; a typed-in account by a person
            Account(feed, "current", ("source", "connector"), ("provider", "ing-nl"), ("type", "checking")),
            Account(feed, "open", ("source", "connector"), ("provider", "enablebanking"), ("type", "savings")),
            Account(feed, "manual", ("source", "manual"), ("type", "loan")),
            Account(feed, "nameless", ("source", "connector"), ("type", "loan")),
            Account(feed, "known", ("source", "connector"), ("provider", "ing-nl"), ("type", "loan"), ("partyType", "credit")),
        ]));
        push.EnsureSuccessStatusCode();

        Assert.Equal(4, await RepairAsync(feed));
        Assert.Equal("loan", Stated(Row(feed, "loan")));
        Assert.Equal("savings", Stated(Row(feed, "savings")));
        Assert.Equal("loan", Stated(Row(feed, "debt")));
        Assert.Equal("mortgage", Stated(Row(feed, "home")));
        foreach (var untouched in new[] { "current", "open", "manual", "nameless" }) Assert.Null(Stated(Row(feed, untouched)));
        // what a fetch already stamped is the party's newer word
        Assert.Equal("credit", Stated(Row(feed, "known")));

        // a device pulls the stamp like any other change, and a second run finds nothing left to do
        var pulled = await client.GetFromJsonAsync<PullResponse>($"/sync/{feed}/pull?since=0");
        Assert.Contains(pulled!.Ops, op => op.EntityId == "debt" && op.Fields.TryGetValue("partyType", out var type) && type.GetString() == "loan");
        Assert.Equal(0, await RepairAsync(feed));
    }

    [Fact]
    public async Task The_repair_runs_once_per_database()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var logger = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        await PartyTypeRepair.RunOnceAsync(db, logger, CancellationToken.None);
        Assert.NotNull(await db.AppSettings.FindAsync(PartyTypeRepair.SettingKey));
        Assert.Equal(0, await PartyTypeRepair.RunOnceAsync(db, logger, CancellationToken.None));
    }

    [Fact]
    public async Task An_account_nobody_holds_states_no_type()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Null(await PartyTypeRepair.StatedTypeAsync(db, "feed-that-is-not-there", "acct"));
        Assert.Equal(0, await PartyTypeRepair.RepairSpaceAsync(db, "space-that-is-not-there", CancellationToken.None));
    }
}
