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

// one profile per agent, provider and account holder: a directory on somebody's machine holding a browser the bank
// trusts (ASN registration is a long errand); a second account at one provider needs a second agent (deploy/byo)
[Collection(ShopApiCollection.Name)]
public sealed class PersistentProfileTests(ShopApiFactory factory)
{
    private const string Provider = PersistentStoreAdapter.ProviderId;

    // CreateAsync mints a new session every time, so the profile alone carries the browser across devices;
    // per-session keys would repeat the bank's registration
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

        Assert.Single(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == agent && p.ProviderId == Provider)
            .ToList()));
    }

    // a second account on one machine looks like a second device, and the browser is already signed in to the first,
    // so a second agent is the answer
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

    // disconnect must leave the profile row: it names a directory on a machine out of reach, and deleting it would
    // send the holder back to the bank's registration
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

    // agents of FleetSubjects owners pass the ownership check for every caller, so the key needs the subject or the
    // second person gets the first's signed-in browser
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

    // an owned agent refuses a stranger with the same answer as a missing one: ownership is not the caller's to learn
    [Fact]
    public async Task Naming_somebody_elses_agent_is_refused_rather_than_given_a_profile()
    {
        var agent = await EnrollAsync(Flows.NewSubject("owner"));

        var refused = await PostAsync(
            Flows.NewSubject("stranger"), agent, pin: null, label: null, TimeSpan.FromSeconds(10));

        Assert.NotNull(refused);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.Status);

        Assert.Empty(Db.Read(factory, db => db.Profiles.AsNoTracking()
            .Where(p => p.AgentId == agent)
            .ToList()));
    }

    // routing never checked the agent was running: a login naming a dead agent sat queued until the abandonment sweep
    // failed it 30 minutes later; 503 is agent_unavailable's catalogue status
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

    // ten seconds is well inside the heartbeat window and still passes if the window shrank to one missed beat
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

    // only profile-pinned work is refused early; an ordinary job goes to the fleet after a head start. The session is
    // activated by hand: no agent here serves this provider
    [Fact]
    public async Task A_fetch_pinned_to_an_agent_that_has_since_gone_offline_is_refused_rather_than_queued()
    {
        var subject = Flows.NewSubject("fetch_offline");
        var agent = await EnrollAsync(subject);

        var connected = await ConnectAsync(subject, agent);
        Assert.NotNull(connected.Profile);

        var bundle = ActivateAndSeal(connected.Session, agent, connected.Profile);

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

        // promptly: the fetch window is at least five seconds, and waiting it out would be the 202 under another status
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(4), $"the refusal took {clock.Elapsed.TotalSeconds:0.0}s");

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.SessionId == connected.Session && j.Kind == JobKind.Fetch)));
    }

    // revocation replaces the token hash: starting that machine gets 401 and a self-revoke that wipes the profiles,
    // so a revoked agent must read agent_revoked (403, reconnect), never "start it"
    [Fact]
    public async Task A_fetch_whose_agent_was_revoked_is_refused_as_revoked_rather_than_as_switched_off()
    {
        var subject = Flows.NewSubject("fetch_revoked");
        var agent = await EnrollAsync(subject);

        var connected = await ConnectAsync(subject, agent);
        Assert.NotNull(connected.Profile);

        var bundle = ActivateAndSeal(connected.Session, agent, connected.Profile);

        // revoked through the real endpoint so the row is what revocation leaves: dead token, orphaned profile, warm heartbeat
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

        Assert.Equal(0, Db.Read(factory, db => db.Jobs.AsNoTracking()
            .Count(j => j.SessionId == connected.Session && j.Kind == JobKind.Fetch)));
    }

    // the error contract has no free-text field (the detail is logged beside a detail_id), so the operator sentence
    // is asserted on the builder
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

        // neither the heartbeat age nor the start-it instruction may survive in the revoked sentence
        Assert.DoesNotContain("last checked in", revoked.Detail!, StringComparison.Ordinal);
        Assert.DoesNotContain("90s ago", revoked.Detail!, StringComparison.Ordinal);
        Assert.DoesNotContain("start the agent", revoked.Detail!, StringComparison.Ordinal);

        var silent = FetchRunner.HolderRefusal("prf_quiet", Holder("agt_off", beat, revoked: false));

        Assert.Equal(ErrorCode.AgentUnavailable, silent.Code);
        Assert.Equal(
            $"agent 'agt_off' holding profile 'prf_quiet' last checked in at {beat:O}, more than 90s ago; "
            + "only that machine can serve this session, so start the agent and fetch again",
            silent.Detail);

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

    // ValidateInputs once refused every input on persistent logins, which made ASN's PIN flow unconnectable;
    // the pin must reach the job, not just be accepted
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

    // only what the manifest declared is accepted: otherwise the manifest turns advisory on this flow
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

    // the unique index holds the rule: two simultaneous connects both miss the read and would register two browsers;
    // the loser now fails with a retriable error
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

    // BYO agents name their own profiles (own-{agent}-{provider}) on heartbeats with no subject; an index refusing
    // them once cost an agent its liveness
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

    // does not wait for the answer: the login job is queued for an agent this suite never stands up, so the route
    // holds the socket for the full login wait; the asserted rows are committed before it
    private async Task<Connected> ConnectAsync(string subject, string agentId, string? pin = null)
    {
        var label = "connect-" + Guid.NewGuid().ToString("N")[..12];

        var posted = await PostAsync(subject, agentId, pin, label, TimeSpan.FromSeconds(1));

        // refusals all happen before anything is queued, within the second; a success is what hangs
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

    // polled: abandoning the request races the write
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

    // null: the route was still working when the caller stopped waiting, the ordinary case here
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

    // sealed through SessionService.Seal so the binding (provider, subject, manifest version) is the real one
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

    private async Task<string> EnrollAsync(string owner, DateTimeOffset? lastBeat = null)
    {
        // straight into the table: the one-time code and its HMAC are tested elsewhere
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
