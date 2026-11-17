using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Munni.Api.Connectors;

namespace Munni.Api.Tests.Connectors;

public class ConnectorBenchTests(ConnectorApiFactory factory) : IClassFixture<ConnectorApiFactory>
{
    private const string Admin = "openid profile admin";
    private const string Simple = "mock-store-simple";
    private const string Sms = "mock-store-sms";

    private static readonly Dictionary<string, string> Credentials = new()
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    [Fact]
    public async Task The_bench_is_the_operators_and_nobody_elses()
    {
        using var user = factory.ClientFor("bench-plain-user");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/lab/bench/sessions")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials })).StatusCode);
    }

    [Fact]
    public async Task A_sign_in_from_the_bench_is_kept_as_a_lab_session_fetched_without_ingesting_and_never_bound_to_a_person()
    {
        using var operatorClient = factory.ClientFor("bench-operator", scope: Admin);
        var rowsBefore = factory.Read(db => db.EntityRows.Count());

        using var login = await operatorClient.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials, label = "the bench run", preferAgent = "fleet" });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.IsSuccessStatusCode, started!.ToJsonString());
        var sessionId = started["sessionId"]!.GetValue<string>();
        // the bundle rests on the relay, never in the operator's tab
        Assert.Null(started["bundle"]);
        Assert.DoesNotContain("sb_v1.", started.ToJsonString(), StringComparison.Ordinal);

        var settled = await AwaitStateAsync(operatorClient, Simple, sessionId, "active");
        Assert.Null(settled["bundle"]);

        var sessions = await operatorClient.GetFromJsonAsync<JsonArray>("/lab/bench/sessions");
        var mine = sessions!.Single(s => s!["sessionId"]!.GetValue<string>() == sessionId)!;
        Assert.Equal(Simple, mine["provider"]!.GetValue<string>());
        Assert.Equal("the bench run", mine["label"]!.GetValue<string>());
        Assert.Equal("active", mine["state"]!.GetValue<string>());
        Assert.True(mine["hasBundle"]!.GetValue<bool>());
        Assert.Equal("fleet", mine["preferAgent"]!.GetValue<string>());
        Assert.DoesNotContain("sb_v1.", sessions!.ToJsonString(), StringComparison.Ordinal);

        // and not among anybody's connections: the lab subject is not a person's, the relay binds nothing
        Assert.Empty(factory.Read(db => db.ConnectorSessions.Where(s => s.Id == sessionId).ToList()));
        var subject = factory.Read(db => db.LabSessions.Single(s => s.Id == sessionId));
        Assert.StartsWith("sb_v1.", subject.Bundle, StringComparison.Ordinal);

        using var fetch = await operatorClient.PostAsJsonAsync($"/lab/bench/sessions/{sessionId}/fetch", new { resource = "receipts", @params = new { since = "2026-01-01" } });
        var page = await fetch.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(fetch.StatusCode == HttpStatusCode.OK, page!.ToJsonString());
        Assert.False(page["accepted"]!.GetValue<bool>());
        Assert.Equal("receipts", page["resource"]!.GetValue<string>());
        Assert.NotEmpty(page["data"]!.AsArray());
        Assert.NotNull(page["data"]![0]!["externalId"]);
        Assert.DoesNotContain("sb_v1.", page.ToJsonString(), StringComparison.Ordinal);
        Assert.Equal(rowsBefore, factory.Read(db => db.EntityRows.Count()));

        var history = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/jobs?provider=mock-store-simple&trigger=lab&kind=fetch");
        Assert.Contains(history!["jobs"]!.AsArray(), j => j!["sessionId"]!.GetValue<string>() == sessionId);

        using var typo = await operatorClient.PostAsJsonAsync($"/lab/bench/sessions/{sessionId}/fetch", new { resource = "reciepts" });
        Assert.Equal(HttpStatusCode.BadRequest, typo.StatusCode);
        Assert.True(factory.Read(db => db.LabSessions.Single(s => s.Id == sessionId).Bundle != null));

        using var gone = await operatorClient.DeleteAsync($"/lab/bench/sessions/{sessionId}");
        Assert.True(gone.IsSuccessStatusCode, await gone.Content.ReadAsStringAsync());
        Assert.Empty(factory.Read(db => db.LabSessions.Where(s => s.Id == sessionId).ToList()));
        Assert.Equal(HttpStatusCode.NotFound, (await operatorClient.GetAsync($"/lab/bench/{Simple}/login/{sessionId}")).StatusCode);
    }

    [Fact]
    public async Task A_question_mid_sign_in_is_answered_through_the_bench_and_the_session_becomes_the_partys_canary()
    {
        using var operatorClient = factory.ClientFor("bench-canary-operator", scope: Admin);

        using var login = await operatorClient.PostAsJsonAsync($"/lab/bench/{Sms}/login", new { inputs = Credentials });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.IsSuccessStatusCode, started!.ToJsonString());
        var sessionId = started["sessionId"]!.GetValue<string>();

        var asked = started["state"]!.GetValue<string>() == "awaiting_input"
            ? started
            : await AwaitStateAsync(operatorClient, Sms, sessionId, "awaiting_input");
        var challenge = asked["challenge"]!.AsObject();
        Assert.Equal("mfa_code", challenge["type"]!.GetValue<string>());

        using var answered = await operatorClient.PostAsJsonAsync($"/lab/bench/{Sms}/login/{sessionId}/answer", new { challengeId = challenge["id"]!.GetValue<string>(), value = "123456" });
        Assert.True(answered.IsSuccessStatusCode, await answered.Content.ReadAsStringAsync());
        await AwaitStateAsync(operatorClient, Sms, sessionId, "active");
        await AwaitBundleAsync(sessionId);

        try
        {
            using var flipped = await operatorClient.PostAsJsonAsync($"/lab/bench/sessions/{sessionId}/canary", new { resource = "receipts", intervalMinutes = 60 });
            var canary = await flipped.Content.ReadFromJsonAsync<JsonObject>();
            Assert.True(flipped.StatusCode == HttpStatusCode.OK, canary!.ToJsonString());
            Assert.Equal(Sms, canary["providerId"]!.GetValue<string>());
            Assert.DoesNotContain("sb_v1.", canary.ToJsonString(), StringComparison.Ordinal);
            Assert.Empty(factory.Read(db => db.LabSessions.Where(s => s.Id == sessionId).ToList()));

            var canaries = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/canaries");
            Assert.Contains(canaries!["canaries"]!.AsArray(), c => c!["providerId"]!.GetValue<string>() == Sms && c["resource"]!.GetValue<string>() == "receipts");

            // an interval under the control plane's floor is its refusal, not a bare 500
            using var tooOften = await operatorClient.PostAsJsonAsync($"/lab/bench/sessions/{sessionId}/canary", new { resource = "receipts", intervalMinutes = 5 });
            Assert.Equal(HttpStatusCode.BadRequest, tooOften.StatusCode);
        }
        finally
        {
            using var removed = await factory.ControlPlane.Server.CreateClient().SendAsync(new HttpRequestMessage(HttpMethod.Delete, $"/v1/admin/providers/{Sms}/canary")
            {
                Headers = { { "X-Connector-Key", ControlPlaneHost.DevKey } },
            });
            Assert.True(removed.StatusCode is HttpStatusCode.NoContent or HttpStatusCode.NotFound, removed.StatusCode.ToString());
        }
    }

    [Fact]
    public async Task A_recorded_bench_run_leaves_a_trace_the_lab_reads_camel_cased_and_deletes()
    {
        using var operatorClient = factory.ClientFor("bench-recorder", scope: Admin);

        using var login = await operatorClient.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials, record = true });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.IsSuccessStatusCode, started!.ToJsonString());
        var sessionId = started["sessionId"]!.GetValue<string>();
        await AwaitStateAsync(operatorClient, Simple, sessionId, "active");

        var history = await operatorClient.GetFromJsonAsync<JsonObject>($"/lab/jobs?session={sessionId}");
        var job = Assert.Single(history!["jobs"]!.AsArray())!;
        var jobId = job["jobId"]!.GetValue<string>();
        Assert.True(job["trace"]!["entries"]!.GetValue<int>() >= 1, job.ToJsonString());

        using var trace = await operatorClient.GetAsync($"/lab/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.OK, trace.StatusCode);
        var text = await trace.Content.ReadAsStringAsync();
        var body = JsonNode.Parse(text)!.AsObject();
        Assert.Equal(jobId, body["jobId"]!.GetValue<string>());
        Assert.NotNull(body["entries"]![0]!["atMs"]);
        Assert.DoesNotContain(Credentials["password"], text, StringComparison.Ordinal);

        using var digest = await operatorClient.GetAsync($"/lab/jobs/{jobId}/trace/digest.md");
        Assert.Equal(HttpStatusCode.OK, digest.StatusCode);
        Assert.Equal("text/markdown", digest.Content.Headers.ContentType?.MediaType);
        Assert.StartsWith("# Recording of", await digest.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        using var user = factory.ClientFor("bench-plain-reader");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync($"/lab/jobs/{jobId}/trace")).StatusCode);

        using var removed = await operatorClient.DeleteAsync($"/lab/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.NoContent, removed.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await operatorClient.GetAsync($"/lab/jobs/{jobId}/trace")).StatusCode);
    }

    [Fact]
    public async Task The_labs_machine_account_reads_runs_and_recordings_and_nothing_else()
    {
        using var operatorClient = factory.ClientFor("bench-machine-operator", scope: Admin);
        using var login = await operatorClient.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials, record = true });
        var started = await login.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(login.IsSuccessStatusCode, started!.ToJsonString());
        var sessionId = started["sessionId"]!.GetValue<string>();
        await AwaitStateAsync(operatorClient, Simple, sessionId, "active");

        const string app = "lab-reader-app";
        using var machine = factory.MachineFor(app, scope: "lab:read");

        var history = await machine.GetFromJsonAsync<JsonObject>($"/lab/jobs?session={sessionId}");
        var jobId = Assert.Single(history!["jobs"]!.AsArray())!["jobId"]!.GetValue<string>();
        using var trace = await machine.GetAsync($"/lab/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.OK, trace.StatusCode);
        Assert.Equal(jobId, JsonNode.Parse(await trace.Content.ReadAsStringAsync())!["jobId"]!.GetValue<string>());
        using var digest = await machine.GetAsync($"/lab/jobs/{jobId}/trace/digest.md");
        Assert.StartsWith("# Recording of", await digest.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        foreach (var path in new[] { "/lab/status", "/lab/providers", $"/lab/providers/{Simple}", "/lab/canaries", "/lab/health" })
        {
            Assert.Equal(HttpStatusCode.OK, (await machine.GetAsync(path)).StatusCode);
        }

        // the runs, never whose they are: an operator sees the person behind one, the machine does not and cannot ask
        using var shopper = factory.ClientFor("machine-seen-shopper");
        using var theirs = await shopper.PostAsJsonAsync($"/connectors/{Simple}/login", new
        {
            connectionId = "conn-machine-seen",
            inputs = Credentials,
            consent = new { acceptedAt = DateTimeOffset.UtcNow, termsVersion = "v1" },
        });
        Assert.True(theirs.IsSuccessStatusCode, await theirs.Content.ReadAsStringAsync());
        var named = await operatorClient.GetFromJsonAsync<JsonObject>("/lab/jobs?user=machine-seen-shopper&kind=login");
        var personal = Assert.Single(named!["jobs"]!.AsArray())!;
        Assert.NotNull(personal["who"]);
        var personalId = personal["jobId"]!.GetValue<string>();
        Assert.Null((await machine.GetFromJsonAsync<JsonObject>($"/lab/jobs/{personalId}"))!["who"]);
        var listed = await machine.GetFromJsonAsync<JsonObject>($"/lab/jobs?provider={Simple}&kind=login");
        Assert.Contains(listed!["jobs"]!.AsArray(), j => j!["jobId"]!.GetValue<string>() == personalId);
        Assert.All(listed["jobs"]!.AsArray(), j => Assert.Null(j!["who"]));
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/lab/jobs?user=machine-seen-shopper")).StatusCode);

        // nothing that acts, nothing of a person's, and no account of its own
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.DeleteAsync($"/lab/jobs/{jobId}/trace")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.PostAsJsonAsync($"/lab/bench/{Simple}/login", new { inputs = Credentials })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.PostAsync($"/lab/canaries/{Simple}/run", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync($"/lab/jobs/{jobId}/scaffold?provider=x-y&name=Xy&product=shop")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/lab/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/lab/ping")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await machine.GetAsync("/me/devices")).StatusCode);
        Assert.Empty(factory.Read(db => db.Users.Where(u => u.Sub == app).ToList()));

        // the scope is the grant: a machine without it reads nothing, a person with it is still a person
        using var stranger = factory.MachineFor("another-app");
        Assert.Equal(HttpStatusCode.Forbidden, (await stranger.GetAsync($"/lab/jobs/{jobId}/trace")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await operatorClient.GetAsync($"/lab/jobs/{jobId}/trace")).StatusCode);
    }

    [Fact]
    public async Task An_explore_run_opens_under_the_lab_subject_and_nowhere_else()
    {
        using var operatorClient = factory.ClientFor("bench-explorer", scope: Admin);

        using var malformed = await operatorClient.PostAsJsonAsync("/lab/bench/explore", new { url = "ftp://www.example.com/" });
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);

        // no fleet agent in the test bench: the run queues and the door answers 202
        using var opened = await operatorClient.PostAsJsonAsync("/lab/bench/explore", new { url = "https://www.example.com/", label = "look around" });
        var view = await opened.Content.ReadFromJsonAsync<JsonObject>();
        Assert.Equal(HttpStatusCode.Accepted, opened.StatusCode);
        var sessionId = view!["sessionId"]!.GetValue<string>();
        Assert.Null(view["bundle"]);

        var row = factory.Read(db => db.LabSessions.Single(s => s.Id == sessionId));
        Assert.Equal("explore", row.Provider);
        Assert.Equal("look around", row.Label);

        var sessions = await operatorClient.GetFromJsonAsync<JsonArray>("/lab/bench/sessions");
        Assert.Contains(sessions!, s => s!["sessionId"]!.GetValue<string>() == sessionId && s["provider"]!.GetValue<string>() == "explore");

        var history = await operatorClient.GetFromJsonAsync<JsonObject>($"/lab/jobs?session={sessionId}");
        var job = Assert.Single(history!["jobs"]!.AsArray())!;
        Assert.Equal("lab", job["trigger"]!.GetValue<string>());
        Assert.Equal("explore", job["providerId"]!.GetValue<string>());

        // a person's door: the explore provider is nobody's party
        using var user = factory.ClientFor("bench-explore-user");
        using var refused = await user.PostAsJsonAsync("/connectors/explore/login", new { inputs = new Dictionary<string, string> { ["url"] = "https://www.example.com/" } });
        Assert.True(refused.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound, refused.StatusCode.ToString());

        using var gone = await operatorClient.DeleteAsync($"/lab/bench/sessions/{sessionId}");
        Assert.True(gone.IsSuccessStatusCode || gone.StatusCode == HttpStatusCode.BadRequest, await gone.Content.ReadAsStringAsync());
    }

    private static async Task<JsonObject> AwaitStateAsync(HttpClient client, string provider, string sessionId, string state)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        JsonObject? view = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            view = await client.GetFromJsonAsync<JsonObject>($"/lab/bench/{provider}/login/{sessionId}");
            if (view!["state"]!.GetValue<string>() == state) return view;
            await Task.Delay(100);
        }
        throw new TimeoutException($"lab session never reached {state}: {view?.ToJsonString()}");
    }

    private async Task AwaitBundleAsync(string sessionId)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (factory.Read(db => db.LabSessions.Single(s => s.Id == sessionId).Bundle) is not null) return;
            await Task.Delay(100);
        }
        throw new TimeoutException("the lab session never received its bundle");
    }
}
