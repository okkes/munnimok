using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.Accounts;

namespace Munni.Api.Tests.Connectors;

/// No agent runs here: a kept bundle is modelled by keeping the mock store's own.
/// Own fixture: the rows it keeps must not surprise the relay suite's write-path scan.
public class ConnectorScheduleTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string MockStore = "mock-store-simple";

    [Fact]
    public void A_bundle_is_kept_for_household_agent_and_server_custody_never_for_a_persons_own_secret()
    {
        Assert.True(ConnectorRelayEndpoints.KeepsBundle(new JsonObject { ["secret_custody"] = "agent" }));
        Assert.True(ConnectorRelayEndpoints.KeepsBundle(new JsonObject { ["secret_custody"] = "server" }));
        Assert.False(ConnectorRelayEndpoints.KeepsBundle(new JsonObject { ["secret_custody"] = "client" }));
        Assert.False(ConnectorRelayEndpoints.KeepsBundle(null));
    }

    [Fact]
    public async Task The_scheduler_syncs_a_kept_session_on_the_providers_interval_and_remembers_a_refusal()
    {
        const string sub = "scheduler";
        var (sessionId, bundle) = await LoginAsync(sub, "conn-scheduled");

        Assert.Null(factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId).KeptBundle));
        await KeepAsync(sessionId, bundle);

        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));

        var row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.NotNull(row.LastScheduledSyncAt);
        Assert.Null(row.LastScheduleError);
        Assert.Equal("active", row.State);
        Assert.NotNull(row.KeptBundle);
        var feedId = ImportIds.PersonalFeedSpaceId(ConnectorIngest.StoreFeedRef, sub);
        Assert.True(factory.Read(db => db.EntityRows.Count(r => r.SpaceId == feedId && r.Entity == "receipt")) > 0);

        Assert.Equal(0, await service.RunOnceAsync(CancellationToken.None));

        // the connector also holds a scheduled fetch to the interval: a run the relay thinks is due is refused and remembered
        await PatchAsync(sessionId, s => s.LastScheduledSyncAt = DateTimeOffset.UtcNow.AddHours(-2));
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));
        row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Equal("rate_limited", row.LastScheduleError);
        Assert.Equal("active", row.State);
        Assert.NotNull(row.KeptBundle);

        using var client = factory.ClientFor(sub);
        var sessions = await client.GetFromJsonAsync<JsonArray>("/connectors/sessions");
        var mine = sessions!.OfType<JsonObject>().Single(s => s["sessionId"]!.GetValue<string>() == sessionId);
        Assert.True(mine["scheduled"]!.GetValue<bool>());
        Assert.Equal("rate_limited", mine["lastScheduleError"]!.GetValue<string>());
        Assert.NotNull(mine["lastScheduledSyncAt"]);
    }

    [Fact]
    public async Task A_kept_bundle_the_connector_no_longer_honours_asks_the_person_to_sign_in_again()
    {
        const string sub = "scheduler-dead";
        var (sessionId, _) = await LoginAsync(sub, "conn-dead");
        await KeepAsync(sessionId, "sb_v1.not-a-bundle-anymore");

        var service = factory.Services.GetRequiredService<ConnectorScheduleService>();
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));

        var row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.NotNull(row.LastScheduleError);
        Assert.Equal("needs_reauth", row.State);
        Assert.Null(row.KeptBundle);
        Assert.Equal(0, await service.RunOnceAsync(CancellationToken.None));
    }

    /// A deploy or restart during the preferred hour's tick used to cost a whole night (prod 2026-10-08):
    /// a later hour of a day without a run still runs, once.
    [Fact]
    public void A_missed_preferred_hour_is_caught_up_later_the_same_day_and_only_once()
    {
        var manifest = new JsonObject
        {
            ["unattended_fetch"] = true,
            ["limits"] = new JsonObject { ["min_interval_seconds"] = 20 * 3600, ["preferred_fetch_hour_local"] = 3 },
        };
        var amsterdam = BankZones.ZoneFor("NL18MOCK0123456789");
        // 2026-10-06 01:10Z is 03:10 in Amsterdam (summer time until the 25th)
        var clock = new ConnectorUnitTests.TestClock(new DateTimeOffset(2026, 10, 6, 1, 10, 0, TimeSpan.Zero));
        var service = new ConnectorScheduleService(factory.Services.GetRequiredService<IServiceScopeFactory>(), clock, NullLogger<ConnectorScheduleService>.Instance);
        var row = new ConnectorSession { Id = "ses_catchup", Provider = MockStore, ConnectionId = "c", State = "active", LastScheduledSyncAt = clock.GetUtcNow().AddDays(-1) };

        Assert.True(service.IsDue(row, manifest, amsterdam));          // the preferred hour, as ever
        clock.Advance(TimeSpan.FromHours(2));                           // 05:10: that hour's tick never came — still due, nothing ran today
        Assert.True(service.IsDue(row, manifest, amsterdam));
        row.LastScheduledSyncAt = clock.GetUtcNow();                    // it ran at 05:10
        clock.Advance(TimeSpan.FromHours(1));                           // 06:10: no second run today
        Assert.False(service.IsDue(row, manifest, amsterdam));
        clock.Advance(TimeSpan.FromHours(17));                          // 23:10: the interval has passed, the day has not
        Assert.False(service.IsDue(row, manifest, amsterdam));
        clock.Advance(TimeSpan.FromHours(4));                           // 03:10 the next night: the preferred hour again
        Assert.True(service.IsDue(row, manifest, amsterdam));
        row.LastScheduledSyncAt = clock.GetUtcNow();
        clock.Advance(TimeSpan.FromHours(22));                          // 01:10 the day after: before the hour, so not yet
        Assert.False(service.IsDue(row, manifest, amsterdam));
    }

    private async Task<(string SessionId, string Bundle)> LoginAsync(string sub, string connectionId)
    {
        using var client = factory.ClientFor(sub);
        using var response = await client.PostAsJsonAsync($"/connectors/{MockStore}/login", new
        {
            connectionId,
            inputs = new Dictionary<string, string> { ["username"] = "shopper", ["password"] = "hunter2" },
        });
        var view = await response.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(response.StatusCode == HttpStatusCode.OK, view!.ToJsonString());
        return (view["sessionId"]!.GetValue<string>(), view["bundle"]!.GetValue<string>());
    }

    private Task KeepAsync(string sessionId, string bundle) => PatchAsync(sessionId, s => s.KeptBundle = bundle);

    private async Task PatchAsync(string sessionId, Action<ConnectorSession> patch)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ConnectorSessions.SingleAsync(s => s.Id == sessionId);
        patch(row);
        await db.SaveChangesAsync();
    }
}
