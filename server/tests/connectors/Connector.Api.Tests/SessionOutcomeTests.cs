using System.Diagnostics;
using System.Net;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// What a failed job does to its session (prod 2026-10-08): a failure that
/// is the session's — the provider no longer honours it — asks the person
/// to sign in again; a block stops it; everything else is a fact about the
/// run, not about the session, and a working session stays usable. Before
/// this, a party's budget refusal ended a valid consent for good, the
/// reconnect made a second session beside it, and the two burnt the budget
/// between them night after night.
/// </summary>
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

        // the party's budget refuses the fetch: the caller hears rate_limited...
        await RefusedAsync(http, $"/v1/{Provider}/receipts?since=2026-01-01", ticket);
        var job = Db.LatestJob(factory, connection.SessionId);
        Assert.Equal(JobState.Failed, job.State);
        Assert.Equal(ErrorCode.RateLimited, job.ErrorCode);

        // ...and the session is still the person's: active, and the same bundle opens it again
        var view = await Flows.ReadSessionAsync(http, Provider, connection.SessionId);
        Assert.Equal("active", view.Text("state"));
        var again = await Flows.ResumeAsync(http, Provider, connection);
        var page = await Flows.FetchPageAsync(http, Provider, $"/v1/{Provider}/receipts?since=2026-01-01", again);
        Assert.Single(page.GetProperty("data").EnumerateArray());
    }

    /// <summary>A fetch refused inside its window answers 429 at once; one the window outran fails as a job the caller polls. Both are the same refusal.</summary>
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
