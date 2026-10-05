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
/// The 2026-10-05 repair: a prediction overlay the server stamped with its
/// live clock buried what a device had filed before it — the repair puts
/// the device's value back, once, and leaves every other row alone.
/// </summary>
public class TxMetaOverlayRepairTests : IClassFixture<FeedsApiFactory>
{
    private readonly FeedsApiFactory _factory;

    public TxMetaOverlayRepairTests(FeedsApiFactory factory) => _factory = factory;

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

    /// <summary>What the ingest used to write: the overlay with the server's live clock.</summary>
    private async Task OverlayAsync(string spaceId, string entityId, int counter, params (string Name, object Value)[] fields)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var space = await db.Spaces.SingleAsync(s => s.Id == spaceId);
        await new SyncWriter(db).ApplyAsync(space, null, [new SyncOpDto(ImportIds.OpId($"test-overlay:{spaceId}:{entityId}:{counter}"), spaceId, "txMeta", entityId, Fields(fields), ServerHlc.Now(counter))]);
        await db.SaveChangesAsync();
    }

    private async Task<int> RepairAsync()
    {
        using var scope = _factory.Services.CreateScope();
        return await TxMetaOverlayRepair.RepairAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), CancellationToken.None);
    }

    private EntityRow Row(string spaceId, string entityId)
    {
        using var scope = _factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<AppDbContext>().EntityRows
            .Single(r => r.SpaceId == spaceId && r.Entity == "txMeta" && r.EntityId == entityId);
    }

    [Fact]
    public async Task A_device_value_the_overlay_buried_comes_back_once_and_reaches_the_devices()
    {
        var spaceId = $"space_{Guid.NewGuid():N}";
        var sub = $"repair_{Guid.NewGuid():N}";
        var client = ClientFor(sub);
        const string buried = "meta-buried";
        const string later = "meta-later";
        const string untouched = "meta-untouched";
        const string partial = "meta-partial";

        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [new SyncOpDto(Guid.NewGuid().ToString("N"), spaceId, "space", spaceId, Fields(("name", "Repair")), "000000100-0000-dev1")]));
        // the person filed four rows, then the overlay landed with the server's live clock
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
        [
            Device(spaceId, buried, "000000200-0000-dev1", ("txId", "t1"), ("catId", "tuition"), ("needsReview", 0)),
            Device(spaceId, partial, "000000201-0000-dev1", ("txId", "t2"), ("needsReview", 0)),
            Device(spaceId, later, "000000202-0000-dev1", ("txId", "t3"), ("catId", "transport"), ("needsReview", 0)),
        ]));
        await OverlayAsync(spaceId, buried, 1, ("txId", "t1"), ("catId", "uncategorized"), ("txType", "expense"), ("needsReview", 1));
        await OverlayAsync(spaceId, partial, 2, ("txId", "t2"), ("catId", "groceries"), ("txType", "expense"), ("needsReview", 0));
        await OverlayAsync(spaceId, later, 3, ("txId", "t3"), ("catId", "uncategorized"), ("txType", "expense"), ("needsReview", 1));
        await OverlayAsync(spaceId, untouched, 4, ("txId", "t4"), ("catId", "groceries"), ("txType", "expense"), ("needsReview", 0));
        // ...and on one row the person spoke again AFTER the overlay — with a clock the overlay beat anyway
        await client.PostAsJsonAsync($"/sync/{spaceId}/push", new PushRequest("dev1",
            [Device(spaceId, later, "000000203-0000-dev1", ("catId", "commute"))]));
        Assert.Contains("\"catId\":\"uncategorized\"", Row(spaceId, buried).DataJson);   // the bug, as prod saw it
        Assert.Contains("\"catId\":\"uncategorized\"", Row(spaceId, later).DataJson);

        Assert.Equal(3, await RepairAsync());

        var repaired = Row(spaceId, buried);
        Assert.Contains("\"catId\":\"tuition\"", repaired.DataJson);
        Assert.Contains("\"needsReview\":0", repaired.DataJson);
        Assert.Contains("\"txType\":\"expense\"", repaired.DataJson);   // nobody had said otherwise
        Assert.EndsWith($"-{ServerHlc.DeviceId}", JsonSerializer.Deserialize<Dictionary<string, string>>(repaired.FieldVersionsJson)!["catId"]);
        // only the field the device had carried comes back
        Assert.Contains("\"catId\":\"groceries\"", Row(spaceId, partial).DataJson);
        Assert.Contains("\"needsReview\":0", Row(spaceId, partial).DataJson);
        // a device op the overlay beat on the clock alone is still the person's latest word
        Assert.Contains("\"catId\":\"commute\"", Row(spaceId, later).DataJson);
        // a row no device ever filed keeps its prediction
        Assert.Contains("\"catId\":\"groceries\"", Row(spaceId, untouched).DataJson);

        // the devices pull the repair as ordinary ops
        var pull = await client.GetFromJsonAsync<PullResponse>($"/sync/{spaceId}/pull?since=0");
        var repairOp = Assert.Single(pull!.Ops, o => o.EntityId == buried && o.Fields.ContainsKey("catId") && o.Fields["catId"].GetString() == "tuition" && o.Hlc.EndsWith($"-{ServerHlc.DeviceId}", StringComparison.Ordinal));
        Assert.Equal(ImportIds.OpId($"repair:txmeta-overlay:{spaceId}:{buried}"), repairOp.OpId);

        // idempotent: the second pass finds nothing to do
        Assert.Equal(0, await RepairAsync());
    }

    [Fact]
    public async Task The_startup_hook_runs_once_per_database()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var marker = await db.AppSettings.FindAsync([TxMetaOverlayRepair.SettingKey]);
        if (marker is not null) { db.AppSettings.Remove(marker); await db.SaveChangesAsync(); }

        await TxMetaOverlayRepair.RunOnceAsync(db, NullLogger.Instance, CancellationToken.None);
        Assert.NotNull(await db.AppSettings.FindAsync([TxMetaOverlayRepair.SettingKey]));
        Assert.Equal(0, await TxMetaOverlayRepair.RunOnceAsync(db, NullLogger.Instance, CancellationToken.None));
    }
}
