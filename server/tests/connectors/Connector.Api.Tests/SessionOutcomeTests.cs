using System.Diagnostics;
using System.Net;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// a failure that is the session's own asks for sign-in, a block stops it, anything else is about the run
// a party's budget refusal once ended a valid consent, and the reconnect's second session burnt the budget nightly
[Collection(ShopApiCollection.Name)]
public sealed class SessionOutcomeTests(ShopApiFactory factory)
{
    private const string Provider = BudgetStoreAdapter.ProviderId;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = BudgetStoreAdapter.Username,
        ["password"] = BudgetStoreAdapter.Password,
    };

    [Theory]
    // the party's budget, the party down, no agent, a question nobody answered: the session stays usable
    [InlineData(ErrorCode.RateLimited, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.ProviderUnavailable, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.AgentUnavailable, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.MfaTimeout, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.ChallengeExpired, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.ProviderChanged, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.UnsupportedResource, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.InvalidRequest, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.ReconciliationFailed, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.Internal, SessionState.Active, JobKind.Fetch, SessionState.Active)]
    // a run on a working session the machine shows as running goes back to active
    [InlineData(ErrorCode.RateLimited, SessionState.Running, JobKind.Fetch, SessionState.Active)]
    [InlineData(ErrorCode.Internal, SessionState.Running, JobKind.Refresh, SessionState.Active)]
    // a login that never produced a usable session fails, whatever stopped it
    [InlineData(ErrorCode.RateLimited, SessionState.Running, JobKind.Login, SessionState.Failed)]
    [InlineData(ErrorCode.ProviderUnavailable, SessionState.Queued, JobKind.Login, SessionState.Failed)]
    [InlineData(ErrorCode.ChallengeExpired, SessionState.AwaitingInput, JobKind.Login, SessionState.Failed)]
    [InlineData(ErrorCode.InvalidCredentials, SessionState.Running, JobKind.Login, SessionState.Failed)]
    // the provider no longer honours what the session holds: a person signs in again
    [InlineData(ErrorCode.InvalidCredentials, SessionState.Active, JobKind.Fetch, SessionState.NeedsReauth)]
    [InlineData(ErrorCode.SessionExpired, SessionState.Active, JobKind.Fetch, SessionState.NeedsReauth)]
    [InlineData(ErrorCode.MfaFailed, SessionState.Active, JobKind.Fetch, SessionState.NeedsReauth)]
    [InlineData(ErrorCode.ConsentExpired, SessionState.Active, JobKind.Fetch, SessionState.NeedsReauth)]
    [InlineData(ErrorCode.AgentRevoked, SessionState.Active, JobKind.Fetch, SessionState.NeedsReauth)]
    // the provider is refusing us: stop, whatever the state
    [InlineData(ErrorCode.BlockedByProvider, SessionState.Active, JobKind.Fetch, SessionState.Blocked)]
    [InlineData(ErrorCode.BlockedByProvider, SessionState.Running, JobKind.Login, SessionState.Blocked)]
    public void A_failure_ends_a_session_only_when_it_is_the_sessions_own(ErrorCode code, SessionState current, JobKind kind, SessionState expected) =>
        Assert.Equal(expected, JobOutcomeService.SessionStateFor(code, current, kind));

    [Fact]
    public void Every_code_has_a_ruling_and_the_sign_in_class_is_exactly_the_reauth_and_reconnect_codes()
    {
        foreach (var code in Enum.GetValues<ErrorCode>())
        {
            var fetch = JobOutcomeService.SessionStateFor(code, SessionState.Active, JobKind.Fetch);
            var expected = code switch
            {
                ErrorCode.BlockedByProvider => SessionState.Blocked,
                _ when ErrorCatalog.ActionFor(code) is UserAction.Reauth or UserAction.Reconnect => SessionState.NeedsReauth,
                _ => SessionState.Active,
            };
            Assert.Equal(expected, fetch);
        }
    }

    [Fact]
    public async Task A_budget_refusal_on_a_fetch_leaves_the_session_usable_and_the_next_resume_succeeds()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("budget"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        await RefusedAsync(http, $"/v1/{Provider}/receipts?since=2026-01-01", ticket);
        var job = Db.LatestJob(factory, connection.SessionId);
        Assert.Equal(JobState.Failed, job.State);
        Assert.Equal(ErrorCode.RateLimited, job.ErrorCode);

        var view = await Flows.ReadSessionAsync(http, Provider, connection.SessionId);
        Assert.Equal("active", view.Text("state"));
        var again = await Flows.ResumeAsync(http, Provider, connection);
        var page = await Flows.FetchPageAsync(http, Provider, $"/v1/{Provider}/receipts?since=2026-01-01", again);
        Assert.Single(page.GetProperty("data").EnumerateArray());
    }

    /// whoever reads the bundle stops asking, and keeps the state that came with it: a bundle under `running` left a
    /// finished login looking busy
    [Fact]
    public async Task A_login_s_bundle_is_never_readable_before_its_session_is_active()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("settles");
        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{PooledStoreAdapter.ProviderId}/login", new
        {
            subject,
            inputs = new Dictionary<string, string> { [PooledStoreAdapter.UsernameField] = "shopper" },
        });
        using var response = await http.SendAsync(request);
        var sessionId = (await response.JsonAsync()).Text("session_id");
        var job = Db.LatestJob(factory, sessionId);
        var agentId = EnrollFleetAgent();

        using var scope = factory.Services.CreateScope();
        var leased = await scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>().TryLeaseAsync(
            agentId, null, new AgentCapabilities { Providers = [PooledStoreAdapter.ProviderId] }, [JobKind.Login],
            TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.Equal(job.Id, leased?.JobId);

        var seen = new List<(SessionState State, bool Bundle)>();
        scope.ServiceProvider.GetRequiredService<ConnectorDbContext>().SavedChanges += (_, _) => seen.Add(Db.Read(factory, db => db.Sessions
            .Where(s => s.Id == sessionId)
            .Select(s => new { s.State, Bundle = s.PendingBundle != null })
            .AsEnumerable()
            .Select(s => (s.State, s.Bundle))
            .Single()));

        await scope.ServiceProvider.GetRequiredService<JobOutcomeService>().SucceedAsync(
            job.Id, agentId, new JobResultRequest { SessionMaterial = new SessionMaterial { AccessToken = "token" } }, CancellationToken.None);

        Assert.Contains(seen, s => s.Bundle);
        Assert.All(seen.Where(s => s.Bundle), s => Assert.Equal(SessionState.Active, s.State));
    }

    /// ING's page moves on when the person approves in its app, so the adapter finishes while the person's own "I approved"
    /// is still on its way. That answer, read before the result and saved after it, left a finished sign-in "running" for ever
    [Fact]
    public async Task An_answer_that_lands_after_the_result_leaves_the_finished_sign_in_finished()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("late-answer");
        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{PooledStoreAdapter.ProviderId}/login", new
        {
            subject,
            inputs = new Dictionary<string, string> { [PooledStoreAdapter.UsernameField] = "shopper" },
        });
        using var response = await http.SendAsync(request);
        var sessionId = (await response.JsonAsync()).Text("session_id");
        var job = Db.LatestJob(factory, sessionId);
        var agentId = EnrollFleetAgent();

        using var agent = factory.Services.CreateScope();
        await agent.ServiceProvider.GetRequiredService<ILeasedJobQueue>().TryLeaseAsync(
            agentId, null, new AgentCapabilities { Providers = [PooledStoreAdapter.ProviderId] }, [JobKind.Login],
            TimeSpan.FromMinutes(2), CancellationToken.None);
        var challenge = await agent.ServiceProvider.GetRequiredService<ChallengeService>().RaiseAsync(job.Id, new PendingChallenge
        {
            Type = ChallengeType.AppApproval,
            ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(5),
            Payload = new ChallengePayload { PromptKey = "connect.challenge.app_approval" },
        }, CancellationToken.None);

        // the answer's request holds the job and the session as they stood when it came in
        using var answer = factory.Services.CreateScope();
        var held = answer.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var heldJob = await held.Jobs.SingleAsync(j => j.Id == job.Id);
        var heldSession = await held.Sessions.SingleAsync(s => s.Id == sessionId);
        Assert.Equal(JobState.AwaitingInput, heldJob.State);
        Assert.Equal(SessionState.AwaitingInput, heldSession.State);

        await agent.ServiceProvider.GetRequiredService<JobOutcomeService>().SucceedAsync(
            job.Id, agentId, new JobResultRequest { SessionMaterial = new SessionMaterial { AccessToken = "token" } }, CancellationToken.None);

        await answer.ServiceProvider.GetRequiredService<ChallengeService>().AnswerAsync(challenge.Id, job.Id, string.Empty, CancellationToken.None);

        Assert.Equal(JobState.Succeeded, Db.Read(factory, db => db.Jobs.Single(j => j.Id == job.Id).State));
        Assert.Equal(SessionState.Active, Db.Read(factory, db => db.Sessions.Single(s => s.Id == sessionId).State));

        // and the request answers from the rows as they are now
        Assert.Equal(JobState.Succeeded, heldJob.State);
        Assert.Equal(SessionState.Active, heldSession.State);
    }

    private string EnrollFleetAgent()
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");
        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "session outcome test agent",
            Class = AgentClass.Pooled,
            OwnerSubject = ConnectorOptions.DevFleetSubject,
            CapabilitiesJson = ConnectorJson.Serialize(new AgentCapabilities { Providers = [PooledStoreAdapter.ProviderId] }),
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));
        return id;
    }

    /// a fetch refused inside its window answers 429 at once; one the window outran fails as a polled job: the same refusal
    private static async Task RefusedAsync(HttpClient http, string url, string ticket)
    {
        using var response = await Flows.FetchAsync(http, url, ticket);
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            await ErrorEnvelope.AssertAsync(response, HttpStatusCode.TooManyRequests, "rate_limited");
            return;
        }

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var jobId = (await response.JsonAsync()).Text("job_id");
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < TimeSpan.FromSeconds(30))
        {
            using var poll = await http.GetAsync($"/v1/{Provider}/jobs/{jobId}");
            var state = (await poll.JsonAsync()).Text("state");
            if (state == "failed") return;
            Assert.NotEqual("succeeded", state);
            await Task.Delay(100);
        }
        Assert.Fail("the refused fetch never settled");
    }
}
