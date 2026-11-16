using System.Net;
using System.Net.Http.Json;
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

// an explicit fleet choice outranks the head start inferred from a live BYO machine; absent prefer_agent = "no preference"
// one rule, three sides: own machines are not offered fleet work, the fleet gets it at once, an unservable ask is refused
[Collection(ShopApiCollection.Name)]
public sealed class FleetRoutingTests(ShopApiFactory factory)
{
    private const string Provider = PooledStoreAdapter.ProviderId;

    private const string OwnMachineOnly = OwnMachineStoreAdapter.ProviderId;

    // pooled, reachable only from a Dutch home line, which no operator agent in this assembly claims
    private const string Residential = ResidentialStoreAdapter.ProviderId;

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private static readonly EgressRequirement Home =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    // not backdated: with a live own machine a fresh job is inside the fleet's head start, which must read the flag too
    // posted through the real route: the failure was an answer on the wire never becoming a row
    [Fact]
    public async Task A_login_that_asks_for_the_fleet_is_refused_to_their_own_machine_and_leased_by_the_fleet()
    {
        var subject = Flows.NewSubject("fleet_chosen");
        var theirs = Enroll(subject, AgentClass.Byo);
        var fleet = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Pooled, [Provider]);

        var session = await ConnectAsync(subject, Provider, preferAgent: RunOn.Fleet);

        // the answer is on the session, not a pin: AgentId holds agent ids and the reserved word is not one
        var row = Db.Read(factory, db => db.Sessions.AsNoTracking().Single(s => s.Id == session));

        Assert.True(row.FleetOnly);
        Assert.Null(row.AgentId);
        Assert.Null(row.ProfileId);

        var job = Db.LatestJob(factory, session);

        Assert.True(job.FleetOnly);
        Assert.Equal(JobState.Queued, job.State);

        // owner-scoped, as a BYO agent's lease is: its owner is not in FleetSubjects
        Assert.Null(await LeaseAsync(theirs, ownerScope: subject));
        Assert.Equal(JobState.Queued, StateOf(job.Id));

        var leased = await LeaseAsync(fleet, ownerScope: null);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
    }

    // absent must keep meaning "no preference": every consumer that is not an agent picker sends no prefer_agent
    [Fact]
    public async Task A_login_that_asks_for_nothing_still_gives_their_own_machine_the_head_start()
    {
        var subject = Flows.NewSubject("fleet_unasked");
        var theirs = Enroll(subject, AgentClass.Byo);
        var fleet = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Pooled, [Provider]);

        var session = await ConnectAsync(subject, Provider, preferAgent: null);

        var row = Db.Read(factory, db => db.Sessions.AsNoTracking().Single(s => s.Id == session));

        Assert.False(row.FleetOnly);
        Assert.Null(row.AgentId);

        var job = Db.LatestJob(factory, session);

        Assert.False(job.FleetOnly);

        Assert.Null(await LeaseAsync(fleet, ownerScope: null));
        Assert.Equal(JobState.Queued, StateOf(job.Id));

        var leased = await LeaseAsync(theirs, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
    }

    // TryLeaseAsync serves ownMachine || !NeedsOwnMachine, so no pooled machine leases this: a queued job would have nobody
    // invalid_request, not agent_unavailable: nothing anybody starts makes a pooled machine eligible, the request must change
    // the caller's own machine is online on purpose: else the own-machine refusal fires first and masks the check
    [Fact]
    public async Task Asking_the_fleet_for_a_provider_that_needs_your_own_machine_is_refused_at_the_login()
    {
        var subject = Flows.NewSubject("fleet_contradiction");
        Enroll(subject, AgentClass.Byo);

        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{OwnMachineOnly}/login", new
        {
            subject,
            label,
            prefer_agent = RunOn.Fleet,
        });

        using var response = await http.SendAsync(request);

        var error = await ErrorEnvelope.AssertAsync(response, HttpStatusCode.BadRequest, "invalid_request");
        Assert.Equal("none", error.Text("user_action"));
        Assert.False(error.GetProperty("retriable").GetBoolean());

        // A refusal, not an early failure: nothing exists for anybody to poll.
        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.ProviderId == OwnMachineOnly
                        && db.Sessions.Any(s => s.Id == j.SessionId && s.Subject == subject))));
    }

    // a fleet-requested job excludes the caller's own machines, so it strands unless the fleet side can serve it: refuse
    // code and action are the own-machine and egress refusals' pair
    [Fact]
    public async Task Asking_the_fleet_where_no_fleet_agent_can_serve_the_provider_is_refused_rather_than_queued()
    {
        var subject = Flows.NewSubject("fleet_absent");
        Enroll(subject, AgentClass.Byo, [Residential], Home);

        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{Residential}/login", new
        {
            subject,
            label,
            prefer_agent = RunOn.Fleet,
        });

        using var response = await http.SendAsync(request);

        var error = await ErrorEnvelope.AssertAsync(
            response, HttpStatusCode.ServiceUnavailable, "agent_unavailable");

        Assert.Equal("start_your_agent", error.Text("user_action"));

        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.ProviderId == Residential
                        && db.Sessions.Any(s => s.Id == j.SessionId && s.Subject == subject))));
    }

    // the answer is about the connection, not one job: a fetch back on the caller's NAS would land where no session exists
    // inline provider: the control plane's process is the fleet, so login must not refuse it for lacking a fleet machine
    [Fact]
    public async Task A_connection_asked_of_the_fleet_keeps_that_answer_on_its_later_work()
    {
        const string inline = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("fleet_inline");

        using var request = Wire.Post($"/v1/{inline}/login", new
        {
            subject,
            inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = RotatingStoreAdapter.Username,
                ["password"] = RotatingStoreAdapter.Password,
            },
            prefer_agent = RunOn.Fleet,
        });

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();

        Assert.True(
            response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted,
            $"connect answered {(int)response.StatusCode}: {body}");

        var session = body.Text("session_id");
        var bundle = body.TextOrNull("bundle") ?? await Flows.AwaitBundleAsync(http, inline, session);

        Assert.True(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Id == session)
            .Select(s => s.FleetOnly)
            .Single()));

        // the login ran in-process on a job carrying the flag: the in-process runner is not locked out by the own-machine rule
        Assert.Equal(JobState.Succeeded, Db.LatestJob(factory, session).State);

        var ticket = await Flows.ResumeAsync(http, inline, new Connection(subject, session, bundle));
        await Flows.FetchPageAsync(http, inline, $"/v1/{inline}/receipts?since=2026-06-01", ticket);

        var fetched = Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Where(j => j.SessionId == session && j.Kind == JobKind.Fetch)
            .OrderByDescending(j => j.CreatedAt)
            .ThenByDescending(j => j.Id)
            .First());

        Assert.True(fetched.FleetOnly);
    }

    // a disconnect builds its logout after the session row is purged, from values read before: the flag is easy to forget
    // its own test: a fetch in between would spend the rotating bundle the disconnect has to send
    [Fact]
    public async Task A_disconnect_of_a_fleet_connection_sends_its_logout_to_the_fleet_as_well()
    {
        const string inline = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("fleet_logout");
        http.ActAs(subject);

        using var request = Wire.Post($"/v1/{inline}/login", new
        {
            subject,
            inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = RotatingStoreAdapter.Username,
                ["password"] = RotatingStoreAdapter.Password,
            },
            prefer_agent = RunOn.Fleet,
        });

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();

        Assert.True(
            response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted,
            $"connect answered {(int)response.StatusCode}: {body}");

        var session = body.Text("session_id");
        var bundle = body.TextOrNull("bundle") ?? await Flows.AwaitBundleAsync(http, inline, session);

        using var disconnect = new HttpRequestMessage(
            HttpMethod.Delete, $"/v1/{inline}/sessions/{session}")
        {
            Content = JsonContent.Create(new { bundle }),
        };

        using var removed = await http.SendAsync(disconnect);
        Assert.Equal(HttpStatusCode.OK, removed.StatusCode);

        var logout = Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Single(j => j.SessionId == session && j.Kind == JobKind.Logout));

        Assert.True(logout.FleetOnly);
    }

    // the reserved word cannot be an agent id: ids are minted as `agt_` plus 128 bits of hex, so a prefixless value is not one
    [Fact]
    public void The_reserved_word_is_not_spellable_as_an_agent_id()
    {
        Assert.False(Ids.Is(RunOn.Fleet, Ids.Agent));
        Assert.True(RunOn.IsFleet(RunOn.Fleet));

        var minted = Ids.New(Ids.Agent);

        Assert.False(RunOn.IsFleet(minted));
        Assert.True(RunOn.IsAgentId(minted));
        Assert.False(RunOn.IsFleet($"{Ids.Agent}_{RunOn.Fleet}"));
        Assert.True(RunOn.IsAgentId($"{Ids.Agent}_{RunOn.Fleet}"));

        Assert.False(RunOn.IsFleet(null));
        Assert.False(RunOn.IsAgentId(null));
        Assert.False(RunOn.IsAgentId(string.Empty));
    }

    // does not wait: no agent here runs this provider, so the route holds the socket for the whole login wait
    private async Task<string> ConnectAsync(string subject, string provider, string? preferAgent)
    {
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{provider}/login", new
        {
            subject,
            label,
            prefer_agent = preferAgent,
        });

        using var abandon = new CancellationTokenSource(TimeSpan.FromSeconds(1));

        try
        {
            using var response = await http.SendAsync(request, abandon.Token);
            var body = await response.Content.ReadAsStringAsync();

            Assert.True(
                response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted,
                $"connect answered {(int)response.StatusCode}: {body}");
        }
        catch (OperationCanceledException)
        {
            // still working when the wait stopped: for a provider nothing serves, that is success
        }

        return await SessionLabelledAsync(label);
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

    private JobState StateOf(string jobId) =>
        Db.Read(factory, db => db.Jobs.AsNoTracking().Where(j => j.Id == jobId).Select(j => j.State).Single());

    private async Task<LeasedJob?> LeaseAsync(string agentId, string? ownerScope)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        return await queue.TryLeaseAsync(
            agentId,
            ownerScope,
            // narrowed to this file's provider: a fleet lease sees every caller's work and would assert on the order of the assembly
            new AgentCapabilities { Providers = [Provider] },
            [JobKind.Login],
            Ttl,
            CancellationToken.None);
    }

    // narrow provider list by default for fleet agents: an agent row lives for the whole assembly, a broad one would answer
    // other tests' refusals; straight into the table: the one-time code and its HMAC are another test's
    private string Enroll(
        string owner,
        AgentClass cls,
        IReadOnlyList<string>? providers = null,
        EgressRequirement? egress = null)
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = $"fleet routing test agent ({cls})",
            Class = cls,
            OwnerSubject = owner,
            CapabilitiesJson = ConnectorJson.Serialize(new AgentCapabilities
            {
                Providers = providers ?? [],
                Egress = egress,
            }),
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));

        return id;
    }
}
