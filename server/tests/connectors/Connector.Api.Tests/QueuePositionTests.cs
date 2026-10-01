using System.Net;
using Connector.Kit;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// A session that waits says how long the line is (user request
/// 2026-10-01: a login sat on "opening the party's site" with no sign of
/// whether anything was happening). The view of a queued job carries
/// <c>progress.ahead</c>: how many queued jobs are older than it, any
/// party's, because the fleet drains the queue oldest first whatever the
/// party. Once the job runs the number is gone - it would be a lie.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class QueuePositionTests(ShopApiFactory factory)
{
    private const string Provider = "ah";

    [Fact]
    public async Task A_queued_logins_view_counts_the_jobs_ahead_of_it_and_a_running_one_counts_nothing()
    {
        var subject = Flows.NewSubject("queue-position");
        var now = DateTimeOffset.UtcNow;
        var sessionId = Ids.New(Ids.Session);
        var jobId = Ids.New(Ids.Job);

        Db.Write(factory, db =>
        {
            db.Sessions.Add(new SessionRow
            {
                Id = sessionId,
                ProviderId = Provider,
                Subject = subject,
                State = SessionState.Queued,
                ExpiresAt = now.AddHours(1),
                CreatedAt = now,
                UpdatedAt = now,
            });
            // two older jobs waiting (another party's among them), one younger
            db.Jobs.Add(Queued("mock-store-simple", now.AddMinutes(-3)));
            db.Jobs.Add(Queued(Provider, now.AddMinutes(-2)));
            db.Jobs.Add(Queued(Provider, now.AddMinutes(1)));
            db.Jobs.Add(Queued(Provider, now, sessionId, jobId));
        });

        // the suite shares its queue: other tests leave older jobs waiting on purpose
        var olderInTheSuite = Db.Read(factory, db => db.Jobs.Count(j => j.State == JobState.Queued && j.CreatedAt < now));

        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using var queued = await http.GetAsync($"/v1/{Provider}/login/{sessionId}");
        Assert.Equal(HttpStatusCode.OK, queued.StatusCode);
        var progress = (await queued.JsonAsync()).GetProperty("progress");
        Assert.Equal("queued", progress.Text("step"));
        Assert.Equal(olderInTheSuite, progress.GetProperty("ahead").GetInt32());
        Assert.True(olderInTheSuite >= 2);

        Db.Write(factory, db =>
        {
            var job = db.Jobs.Single(j => j.Id == jobId);
            job.State = JobState.Running;
            job.Step = JobStep.OpeningProvider;
        });

        using var running = await http.GetAsync($"/v1/{Provider}/login/{sessionId}");
        var later = (await running.JsonAsync()).GetProperty("progress");
        Assert.Equal("opening_provider", later.Text("step"));
        Assert.False(later.TryGetProperty("ahead", out _), "a running job has nobody ahead of it");
    }

    private static JobRow Queued(string provider, DateTimeOffset createdAt, string? sessionId = null, string? id = null) => new()
    {
        Id = id ?? Ids.New(Ids.Job),
        SessionId = sessionId ?? Ids.New(Ids.Session),
        ProviderId = provider,
        Kind = JobKind.Login,
        State = JobState.Queued,
        Step = JobStep.Queued,
        ParamsJson = "{}",
        StepsDoneJson = "[]",
        ConfigJson = "{}",
        CreatedAt = createdAt,
        UpdatedAt = createdAt,
    };
}
