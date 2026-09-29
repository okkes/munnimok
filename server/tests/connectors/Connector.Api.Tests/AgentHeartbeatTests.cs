using System.Net;
using System.Net.Http.Headers;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Manifests;
using Microsoft.EntityFrameworkCore;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// Whether an agent is ALIVE is not a fact that profile bookkeeping gets a vote
/// on.
///
/// <para>
/// The heartbeat used to set <c>LastHeartbeatAt</c>, reconcile the agent's
/// browser profiles, and commit both in ONE <c>SaveChangesAsync</c>. So a
/// profile row the database refused took the liveness with it - and the agent
/// side logs a failed heartbeat at Debug and carries on.
/// </para>
///
/// <para>
/// <b>It was reachable, and it was silent.</b> A BYO agent derived its profile
/// id as <c>"own-" + providerId</c>, identical on every machine that had run
/// the same provider, and the table is keyed on that id alone. The second
/// household to connect ASN therefore collided for ever: their agent ran
/// perfectly, held its browser, served nothing, and appeared offline in every
/// consumer - while the fleet stopped standing back for it, which is the one
/// benefit they installed it for.
/// </para>
///
/// <para>
/// The id is fixed at the source. This is the other half: whatever goes wrong
/// with the bookkeeping, an agent that spoke to us is recorded as having spoken
/// to us.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class AgentHeartbeatTests(ShopApiFactory factory)
{
    /// <summary>
    /// Two machines reporting THE SAME profile id, which is what the derived
    /// id used to guarantee and what any future derivation could reintroduce.
    /// </summary>
    private const string Shared = "own-ah";

    /// <summary>The one provider every agent in this file claims to serve.</summary>
    private static readonly string[] ClaimedProviders = ["ah"];

    [Fact]
    public async Task A_profile_the_database_refuses_does_not_cost_an_agent_its_liveness()
    {
        var first = await EnrollAsync("first household");
        var second = await EnrollAsync("second household");

        // The first one takes the id, exactly as the first household to
        // connect a provider does.
        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(first.Token, Shared)).StatusCode);

        var before = await LastBeatAsync(second.AgentId);

        // And the second one arrives carrying the same id. The insert cannot
        // succeed - that is the point - and what is under test is everything
        // that happens anyway.
        var answered = await HeartbeatAsync(second.Token, Shared);

        Assert.Equal(HttpStatusCode.OK, answered.StatusCode);

        var after = await LastBeatAsync(second.AgentId);

        Assert.True(
            after > before,
            "the second agent's heartbeat was rolled back by a profile row, so a machine that is running "
            + "and talking to us is recorded as offline - and nothing anywhere says why");
    }

    /// <summary>
    /// AND IT KEEPS BEATING, rather than failing once and then for ever.
    /// </summary>
    /// <remarks>
    /// A collision is not a one-off: the other household's row is still there
    /// on the next heartbeat, and the one after that. An agent that recovered
    /// its liveness once and lost it again thirty seconds later is an agent
    /// that is still offline.
    /// <para>
    /// This also pins the thing the endpoint does NOT need to do. A failed
    /// insert stays in the change tracker, so clearing it looks necessary -
    /// and the context is scoped per request, so it is not. That was written,
    /// mutation-tested, found to change nothing, and removed.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task An_agent_that_collided_once_goes_on_beating_afterwards()
    {
        var first = await EnrollAsync("holder of the id");
        var second = await EnrollAsync("the one that collides");

        await HeartbeatAsync(first.Token, Shared);
        await HeartbeatAsync(second.Token, Shared);

        var afterFirstCollision = await LastBeatAsync(second.AgentId);

        // A second and a third, as a real agent sends every thirty seconds.
        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(second.Token, Shared)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await HeartbeatAsync(second.Token, Shared)).StatusCode);

        Assert.True(
            await LastBeatAsync(second.AgentId) > afterFirstCollision,
            "the collision poisoned the context, so every heartbeat after it failed too");
    }

    /// <summary>
    /// And on the ordinary path the profile is still written down.
    /// </summary>
    /// <remarks>
    /// Splitting the save is only correct if the bookkeeping still happens when
    /// it can. A version that quietly stopped recording profiles would pass
    /// both tests above and lose the feature.
    /// </remarks>
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
