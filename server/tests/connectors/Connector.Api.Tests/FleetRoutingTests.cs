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

/// <summary>
/// A caller who asks for the operator's fleet gets the operator's fleet.
///
/// <para>
/// THE DEFECT, AS IT HAPPENED. On 2026-09-21 the account holder connected DUO
/// twice from the demo client. The first time they picked their own machine
/// from "Run it on" and it ran there. The second time they picked "the
/// operator's fleet" from the same dropdown and it ran on their own machine
/// again: session <c>ses_a8dc2d7b4a14782f3050773c610e0f53</c> carries no pin,
/// <c>connector-byo-registry-1</c> logged
/// <c>job_98ef049e691d586ed949be7f819500ad (Login/duo) succeeded</c> and noted
/// that the profile was still signed in, and the pooled fleet agent - online
/// throughout - logged nothing at all.
/// </para>
///
/// <para>
/// WHY, AND IT WAS NOT THE QUEUE BEING WRONG. Choosing the fleet sent no
/// <c>prefer_agent</c>, and "no prefer_agent" is not "the fleet" - it is "no
/// preference". <c>TryLeaseAsync</c> then applies the head start it has
/// applied since it was written: a fleet agent stands back for
/// <c>OwnAgentHeadStartSeconds</c> whenever the job's subject has a live BYO
/// machine, and that machine is under no such restriction. So for every
/// provider the caller's own machine can serve, the fleet could not win inside
/// that window, and the dropdown's two options were one option.
/// </para>
///
/// <para>
/// The head start is right and is untouched: a user who has brought an agent
/// has said where their work should run, standing back is self-healing, and a
/// head start rather than an exclusion is what keeps work from being stranded
/// on a machine that will never lease it. What was missing is that an EXPLICIT
/// choice about one connection could not outrank a standing preference the
/// platform infers - and an explicit choice is the stronger signal. So
/// <c>prefer_agent</c> gained a third answer, <see cref="RunOn.Fleet"/>, and
/// the queue gained the mirror image of its profile pin.
/// </para>
///
/// <para>
/// The three halves are here together because they are one rule seen from
/// three sides: the caller's own machines are not offered work asked of the
/// fleet, the fleet is handed it at once rather than after a wait for nobody,
/// and a caller asking for a fleet that can never take it is told at the login
/// instead of watching a queue that cannot move.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class FleetRoutingTests(ShopApiFactory factory)
{
    /// <summary>The ordinary shop shape: either kind of machine could take it.</summary>
    private const string Provider = PooledStoreAdapter.ProviderId;

    /// <summary>A provider that will only run on a machine of the caller's own.</summary>
    private const string OwnMachineOnly = OwnMachineStoreAdapter.ProviderId;

    /// <summary>
    /// Pooled, and reachable only from a Dutch home line - which no agent of
    /// the operator's in this assembly claims.
    /// </summary>
    private const string Residential = ResidentialStoreAdapter.ProviderId;

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private static readonly EgressRequirement Home =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    /// <summary>
    /// THE DEFECT, REPRODUCED AND ANSWERED: their own machine polls first, is
    /// refused, and the fleet takes the work immediately.
    /// </summary>
    /// <remarks>
    /// Both halves in one test, because "their machine did not get it" and
    /// "the fleet did" are the same sentence: a rule that turned the caller's
    /// own agent away and stranded the job would be a worse bug than the one it
    /// replaces, and it is the exact bug the queue's own head-start comment
    /// warns against.
    /// <para>
    /// THE JOB IS NOT BACKDATED, and that is the second assertion in disguise.
    /// The caller has a live machine of their own, so a fresh job is inside the
    /// fleet's head start - which is where the fleet used to be told to wait
    /// for a machine that is now forbidden to take it. Twenty seconds of
    /// nobody is not what "run it on the fleet" means, so the head start reads
    /// the flag too.
    /// </para>
    /// <para>
    /// Posted through the real route rather than written into the tables,
    /// unlike the neighbouring lease suites: the whole failure was that an
    /// answer given on the wire never became a row, so a test that started
    /// from the row would assert the half that was never broken.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_login_that_asks_for_the_fleet_is_refused_to_their_own_machine_and_leased_by_the_fleet()
    {
        var subject = Flows.NewSubject("fleet_chosen");
        var theirs = Enroll(subject, AgentClass.Byo);
        var fleet = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Pooled, [Provider]);

        var session = await ConnectAsync(subject, Provider, preferAgent: RunOn.Fleet);

        // The answer is on the session, and it is not a pin: nothing was
        // written into AgentId, because the reserved word is not an agent id
        // and that column holds agent ids.
        var row = Db.Read(factory, db => db.Sessions.AsNoTracking().Single(s => s.Id == session));

        Assert.True(row.FleetOnly);
        Assert.Null(row.AgentId);
        Assert.Null(row.ProfileId);

        var job = Db.LatestJob(factory, session);

        Assert.True(job.FleetOnly);
        Assert.Equal(JobState.Queued, job.State);

        // Their own machine asks first, the way a BYO agent does: owner-scoped,
        // because its owner is not named in FleetSubjects.
        Assert.Null(await LeaseAsync(theirs, ownerScope: subject));
        Assert.Equal(JobState.Queued, StateOf(job.Id));

        // And the fleet has it at once - no ageing, no second poll.
        var leased = await LeaseAsync(fleet, ownerScope: null);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
    }

    /// <summary>
    /// AND A CALLER WHO EXPRESSES NOTHING GETS EXACTLY WHAT THEY GOT
    /// YESTERDAY: the fleet stands back, their own machine takes the work.
    /// </summary>
    /// <remarks>
    /// The property most likely to be broken by accident while making the
    /// explicit case work, and the one every consumer that is not an agent
    /// picker depends on - a connector's callers send no <c>prefer_agent</c>
    /// at all. Absent must keep meaning "no preference"; if it had come to mean
    /// "the fleet", this change would have moved every silent caller's work
    /// into the operator's datacenter to fix a dropdown.
    /// <para>
    /// The same two leases as the test above, in the same order, with the same
    /// machines - and both answers the other way round. That is the whole
    /// point: the only difference between the two tests is one word on the
    /// wire.
    /// </para>
    /// </remarks>
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

        // The fleet stands back, because this caller has a machine of their
        // own that is beating.
        Assert.Null(await LeaseAsync(fleet, ownerScope: null));
        Assert.Equal(JobState.Queued, StateOf(job.Id));

        var leased = await LeaseAsync(theirs, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
    }

    /// <summary>
    /// AND ASKING THE FLEET FOR A PROVIDER THAT RUNS NOWHERE BUT YOUR OWN
    /// MACHINE IS A CONTRADICTION, NAMED AT THE LOGIN.
    /// </summary>
    /// <remarks>
    /// <c>TryLeaseAsync</c> builds its serveable set as
    /// <c>ownMachine || !NeedsOwnMachine</c>, so no pooled machine may ever
    /// lease this provider's work however long it waits. Accepted, such a login
    /// would be excluded from the caller's machines by its own request and from
    /// the fleet by the manifest - a job with nobody left at all, which sits
    /// queued until <c>ExpireAbandonedAsync</c> fails it half an hour later.
    /// <para>
    /// <c>invalid_request</c> RATHER THAN <c>agent_unavailable</c>, which is
    /// the one place this refusal departs from its two neighbours, and
    /// deliberately. Their refusals are shortages: a machine is off, an address
    /// is wrong, and <c>start_your_agent</c> is something the person can go and
    /// do. Nothing anybody starts makes a pooled machine eligible for this
    /// provider - the request itself has to change - and that is what a 400
    /// with no user action says.
    /// </para>
    /// <para>
    /// THE CALLER HAS A MACHINE OF THEIR OWN, ONLINE, on purpose: without it
    /// the own-machine refusal fires first and this test passes with the whole
    /// contradiction check deleted.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND ASKING FOR A FLEET THAT CANNOT SERVE THIS PROVIDER IS REFUSED
    /// RATHER THAN QUEUED.
    /// </summary>
    /// <remarks>
    /// The other half of the exclusion, and the reason the queue's own comment
    /// says a head start is not an exclusion: "an exclusion strands work...
    /// with the user watching a queue that never moves". A fleet-requested job
    /// IS an exclusion of the caller's own machines, so the moment nothing on
    /// the other side can take it there is nobody left - and this one would
    /// strand with the caller's NAS switched on two metres away.
    /// <para>
    /// The provider asks for a Dutch home line and no agent of the operator's
    /// in this assembly claims one, while the caller's own machine does - so
    /// the login is refused for the fleet's sake alone, with an agent that
    /// could have run it sitting idle. The code and the action are the ones the
    /// own-machine and egress refusals already use, because
    /// <c>user_action</c> is a function of the code and a consumer that renders
    /// <c>start_your_agent</c> needs nothing new.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND THE ANSWER IS ABOUT THE CONNECTION, SO THE FETCHES KEEP IT.
    /// </summary>
    /// <remarks>
    /// The question the picker asks is "run it on", not "run this one job on".
    /// A login honoured on the fleet whose first fetch went back to the
    /// caller's NAS would be a promise kept for four seconds - and for a
    /// browser provider it is worse than inconsistent: the machine that signed
    /// in is the machine holding the cookies, so the work would land where
    /// there is no session to work with. The flag is denormalised onto every
    /// job of the session exactly as the profile pin is.
    /// <para>
    /// AN INLINE PROVIDER, WHICH IS TWO ASSERTIONS AT ONCE. The control plane
    /// runs this one in its own process and leases with no owner scope, so it
    /// is on the fleet's side of the rule: a fleet-requested job must still
    /// reach it, and the login must not refuse a provider for having no
    /// enrolled fleet machine when the fleet in question is this process. Both
    /// would fail here as a refused connect rather than as a subtle routing
    /// difference, which is the right way round for something no picker can
    /// currently ask for and any caller can send.
    /// </para>
    /// </remarks>
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

        // The login itself ran, in this process, on a job carrying the flag -
        // so the in-process runner is not locked out by a rule about the
        // caller's machines.
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

    /// <summary>
    /// AND THE LAST JOB OF THE CONNECTION KEEPS IT TOO.
    /// </summary>
    /// <remarks>
    /// The one most easily forgotten, because a disconnect builds its logout
    /// AFTER the session row has been purged - from values read before it,
    /// which is a list somebody has to remember to add to. A logout offered to
    /// the machine the whole connection was deliberately kept off would be the
    /// rule holding for every job but the one that tells the provider it is
    /// over.
    /// <para>
    /// Its own test rather than a tail on the one above: the provider that
    /// declares a logout is also the one that rotates its bundle on every use,
    /// so a fetch in between would spend the bundle this disconnect has to send
    /// - and the disconnect would skip the logout for a reason that has nothing
    /// to do with routing.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND THE WORD THE WIRE RESERVES CANNOT BE AN AGENT ID.
    /// </summary>
    /// <remarks>
    /// The whole argument for putting a third answer inside
    /// <c>prefer_agent</c> rather than in a field beside it - one field cannot
    /// contradict itself - rests on this: an agent never names itself, the
    /// enrollment endpoint mints the id as <c>agt_</c> and 128 bits of hex, so
    /// a value carrying no prefix is provably not one. A reserved word that
    /// drifted to something an id could be spelt as would turn every login
    /// naming that machine into a request for the fleet, silently.
    /// </remarks>
    [Fact]
    public void The_reserved_word_is_not_spellable_as_an_agent_id()
    {
        Assert.False(Ids.Is(RunOn.Fleet, Ids.Agent));
        Assert.True(RunOn.IsFleet(RunOn.Fleet));

        // And a minted id is read as a machine rather than as the fleet, for
        // any id at all - the reserved word is exact, not a prefix and not a
        // substring.
        var minted = Ids.New(Ids.Agent);

        Assert.False(RunOn.IsFleet(minted));
        Assert.True(RunOn.IsAgentId(minted));
        Assert.False(RunOn.IsFleet($"{Ids.Agent}_{RunOn.Fleet}"));
        Assert.True(RunOn.IsAgentId($"{Ids.Agent}_{RunOn.Fleet}"));

        // Nothing is still nothing, which is what every caller that has never
        // heard of any of this sends.
        Assert.False(RunOn.IsFleet(null));
        Assert.False(RunOn.IsAgentId(null));
        Assert.False(RunOn.IsAgentId(string.Empty));
    }

    // ---- setup -------------------------------------------------------------

    /// <summary>
    /// Connects through the real route and hands back the session id.
    /// </summary>
    /// <remarks>
    /// IT DOES NOT WAIT FOR THE ANSWER, for the reason the own-machine suite
    /// spells out: no agent here runs this provider, so the session never
    /// settles and the route holds the socket for the whole login wait before
    /// answering 202 with the state the database already had. Everything
    /// asserted is committed before that wait begins, and the rows are found by
    /// the label this connect was given.
    /// </remarks>
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
            // Still working when we stopped waiting, which for a provider
            // nothing serves is what success looks like.
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
            // Narrowed to this file's own provider, which is what keeps a
            // FLEET lease - one with no owner scope, and therefore able to see
            // every caller's work - an assertion about this test rather than
            // about the order of the whole assembly.
            new AgentCapabilities { Providers = [Provider] },
            [JobKind.Login],
            Ttl,
            CancellationToken.None);
    }

    /// <summary>
    /// An enrolled, beating agent. Straight into the table, as the own-machine,
    /// egress and heartbeat suites do: the one-time code and its HMAC are
    /// somebody else's test.
    /// </summary>
    /// <remarks>
    /// The provider list is NARROW BY DEFAULT for the agents this file
    /// enrolls under the operator's fleet subject, and that is not tidiness: an
    /// agent row lives for the whole assembly, and a fleet machine that served
    /// everything would answer the "no fleet agent can serve it" refusal below
    /// for every other test's caller too - which would make that refusal pass
    /// or fail on the order xUnit happened to pick.
    /// </remarks>
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
