using System.Net;
using Connector.Api.Tests.Infrastructure;
using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Api.Tests;

/// <summary>
/// A fetch says how much it has gathered while it runs (user request
/// 2026-10-02: a counter that climbs rather than a spinner). The agent
/// reports a count with its progress; the job's view carries it as
/// <c>progress.found</c>, and a report without a count leaves the last one
/// standing rather than resetting it.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class FetchCountTests(ShopApiFactory factory)
{
    private const string Provider = "ah";

    [Fact]
    public async Task The_count_an_agent_reports_rides_the_jobs_view_and_outlives_a_report_without_one()
    {
        var subject = Flows.NewSubject("fetch-count");
        var (sessionId, jobId) = Seed(subject, JobState.Leased, "agent-counting");

        using (var scope = factory.Services.CreateScope())
        {
            var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();
            await queue.ProgressAsync(jobId, "agent-counting",
                new ProgressReport { Step = JobStep.Downloading, Found = 120 }, CancellationToken.None);
            await queue.ProgressAsync(jobId, "agent-counting",
                new ProgressReport { Step = JobStep.Parsing }, CancellationToken.None);
        }

        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using var view = await http.GetAsync($"/v1/{Provider}/jobs/{jobId}");
        Assert.Equal(HttpStatusCode.OK, view.StatusCode);

        var progress = (await view.JsonAsync()).GetProperty("progress");
        Assert.Equal("parsing", progress.Text("step"));
        Assert.Equal(120, progress.GetProperty("found").GetInt32());

        // the row itself kept the count through the report that carried none
        var row = Db.Read(factory, db => db.Jobs.Single(j => j.Id == jobId));
        Assert.Equal(sessionId, row.SessionId);
        Assert.Equal(120, row.Found);
    }

    [Fact]
    public async Task A_job_that_never_counted_shows_no_count()
    {
        var subject = Flows.NewSubject("fetch-count-none");
        var (_, jobId) = Seed(subject, JobState.Queued, owner: null);

        using var http = factory.CreateAuthorizedClient().ActAs(subject);
        using var view = await http.GetAsync($"/v1/{Provider}/jobs/{jobId}");
        Assert.Equal(HttpStatusCode.OK, view.StatusCode);

        var progress = (await view.JsonAsync()).GetProperty("progress");
        Assert.False(progress.TryGetProperty("found", out _), "a job that counted nothing carries no number");
    }

    private (string SessionId, string JobId) Seed(string subject, JobState state, string? owner)
    {
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
                State = SessionState.Active,
                ExpiresAt = now.AddHours(1),
                CreatedAt = now,
                UpdatedAt = now,
            });
            db.Jobs.Add(new JobRow
            {
                Id = jobId,
                SessionId = sessionId,
                ProviderId = Provider,
                Kind = JobKind.Fetch,
                ResourceId = "receipts",
                State = state,
                LeaseOwner = owner,
                LeaseExpiresAt = owner is null ? null : now.AddMinutes(5),
                Step = owner is null ? JobStep.Queued : JobStep.AgentAssigned,
                CreatedAt = now,
                UpdatedAt = now,
            });
        });

        return (sessionId, jobId);
    }
}
