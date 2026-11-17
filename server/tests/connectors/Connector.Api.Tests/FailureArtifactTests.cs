using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Challenges;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// #441 L1: a person's failed run is held unread until they share it, the operator's own runs are readable at once,
// and an unanswered question deletes itself
[Collection(ShopApiCollection.Name)]
public sealed class FailureArtifactTests(ShopApiFactory factory)
{
    private const string Provider = PooledStoreAdapter.ProviderId;

    private static readonly byte[] Png = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    [Fact]
    public async Task A_persons_failed_run_is_held_pending_and_served_to_nobody_until_they_share_it()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("artifacts");
        var (sessionId, jobId) = await FailWithArtifactsAsync(http, subject, trigger: null);

        var view = await Flows.ReadSessionAsync(http, Provider, sessionId);
        Assert.Equal(jobId, view.TextOrNull("artifacts_job_id"));

        var operatorView = await AdminJobAsync(http, jobId);
        Assert.Equal("pending", operatorView.Text("artifacts"));
        Assert.False(operatorView.GetProperty("has_screenshot").GetBoolean());
        Assert.Null(operatorView.TextOrNull("dom_digest"));

        using (var picture = await http.GetAsync($"/v1/admin/jobs/{jobId}/artifacts/screenshot"))
        {
            await ErrorEnvelope.AssertAsync(picture, HttpStatusCode.BadRequest, "unsupported_resource");
        }

        // Somebody else cannot share it on their behalf: an id learned
        // elsewhere tells its holder nothing.
        http.ActAs(Flows.NewSubject("somebody-else"));
        using (var refused = await http.SendAsync(Wire.Post($"/v1/{Provider}/jobs/{jobId}/artifacts/share")))
        {
            await ErrorEnvelope.AssertAsync(refused, HttpStatusCode.BadRequest, "unsupported_resource");
        }

        http.ActAs(subject);
        using var shared = await http.SendAsync(Wire.Post($"/v1/{Provider}/jobs/{jobId}/artifacts/share"));
        Assert.Equal(HttpStatusCode.OK, shared.StatusCode);
        var answer = await shared.JsonAsync();
        Assert.Equal(jobId, answer.Text("job_id"));
        Assert.True(answer.GetProperty("expires_at").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddDays(29));

        operatorView = await AdminJobAsync(http, jobId);
        Assert.Equal("retained", operatorView.Text("artifacts"));
        Assert.True(operatorView.GetProperty("has_screenshot").GetBoolean());
        Assert.Equal("sha256:login-page-v3", operatorView.Text("dom_digest"));

        using (var picture = await http.GetAsync($"/v1/admin/jobs/{jobId}/artifacts/screenshot"))
        {
            Assert.Equal(HttpStatusCode.OK, picture.StatusCode);
            Assert.Equal("image/png", picture.Content.Headers.ContentType?.MediaType);
            Assert.Equal(Png, await picture.Content.ReadAsByteArrayAsync());
        }

        view = await Flows.ReadSessionAsync(http, Provider, sessionId);
        Assert.Null(view.TextOrNull("artifacts_job_id"));

        using var declined = await http.DeleteAsync($"/v1/{Provider}/jobs/{jobId}/artifacts");
        Assert.Equal(HttpStatusCode.NoContent, declined.StatusCode);
        Assert.Equal("none", (await AdminJobAsync(http, jobId)).Text("artifacts"));
    }

    [Fact]
    public async Task Saying_no_deletes_the_picture_on_the_spot()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("declines");
        var (sessionId, jobId) = await FailWithArtifactsAsync(http, subject, trigger: null);

        http.ActAs(subject);
        using var declined = await http.DeleteAsync($"/v1/{Provider}/jobs/{jobId}/artifacts");
        Assert.Equal(HttpStatusCode.NoContent, declined.StatusCode);

        Assert.False(Db.Read(factory, db => db.JobArtifacts.Any(a => a.JobId == jobId)));
        Assert.Null((await Flows.ReadSessionAsync(http, Provider, sessionId)).TextOrNull("artifacts_job_id"));

        using var late = await http.SendAsync(Wire.Post($"/v1/{Provider}/jobs/{jobId}/artifacts/share"));
        await ErrorEnvelope.AssertAsync(late, HttpStatusCode.BadRequest, "unsupported_resource");
    }

    [Fact]
    public async Task The_operators_own_run_is_retained_without_asking()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("lab-run");
        var (sessionId, jobId) = await FailWithArtifactsAsync(http, subject, trigger: "lab");

        var operatorView = await AdminJobAsync(http, jobId);
        Assert.Equal("lab", operatorView.Text("trigger"));
        Assert.Equal("retained", operatorView.Text("artifacts"));
        Assert.True(operatorView.GetProperty("has_screenshot").GetBoolean());

        Assert.Null((await Flows.ReadSessionAsync(http, Provider, sessionId)).TextOrNull("artifacts_job_id"));
    }

    [Fact]
    public async Task The_sweep_deletes_a_lapsed_question_and_an_expired_report_and_keeps_the_rest()
    {
        var now = DateTimeOffset.UtcNow;
        var lapsed = $"job_lapsed_{Guid.NewGuid():N}";
        var expired = $"job_expired_{Guid.NewGuid():N}";
        var open = $"job_open_{Guid.NewGuid():N}";

        Db.Write(factory, db => db.JobArtifacts.AddRange(
            Row(lapsed, ArtifactStatus.Pending, now.AddHours(-1)),
            Row(expired, ArtifactStatus.Retained, now.AddMinutes(-1)),
            Row(open, ArtifactStatus.Pending, now.AddHours(47))));

        await factory.Services.GetServices<IHostedService>().OfType<ExpiryService>().Single()
            .SweepAsync(CancellationToken.None);

        var left = Db.Read(factory, db => db.JobArtifacts
            .Where(a => a.JobId == lapsed || a.JobId == expired || a.JobId == open)
            .Select(a => a.JobId)
            .ToList());

        Assert.Equal([open], left);
    }

    [Fact]
    public async Task A_disconnect_takes_the_open_question_with_it_and_keeps_what_was_shared()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, "mock-store-simple", Flows.NewSubject("leaving"),
            new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });

        var pending = $"job_pending_{Guid.NewGuid():N}";
        var shared = $"job_shared_{Guid.NewGuid():N}";
        var now = DateTimeOffset.UtcNow;

        Db.Write(factory, db => db.JobArtifacts.AddRange(
            Row(pending, ArtifactStatus.Pending, now.AddHours(40), connection.SessionId),
            Row(shared, ArtifactStatus.Retained, now.AddDays(20), connection.SessionId)));

        http.ActAs(connection.Subject);
        using var disconnected = await http.DeleteAsync($"/v1/mock-store-simple/sessions/{connection.SessionId}");
        Assert.True(disconnected.IsSuccessStatusCode, await disconnected.Content.ReadAsStringAsync());

        var left = Db.Read(factory, db => db.JobArtifacts
            .Where(a => a.SessionId == connection.SessionId)
            .Select(a => a.JobId)
            .ToList());

        Assert.Equal([shared], left);
    }

    [Fact]
    public async Task A_picture_past_the_cap_is_dropped_and_the_digest_kept()
    {
        var cap = factory.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<ConnectorOptions>>().Value.MaxArtifactBytes;
        using var http = factory.CreateAuthorizedClient();
        var (_, jobId) = await FailWithArtifactsAsync(
            http, Flows.NewSubject("huge"), trigger: "lab", screenshot: new byte[cap + 1]);

        var operatorView = await AdminJobAsync(http, jobId);
        Assert.Equal("retained", operatorView.Text("artifacts"));
        Assert.False(operatorView.GetProperty("has_screenshot").GetBoolean());
        Assert.Equal("sha256:login-page-v3", operatorView.Text("dom_digest"));
    }

    private async Task<(string SessionId, string JobId)> FailWithArtifactsAsync(
        HttpClient http, string subject, string? trigger, byte[]? screenshot = null)
    {
        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{Provider}/login", new
        {
            subject,
            inputs = new Dictionary<string, string> { [PooledStoreAdapter.UsernameField] = "shopper" },
        });
        if (trigger is not null) request.AddHeader(RequestContext.TriggerHeader, trigger);

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();
        Assert.True(response.StatusCode == HttpStatusCode.Accepted, body.ToString());
        var sessionId = body.Text("session_id");

        var job = Db.LatestJob(factory, sessionId);
        var agentId = EnrollFleetAgent();

        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
        var leased = await queue.TryLeaseAsync(
            agentId, null, new AgentCapabilities { Providers = [Provider] }, [JobKind.Login], Ttl, CancellationToken.None);
        Assert.NotNull(leased);
        Assert.Equal(job.Id, leased.JobId);

        await scope.ServiceProvider.GetRequiredService<JobOutcomeService>().FailAsync(job.Id, agentId, new JobFailRequest
        {
            Code = "invalid_credentials",
            Detail = "the password form came back with an error banner",
            Artifacts = new FailureArtifacts
            {
                ScreenshotBase64 = Convert.ToBase64String(screenshot ?? Png),
                DomDigest = "sha256:login-page-v3",
            },
        }, CancellationToken.None);

        return (sessionId, job.Id);
    }

    private string EnrollFleetAgent()
    {
        var id = "agt_" + Guid.NewGuid().ToString("N");

        Db.Write(factory, db => db.Agents.Add(new AgentRow
        {
            Id = id,
            Name = "failure artifact test agent",
            Class = AgentClass.Pooled,
            OwnerSubject = ConnectorOptions.DevFleetSubject,
            CapabilitiesJson = ConnectorJson.Serialize(new AgentCapabilities { Providers = [Provider] }),
            TokenHash = Connector.Kit.Hosting.Auth.AgentAuth.Hash("tok_" + Guid.NewGuid().ToString("N")),
            LastHeartbeatAt = DateTimeOffset.UtcNow,
            CreatedAt = DateTimeOffset.UtcNow,
        }));

        return id;
    }

    private static JobArtifactRow Row(string jobId, ArtifactStatus status, DateTimeOffset expiresAt, string sessionId = "ses_none") => new()
    {
        JobId = jobId,
        SessionId = sessionId,
        ProviderId = Provider,
        Status = status,
        Screenshot = Png,
        DomDigest = "sha256:x",
        CapturedAt = DateTimeOffset.UtcNow.AddHours(-2),
        ExpiresAt = expiresAt,
        SharedAt = status == ArtifactStatus.Retained ? DateTimeOffset.UtcNow.AddHours(-2) : null,
    };

    private static async Task<JsonElement> AdminJobAsync(HttpClient http, string jobId)
    {
        using var response = await http.GetAsync($"/v1/admin/jobs/{jobId}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.JsonAsync();
    }
}
