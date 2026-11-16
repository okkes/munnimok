using System.Net;
using System.Text.Json;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Manifests;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// "online" is one 90s window (three beats of 30s) shared by the listing and the refusal of a persistent login;
/// asserted at the exact boundary with a fixed clock, and through the listing with margins a slow box cannot cross
[Collection(ShopApiCollection.Name)]
public sealed class AgentListingTests(ShopApiFactory factory)
{
    [Fact]
    public void An_agent_is_online_until_its_third_missed_beat()
    {
        var now = new DateTimeOffset(2026, 9, 19, 12, 0, 0, TimeSpan.Zero);

        Assert.Equal(90, AgentLiveness.OfflineAfterSeconds);
        Assert.Equal(now.AddSeconds(-90), AgentLiveness.OnlineSince(now));

        Assert.True(AgentLiveness.IsOnline(Agent(now.AddSeconds(-89)), now));
        Assert.False(AgentLiveness.IsOnline(Agent(now.AddSeconds(-90)), now));
    }

    [Fact]
    public void A_revoked_agent_is_offline_however_recently_it_beat()
    {
        var now = new DateTimeOffset(2026, 9, 19, 12, 0, 0, TimeSpan.Zero);

        Assert.False(AgentLiveness.IsOnline(Agent(now, revoked: true), now));
    }

    /// 80s is inside the window and 100s outside: ten seconds clear, so the request's own time cannot move a row across
    [Fact]
    public async Task The_listing_calls_an_agent_online_by_the_platforms_one_window()
    {
        var owner = Flows.NewSubject("listing");
        var recent = Enroll(owner, lastBeat: DateTimeOffset.UtcNow.AddSeconds(-80));
        var silent = Enroll(owner, lastBeat: DateTimeOffset.UtcNow.AddSeconds(-100));

        using var http = factory.CreateAuthorizedClient().ActAs(owner);
        using var response = await http.GetAsync("/v1/agents");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var listed = (await response.JsonAsync()).GetProperty("agents");

        Assert.True(Row(listed, recent).GetProperty("online").GetBoolean());
        Assert.False(Row(listed, silent).GetProperty("online").GetBoolean());

        // #441 L4: the agent's own claims ride on its view, as it last made them
        var claims = Row(listed, recent).GetProperty("capabilities");
        Assert.Equal(1, claims.GetProperty("max_concurrency").GetInt32());
        Assert.Equal("pooled", claims.GetProperty("class").GetString());
    }

    /// a heartbeat interval whose three beats exceed the 90s window refuses start-up: healthy agents would be judged
    /// offline and logins/fetches turned away with agent_unavailable
    [Fact]
    public void A_heartbeat_slower_than_a_third_of_the_window_refuses_to_start()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Development };
        options.Timeouts.HeartbeatSeconds = 60;

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Contains(
            "Connector:Timeouts:HeartbeatSeconds is 60, so three beats take 180s - longer than the 90s "
            + "AgentLiveness.OfflineAfterSeconds allows an agent to be silent",
            refused.Message,
            StringComparison.Ordinal);
    }

    /// the default 30s is exactly three beats, the boundary; Development on purpose:
    /// the check sits ahead of Validate's early return
    [Fact]
    public void The_shipped_thirty_second_beat_is_exactly_three_beats_and_starts()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Development };
        options.Timeouts.HeartbeatSeconds = 30;

        ConnectorPlatform.Validate(options);

        Assert.Equal(30, options.Timeouts.HeartbeatSeconds);
    }

    /// the check also fires in production, alongside the production floor's other problems rather than behind them
    [Fact]
    public void The_coupling_is_reported_alongside_the_production_floor()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Production };
        options.Timeouts.HeartbeatSeconds = 60;

        var refused = Assert.Throws<InvalidOperationException>(() => ConnectorPlatform.Validate(options));

        Assert.Contains("Connector:Timeouts:HeartbeatSeconds is 60", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Connector:Auth:Authority is required in production", refused.Message, StringComparison.Ordinal);
    }

    private static JsonElement Row(JsonElement agents, string id) =>
        agents.EnumerateArray().Single(a => a.Text("id") == id);

    private static AgentRow Agent(DateTimeOffset lastBeat, bool revoked = false) => new()
    {
        Id = "agt_pinned",
        Name = "pinned",
        Class = AgentClass.Byo,
        LastHeartbeatAt = lastBeat,
        Revoked = revoked,
        CreatedAt = lastBeat,
    };

    /// straight into the table, as the heartbeat suite does: the one-time code and its HMAC are another test's concern
    private string Enroll(string owner, DateTimeOffset lastBeat)
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "listed test agent",
            Class = AgentClass.Byo,
            OwnerSubject = owner,
            CapabilitiesJson = "{}",
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = lastBeat,
            CreatedAt = lastBeat,
        }));

        return id;
    }
}
