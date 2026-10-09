using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Accounts;
using Munni.Api.Data;
using Munni.Api.Sync;
using Xunit;

namespace Munni.Api.Tests;

/// <summary>
/// The 2026-10-09 repair: a row the prediction overlay alone marked reviewed
/// goes back to the review, once; whatever a device said about the flag
/// stands — a review, an auto-link's materialised flag, a value the 10-05
/// repair restored. Counted per space: the test database is shared with
/// the other repair specs, which run alongside.
/// </summary>
public class NeedsReviewRepairTests : IClassFixture<FeedsApiFactory>
{
    private readonly FeedsApiFactory _factory;

    public NeedsReviewRepairTests(FeedsApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    private static Dictionary<string, JsonElement> Fields(params (string Name, object Value)[] fields) =>
        fields.ToDictionary(f => f.Name, f => JsonSerializer.SerializeToElement(f.Value));

    private static SyncOpDto Device(string spaceId, string entityId, string hlc, params (string Name, object Value)[] fields) =>
        new(Guid.NewGuid().ToString("N"), spaceId, "txMeta", entityId, Fields(fields), hlc);

    /// <summary>A server-side op on a space: the ingest's prediction overlay (floor stamp today, live clock before 2026-10-05) or a repair's.</summary>
    private async Task ServerOpAsync(string spaceId, string entityId, string opId, string hlc, params (string Name, object Value)[] fields)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var space = await db.Spaces.SingleAsync(s => s.Id == spaceId);
        await new SyncWriter(db).ApplyAsync(space, null, [new SyncOpDto(opId, spaceId, "txMeta", entityId, Fields(fields), hlc)]);
        await db.SaveChangesAsync();
    }

    private Task OverlayAsync(string spaceId, string entityId, string hlc, params (string Name, object Value)[] fields) =>
        ServerOpAsync(spaceId, entityId, ImportIds.OpId($"connmeta:{spaceId}:{entityId}"), hlc, fields);

    private async Task<int> RepairAsync(string spaceId)
    {
        using var scope = _factory.Services.CreateScope();
        return await NeedsReviewRepair.RepairSpaceAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), spaceId, CancellationToken.None);
    }

    private EntityRow Row(string spaceId, string entityId)
    {
        using var scope = _factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<AppDbContext>().EntityRows
            .Single(r => r.SpaceId == spaceId && r.Entity == "txMeta" && r.EntityId == entityId);
    }

    private static string VersionOf(EntityRow row, string field) =>
        JsonSerializer.Deserialize<Dictionary<string, string>>(row.FieldVersionsJson)![field];

    [Fact]
    public async Task A_row_the_prediction_alone_marked_reviewed_goes_back_to_review_once_and_a_device_s_word_stands()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var sub = $"needsreview_{Guid.NewGuid():N}";
        var client = ClientFor(sub);
        const string predicted = "meta-predicted";       // the floor overlay knew the merchant: 0 by the server alone
        const string liveClock = "meta-live";            // the pre-floor overlay with the live clock, nobody spoke
        const string reviewed = "meta-reviewed";         // the person reviewed it before the overlay
        const string autoLinked = "meta-autolinked";     // a device's auto-link materialised the flag it saw
        const string restored = "meta-restored";         // the 10-05 repair put the device's 0 back under the server's stamp
        const string unreviewed = "meta-unreviewed";     // the overlay never claimed a review

        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "space", spaceId, Fields(("name", "Review")), "000000100-0000-dev1")]));
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
        [
            Device(spaceId, reviewed, "000000200-0000-dev1", ("txId", "t3"), ("catId", "tuition"), ("needsReview", 0)),
            Device(spaceId, restored, "000000201-0000-dev1", ("txId", "t5"), ("catId", "transport"), ("needsReview", 0)),
        ]));
        await OverlayAsync(spaceId, predicted, ServerHlc.Floor, ("txId", "t1"), ("catId", "groceries"), ("txType", "expense"), ("needsReview", 0));
        await OverlayAsync(spaceId, liveClock, ServerHlc.Now(1), ("txId", "t2"), ("catId", "groceries"), ("txType", "expense"), ("needsReview", 0));
        await OverlayAsync(spaceId, reviewed, ServerHlc.Floor, ("txId", "t3"), ("catId", "uncategorized"), ("txType", "expense"), ("needsReview", 1));
        await OverlayAsync(spaceId, autoLinked, ServerHlc.Floor, ("txId", "t4"), ("catId", "telecom"), ("txType", "expense"), ("needsReview", 0));
        await OverlayAsync(spaceId, unreviewed, ServerHlc.Floor, ("txId", "t6"), ("catId", "uncategorized"), ("txType", "expense"), ("needsReview", 1));
        // the auto-link rode the recurring the person set up and carried the flag it saw — a device op, accepted as its word
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [Device(spaceId, autoLinked, "000000300-0000-dev1", ("recurringId", "rec1"), ("needsReview", 0))]));
        // what the 10-05 repair left on `restored`: the device's values under the server's stamp, its own op id
        await ServerOpAsync(spaceId, restored, ImportIds.OpId($"repair:txmeta-overlay:{spaceId}:{restored}"), ServerHlc.Now(2), ("catId", "transport"), ("needsReview", 0));
        Assert.EndsWith($"-{ServerHlc.DeviceId}", VersionOf(Row(spaceId, restored), "needsReview"));

        Assert.Equal(2, await RepairAsync(spaceId));

        // the prediction's marks are back to review, the suggested category untouched
        foreach (var id in new[] { predicted, liveClock })
        {
            var row = Row(spaceId, id);
            Assert.Contains("\"needsReview\":1", row.DataJson);
            Assert.Contains("\"catId\":\"groceries\"", row.DataJson);
            Assert.EndsWith($"-{ServerHlc.DeviceId}", VersionOf(row, "needsReview"));
        }
        // a device's word stands, whichever way it got there
        Assert.Contains("\"needsReview\":0", Row(spaceId, reviewed).DataJson);
        Assert.Contains("\"needsReview\":0", Row(spaceId, autoLinked).DataJson);
        Assert.Contains("\"needsReview\":0", Row(spaceId, restored).DataJson);
        Assert.Contains("\"catId\":\"transport\"", Row(spaceId, restored).DataJson);
        Assert.Contains("\"needsReview\":1", Row(spaceId, unreviewed).DataJson);

        // the devices pull the repair as ordinary ops
        var pull = await client.GetFromJsonAsync<PullResponse>($"/sync/{spaceId}/pull?since=0");
        var repairOp = Assert.Single(pull!.Ops, o => o.EntityId == predicted && o.Fields.ContainsKey("needsReview") && o.Fields["needsReview"].GetInt32() == 1);
        Assert.Equal(ImportIds.OpId($"repair:needs-review:{spaceId}:{predicted}"), repairOp.OpId);
        Assert.EndsWith($"-{ServerHlc.DeviceId}", repairOp.Hlc);
        Assert.Single(repairOp.Fields);   // only the flag moves

        // a later word from the person outranks the repair, as any device op does
        var laterStamp = ServerHlc.Encode(DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(), 0).Replace($"-{ServerHlc.DeviceId}", "-dev1");
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1", [Device(spaceId, predicted, laterStamp, ("needsReview", 0))]));
        Assert.Contains("\"needsReview\":0", Row(spaceId, predicted).DataJson);

        // idempotent: the second pass finds nothing to do
        Assert.Equal(0, await RepairAsync(spaceId));
    }

    [Fact]
    public async Task The_startup_hook_runs_once_per_database()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var marker = await db.AppSettings.FindAsync([NeedsReviewRepair.SettingKey]);
        if (marker is not null) { db.AppSettings.Remove(marker); await db.SaveChangesAsync(); }

        await NeedsReviewRepair.RunOnceAsync(db, NullLogger.Instance, CancellationToken.None);
        Assert.NotNull(await db.AppSettings.FindAsync([NeedsReviewRepair.SettingKey]));
        Assert.Equal(0, await NeedsReviewRepair.RunOnceAsync(db, NullLogger.Instance, CancellationToken.None));
    }
}
