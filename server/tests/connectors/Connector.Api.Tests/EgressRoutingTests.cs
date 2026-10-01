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

/// <summary>
/// A provider that asks to be reached from a particular address gets an agent
/// on one, or an honest refusal.
///
/// <para>
/// <c>EgressRequirement</c> was documentation. Thirteen manifests ask for an
/// address - DUO and BKR for a Dutch residential line, and so do AH, Jumbo,
/// Bol, amazon.nl, Lidl Plus and ASN - an agent has always sent its own claim
/// on enrollment and on every heartbeat, and <c>CanServe</c>, the only gate the
/// lease query applies, asked for providers and runtimes and stopped. A grep
/// for a READ of <c>.Egress</c> outside the assignments found nothing at all.
/// So the operator's datacenter fleet was offered Jumbo's logins exactly as
/// readily as a machine on a domestic line, and what came back was the tarpit
/// rather than an explanation.
/// </para>
///
/// <para>
/// The two halves are here together because they are one rule seen from both
/// sides: nobody on the wrong line may take the job, and the caller is told at
/// once when nobody on the right one is there - rather than watching a queue
/// that cannot move until <c>ExpireAbandonedAsync</c> fails it half an hour
/// later. An exclusion without the refusal is the stranding the queue's own
/// head-start comment warns about, in a new place.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class EgressRoutingTests(ShopApiFactory factory)
{
    private const string Residential = ResidentialStoreAdapter.ProviderId;

    /// <summary>
    /// A shipped provider that asks for NL and nothing more, so the "still
    /// offered everything else" half is about the real catalogue rather than
    /// about a second double written to agree with the first.
    /// </summary>
    private const string CountryOnly = "mediamarkt-nl";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    private static readonly EgressRequirement Datacenter =
        new() { Country = "NL", Kind = EgressRequirement.Any };

    private static readonly EgressRequirement Home =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    /// <summary>
    /// THE DEFECT, REPRODUCED, and its other half: the agent on the wrong line
    /// is turned away and everything else it carries still reaches it.
    /// </summary>
    /// <remarks>
    /// Both in one test, because either alone would be a worse bug than the one
    /// they replace. A check that turned the fleet away from a residential
    /// provider and also stopped it serving mediamarkt would be a fleet-wide
    /// narrowing dressed as a safety rule - and <c>any</c> is what every agent
    /// in <c>deploy/docker-compose.yml</c> claims, so that would be the whole
    /// of production.
    /// <para>
    /// The same agent, claiming a home line, then takes the job it was refused.
    /// Without that the first assertion is satisfied by a queue that hands out
    /// nothing at all.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task An_agent_on_the_wrong_line_is_refused_that_provider_and_still_offered_the_rest()
    {
        var subject = Flows.NewSubject("egress_lease");

        var wanted = await QueueLoginAsync(subject, Residential);
        var ordinary = await QueueLoginAsync(subject, CountryOnly);

        // Country matches, kind does not: `any` is what a datacenter says
        // about itself, and it is weaker than `residential` rather than a
        // wildcard.
        Assert.Null(await LeaseAsync(subject, [Residential], Datacenter));
        Assert.Equal(JobState.Queued, StateOf(wanted));

        // And the same agent is still handed the provider that asked only for
        // the country.
        var other = await LeaseAsync(subject, [CountryOnly], Datacenter);
        Assert.NotNull(other);
        Assert.Equal(ordinary, other.JobId);

        var leased = await LeaseAsync(subject, [Residential], Home);

        Assert.NotNull(leased);
        Assert.Equal(wanted, leased.JobId);
    }

    /// <summary>
    /// AND AN AGENT THAT CLAIMS NOTHING IS NOT AN AGENT THAT WILL DO.
    /// </summary>
    /// <remarks>
    /// Saying nothing is the default - <c>deploy/byo</c> shipped no egress
    /// setting at all until the change that added this - so reading a missing
    /// claim as "any address" would make the comparison opt-in for exactly the
    /// deployments careful enough to fill it in, and this whole suite would
    /// pass while production routed as it always had.
    /// </remarks>
    [Fact]
    public async Task An_agent_that_claims_no_address_at_all_is_refused_as_well()
    {
        var subject = Flows.NewSubject("egress_unstated");

        var queued = await QueueLoginAsync(subject, Residential);

        Assert.Null(await LeaseAsync(subject, [Residential], claimed: null));
        Assert.Equal(JobState.Queued, StateOf(queued));
    }

    /// <summary>
    /// AND THE CALLER IS TOLD AT LOGIN, not half an hour later by the sweep.
    /// </summary>
    /// <remarks>
    /// The other half of the exclusion, and the queue's own comment above the
    /// fleet's head start says why it has to exist: "an exclusion strands
    /// work... with the user watching a queue that never moves". Accepted, this
    /// login would sit queued until <c>ExpireAbandonedAsync</c> failed it with
    /// <c>agent_unavailable</c> - the same code, after a 202 and a spinner, to
    /// somebody who has long since put the phone down.
    /// <para>
    /// The code and the action are asserted on the wire rather than the prose,
    /// because they are the whole of what a consumer can branch on, and they
    /// are deliberately the pair the own-machine refusal already uses:
    /// <c>user_action</c> is a function of the code and of nothing else, so a
    /// consumer that renders <c>start_your_agent</c> today needs nothing new.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// And an agent that is online and on the wrong line is refused exactly as
    /// one that is not there at all.
    /// </summary>
    /// <remarks>
    /// The case that looks like the opposite of the last one: a machine,
    /// beating, carrying this provider, and useless for it - which is precisely
    /// the production NAS, where every agent claims <c>any</c> because that is
    /// the truth from that box. Without this the refusal would be a headcount
    /// rather than a reading of the claim, and it would pass a login the queue
    /// then refuses to hand anybody.
    /// <para>
    /// Enrolled under this caller's own subject rather than the operator's
    /// fleet, and that is not incidental: an agent row lives for the whole
    /// assembly, and a FLEET machine claiming an address would answer for every
    /// other test's caller too - which would make the refusal above pass or
    /// fail on the order xUnit happened to pick.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND THE REFUSAL LIFTS THE MOMENT SOMEBODY IS THERE WHO CAN.
    /// </summary>
    /// <remarks>
    /// The assertion that stops this rule from being a provider nobody can ever
    /// connect. One machine claiming a home line - which is what
    /// <c>deploy/README.md</c>'s residential host is, and what the local stack
    /// and every BYO container now claim - and the login goes through and
    /// queues its job like any other.
    /// <para>
    /// This caller's own machine and not the operator's, for the ordering
    /// reason above: a fleet agent claiming a home line would satisfy every
    /// other test's caller for the rest of the assembly and quietly delete the
    /// refusals.
    /// </para>
    /// <para>
    /// It does not wait for the answer, for the reason the own-machine suite
    /// spells out: no agent here actually RUNS this provider, so the session
    /// never settles and the route holds the socket for the whole login wait.
    /// Everything asserted is committed before that wait begins.
    /// </para>
    /// </remarks>
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

    // ---- setup -------------------------------------------------------------

    private sealed record Posted(HttpStatusCode Status, string Body);

    /// <summary>
    /// A session and a queued login straight into the tables, as the ownership
    /// and own-machine suites do: going through POST /login would drag consent,
    /// idempotency and - for this provider above all - the login's own egress
    /// refusal into a test about the lease clause alone.
    /// </summary>
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

    /// <summary>
    /// A lease scoped to one caller, and headed so that mediamarkt's separate
    /// rule about somebody standing at the browser never decides anything here.
    /// </summary>
    /// <remarks>
    /// OWNER-SCOPED RATHER THAN THE FLEET, which is what keeps these
    /// assertions about this test's own two jobs. The suite shares one host and
    /// other classes leave queued logins for the same shipped providers behind;
    /// a fleet lease sees all of them, so "the job I queued came back" would be
    /// an assertion about the order of the whole assembly - and getting there
    /// would mean leasing other classes' work out from under them. The scope
    /// costs nothing here: whose job it is and where an agent connects from are
    /// separate clauses, and the second is the only one under test.
    /// </remarks>
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

    /// <summary>
    /// An enrolled, beating agent whose stored capabilities claim
    /// <paramref name="claimed"/>. Straight into the table, as the own-machine
    /// and heartbeat suites do: the one-time code and its HMAC are somebody
    /// else's test.
    /// </summary>
    /// <remarks>
    /// The claim goes into <c>CapabilitiesJson</c> rather than beside it,
    /// because that is where the login has to read it from - the column is the
    /// blob the queue's own SQL cannot see into, which is the reason the
    /// refusal decides in memory.
    /// </remarks>
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
