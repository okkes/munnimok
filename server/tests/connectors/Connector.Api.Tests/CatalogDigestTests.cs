using System.Net;
using System.Net.Http.Headers;
using Connector.Api.Tests.Infrastructure;
using Connector.Kit;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Agents;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Api.Tests;

/// <summary>
/// An agent on another adapter catalogue - other code, or the same code
/// configured differently - is enrolled, alive, told so on every heartbeat,
/// shown as stale to the operator, and leased nothing. One on the same
/// catalogue takes the work.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class CatalogDigestTests(ShopApiFactory factory)
{
    private const string Provider = "ah";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private string Ours => factory.Services.GetRequiredService<IProviderRegistry>().CatalogDigest;

    [Fact]
    public void An_agent_that_claims_another_catalogue_is_stale_and_one_that_claims_none_is_not_judged()
    {
        var registry = factory.Services.GetRequiredService<IProviderRegistry>();

        Assert.False(AgentCatalogue.IsStale(new AgentCapabilities(), registry));
        Assert.False(AgentCatalogue.IsStale(new AgentCapabilities { CatalogDigest = registry.CatalogDigest }, registry));
        Assert.True(AgentCatalogue.IsStale(new AgentCapabilities { CatalogDigest = "sha256:elsewhere" }, registry));
    }

    [Fact]
    public async Task A_stale_agent_is_leased_nothing_while_a_current_one_takes_the_job()
    {
        var stale = Enroll("sha256:somebody-elses-adapters");
        var current = Enroll(Ours);
        var job = await QueueLoginAsync();

        using (var refused = await LeaseAsync(stale.Token, TimeSpan.FromSeconds(2)))
        {
            Assert.Null(refused);
        }

        Assert.Equal(JobState.Queued, StateOf(job));

        // other tests leave work on this provider's queue; the current agent
        // leases until it reaches ours
        string leasedId;
        var seen = 0;
        do
        {
            using var leased = await LeaseAsync(current.Token, TimeSpan.FromSeconds(20));
            Assert.NotNull(leased);
            Assert.Equal(HttpStatusCode.OK, leased.StatusCode);
            leasedId = (await leased.JsonAsync()).Text("job_id");
            seen++;
        } while (leasedId != job && seen < 25);

        Assert.Equal(job, leasedId);

        using var operatorSide = factory.CreateAuthorizedClient();
        using var listed = await operatorSide.GetAsync("/v1/admin/agents");
        var agents = (await listed.JsonAsync()).GetProperty("agents").EnumerateArray().ToList();
        Assert.True(agents.Single(a => a.Text("id") == stale.Id).GetProperty("stale").GetBoolean());
        Assert.False(agents.Single(a => a.Text("id") == current.Id).GetProperty("stale").GetBoolean());
    }

    [Fact]
    public async Task The_heartbeat_tells_an_agent_which_catalogue_the_control_plane_runs()
    {
        var agent = Enroll(Ours);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", agent.Token);
        using var request = Wire.Post("/agent/v1/heartbeat", new
        {
            capabilities = new { providers = new[] { Provider }, catalog_digest = Ours },
            profiles = Array.Empty<object>(),
        });

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Ours, (await response.JsonAsync()).Text("catalog_digest"));
    }

    private sealed record Enrolled(string Id, string Token);

    private Enrolled Enroll(string digest)
    {
        var id = Ids.New(Ids.Agent);
        var token = "tok_" + Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var capabilities = new AgentCapabilities
        {
            Providers = [Provider],
            Egress = new EgressRequirement { Country = "NL", Kind = EgressRequirement.Residential },
            CatalogDigest = digest,
        };

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "digest test agent",
            Class = AgentClass.Pooled,
            OwnerSubject = ConnectorOptions.DevFleetSubject,
            CapabilitiesJson = ConnectorJson.Serialize(capabilities),
            TokenHash = AgentAuth.Hash(token),
            LastHeartbeatAt = now,
            CreatedAt = now,
        }));

        return new Enrolled(id, token);
    }

    private async Task<string> QueueLoginAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = Provider,
            Subject = Flows.NewSubject("digest"),
            State = SessionState.Queued,
            ExpiresAt = now.AddHours(1),
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.Sessions.Add(session);
        await db.SaveChangesAsync(CancellationToken.None);

        var job = await queue.EnqueueAsync(new NewJob
        {
            SessionId = session.Id,
            ProviderId = Provider,
            Kind = JobKind.Login,
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = session.Subject,
                ["password"] = "hunter2",
            },
        }, CancellationToken.None);

        return job.Id;
    }

    /// <summary>One long poll, given up after <paramref name="patience"/>: null is "nothing came".</summary>
    private async Task<HttpResponseMessage?> LeaseAsync(string token, TimeSpan patience)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var request = Wire.Post("/agent/v1/jobs/lease", new { accept = new[] { "login" } });
        using var giveUp = new CancellationTokenSource(patience);

        try
        {
            var response = await client.SendAsync(request, giveUp.Token);
            if (response.StatusCode == HttpStatusCode.NoContent)
            {
                response.Dispose();
                return null;
            }

            return response;
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private JobState StateOf(string jobId) =>
        Db.Read(factory, db => db.Jobs.Where(j => j.Id == jobId).Select(j => j.State).Single());
}
