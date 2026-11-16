using System.Net;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// a BYO, agent-required provider runs only on the caller's own machine: a pooled fleet signing in many citizens
// from one address is what Logius scores on DigiD (DUO's reason; its manifest went pooled 2026-09-21, the rule stays)
[Collection(ShopApiCollection.Name)]
public sealed class OwnMachineRoutingTests(ShopApiFactory factory)
{
    private const string Provider = OwnMachineStoreAdapter.ProviderId;

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    // the job is backdated past the fleet's head start, else the test would pass with the rule deleted
    [Fact]
    public async Task The_pooled_fleet_is_refused_a_provider_that_needs_the_callers_own_machine_and_their_own_agent_gets_it()
    {
        var subject = Flows.NewSubject("own_machine_lease");
        var theirs = Enroll(subject, AgentClass.Byo);
        var fleet = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Pooled);

        var queued = await QueueLoginAsync(subject);
        Age(queued, TimeSpan.FromMinutes(1));

        Assert.Null(await LeaseAsync(fleet, ownerScope: null));

        Assert.Equal(JobState.Queued, StateOf(queued));

        var leased = await LeaseAsync(theirs, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(queued, leased.JobId);
    }

    // the class comes off the row, not the lease request: a machine could simply call itself byo
    [Fact]
    public async Task An_agent_that_merely_calls_itself_byo_in_its_capabilities_is_still_refused()
    {
        var subject = Flows.NewSubject("own_machine_claim");
        var pretender = Enroll(subject, AgentClass.Pooled);

        var queued = await QueueLoginAsync(subject);

        var leased = await LeaseAsync(
            pretender,
            ownerScope: subject,
            new AgentCapabilities { Providers = [Provider], Class = AgentClass.Byo });

        Assert.Null(leased);
        Assert.Equal(JobState.Queued, StateOf(queued));
    }

    // an agent in FleetSubjects asks with no owner scope (serves every caller) and must not count as someone's own,
    // matching the login, which will not pin such a machine either
    [Fact]
    public async Task A_byo_machine_that_serves_every_caller_is_refused_the_same_work()
    {
        var subject = Flows.NewSubject("own_machine_shared");
        var shared = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Byo);

        // no agent of their own, so the head start is not what holds this job back
        var queued = await QueueLoginAsync(subject);

        Assert.Null(await LeaseAsync(shared, ownerScope: null));
        Assert.Equal(JobState.Queued, StateOf(queued));
    }

    // the other half of the exclusion: accepted, the login would sit queued until ExpireAbandonedAsync fails it
    // with agent_unavailable half an hour later
    [Fact]
    public async Task A_login_for_such_a_provider_with_no_machine_of_their_own_is_refused_before_anything_is_queued()
    {
        var subject = Flows.NewSubject("own_machine_none");
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var refused = await PostAsync(subject, preferAgent: null, label, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        using var body = System.Text.Json.JsonDocument.Parse(refused.Body);
        var error = body.RootElement.GetProperty("error");
        Assert.Equal("agent_unavailable", error.GetProperty("code").GetString());
        Assert.Equal("start_your_agent", error.GetProperty("user_action").GetString());

        // a refusal, not an early failure: nothing exists to poll
        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.ProviderId == Provider
                        && db.Sessions.Any(s => s.Id == j.SessionId && s.Subject == subject))));
    }

    // the local stack's agents are all Class: pooled; the refusal must agree with the queue about that machine
    [Fact]
    public async Task A_pooled_agent_of_their_own_does_not_count_as_a_machine_of_their_own()
    {
        var subject = Flows.NewSubject("own_machine_pooled");
        Enroll(subject, AgentClass.Pooled);

        var refused = await PostAsync(subject, preferAgent: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);
    }

    // the operator's fleet machine is never handed to a caller who named none: a shared browser, and counted it would
    // stop the refusal firing (passed alone, failed in the assembly)
    [Fact]
    public async Task The_operators_own_fleet_machine_is_not_handed_to_a_caller_who_asked_for_nothing()
    {
        var subject = Flows.NewSubject("own_machine_fleet");
        Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Byo);

        var refused = await PostAsync(subject, preferAgent: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);
    }

    // the online window is the platform's single definition (agent listing, fleet head start); login must agree with it
    [Fact]
    public async Task A_machine_of_their_own_that_stopped_beating_is_refused_rather_than_queued_behind()
    {
        var subject = Flows.NewSubject("own_machine_off");
        Enroll(subject, AgentClass.Byo, lastBeat: DateTimeOffset.UtcNow.AddHours(-1));

        var refused = await PostAsync(subject, preferAgent: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        using var body = System.Text.Json.JsonDocument.Parse(refused.Body);
        var error = body.RootElement.GetProperty("error");
        Assert.Equal("agent_unavailable", error.GetProperty("code").GetString());
        Assert.Equal("start_your_agent", error.GetProperty("user_action").GetString());
    }

    // a login naming a machine is pinned to it by profile: a browser_interactive job had none, so two machines
    // raced and the cookies were on the loser
    [Fact]
    public async Task A_login_that_names_a_machine_pins_its_job_to_that_machine()
    {
        var subject = Flows.NewSubject("own_machine_pin");
        var named = Enroll(subject, AgentClass.Byo);
        var other = Enroll(subject, AgentClass.Byo);

        var connected = await ConnectAsync(subject, preferAgent: named);

        Assert.NotNull(connected.Profile);
        Assert.Equal(named, Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.Id == connected.Profile)
            .Select(p => p.AgentId)
            .Single()));

        var job = Db.LatestJob(factory, connected.Session);
        Assert.Equal(connected.Profile, job.ProfileId);

        // their other machine is online, owned and BYO, and still not the one holding this browser
        Assert.Null(await LeaseAsync(other, ownerScope: subject));

        var leased = await LeaseAsync(named, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
        Assert.Equal(connected.Profile, leased.ProfileId);
    }

    // no prefer_agent is required: the agent picker is offered for T4 only; the second connect must land in the
    // first one's browser (T3 sessions are short, DUO's fifteen idle minutes)
    [Fact]
    public async Task A_second_connect_comes_back_to_the_machine_that_holds_the_first_ones_cookies()
    {
        var subject = Flows.NewSubject("own_machine_only");
        var only = Enroll(subject, AgentClass.Byo);

        var first = await ConnectAsync(subject, preferAgent: null);
        var second = await ConnectAsync(subject, preferAgent: null);

        Assert.NotEqual(first.Session, second.Session);

        Assert.NotNull(first.Profile);
        Assert.Equal(first.Profile, second.Profile);

        Assert.Equal(only, Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.Id == first.Profile)
            .Select(p => p.AgentId)
            .Single()));

        Assert.Single(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == only && p.ProviderId == Provider)
            .ToList()));
    }

    // with two machines a connect naming none returns to the one an earlier connect named, not the other without cookies
    [Fact]
    public async Task A_connect_that_names_nothing_returns_to_the_machine_an_earlier_one_named()
    {
        var subject = Flows.NewSubject("own_machine_home");
        var named = Enroll(subject, AgentClass.Byo);
        Enroll(subject, AgentClass.Byo);

        var first = await ConnectAsync(subject, preferAgent: named);
        var second = await ConnectAsync(subject, preferAgent: null);

        Assert.NotNull(first.Profile);
        Assert.Equal(first.Profile, second.Profile);
    }

    // two machines that never ran it: the connect goes unpinned and either of THEIR agents may take it; a guess
    // would bind every later fetch to the wrong machine
    [Fact]
    public async Task Two_machines_that_have_never_run_it_leave_the_login_open_to_either()
    {
        var subject = Flows.NewSubject("own_machine_both");
        Enroll(subject, AgentClass.Byo);
        var second = Enroll(subject, AgentClass.Byo);

        var connected = await ConnectAsync(subject, preferAgent: null);

        Assert.Null(connected.Profile);

        var leased = await LeaseAsync(second, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(Db.LatestJob(factory, connected.Session).Id, leased.JobId);
        Assert.Null(leased.ProfileId);
    }

    private sealed record Connected(string Session, string? Profile);

    private sealed record Posted(HttpStatusCode Status, string Body);

    // straight into the tables: POST /login would drag consent, idempotency and profile routing into a lease-clause test
    private async Task<string> QueueLoginAsync(string subject)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = Provider,
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
            ProviderId = Provider,
            Kind = JobKind.Login,
        }, CancellationToken.None);

        return job.Id;
    }

    // the fleet's head start is measured from CreatedAt
    private void Age(string jobId, TimeSpan by) =>
        Db.Write(factory, db => db.Jobs
            .Where(j => j.Id == jobId)
            .ExecuteUpdate(s => s.SetProperty(j => j.CreatedAt, DateTimeOffset.UtcNow - by)));

    private JobState StateOf(string jobId) =>
        Db.Read(factory, db => db.Jobs.AsNoTracking().Where(j => j.Id == jobId).Select(j => j.State).Single());

    private async Task<LeasedJob?> LeaseAsync(string agentId, string? ownerScope, AgentCapabilities? capabilities = null)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        return await queue.TryLeaseAsync(
            agentId,
            ownerScope,
            capabilities ?? new AgentCapabilities { Providers = [Provider] },
            [JobKind.Login],
            Ttl,
            CancellationToken.None);
    }

    // does not wait for the answer: no agent serves this provider, so the route holds the socket for the whole login
    // wait; rows are found by the connect's label
    private async Task<Connected> ConnectAsync(string subject, string? preferAgent)
    {
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var posted = await PostAsync(subject, preferAgent, label, TimeSpan.FromSeconds(1));

        if (posted is not null)
        {
            Assert.True(
                posted.Status is HttpStatusCode.OK or HttpStatusCode.Accepted,
                $"connect answered {(int)posted.Status}: {posted.Body}");
        }

        var session = await SessionLabelledAsync(label);

        return new Connected(
            session,
            Db.Read(factory, db => db.Sessions.AsNoTracking()
                .Where(s => s.Id == session)
                .Select(s => s.ProfileId)
                .Single()));
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

    // null: the route was still working when the caller stopped waiting, which for this provider is success
    private async Task<Posted?> PostAsync(string subject, string? preferAgent, string? label, TimeSpan patience)
    {
        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject,
            label,
            prefer_agent = preferAgent,
        });

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

    // straight into the table: the one-time code and its HMAC are tested elsewhere
    private string Enroll(string owner, AgentClass cls, DateTimeOffset? lastBeat = null)
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = $"own machine test agent ({cls})",
            Class = cls,
            OwnerSubject = owner,
            CapabilitiesJson = "{}",
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = lastBeat ?? DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));

        return id;
    }
}
