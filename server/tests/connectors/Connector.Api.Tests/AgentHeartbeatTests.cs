using System.Net;
using System.Net.Http.Headers;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// liveness is recorded whatever the profile bookkeeping does: a BYO profile id ("own-" + providerId) collides across
/// households, and the one-save heartbeat used to roll LastHeartbeatAt back with the refused row
[Collection(ShopApiCollection.Name)]
public sealed class AgentHeartbeatTests(ShopApiFactory factory)
{
    /// two machines reporting the same profile id (the table is keyed on it alone)
    private const string Shared = "own-ah";

    private static readonly string[] ClaimedProviders = ["ah"];

    [Fact]
    public async Task A_profile_the_database_refuses_does_not_cost_an_agent_its_liveness()
    {
        var first = await EnrollAsync("first household");
        var second = await EnrollAsync("second household");

        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(first.Token, Shared)).StatusCode);

        var before = await LastBeatAsync(second.AgentId);

        var answered = await HeartbeatAsync(second.Token, Shared);

        Assert.Equal(HttpStatusCode.OK, answered.StatusCode);

        var after = await LastBeatAsync(second.AgentId);

        Assert.True(
            after > before,
            "the second agent's heartbeat was rolled back by a profile row, so a machine that is running "
            + "and talking to us is recorded as offline - and nothing anywhere says why");
    }

    /// a collision repeats on every beat, so liveness must keep recording;
    /// the failed insert left in the tracker is harmless (scoped context)
    [Fact]
    public async Task An_agent_that_collided_once_goes_on_beating_afterwards()
    {
        var first = await EnrollAsync("holder of the id");
        var second = await EnrollAsync("the one that collides");

        await HeartbeatAsync(first.Token, Shared);
        await HeartbeatAsync(second.Token, Shared);

        var afterFirstCollision = await LastBeatAsync(second.AgentId);

        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(second.Token, Shared)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(second.Token, Shared)).StatusCode);

        Assert.True(
            await LastBeatAsync(second.AgentId) > afterFirstCollision,
            "the collision poisoned the context, so every heartbeat after it failed too");
    }

    /// splitting the save must not stop profiles being recorded on the ordinary path
    [Fact]
    public async Task A_heartbeat_that_can_record_its_profiles_still_does()
    {
        var agent = await EnrollAsync("ordinary");
        var mine = "own-" + Guid.NewGuid().ToString("N")[..12];

        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(agent.Token, mine)).StatusCode);

        var row = Db.Read(factory, db => db.Profiles.AsNoTracking()
            .FirstOrDefault(p => p.Id == mine && p.AgentId == agent.AgentId));

        Assert.NotNull(row);
        Assert.Equal("ah", row.ProviderId);
        Assert.True(row.Healthy);
    }

    private sealed record Enrolled(string AgentId, string Token);

    private async Task<Enrolled> EnrollAsync(string name)
    {
        // Straight into the tables: going through /agent/v1/enroll would drag
        // one-time codes and an HMAC into a test about a transaction boundary.
        var id = "agt_" + Guid.NewGuid().ToString("N");
        var token = "tok_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = name,
            Class = AgentClass.Byo,
            OwnerSubject = $"u_beat_{Guid.NewGuid():N}",
            CapabilitiesJson = "{}",
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash(token),
            LastHeartbeatAt = DateTimeOffset.UtcNow.AddMinutes(-5),
            CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-5),
        }));

        await Task.CompletedTask;
        return new Enrolled(id, token);
    }

    private async Task<HttpResponseMessage> HeartbeatAsync(string token, string profileId)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var request = Wire.Post("/agent/v1/heartbeat", new
        {
            capabilities = new { providers = ClaimedProviders, @class = "byo" },
            profiles = new[] { new { id = profileId, provider = "ah", healthy = true } },
        });

        return await client.SendAsync(request);
    }

    private async Task<DateTimeOffset> LastBeatAsync(string agentId)
    {
        await Task.CompletedTask;

        return Db.Read(factory, db => db.Agents.AsNoTracking()
            .Where(a => a.Id == agentId)
            .Select(a => a.LastHeartbeatAt)
            .First());
    }
}
