using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Tests.Connectors;

/// <summary>The operator's view of the connectors, behind the admin scope, relayed to the control plane's own admin routes.</summary>
public class ConnectorAdminTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task The_scope_gates_the_operator_routes()
    {
        using var user = factory.ClientFor("plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/connectors/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/control/connectors/status")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/connectors/agents")).StatusCode);
    }

    [Fact]
    public async Task The_status_line_names_the_providers_the_agents_and_the_queue()
    {
        using var operatorClient = factory.ClientFor("the-operator", scope: Admin);
        var status = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/connectors/status");
        Assert.NotNull(status!["service"]!["kinds"]);
        Assert.Contains(status["providers"]!.AsArray(), p => p!["providerId"]!.GetValue<string>() == "mock-store-simple");
        Assert.NotNull(status["agents"]!["online"]);
        Assert.NotNull(status["queue"]!["queued"]);
        Assert.NotNull(status["relay"]!["openStreams"]);
        Assert.DoesNotContain("provider_id", status.ToJsonString(), StringComparison.Ordinal);

        var cockpit = await operatorClient.GetFromJsonAsync<JsonObject>("/control/connectors/status");
        Assert.NotNull(cockpit!["providers"]);
    }

    [Fact]
    public async Task The_kill_switch_pauses_a_party_and_the_catalogue_says_so()
    {
        using var operatorClient = factory.ClientFor("the-pauser", scope: Admin);
        using var shopper = factory.ClientFor("paused-shopper");

        using var paused = await operatorClient.PostAsJsonAsync("/admin/connectors/providers/mock-store-broken/status", new { state = "paused", reasonKey = "connect.paused.maintenance" });
        Assert.Equal(HttpStatusCode.OK, paused.StatusCode);
        var view = await paused.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal("paused", view!["state"]!.GetValue<string>());

        var catalogue = await shopper.GetFromJsonAsync<JsonObject>("/connectors/providers");
        var broken = catalogue!["providers"]!.AsArray().Single(p => p!["id"]!.GetValue<string>() == "mock-store-broken")!;
        Assert.Equal("paused", broken["status"]!["state"]!.GetValue<string>());
        Assert.Equal("connect.paused.maintenance", broken["status"]!["reasonKey"]!.GetValue<string>());

        // a login against a paused party is refused with the envelope
        using var login = await shopper.PostAsJsonAsync("/connectors/mock-store-broken/login", new { connectionId = "conn-paused", inputs = Credentials });
        Assert.False(login.IsSuccessStatusCode);
        Assert.NotNull((await login.Content.ReadFromJsonAsync<JsonObject>())!["error"]!["code"]);

        using var resumed = await operatorClient.PostAsJsonAsync("/admin/connectors/providers/mock-store-broken/status", new { state = "healthy" });
        Assert.True(resumed.StatusCode == HttpStatusCode.OK, await resumed.Content.ReadAsStringAsync());
        Assert.Equal("healthy", (await resumed.Content.ReadFromJsonAsync<JsonObject>())!["state"]!.GetValue<string>());

        // "active" is a session's word, not a party's — the control plane says healthy
        using var nonsense = await operatorClient.PostAsJsonAsync("/admin/connectors/providers/mock-store-broken/status", new { state = "active" });
        Assert.Equal(HttpStatusCode.BadRequest, nonsense.StatusCode);
    }

    [Fact]
    public async Task The_fleet_and_the_canaries_are_readable_and_a_users_sessions_are_listed()
    {
        using var operatorClient = factory.ClientFor("the-lister", scope: Admin);
        using var shopper = factory.ClientFor("listed-shopper");
        using var login = await shopper.PostAsJsonAsync("/connectors/mock-store-simple/login", new { connectionId = "conn-listed", inputs = Credentials });
        var sessionId = (await login.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]!.GetValue<string>();

        var fleet = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/connectors/agents");
        Assert.NotNull(fleet!["agents"]);
        var canaries = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/connectors/canaries");
        Assert.NotNull(canaries);

        var sessions = await operatorClient.GetFromJsonAsync<JsonArray>("/admin/connectors/users/listed-shopper/sessions");
        var listed = Assert.Single(sessions!);
        Assert.Equal(sessionId, listed!["sessionId"]!.GetValue<string>());
        Assert.Equal("conn-listed", listed["connectionId"]!.GetValue<string>());
        Assert.DoesNotContain("bundle", sessions!.ToJsonString(), StringComparison.OrdinalIgnoreCase);

        var diagnosis = await operatorClient.GetFromJsonAsync<JsonObject>("/admin/users/listed-shopper/diagnosis");
        Assert.Contains(diagnosis!["connectorSessions"]!.AsArray(), s => s!["sessionId"]!.GetValue<string>() == sessionId);

        Assert.Equal(HttpStatusCode.NotFound, (await operatorClient.GetAsync("/admin/connectors/users/nobody-here/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await operatorClient.DeleteAsync("/admin/connectors/agents/agt_00000000000000000000000000")).StatusCode);
    }
}
