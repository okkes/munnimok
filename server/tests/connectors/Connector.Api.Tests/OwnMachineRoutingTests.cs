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

/// <summary>
/// A provider that says it needs the account holder's own machine gets one, or
/// an honest refusal.
///
/// <para>
/// <c>AgentRequirement</c> was documentation. A manifest declared
/// <c>required: true, class: byo</c> - DUO's did, with the reason written out:
/// Logius scores DigiD authentications on IP and BSN, and a pooled fleet
/// signing in as many different citizens from one address is that signature -
/// and the queue filtered candidates on <c>CanServe</c>, which asks only which
/// providers an agent carries and which runtimes it drives. <c>AgentClass</c>
/// appeared in the queue exactly once, as the fleet's twenty-second head start,
/// which is a reason to WAIT and then take the work anyway. So the operator's
/// pooled agent leased that login on the twenty-first second.
/// </para>
///
/// <para>
/// Everything that kept such work on one machine had been written for T4 and
/// keyed on the RUNTIME: the login pinned a profile for
/// <c>browser_persistent</c> and for nothing else. A provider that is BYO and
/// agent-required but T3 - DUO, and the double this suite uses for it - fell
/// through all of it.
/// </para>
///
/// <para>
/// DUO IS NOT THAT PROVIDER ANY MORE, and the rule is unchanged. Its manifest
/// went <c>pooled</c> on 2026-09-21: the account holder's fleet is a container
/// on their own connection serving one person, so the Logius reasoning - which
/// is about one shared egress serving many households - bought them nothing and
/// cost them their DUO test route. None of this suite moves, because none of it
/// was ever pointed at DUO: the double below declares the shape, the rule is
/// the platform's, and it still routes every BYO provider the tree ships. What
/// the paragraphs above are is the history of why the rule exists.
/// </para>
///
/// <para>
/// The three halves are here together because they are one rule seen from three
/// sides: nobody but their own machine may take the job, the caller is told at
/// once when they have no such machine rather than watching a queue that cannot
/// move, and a second connect goes back to the machine holding the first one's
/// cookies - which is the entire reason to want the rule.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class OwnMachineRoutingTests(ShopApiFactory factory)
{
    private const string Provider = OwnMachineStoreAdapter.ProviderId;

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    /// <summary>
    /// THE DEFECT, REPRODUCED: the pooled fleet takes the job once its head
    /// start has elapsed.
    /// </summary>
    /// <remarks>
    /// The job is backdated past the head start on purpose. Inside it, the
    /// fleet stands back for any owner with a live machine of their own and
    /// this test would pass with the rule deleted - which is what the head
    /// start is for and is not what is under test here. Past it, the only
    /// thing that can keep a pooled agent off this provider is the manifest.
    /// <para>
    /// Both halves in one test, because "nobody leased it" and "the right
    /// machine leased it" are the same sentence: a rule that turned the fleet
    /// away and also stranded the work would be a worse bug than the one it
    /// replaced.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_pooled_fleet_is_refused_a_provider_that_needs_the_callers_own_machine_and_their_own_agent_gets_it()
    {
        var subject = Flows.NewSubject("own_machine_lease");
        var theirs = Enroll(subject, AgentClass.Byo);
        var fleet = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Pooled);

        var queued = await QueueLoginAsync(subject);
        Age(queued, TimeSpan.FromMinutes(1));

        // The fleet asks the way the lease route makes it ask: no owner scope,
        // because its owner is named in FleetSubjects.
        Assert.Null(await LeaseAsync(fleet, ownerScope: null));

        // And the work is still there, rather than failed or taken.
        Assert.Equal(JobState.Queued, StateOf(queued));

        var leased = await LeaseAsync(theirs, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(queued, leased.JobId);
    }

    /// <summary>
    /// AND THE CLASS COMES OFF THE ROW, not off the lease request.
    /// </summary>
    /// <remarks>
    /// <c>AgentCapabilities.Class</c> is on the blob an agent sends on every
    /// heartbeat, so a machine that wanted this work would simply call itself
    /// byo - which is why the lease route already takes the owner scope off the
    /// row rather than off the request, and why this rule does the same. A
    /// pooled agent claiming byo in its capabilities is still refused.
    /// </remarks>
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

    /// <summary>
    /// And a byo-class machine that serves everybody is not somebody's own
    /// either.
    /// </summary>
    /// <remarks>
    /// The class says what KIND of machine; the owner scope says WHOSE. An
    /// agent named in <c>FleetSubjects</c> asks with no scope at all, which is
    /// the platform's way of saying it serves every caller - and many different
    /// people authenticating from one address is the exact arrangement DUO's
    /// manifest was written about, whatever that machine calls itself.
    /// <para>
    /// It has to match the login, which will not pin such a machine to a
    /// connection either. Disagreeing, a caller would be told they have no
    /// machine of their own and then watch their DigiD sign-in run on the
    /// operator's.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_byo_machine_that_serves_every_caller_is_refused_the_same_work()
    {
        var subject = Flows.NewSubject("own_machine_shared");
        var shared = Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Byo);

        // No agent of their own, so the fleet's head start is not what keeps
        // this job back: with nobody to stand back for, it is offered from the
        // instant it is queued.
        var queued = await QueueLoginAsync(subject);

        Assert.Null(await LeaseAsync(shared, ownerScope: null));
        Assert.Equal(JobState.Queued, StateOf(queued));
    }

    /// <summary>
    /// AND A CALLER WITH NO MACHINE OF THEIR OWN IS TOLD SO AT LOGIN.
    /// </summary>
    /// <remarks>
    /// The other half of the exclusion, and the queue's own comment two screens
    /// above the head start says why it has to exist: "an exclusion strands
    /// work... with the user watching a queue that never moves". Accepted, this
    /// login would sit queued until <c>ExpireAbandonedAsync</c> failed it with
    /// <c>agent_unavailable</c> half an hour later - the same code, after a 202
    /// and a spinner, to somebody who has long since put the phone down.
    /// <para>
    /// The code and the action are asserted on the wire rather than the prose,
    /// because they are the whole of what a consumer can branch on:
    /// <c>user_action</c> is a function of the code and of nothing else, and
    /// "start_your_agent" is the instruction that fixes this.
    /// </para>
    /// </remarks>
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

        // A refusal, not an early failure: nothing exists for anybody to poll.
        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.ProviderId == Provider
                        && db.Sessions.Any(s => s.Id == j.SessionId && s.Subject == subject))));
    }

    /// <summary>
    /// And a pooled machine of theirs is not a machine of their own.
    /// </summary>
    /// <remarks>
    /// The same refusal for the case that looks like the opposite: an agent
    /// they own, online, beating, and useless for this provider - which is
    /// precisely the local stack, where the shop, bank and registry agents are
    /// all <c>Class: pooled</c> in the compose file. Without this the refusal
    /// would read "you have an agent" and the queue would then read "not that
    /// one", and the two would disagree about the same machine.
    /// </remarks>
    [Fact]
    public async Task A_pooled_agent_of_their_own_does_not_count_as_a_machine_of_their_own()
    {
        var subject = Flows.NewSubject("own_machine_pooled");
        Enroll(subject, AgentClass.Pooled);

        var refused = await PostAsync(subject, preferAgent: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);
    }

    /// <summary>
    /// And neither does the operator's machine, however it is classed.
    /// </summary>
    /// <remarks>
    /// The fleet exception lets somebody NAME a shared machine, and this is the
    /// one place that does not extend to being handed one. Pinning a login to
    /// an agent the caller never asked for puts their signed-in browser on a
    /// computer everybody shares, which is the arrangement the manifest exists
    /// to forbid - and if it counted, every caller on a stack whose fleet runs
    /// one byo-class agent would "have a machine of their own" and the refusal
    /// above would never fire for anybody.
    /// <para>
    /// This is not hypothetical and was not reasoned out in advance: the
    /// persistent suite enrolls a fleet-owned BYO agent two classes away, and
    /// with it counted these tests passed alone and failed in the assembly,
    /// which is exactly how the live stack would have failed.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_operators_own_fleet_machine_is_not_handed_to_a_caller_who_asked_for_nothing()
    {
        var subject = Flows.NewSubject("own_machine_fleet");
        Enroll(ConnectorOptions.DevFleetSubject, AgentClass.Byo);

        var refused = await PostAsync(subject, preferAgent: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);
    }

    /// <summary>
    /// And neither does one of theirs that stopped beating.
    /// </summary>
    /// <remarks>
    /// The commonest way to arrive here, and the one the message is written
    /// for: the machine exists, it is the right kind, and it is switched off.
    /// The window is the platform's single definition of online - the same one
    /// the agent listing offers machines by and the same one the fleet's head
    /// start stands back for - because a consumer that showed a machine as
    /// ready and then had the login refuse it would be reporting two different
    /// answers about one NAS.
    /// </remarks>
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

    /// <summary>
    /// AND A LOGIN THAT NAMES A MACHINE IS PINNED TO IT, so a household with
    /// two agents cannot sign in on one and fetch from the other.
    /// </summary>
    /// <remarks>
    /// The profile is the pin, as it is for a persistent login: the queue
    /// offers a job carrying one to the agent holding that row and to nobody
    /// else. A <c>browser_interactive</c> job carried no profile at all, so two
    /// machines belonging to one person raced for it - and the browser with the
    /// cookies in it was on whichever one lost.
    /// </remarks>
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

        // Their other machine is online, owned by them, and BYO - and it is
        // still not the one holding this browser.
        Assert.Null(await LeaseAsync(other, ownerScope: subject));

        var leased = await LeaseAsync(named, ownerScope: subject);

        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);
        Assert.Equal(connected.Profile, leased.ProfileId);
    }

    /// <summary>
    /// AND ONE AGENT IS ALL ANYBODY HAS TO BRING.
    /// </summary>
    /// <remarks>
    /// A persistent login refuses a request that names no agent, because its
    /// whole material is a pointer to one directory. This provider must not:
    /// the consumer's agent picker is offered for T4 and for nothing else, so
    /// insisting on <c>prefer_agent</c> would make every such provider
    /// unconnectable from the client that exists - and somebody with one
    /// machine has already answered the question by owning one machine.
    /// <para>
    /// The second connect is the whole errand. A T3 session is short - DUO's,
    /// which this double was modelled on, is fifteen idle minutes - so a person
    /// who connects twice inside it should be asked for nothing the second
    /// time, which only works if the second login lands in the browser the
    /// first one signed in on. Asserted as the same profile on the same agent
    /// across two separate sessions.
    /// </para>
    /// </remarks>
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

        // One directory, not two that happen to be named the same.
        Assert.Single(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == only && p.ProviderId == Provider)
            .ToList()));
    }

    /// <summary>
    /// And with two machines it comes home to the one that already holds the
    /// connection, rather than back to being ambiguous.
    /// </summary>
    /// <remarks>
    /// The case the previous test cannot see, because with one agent "the
    /// machine holding this connection" and "their only machine" are the same
    /// answer. Here they are not: the first connect named one of two, and the
    /// second names nothing at all. A consumer that shows the picker once and
    /// not afterwards - or a person who simply left the box empty the second
    /// time - must not thereby be sent to the other machine, where the cookies
    /// are not.
    /// </remarks>
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

    /// <summary>
    /// AND TWO MACHINES THAT HAVE NEVER RUN IT ARE NOT A REFUSAL.
    /// </summary>
    /// <remarks>
    /// Nothing here can tell which of somebody's two machines they are sitting
    /// at, and a guess would bind every later fetch of that connection to it.
    /// So this one connect goes unpinned and the queue offers it to whichever
    /// of THEIR agents asks - the class rule keeps the fleet out either way -
    /// and the next connect comes back to the one that ran it. Refusing
    /// instead, or pinning on a coin toss, would both be worse than the
    /// ambiguity they are trying to remove.
    /// <para>
    /// The second assertion is the one that matters: the job is leasable by an
    /// agent that is NOT the first one enrolled, which is what "unpinned" has
    /// to mean for this to be a workable answer rather than a silent stranding.
    /// </para>
    /// </remarks>
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

    // ---- setup -------------------------------------------------------------

    private sealed record Connected(string Session, string? Profile);

    private sealed record Posted(HttpStatusCode Status, string Body);

    /// <summary>
    /// A session and a queued login straight into the tables, as the ownership
    /// suite does: going through POST /login would drag consent, idempotency
    /// and the profile routing into a test about the lease clause alone.
    /// </summary>
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

    /// <summary>
    /// Backdates a queued job past the fleet's head start, which is measured
    /// from <c>CreatedAt</c> and is the one other reason a pooled agent would
    /// be handed nothing.
    /// </summary>
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

    /// <summary>
    /// Connects and hands back the session and the profile it was pinned to.
    /// </summary>
    /// <remarks>
    /// IT DOES NOT WAIT FOR THE ANSWER, for the reason the persistent suite
    /// spells out: no agent here serves this provider, so the session never
    /// settles and the route holds the socket for the whole login wait before
    /// answering 202 with the state the database already had. Everything
    /// asserted is committed before that wait begins, and the rows are found by
    /// the label this connect was given.
    /// </remarks>
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

    /// <summary>
    /// Posts the login. Null means the route was still working when the caller
    /// stopped waiting, which for this provider is what success looks like.
    /// </summary>
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

    /// <summary>
    /// An enrolled agent of the given class, last heard from at
    /// <paramref name="lastBeat"/> - now, unless a test is about the window.
    /// Straight into the table, as the persistent and heartbeat suites do: the
    /// one-time code and its HMAC are somebody else's test.
    /// </summary>
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
