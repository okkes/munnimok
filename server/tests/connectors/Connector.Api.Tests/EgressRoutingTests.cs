using System.Net;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// one rule from two sides: nobody on the wrong line may take the job, and the caller is told at once when nobody is on the
// right one, instead of a queue that cannot move until ExpireAbandonedAsync fails it half an hour later
[Collection(ShopApiCollection.Name)]
public sealed class EgressRoutingTests(ShopApiFactory factory)
{
    private const string Residential = ResidentialStoreAdapter.ProviderId;

    // a shipped provider that asks for NL and nothing more: the real catalogue, not a second double
    private const string CountryOnly = "mediamarkt-nl";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private static readonly EgressRequirement Datacenter =
        new() { Country = "NL", Kind = EgressRequirement.Any };

    private static readonly EgressRequirement Home =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    // one test for both halves: a check that also stopped serving mediamarkt would narrow production (agents claim `any`)
    // the same agent claiming a home line then takes the refused job, or a queue handing out nothing would pass
    [Fact]
    public async Task An_agent_on_the_wrong_line_is_refused_that_provider_and_still_offered_the_rest()
    {
        var subject = Flows.NewSubject("egress_lease");

        var wanted = await QueueLoginAsync(subject, Residential);
        var ordinary = await QueueLoginAsync(subject, CountryOnly);

        // country matches, kind does not: `any` is weaker than `residential`, not a wildcard
        Assert.Null(await LeaseAsync(subject, [Residential], Datacenter));
        Assert.Equal(JobState.Queued, StateOf(wanted));

        var other = await LeaseAsync(subject, [CountryOnly], Datacenter);
        Assert.NotNull(other);
        Assert.Equal(ordinary, other.JobId);

        var leased = await LeaseAsync(subject, [Residential], Home);

        Assert.NotNull(leased);
        Assert.Equal(wanted, leased.JobId);
    }

    // a missing claim is not "any address": that would make the check opt-in for deployments careful enough to fill it in
    [Fact]
    public async Task An_agent_that_claims_no_address_at_all_is_refused_as_well()
    {
        var subject = Flows.NewSubject("egress_unstated");

        var queued = await QueueLoginAsync(subject, Residential);

        Assert.Null(await LeaseAsync(subject, [Residential], claimed: null));
        Assert.Equal(JobState.Queued, StateOf(queued));
    }

    // refused at login, not after ExpireAbandonedAsync fails it; code and action are the pair the own-machine refusal uses
    [Fact]
    public async Task A_login_no_online_agent_can_reach_is_refused_before_anything_is_queued()
    {
        var subject = Flows.NewSubject("egress_none");
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var refused = await PostAsync(subject, label, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        using var body = System.Text.Json.JsonDocument.Parse(refused.Body);
        var error = body.RootElement.GetProperty("error");
        Assert.Equal("agent_unavailable", error.GetProperty("code").GetString());
        Assert.Equal("start_your_agent", error.GetProperty("user_action").GetString());

        // A refusal, not an early failure: nothing exists for anybody to poll.
        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.ProviderId == Residential
                        && db.Sessions.Any(s => s.Id == j.SessionId && s.Subject == subject))));
    }

    // an online agent on the wrong line is refused like none at all (the production NAS: every agent claims `any`)
    // enrolled under the caller's own subject: a fleet agent row would answer for every other test too
    [Fact]
    public async Task An_online_agent_on_the_wrong_line_does_not_count_as_one_that_can_reach_it()
    {
        var subject = Flows.NewSubject("egress_wrong_line");
        Enroll(subject, Datacenter);

        var refused = await PostAsync(subject, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        using var body = System.Text.Json.JsonDocument.Parse(refused.Body);
        Assert.Equal(
            "agent_unavailable",
            body.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    // the refusal lifts once a machine on a home line exists; own subject, not the fleet, for the same ordering reason
    // no agent runs this provider, so the route holds the socket for the login wait: assertions are committed before it
    [Fact]
    public async Task A_machine_on_a_home_line_lets_the_same_login_through()
    {
        var subject = Flows.NewSubject("egress_reachable");
        Enroll(subject, Home);

        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];
        var posted = await PostAsync(subject, label, TimeSpan.FromSeconds(1));

        if (posted is not null)
        {
            Assert.True(
                posted.Status is HttpStatusCode.OK or HttpStatusCode.Accepted,
                $"connect answered {(int)posted.Status}: {posted.Body}");
        }

        var session = await SessionLabelledAsync(label);

        Assert.Equal(Residential, Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Id == session)
            .Select(s => s.ProviderId)
            .Single()));
    }

    private sealed record Posted(HttpStatusCode Status, string Body);

    // straight into the tables: POST /login would drag consent, idempotency and the login's own egress refusal into the test
    private async Task<string> QueueLoginAsync(string subject, string provider)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = provider,
            // A session of its own per job: per-session concurrency is 1, so
            // two jobs sharing one would hide each other.
            Subject = subject,
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
            ProviderId = provider,
            Kind = JobKind.Login,
        }, CancellationToken.None);

        return job.Id;
    }

    private JobState StateOf(string jobId) =>
        Db.Read(factory, db => db.Jobs.AsNoTracking().Where(j => j.Id == jobId).Select(j => j.State).Single());

    // owner-scoped, not the fleet: the suite shares one host and a fleet lease sees other classes' queued logins
    // headed, so mediamarkt's rule about somebody at the browser never decides anything here
    private async Task<LeasedJob?> LeaseAsync(string subject, string[] providers, EgressRequirement? claimed)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        return await queue.TryLeaseAsync(
            Ids.New(Ids.Agent),
            subject,
            new AgentCapabilities { Providers = providers, Headed = true, Egress = claimed },
            [JobKind.Login],
            Ttl,
            CancellationToken.None);
    }

    private async Task<Posted?> PostAsync(string subject, string? label, TimeSpan patience)
    {
        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{Residential}/login", new { subject, label });

        using var abandon = new CancellationTokenSource(patience);

        try
        {
            using var response = await http.SendAsync(request, abandon.Token);
            return new Posted(response.StatusCode, await response.Content.ReadAsStringAsync());
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private async Task<string> SessionLabelledAsync(string label)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(15);

        while (DateTimeOffset.UtcNow < deadline)
        {
            var found = Db.Read(factory, db => db.Sessions.AsNoTracking()
                .Where(s => s.Label == label)
                .Select(s => s.Id)
                .FirstOrDefault());

            if (found is not null) return found;

            await Task.Delay(25);
        }

        Assert.Fail($"no session was ever written for connect '{label}'");
        return string.Empty;
    }

    // straight into the table: the one-time code and its HMAC are another test's
    // the claim goes into CapabilitiesJson, which the queue's SQL cannot see into: the refusal decides in memory
    private string Enroll(string owner, EgressRequirement claimed)
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = $"egress test agent ({claimed.Kind})",
            Class = AgentClass.Pooled,
            OwnerSubject = owner,
            CapabilitiesJson = ConnectorJson.Serialize(new AgentCapabilities
            {
                Providers = [Residential],
                Egress = claimed,
            }),
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));

        return id;
    }
}
