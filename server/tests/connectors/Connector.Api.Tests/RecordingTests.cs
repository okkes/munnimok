using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Connector.Kit;
using Connector.Kit.Challenges;
using Connector.Kit.Exploring;
using Connector.Kit.Hosting.Auth;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Connector.Kit.Tracing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// Recordings on the control plane (#441 L3): the record flag is the lab's
/// alone, an inline run writes its own trace, the operator reads the trace
/// and its digest and deletes them, an agent's trace lands only for the
/// operator's run, the explore provider is nobody else's, and navigation is
/// refused on every live view but an explore run's.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class RecordingTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2-recorded-never-on-the-wire",
    };

    [Fact]
    public async Task A_lab_run_asked_to_record_leaves_a_trace_the_operator_reads_and_deletes()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("recorded");
        http.ActAs(subject);
        http.DefaultRequestHeaders.Add(RequestContext.TriggerHeader, "lab");

        using var started = await http.SendAsync(Wire.Post($"/v1/{Provider}/login", new { subject, inputs = Credentials, record = true }));
        var view = await started.JsonAsync();
        Assert.True(started.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, view.ToString());
        var sessionId = view.Text("session_id");
        // the bundle is handed over once: on the login's own answer when the run settled inside the window
        if (view.TextOrNull("bundle") is null) await Flows.AwaitBundleAsync(http, Provider, sessionId);

        using var listed = await http.GetAsync($"/v1/admin/jobs?session={sessionId}");
        var job = Assert.Single((await listed.JsonAsync()).GetProperty("jobs").EnumerateArray());
        var jobId = job.Text("job_id");
        Assert.Equal("lab", job.Text("trigger"));
        Assert.True(job.TryGetProperty("trace", out var summary), $"no recording on the job view: {job}");
        Assert.True(summary.GetProperty("entries").GetInt32() >= 1);
        Assert.False(summary.GetProperty("truncated").GetBoolean());

        using var trace = await http.GetAsync($"/v1/admin/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.OK, trace.StatusCode);
        Assert.Equal("application/json", trace.ContentType()?.MediaType);
        var body = await trace.Content.ReadAsStringAsync();
        var parsed = JsonSerializer.Deserialize<JobTrace>(body, ConnectorWireJson.Options)!;
        Assert.Equal(jobId, parsed.JobId);
        Assert.Contains(parsed.Entries, e => e.Kind == TraceKind.Note && e.Text == "the run ended");
        Assert.DoesNotContain(Credentials["password"], body, StringComparison.Ordinal);

        using var digest = await http.GetAsync($"/v1/admin/jobs/{jobId}/trace/digest");
        Assert.Equal(HttpStatusCode.OK, digest.StatusCode);
        Assert.Equal("text/markdown", digest.ContentType()?.MediaType);
        Assert.StartsWith($"# Recording of {Provider} · job {jobId}", await digest.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        using var deleted = await http.DeleteAsync($"/v1/admin/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        using var again = await http.DeleteAsync($"/v1/admin/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        using var gone = await http.GetAsync($"/v1/admin/jobs/{jobId}/trace");
        Assert.Equal(HttpStatusCode.BadRequest, gone.StatusCode);

        using var after = await http.GetAsync($"/v1/admin/jobs/{jobId}");
        Assert.False((await after.JsonAsync()).TryGetProperty("trace", out _), "the job view still names a recording");
    }

    [Fact]
    public async Task Recording_is_refused_on_any_door_but_the_labs()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("not-the-lab");
        http.ActAs(subject);

        using var refused = await http.SendAsync(Wire.Post($"/v1/{Provider}/login", new { subject, inputs = Credentials, record = true }));

        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("invalid_request", (await refused.JsonAsync()).GetProperty("error").Text("code"));
    }

    [Fact]
    public async Task The_explore_provider_is_out_of_the_catalogue_and_opens_for_the_lab_only()
    {
        using var http = factory.CreateAuthorizedClient();

        using var catalogue = await http.GetAsync("/v1/providers");
        var ids = (await catalogue.JsonAsync()).GetProperty("providers").EnumerateArray().Select(p => p.Text("id")).ToList();
        Assert.DoesNotContain(ExploreProvider.Id, ids);
        Assert.Contains(Provider, ids);

        using var one = await http.GetAsync($"/v1/providers/{ExploreProvider.Id}");
        Assert.Equal(HttpStatusCode.OK, one.StatusCode);
        Assert.True((await one.JsonAsync()).GetProperty("operator_only").GetBoolean());

        var subject = Flows.NewSubject("explorer");
        http.ActAs(subject);
        using var refused = await http.SendAsync(Wire.Post($"/v1/{ExploreProvider.Id}/login", new
        {
            subject,
            inputs = new Dictionary<string, string> { ["url"] = "https://www.example.com/" },
        }));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Equal("unsupported_resource", (await refused.JsonAsync()).GetProperty("error").Text("code"));

        using var malformed = Wire.Post($"/v1/{ExploreProvider.Id}/login", new
        {
            subject,
            inputs = new Dictionary<string, string> { ["url"] = "not an address" },
        });
        malformed.AddHeader(RequestContext.TriggerHeader, "lab");
        using var badAddress = await http.SendAsync(malformed);
        Assert.Equal(HttpStatusCode.BadRequest, badAddress.StatusCode);
    }

    [Fact]
    public async Task Navigation_is_refused_on_every_live_view_but_an_explore_runs()
    {
        var run = await ArrangeLiveAsync("ah", trigger: null);
        using var http = factory.CreateAuthorizedClient().ActAs(run.Subject);
        var url = $"/v1/ah/login/{run.SessionId}/challenges/{run.ChallengeId}/live/input";

        using var navigate = await http.SendAsync(Wire.Post(url, new { events = new object[] { new { kind = "navigate", url = "https://www.example.com/", sequence = 1 } } }));
        Assert.Equal(HttpStatusCode.BadRequest, navigate.StatusCode);
        Assert.Equal("invalid_request", (await navigate.JsonAsync()).GetProperty("error").Text("code"));

        using var back = await http.SendAsync(Wire.Post(url, new { events = new object[] { new { kind = "back", sequence = 2 } } }));
        Assert.Equal(HttpStatusCode.BadRequest, back.StatusCode);

        using var key = await http.SendAsync(Wire.Post(url, new { events = new object[] { new { kind = "key", key = "Enter", sequence = 3 } } }));
        Assert.Equal(HttpStatusCode.Accepted, key.StatusCode);
    }

    [Fact]
    public async Task An_agents_trace_lands_for_the_operators_run_and_is_dropped_unread_for_anybody_elses()
    {
        var mine = await ArrangeLiveAsync("ah", trigger: JobRow.LabTrigger);
        using var agent = factory.CreateClient();
        agent.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", mine.AgentToken);
        using var operatorClient = factory.CreateAuthorizedClient();

        var trace = new JobTrace
        {
            JobId = mine.JobId,
            Provider = "ah",
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            EndedAt = DateTimeOffset.UtcNow,
            Entries = [new TraceEntry { Seq = 1, AtMs = 0, Kind = TraceKind.Navigation, Url = "https://login.ah.nl/" }],
        };

        using (var posted = await agent.SendAsync(TracePost(mine.JobId, trace, gzip: true)))
        {
            Assert.Equal(HttpStatusCode.OK, posted.StatusCode);
            Assert.Equal(1, (await posted.JsonAsync()).GetProperty("entries").GetInt32());
        }

        using (var read = await operatorClient.GetAsync($"/v1/admin/jobs/{mine.JobId}/trace"))
        {
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
            Assert.Contains("https://login.ah.nl/", await read.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        // A person's run: the post is answered, nothing is kept.
        var theirs = await ArrangeLiveAsync("ah", trigger: null);
        using var theirAgent = factory.CreateClient();
        theirAgent.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", theirs.AgentToken);

        using (var posted = await theirAgent.SendAsync(TracePost(theirs.JobId, trace with { JobId = theirs.JobId }, gzip: false)))
        {
            Assert.Equal(HttpStatusCode.OK, posted.StatusCode);
            Assert.Equal(0, (await posted.JsonAsync()).GetProperty("entries").GetInt32());
        }

        using var nothing = await operatorClient.GetAsync($"/v1/admin/jobs/{theirs.JobId}/trace");
        Assert.Equal(HttpStatusCode.BadRequest, nothing.StatusCode);

        // Another agent's token cannot post for a job it does not hold.
        using var stranger = await theirAgent.SendAsync(TracePost(mine.JobId, trace, gzip: false));
        Assert.Equal(HttpStatusCode.BadRequest, stranger.StatusCode);
    }

    private static HttpRequestMessage TracePost(string jobId, JobTrace trace, bool gzip)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(trace, ConnectorWireJson.Options);
        byte[] bytes = plain;
        if (gzip)
        {
            using var packed = new MemoryStream();
            using (var zip = new GZipStream(packed, CompressionLevel.Fastest, leaveOpen: true)) zip.Write(plain);
            bytes = packed.ToArray();
        }

        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        if (gzip) content.Headers.ContentEncoding.Add("gzip");
        return new HttpRequestMessage(HttpMethod.Post, $"/agent/v1/jobs/{jobId}/trace") { Content = content };
    }

    private async Task<LiveRun> ArrangeLiveAsync(string provider, string? trigger)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
        var challenges = scope.ServiceProvider.GetRequiredService<ChallengeService>();

        var now = DateTimeOffset.UtcNow;
        var subject = $"u_rec_{Guid.NewGuid():N}";
        var token = AgentAuth.NewToken();

        db.Agents.Add(new AgentRow
        {
            Id = Ids.New(Ids.Agent),
            Name = "recording-test",
            OwnerSubject = subject,
            TokenHash = AgentAuth.Hash(token),
            LastHeartbeatAt = now,
            CreatedAt = now,
        });

        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = provider,
            Subject = subject,
            State = SessionState.Queued,
            ExpiresAt = now.AddHours(1),
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Sessions.Add(session);
        await db.SaveChangesAsync(CancellationToken.None);

        var agentId = await db.Agents.Where(a => a.OwnerSubject == subject).Select(a => a.Id).FirstAsync();

        var job = await queue.EnqueueAsync(new NewJob
        {
            SessionId = session.Id,
            ProviderId = provider,
            Kind = JobKind.Login,
            Trigger = trigger,
            Record = trigger == JobRow.LabTrigger,
        }, CancellationToken.None);

        var row = await db.Jobs.FirstAsync(j => j.Id == job.Id);
        row.State = JobState.Leased;
        row.LeaseOwner = agentId;
        row.LeaseExpiresAt = now.AddMinutes(10);
        await db.SaveChangesAsync(CancellationToken.None);

        var challenge = await challenges.RaiseAsync(job.Id, new PendingChallenge
        {
            Type = ChallengeType.LiveView,
            ExpiresAt = now.AddMinutes(5),
            Payload = new ChallengePayload { PromptKey = "connect.challenge.live_login" },
        }, CancellationToken.None);

        return new LiveRun(subject, session.Id, job.Id, challenge.Id, token);
    }

    private sealed record LiveRun(string Subject, string SessionId, string JobId, string ChallengeId, string AgentToken);
}
