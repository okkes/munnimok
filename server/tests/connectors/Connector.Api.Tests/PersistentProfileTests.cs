using System.Net;
using System.Net.Http.Json;
using Connector.Kit;
using Connector.Kit.Errors;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Sessions;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// WHICH BROWSER, ON WHOSE MACHINE, a persistent connection lands in.
///
/// <para>
/// A persistent profile is not a record - it is a directory on somebody's
/// computer holding a browser a bank has been taught to trust. ASN registers
/// one once, through an e-mail code, an SMS code and a debit card, and
/// afterwards asks five digits instead of a QR scan and a phone. Everything
/// here is about not throwing that away.
/// </para>
///
/// <para>
/// The rule is ONE PROFILE PER AGENT, PROVIDER AND ACCOUNT HOLDER, and it cuts
/// two ways. Every device of one person shares it, so connecting from a phone
/// and then a laptop does not register two browsers. And a second account at
/// the same provider therefore needs a second agent - the limit is real, it is
/// stated in <c>deploy/byo</c>, and the escape hatch is asserted below rather
/// than assumed.
/// </para>
///
/// <para>
/// Until this suite existed the reuse happened by accident. The filter read
/// <c>p.SessionId == null</c> against a column NOTHING ever assigned, so it
/// matched every row for ever: the right behaviour, produced by a condition
/// that was not doing anything - and it would not have survived anybody
/// rewriting that dead field into a live one, at which point every second
/// device becomes a second browser registration.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class PersistentProfileTests(ShopApiFactory factory)
{
    private const string Provider = PersistentStoreAdapter.ProviderId;

    /// <summary>
    /// A PHONE AND A LAPTOP ARE TWO SESSIONS OF ONE CONNECTION.
    /// </summary>
    /// <remarks>
    /// Nothing reuses a session by subject and provider - <c>CreateAsync</c>
    /// mints a new one every time - so the second device arrives as a brand new
    /// session, and the profile is the only thing that can carry the browser
    /// across. Key it per session and the laptop opens a directory the bank has
    /// never seen, which costs the account holder the whole registration errand
    /// a second time.
    /// </remarks>
    [Fact]
    public async Task Two_devices_of_one_person_land_in_the_browser_they_already_trusted()
    {
        var subject = Flows.NewSubject("two_devices");
        var agent = await EnrollAsync(subject);

        var phone = await ConnectAsync(subject, agent);
        var laptop = await ConnectAsync(subject, agent);

        Assert.NotEqual(phone.Session, laptop.Session);

        Assert.NotNull(phone.Profile);
        Assert.Equal(phone.Profile, laptop.Profile);

        // And one directory exists, rather than two that happen to be named
        // the same.
        Assert.Single(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == agent && p.ProviderId == Provider)
            .ToList()));
    }

    /// <summary>
    /// AND A SECOND AGENT IS WHAT A SECOND ACCOUNT NEEDS.
    /// </summary>
    /// <remarks>
    /// The other half of the same rule, and the reason it is a limit rather
    /// than a defect. One person with two accounts at one bank cannot have both
    /// on one machine: the browser is already signed in to the first, so the
    /// adapter finds a live session and never asks for the second. Nothing here
    /// can tell that request apart from a second device - same subject, same
    /// provider, same agent - so the answer is a second agent, and this asserts
    /// that naming one really does produce a second browser.
    /// </remarks>
    [Fact]
    public async Task A_second_agent_is_what_a_second_account_needs()
    {
        var subject = Flows.NewSubject("two_accounts");

        var first = await EnrollAsync(subject);
        var second = await EnrollAsync(subject);

        var one = await ConnectAsync(subject, first);
        var other = await ConnectAsync(subject, second);

        Assert.NotNull(one.Profile);
        Assert.NotNull(other.Profile);
        Assert.NotEqual(one.Profile, other.Profile);
    }

    /// <summary>
    /// AND DISCONNECTING DOES NOT COST THEM THE REGISTRATION.
    /// </summary>
    /// <remarks>
    /// Disconnect purges everything this platform holds about a connection, and
    /// the profile row is the one thing it must leave alone: it names a
    /// directory on a machine nothing here can reach, and deleting it would
    /// mint a fresh id on the next connect, point the agent at an empty
    /// directory, and send the account holder back to the bank's registration
    /// errand for a connection they only meant to re-add.
    /// <para>
    /// The provider session is still ended properly wherever a provider has
    /// one: a declared logout reaches the agent as its own job. This provider
    /// declares none, because signing out IS destroying the asset.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_reconnect_after_disconnecting_keeps_the_browser_the_bank_trusts()
    {
        var subject = Flows.NewSubject("reconnect");
        var agent = await EnrollAsync(subject);

        var before = await ConnectAsync(subject, agent);

        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using var request = new HttpRequestMessage(
            HttpMethod.Delete, $"/v1/{Provider}/sessions/{before.Session}")
        {
            Content = JsonContent.Create(new { bundle = (string?)null }),
        };

        using var disconnect = await http.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);

        var after = await ConnectAsync(subject, agent);

        Assert.NotEqual(before.Session, after.Session);
        Assert.Equal(before.Profile, after.Profile);
    }

    /// <summary>
    /// AND TWO PEOPLE SHARING ONE MACHINE NEVER SHARE A BROWSER.
    /// </summary>
    /// <remarks>
    /// An agent has one owner and may only ever serve that subject, which makes
    /// the account holder look redundant in the key - and it is not, because
    /// the operator's own fleet is the standing exception: an agent whose owner
    /// is listed in <c>FleetSubjects</c> passes the ownership check for EVERY
    /// caller. Keyed on the agent and provider alone, the second person to name
    /// one would be pinned to the first person's profile and handed a browser
    /// already signed in to somebody else's account.
    /// <para>
    /// This is the clause with no other guard behind it. It costs one column
    /// and one comparison, and the failure it prevents is a bank session
    /// crossing between two people.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Two_people_sharing_one_fleet_agent_never_share_a_browser()
    {
        var agent = await EnrollAsync(ConnectorOptions.DevFleetSubject);

        var mine = await ConnectAsync(Flows.NewSubject("fleet_first"), agent);
        var theirs = await ConnectAsync(Flows.NewSubject("fleet_second"), agent);

        Assert.NotNull(mine.Profile);
        Assert.NotNull(theirs.Profile);

        Assert.NotEqual(mine.Profile, theirs.Profile);
    }

    /// <summary>
    /// And naming somebody else's machine still gets you nowhere.
    /// </summary>
    /// <remarks>
    /// The subject in the key is a second line and never the first. An owned
    /// agent refuses a stranger outright, and says the same thing it says about
    /// an agent that does not exist - whether a given id belongs to somebody
    /// else is not the caller's to learn.
    /// </remarks>
    [Fact]
    public async Task Naming_somebody_elses_agent_is_refused_rather_than_given_a_profile()
    {
        var agent = await EnrollAsync(Flows.NewSubject("owner"));

        var refused = await PostAsync(
            Flows.NewSubject("stranger"), agent, pin: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        // And nothing was minted on the way to refusing.
        Assert.Empty(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == agent)
            .ToList()));
    }

    /// <summary>
    /// AND NAMING AN AGENT THAT IS NOT THERE IS REFUSED NOW, not in thirty
    /// minutes.
    /// </summary>
    /// <remarks>
    /// The routing checked that the agent existed, was not revoked and was the
    /// caller's, and never whether it was RUNNING. A login naming an agent
    /// whose last heartbeat was in August was accepted, pinned to a profile
    /// only that agent can lease, and sat queued until the abandonment sweep
    /// failed it with <c>agent_unavailable</c> half an hour later - the same
    /// code, delivered after a 202 and a spinner instead of at once. On the
    /// user's stack two such rows exist, one sharing the live agent's name,
    /// so picking the wrong "my nas" from a list produced exactly this.
    /// <para>
    /// 503 because that is what <c>agent_unavailable</c> is in the catalogue,
    /// and the code is asserted on the wire rather than the status alone: the
    /// consumer keys "start your agent" off the code, and a refusal on any
    /// other one would be rendered as a failure. Nothing is created on the way
    /// to refusing - no session, no profile - which is what makes this a
    /// refusal rather than an early failure.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Naming_an_agent_that_has_stopped_beating_is_refused_before_anything_is_queued()
    {
        var subject = Flows.NewSubject("offline_agent");
        var agent = await EnrollAsync(subject, lastBeat: DateTimeOffset.UtcNow.AddHours(-1));
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var refused = await PostAsync(subject, agent, pin: null, label, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        using var body = System.Text.Json.JsonDocument.Parse(refused.Body);
        var error = body.RootElement.GetProperty("error");
        Assert.Equal("agent_unavailable", error.GetProperty("code").GetString());
        Assert.Equal("start_your_agent", error.GetProperty("user_action").GetString());

        Assert.Null(Db.Read(factory, db => db.Sessions.AsNoTracking()
            .Where(s => s.Label == label)
            .Select(s => s.Id)
            .FirstOrDefault()));

        Assert.Empty(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == agent)
            .ToList()));
    }

    /// <summary>
    /// And one that beat a moment ago is accepted exactly as before.
    /// </summary>
    /// <remarks>
    /// The other edge of the same rule. Ten seconds is a third of one
    /// heartbeat interval - well inside the window, and a value that would
    /// still pass if the window were tightened to a single missed beat. A
    /// refusal that fired here would refuse every real agent there is.
    /// </remarks>
    [Fact]
    public async Task Naming_an_agent_that_beat_ten_seconds_ago_is_accepted()
    {
        var subject = Flows.NewSubject("live_agent");
        var agent = await EnrollAsync(subject, lastBeat: DateTimeOffset.UtcNow.AddSeconds(-10));

        var connected = await ConnectAsync(subject, agent);

        Assert.NotNull(connected.Profile);
        Assert.Equal(agent, Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.Id == connected.Profile)
            .Select(p => p.AgentId)
            .Single()));
    }

    /// <summary>
    /// AND A FETCH ON A CONNECTION WHOSE MACHINE HAS SINCE GONE OFF is refused
    /// the same way, rather than accepted and left to time out.
    /// </summary>
    /// <remarks>
    /// The login check catches the agent that was already off. This is the
    /// agent that went off afterwards: the connection is real, the bundle is
    /// real, and the fetch it carries is pinned to a profile on a machine that
    /// is not running. Queued, it would sit for the full abandonment window
    /// behind a 202 - the caller polling a job nobody will ever lease.
    /// <para>
    /// Only profile-pinned work may be refused like this. An ordinary job
    /// whose owner's machine is off is handed to the fleet after a head
    /// start, and refusing it early would break that. So the assertion is
    /// two-sided: the fetch answers <c>agent_unavailable</c> at once, AND no
    /// fetch job was written - the login job that was already queued is the
    /// only one the session has.
    /// </para>
    /// <para>
    /// The session is driven to active by hand and the bundle sealed with the
    /// service's own codec, because this provider's login never finishes: no
    /// agent in this suite serves it, which is the very state under test.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_fetch_pinned_to_an_agent_that_has_since_gone_offline_is_refused_rather_than_queued()
    {
        var subject = Flows.NewSubject("fetch_offline");
        var agent = await EnrollAsync(subject);

        var connected = await ConnectAsync(subject, agent);
        Assert.NotNull(connected.Profile);

        var bundle = ActivateAndSeal(connected.Session, agent, connected.Profile);

        // The machine goes off after the connection was made.
        Db.Write(factory, db => db.Agents
            .Where(a => a.Id == agent)
            .ExecuteUpdate(s => s.SetProperty(a => a.LastHeartbeatAt, DateTimeOffset.UtcNow.AddHours(-1))));

        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{Provider}/receipts:fetch", new { subject, bundle });

        var clock = System.Diagnostics.Stopwatch.StartNew();
        using var response = await http.SendAsync(request);
        clock.Stop();

        var error = await ErrorEnvelope.AssertAsync(response, HttpStatusCode.ServiceUnavailable, "agent_unavailable");
        Assert.Equal("start_your_agent", error.Text("user_action"));

        // Promptly: the fetch window is at least five seconds, and a refusal
        // that waited it out would be the 202 this test exists to prevent
        // wearing a different status code.
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(4), $"the refusal took {clock.Elapsed.TotalSeconds:0.0}s");

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.SessionId == connected.Session && j.Kind == JobKind.Fetch)));
    }

    /// <summary>
    /// AND A FETCH WHOSE AGENT WAS REVOKED IS TOLD THAT, not told to switch a
    /// machine on.
    /// </summary>
    /// <remarks>
    /// The other way a holder stops being usable, and until now it wore the
    /// silent one's clothes. <c>AgentLiveness.IsOnline</c> answers false for
    /// REVOKED or STALE, and the refusal only knew the stale sentence - so an
    /// agent revoked thirty seconds ago, heartbeat still warm, was reported as
    /// not having checked in for more than ninety seconds and the user was
    /// told to start it.
    /// <para>
    /// Both halves were false, and the instruction was the harmful half.
    /// Revocation replaces the agent's token hash, so the machine that does as
    /// it is told is answered 401 on its first call, self-revokes and wipes
    /// the profiles - the browser registration this whole suite is about -
    /// on the way out. The advice destroys what it claims to recover, and
    /// repeating it never changes the answer.
    /// </para>
    /// <para>
    /// So the code differs, because <c>user_action</c> is a function of the
    /// code and of nothing else: <c>agent_revoked</c>, 403, not retriable,
    /// <c>reconnect</c>. Asserted on the wire rather than by the detail,
    /// because the detail is not on the wire - it is logged beside a
    /// <c>detail_id</c>, and the code and the action are the whole of what a
    /// consumer can branch on.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_fetch_whose_agent_was_revoked_is_refused_as_revoked_rather_than_as_switched_off()
    {
        var subject = Flows.NewSubject("fetch_revoked");
        var agent = await EnrollAsync(subject);

        var connected = await ConnectAsync(subject, agent);
        Assert.NotNull(connected.Profile);

        var bundle = ActivateAndSeal(connected.Session, agent, connected.Profile);

        // Revoked through the real endpoint, so the row under test is the one
        // revocation actually leaves behind - dead token, orphaned profile -
        // rather than a hand-set flag. The heartbeat is untouched and seconds
        // old, which is the case the old wording got wrong.
        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using (var revoked = await http.DeleteAsync($"/v1/agents/{agent}"))
        {
            Assert.Equal(HttpStatusCode.NoContent, revoked.StatusCode);
        }

        Assert.True(Db.Read(factory, db => db.Agents.AsNoTracking()
            .Where(a => a.Id == agent)
            .Select(a => a.Revoked)
            .Single()));

        using var request = Wire.Post($"/v1/{Provider}/receipts:fetch", new { subject, bundle });
        using var response = await http.SendAsync(request);

        var error = await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Forbidden, "agent_revoked");
        Assert.Equal("reconnect", error.Text("user_action"));
        Assert.False(error.GetProperty("retriable").GetBoolean());

        // And it is a refusal, not an early failure: nothing was queued for
        // somebody to poll.
        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.SessionId == connected.Session && j.Kind == JobKind.Fetch)));
    }

    /// <summary>
    /// And the operator-facing sentence says the revoked thing, with no trace
    /// of the heartbeat one.
    /// </summary>
    /// <remarks>
    /// Asserted against the builder directly because there is nowhere else to
    /// assert it. The error contract has no free-text field on purpose - the
    /// detail is logged beside a <c>detail_id</c> and stops at the boundary -
    /// so the test above can prove the code and the action and not one word of
    /// the prose an operator reads at three in the morning. This is the half
    /// that was lying, so it is the half worth pinning, and the negative
    /// assertions are the point: the old sentence must not survive anywhere in
    /// the new one.
    /// </remarks>
    [Fact]
    public void The_revoked_refusal_says_revoked_and_never_quotes_a_heartbeat_age()
    {
        var beat = DateTimeOffset.UtcNow.AddSeconds(-5);

        var revoked = FetchRunner.HolderRefusal("prf_revoked", Holder("agt_gone", beat, revoked: true));

        Assert.Equal(ErrorCode.AgentRevoked, revoked.Code);
        Assert.Equal(
            "agent 'agt_gone' holding profile 'prf_revoked' was revoked; nothing can serve this session, "
            + "and starting that machine cannot help - its token no longer matches, so it would be answered "
            + "401 and wipe the profile on the way out; the connection has to be set up again",
            revoked.Detail);

        // Neither half of the sentence it used to get: not the age, which was
        // five seconds, and not the instruction, which cannot work.
        Assert.DoesNotContain("last checked in", revoked.Detail!, StringComparison.Ordinal);
        Assert.DoesNotContain("90s ago", revoked.Detail!, StringComparison.Ordinal);
        Assert.DoesNotContain("start the agent", revoked.Detail!, StringComparison.Ordinal);

        // And the silent holder still gets exactly what it always got, so the
        // branch added a case rather than replacing one.
        var silent = FetchRunner.HolderRefusal("prf_quiet", Holder("agt_off", beat, revoked: false));

        Assert.Equal(ErrorCode.AgentUnavailable, silent.Code);
        Assert.Equal(
            $"agent 'agt_off' holding profile 'prf_quiet' last checked in at {beat:O}, more than 90s ago; "
            + "only that machine can serve this session, so start the agent and fetch again",
            silent.Detail);

        // And a profile whose agent row has gone entirely is the third case,
        // which is neither of the other two.
        var missing = FetchRunner.HolderRefusal("prf_orphan", holder: null);

        Assert.Equal(ErrorCode.AgentUnavailable, missing.Code);
        Assert.Equal(
            "profile 'prf_orphan' or the agent holding it no longer exists; nothing can serve this session",
            missing.Detail);
    }

    private static AgentRow Holder(string id, DateTimeOffset lastBeat, bool revoked) => new()
    {
        Id = id,
        Name = "holder",
        Class = AgentClass.Byo,
        LastHeartbeatAt = lastBeat,
        Revoked = revoked,
        CreatedAt = lastBeat,
    };

    /// <summary>
    /// AND IT TAKES THE INPUTS ITS MANIFEST ASKS FOR.
    /// </summary>
    /// <remarks>
    /// <c>ValidateInputs</c> refused EVERY input on this flow, on the reasoning
    /// that a persistent login has no credential step - and that stopped being
    /// true the moment ASN's trusted-browser sign-in arrived. Five digits, held
    /// by the client, typed into a browser the bank already knows. Under the
    /// old rule ASN answered "this provider's login takes no inputs" to the
    /// exact payload its own manifest describes, and omitting the payload
    /// failed on the missing required field instead. Both persistent providers
    /// that ask for anything were unconnectable, and every test of either
    /// called the adapter directly, so nothing said so. The third declares no
    /// fields, agreed with the rule, and was the only one anybody connected.
    /// <para>
    /// The pin is asserted to reach the session's job rather than merely to be
    /// accepted: a validator that stopped refusing but dropped the value would
    /// leave the agent with a browser and nothing to unlock it with.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_persistent_login_carries_the_secret_its_manifest_declares()
    {
        var subject = Flows.NewSubject("with_pin");
        var agent = await EnrollAsync(subject);

        var connected = await ConnectAsync(subject, agent, pin: "54321");

        var job = Db.LatestJob(factory, connected.Session);

        Assert.NotNull(job.InputsJson);
        Assert.Contains("54321", job.InputsJson, StringComparison.Ordinal);
    }

    /// <summary>
    /// And a field the manifest never declared is still refused.
    /// </summary>
    /// <remarks>
    /// The rule that replaced the blanket refusal is "only what the manifest
    /// declared", and it has to still say no - otherwise letting a persistent
    /// login take inputs would have made the manifest advisory on the one flow
    /// whose whole point is that nothing unexpected reaches the machine.
    /// </remarks>
    [Fact]
    public async Task An_input_the_manifest_never_declared_is_still_refused()
    {
        var subject = Flows.NewSubject("undeclared");
        var agent = await EnrollAsync(subject);

        using var http = factory.CreateAuthorizedClient();
        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject,
            inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [PersistentStoreAdapter.AgentField] = agent,
                ["password"] = "not a field this provider has",
            },
            prefer_agent = agent,
        });

        using var response = await http.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// AND THE DATABASE HOLDS THE RULE, not just the query that reads it.
    /// </summary>
    /// <remarks>
    /// Every assertion above goes through one <c>FirstOrDefaultAsync</c> that
    /// looks for the profile before minting one, and between that read and its
    /// write there is a gap. Two devices connecting at the same instant both
    /// miss, both insert, and the account holder ends up with two browsers
    /// where the bank trusts one - silently, because both connects succeeded.
    /// <para>
    /// With the index the loser of that race fails instead, on a code the
    /// caller may retry, and the retry finds the row the winner wrote. A
    /// retriable error beats a second browser registration nobody asked for.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task One_machine_cannot_hold_two_browsers_for_one_person_and_provider()
    {
        var subject = Flows.NewSubject("collide");
        var agent = await EnrollAsync(subject);

        await ConnectAsync(subject, agent);

        var second = Record.Exception(() => Db.Write(factory, db => db.Profiles.Add(new ProfileRow
        {
            Id = Ids.New(Ids.Profile),
            AgentId = agent,
            ProviderId = Provider,
            Subject = subject,
            Healthy = false,
        })));

        Assert.IsType<DbUpdateException>(second);
    }

    /// <summary>
    /// And it still leaves room for the profiles an agent names itself.
    /// </summary>
    /// <remarks>
    /// A BYO agent runs ordinary providers persistently too, and derives their
    /// ids on its own machine - <c>own-{agent}-{provider}</c> - then reports
    /// them on a heartbeat that has no subject to attach. Those rows are
    /// already unique by construction. An index that refused them would refuse
    /// a heartbeat, and the last time a profile insert could fail on a
    /// heartbeat it took the agent's liveness with it and nothing said why.
    /// </remarks>
    [Fact]
    public async Task A_profile_the_agent_named_itself_still_fits_beside_one_we_pinned()
    {
        var subject = Flows.NewSubject("derived");
        var agent = await EnrollAsync(subject);

        await ConnectAsync(subject, agent);

        var derived = Record.Exception(() => Db.Write(factory, db => db.Profiles.Add(new ProfileRow
        {
            Id = $"own-{agent}-{Provider}",
            AgentId = agent,
            ProviderId = Provider,
            Subject = null,
            Healthy = true,
        })));

        Assert.Null(derived);
    }

    private sealed record Connected(string Session, string? Profile);

    private sealed record Posted(HttpStatusCode Status, string Body);

    /// <summary>
    /// Connects and hands back the session and the profile it was pinned to.
    /// </summary>
    /// <remarks>
    /// IT DOES NOT WAIT FOR THE ANSWER, and that is the difference between
    /// this suite taking two seconds and taking two minutes. A persistent
    /// provider is BYO and agent-required, so its login job is queued for a
    /// machine this suite never stands up: the session never settles, and the
    /// route holds the socket for the full login wait before answering 202
    /// with exactly the state the database already had.
    /// <para>
    /// Everything asserted here - the session, its profile, the job and its
    /// inputs - is committed BEFORE that wait begins. So the request is
    /// abandoned at the point where it would only be waiting, and the rows are
    /// read by the label this connect was given, which is unique to it.
    /// </para>
    /// </remarks>
    private async Task<Connected> ConnectAsync(string subject, string agentId, string? pin = null)
    {
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var posted = await PostAsync(subject, agentId, pin, label, TimeSpan.FromSeconds(1));

        // An error comes back inside the second, because the refusals all
        // happen before anything is queued. A success is the one that hangs.
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

    /// <summary>
    /// The session this connect created, once the route has committed it.
    /// Polled rather than assumed: abandoning the request is a race against the
    /// write, and losing it would read as "no session" rather than as the
    /// timing it is.
    /// </summary>
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
    /// Posts the login. Null means the route was still working when the
    /// caller stopped waiting, which for this provider is the ordinary case.
    /// </summary>
    private async Task<Posted?> PostAsync(
        string subject, string agentId, string? pin, string? label, TimeSpan patience)
    {
        var inputs = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [PersistentStoreAdapter.AgentField] = agentId,
        };

        if (pin is not null) inputs[PersistentStoreAdapter.PinField] = pin;

        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject,
            inputs,
            label,
            prefer_agent = agentId,
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
    /// Drives a session to active and seals the bundle a finished login would
    /// have handed back: a pointer to the agent and the profile, no secret.
    /// </summary>
    /// <remarks>
    /// Through <c>SessionService.Seal</c> rather than a hand-built blob, so the
    /// binding - provider, subject, manifest version - is the real one and the
    /// resume path opens it exactly as it opens a bundle the platform minted.
    /// </remarks>
    private string ActivateAndSeal(string sessionId, string agentId, string profileId)
    {
        Db.Write(factory, db => db.Sessions
            .Where(s => s.Id == sessionId)
            .ExecuteUpdate(s => s.SetProperty(row => row.State, SessionState.Active)));

        using var scope = factory.Services.CreateScope();
        var session = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>().Sessions
            .AsNoTracking()
            .Single(s => s.Id == sessionId);

        return scope.ServiceProvider.GetRequiredService<SessionService>()
            .Seal(session, SessionMaterial.ForAgent(agentId, profileId), accounts: [], adapterExpiry: null)
            .Bundle;
    }

    /// <summary>
    /// An enrolled BYO agent owned by <paramref name="owner"/>, last heard
    /// from at <paramref name="lastBeat"/> - now, unless a test is about the
    /// window.
    /// </summary>
    private async Task<string> EnrollAsync(string owner, DateTimeOffset? lastBeat = null)
    {
        // Straight into the table, as the heartbeat suite does: the one-time
        // code and its HMAC are somebody else's test.
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "persistent test agent",
            Class = AgentClass.Byo,
            OwnerSubject = owner,
            CapabilitiesJson = "{}",
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = lastBeat ?? DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));

        await Task.CompletedTask;
        return id;
    }
}
