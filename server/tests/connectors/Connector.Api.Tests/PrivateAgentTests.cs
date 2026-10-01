using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Connector.Kit;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// Hosted private slots (#420 A2): munni's own container that serves one
/// person at a time. The properties worth pinning are the ones the custody
/// story rests on - a free slot is NOBODY's (leased nothing, listed for no
/// one), an approval makes it exactly one person's machine, and giving it
/// back takes the previous person's sign-ins off it before anybody else can
/// have it, with the agent's own word for the wipe as the last step.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class PrivateAgentTests(ShopApiFactory factory)
{
    /// <summary>Agent-tier, and asks for a Dutch residential line - which every slot here claims.</summary>
    private const string Provider = "ah";

    private static readonly string[] LoginJobsOnly = ["login"];

    /// <summary>
    /// The token of every slot this class enrolled. The suite shares one
    /// database, so an approval may bind a slot another test enrolled - the
    /// oldest free one - and the test must be able to beat and lease as
    /// whichever slot it was given.
    /// </summary>
    private static readonly ConcurrentDictionary<string, string> Tokens = new(StringComparer.Ordinal);

    [Fact]
    public async Task A_slot_enrolls_with_the_private_code_as_nobodys_and_is_leased_nobodys_work()
    {
        var slot = await EnrollSlotAsync("slot one");

        var row = Db.Read(factory, db => db.Agents.Single(a => a.Id == slot.Id));
        Assert.True(row.Hosted);
        Assert.Equal(ConnectorOptions.PrivateSlotSubject, row.OwnerSubject);
        Assert.Equal(AgentClass.Byo, row.Class);

        // somebody's login is queued; a free slot is offered nothing
        var job = await QueueLoginAsync(Flows.NewSubject("queued"));
        using (var refused = await LeaseAsync(slot.Token, TimeSpan.FromSeconds(2)))
        {
            Assert.Null(refused);
        }

        Assert.Equal(JobState.Queued, StateOf(job));

        // and it is nobody's machine: a person's own list leaves it out, the operator sees a free slot
        using var theirs = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        Assert.DoesNotContain(slot.Id, await AgentIdsAsync(theirs, "/v1/agents"));

        using var operatorSide = factory.CreateAuthorizedClient();
        var overview = await (await operatorSide.GetAsync("/v1/admin/private-agents")).JsonAsync();
        var listed = overview.GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("agent").Text("id") == slot.Id);
        Assert.True(listed.GetProperty("agent").GetProperty("hosted").GetBoolean());
        Assert.False(listed.GetProperty("agent").GetProperty("bound").GetBoolean());
        Assert.True(Absent(listed, "subject"), "a free slot names nobody");
        Assert.True(overview.GetProperty("free").GetInt32() >= 1);
        Assert.True(overview.GetProperty("total").GetInt32() >= overview.GetProperty("free").GetInt32());
    }

    [Fact]
    public async Task A_person_asks_the_operator_approves_the_slot_is_their_own_machine_and_giving_it_back_wipes_it()
    {
        await EnrollSlotAsync("slot two");
        var person = Flows.NewSubject("asker");
        using var mine = factory.CreateAuthorizedClient().ActAs(person);
        using var operatorSide = factory.CreateAuthorizedClient();

        var before = await (await mine.GetAsync("/v1/private-agents/mine")).JsonAsync();
        Assert.True(before.GetProperty("offered").GetBoolean());
        Assert.True(Absent(before, "request"));
        Assert.True(Absent(before, "agent"));

        // the request - and asking twice is one request
        using var asked = await mine.SendAsync(Wire.Post("/v1/private-agents/requests", new { subject = person }));
        Assert.Equal(HttpStatusCode.OK, asked.StatusCode);
        var request = await asked.JsonAsync();
        Assert.Equal("pending", request.Text("state"));
        var requestId = request.Text("id");
        using var again = await mine.SendAsync(Wire.Post("/v1/private-agents/requests", new { subject = person }));
        Assert.Equal(requestId, (await again.JsonAsync()).Text("id"));

        // the operator sees it and approves: the oldest free slot is theirs
        var overview = await (await operatorSide.GetAsync("/v1/admin/private-agents")).JsonAsync();
        Assert.Contains(overview.GetProperty("requests").EnumerateArray(), r => r.Text("id") == requestId);
        using var approved = await operatorSide.SendAsync(Wire.Post($"/v1/admin/private-agents/requests/{requestId}/approve"));
        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        var decided = await approved.JsonAsync();
        Assert.Equal("approved", decided.Text("state"));
        var boundId = decided.Text("agent_id");
        var token = Tokens[boundId];

        var bound = Db.Read(factory, db => db.Agents.Single(a => a.Id == boundId));
        Assert.True(bound.Hosted);
        Assert.Equal(person, bound.OwnerSubject);
        Assert.NotNull(bound.BoundAt);

        // their own machine now: in their list as hosted and bound, in nobody else's
        var listed = (await (await mine.GetAsync("/v1/agents")).JsonAsync())
            .GetProperty("agents").EnumerateArray().Single(a => a.Text("id") == boundId);
        Assert.True(listed.GetProperty("hosted").GetBoolean());
        Assert.True(listed.GetProperty("bound").GetBoolean());
        using var stranger = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        Assert.DoesNotContain(boundId, await AgentIdsAsync(stranger, "/v1/agents"));

        var after = await (await mine.GetAsync("/v1/private-agents/mine")).JsonAsync();
        Assert.Equal(boundId, after.GetProperty("agent").Text("id"));
        Assert.Equal("approved", after.GetProperty("request").Text("state"));

        // and their work goes to it, as to a container in their house
        var job = await QueueLoginAsync(person);
        Assert.Equal(job, await LeaseUntilAsync(token, job));

        // giving it back: the owner is the slot subject again, the previous
        // sign-ins are gone from the books, and the slot is free to nobody
        // until the agent says the directories are gone too
        Db.Write(factory, db => db.Profiles.Add(new ProfileRow
        {
            Id = "prf_" + Guid.NewGuid().ToString("N"),
            AgentId = boundId,
            ProviderId = Provider,
            Subject = person,
            Healthy = true,
        }));
        using var back = await mine.DeleteAsync("/v1/private-agents/mine");
        Assert.Equal(HttpStatusCode.NoContent, back.StatusCode);

        var released = Db.Read(factory, db => db.Agents.Single(a => a.Id == boundId));
        Assert.Equal(ConnectorOptions.PrivateSlotSubject, released.OwnerSubject);
        Assert.Null(released.BoundAt);
        Assert.NotNull(released.ResetRequestedAt);
        Assert.Equal(0, Db.Read(factory, db => db.Profiles.Count(p => p.AgentId == boundId)));
        Assert.Equal("released", (await (await mine.GetAsync("/v1/private-agents/mine")).JsonAsync()).GetProperty("request").Text("state"));
        Assert.DoesNotContain(boundId, await AgentIdsAsync(mine, "/v1/agents"));

        var resetting = (await (await operatorSide.GetAsync("/v1/admin/private-agents")).JsonAsync())
            .GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("agent").Text("id") == boundId);
        Assert.True(resetting.GetProperty("agent").GetProperty("resetting").GetBoolean());
        Assert.False(resetting.GetProperty("agent").GetProperty("bound").GetBoolean());

        // the beat asks for the wipe; the beat that confirms it frees the slot
        var askedToWipe = await HeartbeatAsync(token, resetDone: false);
        Assert.True(askedToWipe.GetProperty("reset_profiles").GetBoolean());
        var wiped = await HeartbeatAsync(token, resetDone: true);
        Assert.False(wiped.GetProperty("reset_profiles").GetBoolean());
        Assert.Null(Db.Read(factory, db => db.Agents.Single(a => a.Id == boundId)).ResetRequestedAt);
    }

    [Fact]
    public async Task An_approval_with_no_free_slot_is_refused_and_a_denial_or_a_withdrawal_ends_a_request()
    {
        var person = Flows.NewSubject("refused");
        using var mine = factory.CreateAuthorizedClient().ActAs(person);
        using var operatorSide = factory.CreateAuthorizedClient();
        var requestId = (await (await mine.SendAsync(Wire.Post("/v1/private-agents/requests", new { subject = person }))).JsonAsync()).Text("id");

        // every free slot is made busy for the duration: the suite shares its slots
        var frozen = Db.Read(factory, db => db.Agents
            .Where(a => a.Hosted && !a.Revoked && a.OwnerSubject == ConnectorOptions.PrivateSlotSubject && a.ResetRequestedAt == null)
            .Select(a => a.Id)
            .ToList());
        Db.Write(factory, db =>
        {
            foreach (var slot in db.Agents.Where(a => frozen.Contains(a.Id))) slot.ResetRequestedAt = DateTimeOffset.UtcNow;
        });
        try
        {
            using var refused = await operatorSide.SendAsync(Wire.Post($"/v1/admin/private-agents/requests/{requestId}/approve"));
            Assert.False(refused.IsSuccessStatusCode);
            Assert.Equal("agent_unavailable", (await refused.JsonAsync()).GetProperty("error").Text("code"));
            Assert.Equal(PrivateAgentRequestState.Pending, StateOfRequest(requestId));
        }
        finally
        {
            Db.Write(factory, db =>
            {
                foreach (var slot in db.Agents.Where(a => frozen.Contains(a.Id))) slot.ResetRequestedAt = null;
            });
        }

        using var denied = await operatorSide.SendAsync(Wire.Post($"/v1/admin/private-agents/requests/{requestId}/deny"));
        Assert.Equal("denied", (await denied.JsonAsync()).Text("state"));
        Assert.Equal("denied", (await (await mine.GetAsync("/v1/private-agents/mine")).JsonAsync()).GetProperty("request").Text("state"));

        // a decision is final
        using var twice = await operatorSide.SendAsync(Wire.Post($"/v1/admin/private-agents/requests/{requestId}/approve"));
        Assert.Equal(HttpStatusCode.BadRequest, twice.StatusCode);

        // a fresh request can be withdrawn by its owner, and by nobody else
        var second = (await (await mine.SendAsync(Wire.Post("/v1/private-agents/requests", new { subject = person }))).JsonAsync()).Text("id");
        Assert.NotEqual(requestId, second);
        using var stranger = factory.CreateAuthorizedClient().ActAs(Flows.NewSubject("stranger"));
        using var notTheirs = await stranger.DeleteAsync($"/v1/private-agents/requests/{second}");
        Assert.Equal(HttpStatusCode.BadRequest, notTheirs.StatusCode);
        using var withdrawn = await mine.DeleteAsync($"/v1/private-agents/requests/{second}");
        Assert.Equal(HttpStatusCode.NoContent, withdrawn.StatusCode);
        Assert.Equal(PrivateAgentRequestState.Withdrawn, StateOfRequest(second));

        // nobody's hosted agent to give back
        using var nothing = await mine.DeleteAsync("/v1/private-agents/mine");
        Assert.Equal(HttpStatusCode.BadRequest, nothing.StatusCode);
    }

    [Fact]
    public async Task The_operator_takes_a_slot_back_and_the_persons_sessions_on_it_expire()
    {
        var slot = await EnrollSlotAsync("slot three");
        var person = Flows.NewSubject("taken");
        using var mine = factory.CreateAuthorizedClient().ActAs(person);
        using var operatorSide = factory.CreateAuthorizedClient();

        // bound by hand to THIS slot, so the test is about the take-back and not about which slot an approval picks
        Db.Write(factory, db =>
        {
            var row = db.Agents.Single(a => a.Id == slot.Id);
            row.OwnerSubject = person;
            row.BoundAt = DateTimeOffset.UtcNow;
        });
        var profileId = "prf_" + Guid.NewGuid().ToString("N");
        var sessionId = Ids.New(Ids.Session);
        Db.Write(factory, db =>
        {
            db.Profiles.Add(new ProfileRow { Id = profileId, AgentId = slot.Id, ProviderId = Provider, Subject = person, Healthy = true });
            var now = DateTimeOffset.UtcNow;
            db.Sessions.Add(new SessionRow
            {
                Id = sessionId,
                ProviderId = Provider,
                Subject = person,
                State = SessionState.Active,
                ProfileId = profileId,
                ExpiresAt = now.AddHours(1),
                CreatedAt = now,
                UpdatedAt = now,
            });
        });

        using var taken = await operatorSide.SendAsync(Wire.Post($"/v1/admin/private-agents/{slot.Id}/release"));
        Assert.Equal(HttpStatusCode.NoContent, taken.StatusCode);

        Assert.Equal(ConnectorOptions.PrivateSlotSubject, Db.Read(factory, db => db.Agents.Single(a => a.Id == slot.Id)).OwnerSubject);
        Assert.Equal(SessionState.Expired, Db.Read(factory, db => db.Sessions.Single(s => s.Id == sessionId)).State);
        Assert.Equal(0, Db.Read(factory, db => db.Profiles.Count(p => p.AgentId == slot.Id)));
        Assert.DoesNotContain(slot.Id, await AgentIdsAsync(mine, "/v1/agents"));

        // a slot that is not a slot cannot be taken back this way
        using var notASlot = await operatorSide.SendAsync(Wire.Post("/v1/admin/private-agents/agt_00000000000000000000000000000000/release"));
        Assert.Equal(HttpStatusCode.BadRequest, notASlot.StatusCode);
    }

    private sealed record Enrolled(string Id, string Token);

    /// <summary>Seeds a private-slot code and enrolls through the wire with it, as a rendered slot container does.</summary>
    private async Task<Enrolled> EnrollSlotAsync(string name)
    {
        var code = $"AGNT-SLOT-{Guid.NewGuid():N}"[..24];
        using (var scope = factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<AgentAuth>()
                .SeedStandingEnrollmentAsync(code, ConnectorOptions.PrivateSlotSubject, "private slot", CancellationToken.None);
        }

        using var client = factory.CreateClient();
        using var response = await client.SendAsync(Wire.Post("/agent/v1/enroll", new
        {
            code,
            name,
            capabilities = Capabilities,
        }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.JsonAsync();
        var enrolled = new Enrolled(body.Text("agent_id"), body.Text("token"));
        Tokens[enrolled.Id] = enrolled.Token;
        return enrolled;
    }

    private static object Capabilities => new
    {
        providers = new[] { Provider },
        egress = new { country = "NL", kind = "residential" },
        @class = "byo",
    };

    private async Task<JsonElement> HeartbeatAsync(string token, bool resetDone)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var request = Wire.Post("/agent/v1/heartbeat", new
        {
            capabilities = Capabilities,
            profiles = Array.Empty<object>(),
            reset_done = resetDone,
        });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.JsonAsync();
    }

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
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = subject,
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
        using var request = Wire.Post("/agent/v1/jobs/lease", new { accept = LoginJobsOnly });
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

    /// <summary>Leases as the slot until the job named comes, or a handful of others did.</summary>
    private async Task<string?> LeaseUntilAsync(string token, string job)
    {
        for (var seen = 0; seen < 10; seen++)
        {
            using var leased = await LeaseAsync(token, TimeSpan.FromSeconds(20));
            if (leased is null) return null;
            var id = (await leased.JsonAsync()).Text("job_id");
            if (id == job) return id;
        }

        return null;
    }

    private JobState StateOf(string jobId) =>
        Db.Read(factory, db => db.Jobs.Where(j => j.Id == jobId).Select(j => j.State).Single());

    private PrivateAgentRequestState StateOfRequest(string id) =>
        Db.Read(factory, db => db.PrivateAgentRequests.Where(r => r.Id == id).Select(r => r.State).Single());

    /// <summary>The wire leaves a null member out; absent and null are the same answer.</summary>
    private static bool Absent(JsonElement element, string property) =>
        !element.TryGetProperty(property, out var value) || value.ValueKind == JsonValueKind.Null;

    private static async Task<IReadOnlyList<string>> AgentIdsAsync(HttpClient http, string url)
    {
        using var response = await http.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var listed = (await response.JsonAsync()).GetProperty("agents");
        return [.. listed.EnumerateArray().Select(a => a.Text("id"))];
    }
}
