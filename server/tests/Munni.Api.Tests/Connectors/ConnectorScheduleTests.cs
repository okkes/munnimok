using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Connectors;
using Munni.Api.Data;
using Munni.Api.GoCardless;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The scheduler of docs/connector-integration-plan.md §5.5: a session
/// whose bundle the relay keeps (household-agent custody) syncs by itself,
/// on the provider's interval, and a refusal the person must act on drops
/// the kept bundle. No agent runs in this suite, so a kept bundle is
/// modelled by keeping the mock store's own — the scheduler does not know
/// the difference, and that is the point. Its own fixture: the rows it
/// keeps must not surprise the relay suite's write-path scan.
/// </summary>
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

        // client custody: the relay kept nothing of the login
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

        // inside the provider's interval nothing runs
        Assert.Equal(0, await service.RunOnceAsync(CancellationToken.None));

        // the connector holds a scheduled fetch to the interval as well: a
        // run the relay thinks is due is refused, and the refusal is remembered
        await PatchAsync(sessionId, s => s.LastScheduledSyncAt = DateTimeOffset.UtcNow.AddHours(-2));
        Assert.Equal(1, await service.RunOnceAsync(CancellationToken.None));
        row = factory.Read(db => db.ConnectorSessions.Single(s => s.Id == sessionId));
        Assert.Equal("rate_limited", row.LastScheduleError);
        Assert.Equal("active", row.State);
        Assert.NotNull(row.KeptBundle);

        // the app sees all of it on the bindings list
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
        // and nothing runs for it again until a person signs in
        Assert.Equal(0, await service.RunOnceAsync(CancellationToken.None));
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
