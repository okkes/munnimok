using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// The operator's view of what happened (#441 L1): the job history and the
/// per-provider health behind the lab's screens.
///
/// The history is the one place a consumer's runs are visible to somebody
/// who is not that consumer, so the first test is about what a row does NOT
/// carry. The rest is arithmetic a person will read numbers off.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class OperatorJobTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2-never-on-the-wire",
    };

    [Fact]
    public async Task The_history_says_what_happened_and_never_what_was_typed()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("history");
        var connection = await Flows.ConnectAsync(http, Provider, subject, Credentials);

        var (body, jobs) = await ListAsync(http, $"subject={subject}");

        var login = Assert.Single(jobs);
        Assert.Equal(connection.SessionId, login.Text("session_id"));
        Assert.Equal(subject, login.Text("subject"));
        Assert.Equal(Provider, login.Text("provider_id"));
        Assert.Equal("login", login.Text("kind"));
        Assert.Equal("succeeded", login.Text("state"));
        Assert.Equal("user", login.Text("trigger"));
        Assert.Equal("none", login.Text("artifacts"));
        Assert.True(login.GetProperty("credential_submitted").GetBoolean());
        Assert.NotEqual(JsonValueKind.Undefined, login.GetProperty("progress").ValueKind);

        // The password went upstream once and is on no view afterwards -
        // not as a field, not as a value, not under any name.
        Assert.DoesNotContain(Credentials["password"], body, StringComparison.Ordinal);
        Assert.DoesNotContain("inputs", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("material", body, StringComparison.OrdinalIgnoreCase);

        // Alone, the same row.
        using var one = await http.GetAsync($"/v1/admin/jobs/{login.Text("job_id")}");
        Assert.Equal(HttpStatusCode.OK, one.StatusCode);
        Assert.Equal(login.Text("job_id"), (await one.JsonAsync()).Text("job_id"));

        using var missing = await http.GetAsync("/v1/admin/jobs/job_nobody");
        await ErrorEnvelope.AssertAsync(missing, HttpStatusCode.BadRequest, "unsupported_resource");
    }

    [Fact]
    public async Task The_history_narrows_by_provider_state_kind_and_code_and_says_when_it_was_cut()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("filters");
        var connection = await Flows.ConnectAsync(http, Provider, subject, Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);
        using (var fetch = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since=2026-01-01", ticket))
        {
            Assert.Equal(HttpStatusCode.OK, fetch.StatusCode);
        }

        var (_, both) = await ListAsync(http, $"subject={subject}");
        Assert.Equal(2, both.Count);

        // #441 L4: narrowed by the agent that ran it - the inline runner here
        var (_, inline) = await ListAsync(http, $"subject={subject}&agent=agt_inline");
        Assert.Equal(2, inline.Count);
        var (_, nobody) = await ListAsync(http, $"subject={subject}&agent=agt_nobody");
        Assert.Empty(nobody);
        Assert.Equal("fetch", both[0].Text("kind")); // newest first
        Assert.Equal("receipts", both[0].Text("resource"));

        var (_, fetches) = await ListAsync(http, $"subject={subject}&kind=fetch&state=succeeded&provider={Provider}");
        Assert.Single(fetches);

        var (_, none) = await ListAsync(http, $"subject={subject}&code=provider_changed");
        Assert.Empty(none);

        var (cut, first) = await ListAsync(http, $"subject={subject}&limit=1");
        Assert.Single(first);
        Assert.Contains("\"truncated\":true", cut, StringComparison.Ordinal);

        using var typo = await http.GetAsync("/v1/admin/jobs?state=finished");
        await ErrorEnvelope.AssertAsync(typo, HttpStatusCode.BadRequest, "invalid_request");

        using var badLimit = await http.GetAsync("/v1/admin/jobs?limit=0");
        await ErrorEnvelope.AssertAsync(badLimit, HttpStatusCode.BadRequest, "invalid_request");
    }

    /// <summary>
    /// A fetch the party refuses with <c>provider_changed</c> shows up in
    /// the provider's health as a failure, under its code, under the trigger
    /// that asked, and as one person affected.
    /// </summary>
    [Fact]
    public async Task Health_counts_the_months_runs_by_outcome_code_and_trigger_and_the_people_behind_them()
    {
        const string broken = "mock-store-broken";
        using var http = factory.CreateAuthorizedClient();
        try
        {
            var connection = await Flows.ConnectAsync(http, broken, Flows.NewSubject("health"),
                new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });
            var ticket = await Flows.ResumeAsync(http, broken, connection);
            using (var fetch = await Flows.FetchAsync(http, $"/v1/{broken}/receipts?since=2026-01-01", ticket))
            {
                Assert.NotEqual(HttpStatusCode.OK, fetch.StatusCode);
            }

            var report = await HealthAsync(http, broken);
            var day = report.GetProperty("windows").GetProperty("24h");

            Assert.True(day.GetProperty("failed").GetInt32() >= 1);
            Assert.True(day.GetProperty("succeeded").GetInt32() >= 1); // the login
            Assert.True(day.GetProperty("by_code").GetProperty("provider_changed").GetInt32() >= 1);
            Assert.True(day.GetProperty("by_trigger").GetProperty("user").GetInt32() >= 2);
            Assert.True(day.GetProperty("people_affected").GetInt32() >= 1);

            var last = report.GetProperty("last_failure");
            Assert.Equal("provider_changed", last.Text("code"));
            Assert.Equal("user", last.Text("trigger"));
            Assert.NotNull(report.TextOrNull("last_success_at"));

            Assert.Equal("degraded", report.GetProperty("status").Text("state"));
            // the session the fetch ran under is counted under whatever state the failure left it in
            Assert.True(report.GetProperty("sessions").EnumerateObject().Sum(s => s.Value.GetInt32()) >= 1, report.ToString());
            Assert.Equal(0, report.GetProperty("reports").GetInt32() + report.GetProperty("pending_reports").GetInt32());
        }
        finally
        {
            using var reset = await http.SendAsync(Wire.Post($"/v1/admin/providers/{broken}/status", new { state = "healthy" }));
            Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        }
    }

    /// <summary>
    /// The operator runs a canary now: a real job, stamped as the canary's,
    /// read back as the canary's verdict without waiting for the interval.
    /// </summary>
    [Fact]
    public async Task A_canary_runs_on_demand_and_its_job_is_stamped_as_the_canarys()
    {
        using var http = factory.CreateAuthorizedClient();
        var operatorConnection = await Flows.ConnectAsync(
            http, Provider, $"canary:{Guid.NewGuid():N}", Credentials);

        try
        {
            using (var enrolled = await http.SendAsync(Wire.Put(
                $"/v1/admin/providers/{Provider}/canary",
                new { subject = operatorConnection.Subject, bundle = operatorConnection.Bundle, resource = "receipts", intervalMinutes = 60 })))
            {
                Assert.Equal(HttpStatusCode.OK, enrolled.StatusCode);
            }

            using var run = await http.SendAsync(Wire.Post($"/v1/admin/canaries/{Provider}/run"));
            var started = await run.JsonAsync();
            Assert.True(run.StatusCode == HttpStatusCode.OK, started.ToString());
            var jobId = started.Text("last_job_id");
            Assert.False(string.IsNullOrWhiteSpace(jobId));

            using var job = await http.GetAsync($"/v1/admin/jobs/{jobId}");
            Assert.Equal("canary", (await job.JsonAsync()).Text("trigger"));

            using var unknown = await http.SendAsync(Wire.Post("/v1/admin/canaries/no-such-provider/run"));
            await ErrorEnvelope.AssertAsync(unknown, HttpStatusCode.BadRequest, "unsupported_resource");
        }
        finally
        {
            using var removed = await http.DeleteAsync($"/v1/admin/providers/{Provider}/canary");
            Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        }
    }

    private static async Task<(string Body, List<JsonElement> Jobs)> ListAsync(HttpClient http, string query)
    {
        using var response = await http.GetAsync($"/v1/admin/jobs?{query}");
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, body);
        using var parsed = JsonDocument.Parse(body);
        return (body, [.. parsed.RootElement.GetProperty("jobs").EnumerateArray().Select(j => j.Clone())]);
    }

    private static async Task<JsonElement> HealthAsync(HttpClient http, string providerId)
    {
        using var response = await http.GetAsync("/v1/admin/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.JsonAsync();
        return Assert.Single(body.GetProperty("providers").EnumerateArray(), p => p.Text("provider_id") == providerId);
    }
}
