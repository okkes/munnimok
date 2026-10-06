using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Tests.Connectors;

/// <summary>The lab's view of the connectors (#441), behind the admin scope, relayed to the control plane's own routes.</summary>
public class ConnectorLabTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task The_scope_gates_the_lab_and_the_cockpit()
    {
        using var user = factory.ClientFor("plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/lab/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/lab/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/control/connectors/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/lab/agents")).StatusCode);

        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        var ping = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/ping");
        Assert.True(ping!["admin"]!.GetValue<bool>());
    }

    [Fact]
    public async Task The_lab_subject_is_the_operators_own_and_never_the_apps()
    {
        using var operatorClient = factory.ClientFor("lab-operator", scope: Admin);
        var me = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/me");
        var labSubject = me!["subject"]!.GetValue<string>();
        Assert.StartsWith("u_", labSubject, StringComparison.Ordinal);

        // the app's own agent list is the APP subject's: an agent enrolled for the lab must not appear there
        using var minted = await operatorClient.PostAsJsonAsync("/lab/agents/enrollment", new { name = "the lab box" });
        Assert.Equal(HttpStatusCode.OK, minted.StatusCode);
        var enrollment = await minted.Content.ReadFromJsonAsync<JsonObject>();
        Assert.StartsWith("AGNT-", enrollment!["code"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.Contains("docker compose -f household-agent.yml up -d", enrollment["composeCommand"]!.GetValue<string>(), StringComparison.Ordinal);
        Assert.Contains("AGENT_NAME='the lab box'", enrollment["composeCommand"]!.GetValue<string>(), StringComparison.Ordinal);

        // the same person asking twice is the same lab subject; a different person is another
        var again = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/me");
        Assert.Equal(labSubject, again!["subject"]!.GetValue<string>());
        using var other = factory.ClientFor("another-operator", scope: Admin);
        var otherMe = await other.GetFromJsonAsync<JsonObject>("/lab/me");
        Assert.NotEqual(labSubject, otherMe!["subject"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_status_line_and_the_catalogue_name_the_providers_the_agents_and_the_queue()
    {
        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        var status = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/status");
        Assert.NotNull(status!["service"]!["kinds"]);
        Assert.Contains(status["providers"]!.AsArray(), p => p!["providerId"]!.GetValue<string>() == "mock-store-simple");
        Assert.NotNull(status["agents"]!["online"]);
        Assert.NotNull(status["queue"]!["queued"]);
        Assert.NotNull(status["relay"]!["openStreams"]);
        Assert.DoesNotContain("provider_id", status.ToJsonString(), StringComparison.Ordinal);

        var catalogue = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/providers");
        var simple = catalogue!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "mock-store-simple")!;
        Assert.Equal("store", simple["kind"]!.GetValue<string>());
        Assert.NotNull(simple["status"]!["state"]);
        Assert.NotNull(simple["resources"]);

        var one = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/providers/mock-store-simple");
        Assert.Equal("mock-store-simple", one!["id"]!.GetValue<string>());
        Assert.NotNull(one["auth"]);

        var cockpit = await operatorClient.GetFromJsonAsync<JsonObject>("/control/connectors/status");
        Assert.NotNull(cockpit!["providers"]);
    }

    [Fact]
    public async Task The_kill_switch_pauses_a_party_and_the_catalogue_says_so()
    {
        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        using var shopper = factory.ClientFor("paused-shopper");

        using var paused = await operatorClient.PostAsJsonAsync("/lab/providers/mock-store-broken/status", new { state = "paused", reasonKey = "connect.paused.maintenance" });
        Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        var view = await paused.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal("paused", view!["state"]!.GetValue<string>());
        Assert.Equal("connect.paused.maintenance", view["reasonKey"]!.GetValue<string>());

        var catalogue = await shopper.GetFromJsonAsync<JsonObject>("/connectors/providers");
        var broken = catalogue!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "mock-store-broken")!;
        Assert.Equal("paused", broken["status"]!["state"]!.GetValue<string>());

        using var refused = await shopper.PostAsJsonAsync("/connectors/mock-store-broken/login", new
        {
            connectionId = Guid.NewGuid().ToString(),
            inputs = Credentials,
            consent = new { acceptedAt = DateTimeOffset.UtcNow, termsVersion = "v1" },
        });
        Assert.NotEqual(HttpStatusCode.OK, refused.StatusCode);

        using var resumed = await operatorClient.PostAsJsonAsync("/lab/providers/mock-store-broken/status", new { state = "healthy" });
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        var after = await shopper.GetFromJsonAsync<JsonObject>("/connectors/providers");
        Assert.Equal("healthy", after!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "mock-store-broken")!["status"]!["state"]!.GetValue<string>());

        using var nonsense = await operatorClient.PostAsJsonAsync("/lab/providers/mock-store-broken/status", new { state = "active" });
        Assert.Equal(HttpStatusCode.BadRequest, nonsense.StatusCode);
    }

    [Fact]
    public async Task A_hosted_private_agent_is_asked_for_approved_and_taken_back_through_the_lab()
    {
        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        using var asker = factory.ClientFor("slot-asker");
        var slotId = await factory.ControlPlane.EnrollPrivateSlotAsync("munni test private agent 1");

        using var asked = await asker.PostAsync("/connectors/private-agents/requests", null);
        Assert.Equal(HttpStatusCode.OK, asked.StatusCode);
        var requestId = (await asked.Content.ReadFromJsonAsync<JsonObject>())!["id"]!.GetValue<string>();

        var overview = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/private-agents");
        Assert.Equal(1, overview!["free"]!.GetValue<int>());
        var pending = overview["requests"]!.AsArray().Single(r => r!["id"]!.GetValue<string>() == requestId)!;
        Assert.Equal("pending", pending["state"]!.GetValue<string>());
        Assert.NotNull(pending["who"]);

        using var approved = await operatorClient.PostAsync($"/lab/private-agents/requests/{requestId}/approve", null);
        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        var mine = await asker.GetFromJsonAsync<JsonObject>("/connectors/private-agents/mine");
        Assert.Equal(slotId, mine!["agent"]!["id"]!.GetValue<string>());

        using var taken = await operatorClient.PostAsync($"/lab/private-agents/{slotId}/release", null);
        Assert.Equal(HttpStatusCode.NoContent, taken.StatusCode);
        var slots = (await operatorClient.GetFromJsonAsync<JsonObject>("/lab/private-agents"))!["slots"]!.AsArray();
        var slot = slots.Single(s => s!["agent"]!["id"]!.GetValue<string>() == slotId)!;
        Assert.False(slot["agent"]!["bound"]!.GetValue<bool>());
        Assert.True(slot["agent"]!["resetting"]!.GetValue<bool>());

        using var asked2 = await asker.PostAsync("/connectors/private-agents/requests", null);
        var second = (await asked2.Content.ReadFromJsonAsync<JsonObject>())!["id"]!.GetValue<string>();
        using var denied = await operatorClient.PostAsync($"/lab/private-agents/requests/{second}/deny", null);
        Assert.Equal(HttpStatusCode.OK, denied.StatusCode);
        Assert.Equal("denied", (await asker.GetFromJsonAsync<JsonObject>("/connectors/private-agents/mine"))!["request"]!["state"]!.GetValue<string>());

        using var plain = factory.ClientFor("plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await plain.GetAsync("/lab/private-agents")).StatusCode);
    }

    [Fact]
    public async Task The_fleet_and_the_canaries_are_readable_and_a_users_sessions_are_listed()
    {
        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        using var shopper = factory.ClientFor("listed-shopper");
        var connectionId = Guid.NewGuid().ToString();
        using var login = await shopper.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId, inputs = Credentials, consent = new { acceptedAt = DateTimeOffset.UtcNow, termsVersion = "v1" } });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var fleet = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/agents");
        Assert.NotNull(fleet!["agents"]);
        var canaries = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/canaries");
        Assert.NotNull(canaries!["canaries"]);

        var sessions = await operatorClient.GetFromJsonAsync<JsonArray>("/lab/users/listed-shopper/sessions");
        var row = Assert.Single(sessions!);
        Assert.Equal("mock-store-simple", row!["provider"]!.GetValue<string>());
        Assert.Equal(connectionId, row["connectionId"]!.GetValue<string>());

        var diagnosis = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/users/listed-shopper/diagnosis");
        Assert.Equal(connectionId, diagnosis!["connectorSessions"]!.AsArray().Single()!["connectionId"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.NotFound, (await operatorClient.GetAsync("/lab/users/nobody-here/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await operatorClient.DeleteAsync("/lab/agents/agt_00000000000000000000000000")).StatusCode);
    }
}
