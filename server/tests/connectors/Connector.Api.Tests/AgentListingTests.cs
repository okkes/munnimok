using System.Net;
using System.Text.Json;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Manifests;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// WHAT "ONLINE" MEANS, pinned, because two things now depend on it agreeing
/// with itself.
///
/// <para>
/// The agent listing is what a consumer offers to pick from, and a persistent
/// login naming an agent is refused unless that agent is online. Those two
/// used to carry separate copies of a ninety-second window - the listing, the
/// queue's fleet head start and the <c>/status</c> pool count each had one -
/// and nothing held them together but the habit of copying the last. The
/// moment the refusal joined them, a drift stopped being cosmetic: a picker
/// offering a machine the login then turns away, or turning away one the
/// picker calls live.
/// </para>
///
/// <para>
/// So the value is asserted in two places on purpose. Once against the rule
/// itself, at its exact boundary, with a fixed clock. And once through the
/// listing, with real rows and the real clock, on either side of the boundary
/// by a margin wide enough that a slow test box cannot cross it - which is
/// what makes a local constant quietly reintroduced into the listing show up
/// as a red test rather than as a support ticket.
/// </para>
///
/// <para>
/// And a third thing depends on it now, from the other side: the interval the
/// enrollment response hands an agent. Ninety seconds is three beats of
/// thirty, and nothing but that arithmetic made the constant reasonable - so
/// a configured interval that does not fit inside it is a stack that refuses
/// its own healthy agents on a schedule. The start-up refusal that holds the
/// two together is asserted at the end of this file, because the number it
/// protects is the one this file exists to pin.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class AgentListingTests(ShopApiFactory factory)
{
    /// <summary>
    /// Three missed beats, not one, at an interval of thirty seconds: the
    /// ninetieth second is the first one that is NOT online.
    /// </summary>
    [Fact]
    public void An_agent_is_online_until_its_third_missed_beat()
    {
        var now = new DateTimeOffset(2026, 9, 19, 12, 0, 0, TimeSpan.Zero);

        Assert.Equal(90, AgentLiveness.OfflineAfterSeconds);
        Assert.Equal(now.AddSeconds(-90), AgentLiveness.OnlineSince(now));

        Assert.True(AgentLiveness.IsOnline(Agent(now.AddSeconds(-89)), now));
        Assert.False(AgentLiveness.IsOnline(Agent(now.AddSeconds(-90)), now));
    }

    /// <summary>
    /// Revoked wins over any heartbeat. An agent revoked a second ago has a
    /// heartbeat a second old, and is not one anybody may pick.
    /// </summary>
    [Fact]
    public void A_revoked_agent_is_offline_however_recently_it_beat()
    {
        var now = new DateTimeOffset(2026, 9, 19, 12, 0, 0, TimeSpan.Zero);

        Assert.False(AgentLiveness.IsOnline(Agent(now, revoked: true), now));
    }

    /// <summary>
    /// And the listing reports exactly that rule. Eighty seconds is inside the
    /// window and a hundred is outside it, ten seconds clear on either side of
    /// the boundary so that the time this request takes cannot move a row
    /// across it.
    /// </summary>
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

    /// <summary>
    /// AND THE CONFIGURED INTERVAL HAS TO FIT INSIDE THE WINDOW, or the
    /// platform will not start.
    /// </summary>
    /// <remarks>
    /// The third thing that now depends on ninety seconds, and the one nothing
    /// held. <see cref="AgentLiveness.OfflineAfterSeconds"/> is a constant; the
    /// beat an agent is told to keep is <c>Connector:Timeouts:HeartbeatSeconds</c>,
    /// and nothing tied the two together. Sixty seconds is a perfectly
    /// reasonable-looking value - half a minute felt chatty, so somebody
    /// doubles it - and it means the third beat lands at a hundred and eighty
    /// seconds, twice the window. Every agent in the fleet is then judged
    /// offline for two thirds of every cycle WHILE RUNNING NORMALLY, and since
    /// the window became a refusal rather than a label on a listing, that is
    /// logins turned away with <c>agent_unavailable</c> and fetches turned away
    /// the same way, intermittently, on a healthy stack.
    /// <para>
    /// Both numbers are named in the refusal because the fix could be either
    /// one, and a message that reported only the interval would send somebody
    /// looking for a limit it does not mention.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// And the shipped interval is accepted, in the mode this stack runs in.
    /// </summary>
    /// <remarks>
    /// Thirty seconds is the default and exactly three beats - the boundary
    /// itself, which is the value most likely to be broken by a check written
    /// with the wrong comparison. A refusal here would mean nothing starts at
    /// all.
    /// <para>
    /// Development on purpose. <c>Validate</c> returns early outside
    /// production for every other refusal it carries, because every other one
    /// is about a secret a laptop is meant to be missing. This check sits
    /// ahead of that return, and the pair of tests is what says so: one fires
    /// in development, and the other proves the early return still happens.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_shipped_thirty_second_beat_is_exactly_three_beats_and_starts()
    {
        var options = new ConnectorOptions { Mode = ConnectorMode.Development };
        options.Timeouts.HeartbeatSeconds = 30;

        ConnectorPlatform.Validate(options);

        // The same configuration with nothing production needs still starts,
        // which is what places the new check ahead of the production gate
        // rather than inside it.
        Assert.Equal(30, options.Timeouts.HeartbeatSeconds);
    }

    /// <summary>
    /// And it fires in production too, where it is one problem among the
    /// production floor rather than the only one.
    /// </summary>
    /// <remarks>
    /// A check placed ahead of an early return is easy to place ahead of the
    /// problem list as well, in which case production would collect its own
    /// problems and throw without this one ever being mentioned. The deploy
    /// that needs it most would then be told about five things and not this.
    /// </remarks>
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

    /// <summary>
    /// Straight into the table, as the heartbeat suite does: the one-time code
    /// and its HMAC are somebody else's test.
    /// </summary>
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
