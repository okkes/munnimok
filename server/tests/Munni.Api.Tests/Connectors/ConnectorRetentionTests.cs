using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// The retention bench's report store (#441 L4): a run is the operator's own,
/// its steps are written in the order taken and replaced by name, it ends
/// once, and the history lists it newest first.
/// </summary>
public class ConnectorRetentionTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";

    [Fact]
    public async Task A_run_is_written_step_by_step_ended_once_and_listed_to_its_operator_alone()
    {
        using var user = factory.ClientFor("retention-plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/lab/bench/retention/runs")).StatusCode);

        using var operatorClient = factory.ClientFor("retention-operator", scope: Admin);

        using var malformed = await operatorClient.PostAsJsonAsync("/lab/bench/retention/runs", new { provider = "Mock Store", resource = "receipts" });
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);

        using var created = await operatorClient.PostAsJsonAsync("/lab/bench/retention/runs", new { provider = "mock-store-persistent", resource = "receipts", agentId = "agt_kitchen", agentName = "the kitchen laptop", label = "first pass" });
        var run = await created.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var runId = run!["id"]!.GetValue<string>();
        Assert.StartsWith("lrr_", runId, StringComparison.Ordinal);
        Assert.Equal("running", run["state"]!.GetValue<string>());
        Assert.Equal("agt_kitchen", run["agentId"]!.GetValue<string>());
        Assert.Empty(run["steps"]!.AsArray());

        // steps in order; the same name again replaces what it said
        using var first = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/steps", new { name = "sign-in", state = "running" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using var again = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/steps", new { name = "sign-in", state = "pass", detail = "active in 2.1 s", sessionId = "ses_r1", jobId = "job_r1" });
        var afterSignIn = await again.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        var steps = afterSignIn!["steps"]!.AsArray();
        Assert.Single(steps);
        Assert.Equal("pass", steps[0]!["state"]!.GetValue<string>());
        Assert.Equal("ses_r1", afterSignIn["sessionId"]!.GetValue<string>());

        using var fetch = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/steps", new { name = "fetch", state = "fail", detail = "session_expired" });
        Assert.Equal(HttpStatusCode.OK, fetch.StatusCode);
        using var odd = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/steps", new { name = "fetch", state = "maybe" });
        Assert.Equal(HttpStatusCode.BadRequest, odd.StatusCode);

        using var finished = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/finish", new { state = "failed" });
        var ended = await finished.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(HttpStatusCode.OK, finished.StatusCode);
        Assert.Equal("failed", ended!["state"]!.GetValue<string>());
        Assert.Equal(2, ended["steps"]!.AsArray().Count);

        // a step after the end is refused; the report stands as it was
        using var late = await operatorClient.PostAsJsonAsync($"/lab/bench/retention/runs/{runId}/steps", new { name = "kept-login", state = "pass" });
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);

        var listed = await operatorClient.GetFromJsonAsync<JsonArray>("/lab/bench/retention/runs");
        Assert.Contains(listed!, r => r!["id"]!.GetValue<string>() == runId && r["state"]!.GetValue<string>() == "failed");

        var one = await operatorClient.GetFromJsonAsync<JsonObject>($"/lab/bench/retention/runs/{runId}");
        Assert.Equal("first pass", one!["label"]!.GetValue<string>());

        // another operator's door shows nothing of it
        using var other = factory.ClientFor("retention-other-operator", scope: Admin);
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/lab/bench/retention/runs/{runId}")).StatusCode);
        Assert.DoesNotContain((await other.GetFromJsonAsync<JsonArray>("/lab/bench/retention/runs"))!, r => r!["id"]!.GetValue<string>() == runId);

        using var removed = await operatorClient.DeleteAsync($"/lab/bench/retention/runs/{runId}");
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await operatorClient.GetAsync($"/lab/bench/retention/runs/{runId}")).StatusCode);
        Assert.Empty(factory.Read(db => db.LabRetentionRuns.Where(r => r.Id == runId).ToList()));
    }
}
