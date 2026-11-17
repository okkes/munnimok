using Connector.Kit;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Sessions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// a job never leased has no lease to expire, so no clearing path reached its plaintext login inputs;
/// ExpireAbandonedAsync is the backstop (Jumbo: browser-tier, daily fresh password, maybe no agent)
[Collection(ShopApiCollection.Name)]
public sealed class AbandonedJobCredentialTests(ShopApiFactory factory)
{
    /// <summary>Browser-tier and pooled, so nothing in this suite will lease it.</summary>
    private const string UnservedProvider = "jumbo";

    private const string Password = "the-password-that-used-to-stay";

    [Fact]
    public async Task A_job_nobody_leased_does_not_keep_its_password_for_ever()
    {
        var jobId = await QueueLoginAsync();

        Assert.Contains(Password, await ColumnAsync(jobId, j => j.InputsJson), StringComparison.Ordinal);

        await BackdateAsync(jobId, TimeSpan.FromHours(2));
        Assert.Equal(1, await SweepAsync());

        var job = await JobAsync(jobId);

        Assert.Null(job.InputsJson);
        Assert.Null(job.MaterialJson);

        // Failed, not just scrubbed: a queued login stripped of its inputs would fail later for an untraceable reason
        Assert.Equal(JobState.Failed, job.State);
        Assert.Equal(ErrorCode.AgentUnavailable, job.ErrorCode);
    }

    [Fact]
    public async Task A_job_still_inside_its_window_is_left_alone()
    {
        var jobId = await QueueLoginAsync();

        // a pooled agent briefly offline is ordinary: the sweep must not discard credentials of a legitimate queue wait
        await BackdateAsync(jobId, TimeSpan.FromMinutes(5));
        await SweepAsync();

        var job = await JobAsync(jobId);

        Assert.Equal(JobState.Queued, job.State);
        Assert.Contains(Password, job.InputsJson!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_job_an_agent_is_holding_is_never_swept_however_long_it_takes()
    {
        var jobId = await QueueLoginAsync();

        // a live lease belongs to the existing expiry paths (a human mid-login can hold a job ~15 min); the backstop stays out
        await LeaseInPlaceAsync(jobId);
        await BackdateAsync(jobId, TimeSpan.FromHours(2));

        Assert.Equal(0, await SweepAsync());

        var job = await JobAsync(jobId);

        Assert.Equal(JobState.Leased, job.State);
        Assert.Contains(Password, job.InputsJson!, StringComparison.Ordinal);
    }

    private async Task<string> QueueLoginAsync()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = UnservedProvider,
            Subject = $"u_aban_{Guid.NewGuid():N}",
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
            ProviderId = UnservedProvider,
            Kind = JobKind.Login,
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = "somebody@example.test",
                ["password"] = Password,
            },
        }, CancellationToken.None);

        return job.Id;
    }

    /// moves the row's clock, not the host's: the suite shares one host on the system TimeProvider
    private async Task BackdateAsync(string jobId, TimeSpan age)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();

        await db.Jobs.Where(j => j.Id == jobId)
            .ExecuteUpdateAsync(s => s.SetProperty(j => j.UpdatedAt, DateTimeOffset.UtcNow - age));
    }

    private async Task LeaseInPlaceAsync(string jobId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();

        await db.Jobs.Where(j => j.Id == jobId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.State, JobState.Leased)
                .SetProperty(j => j.LeaseOwner, "agent-holding-it")
                .SetProperty(j => j.LeaseExpiresAt, DateTimeOffset.UtcNow.AddMinutes(2)));
    }

    private async Task<int> SweepAsync()
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        return await queue.ExpireAbandonedAsync(CancellationToken.None);
    }

    private async Task<JobRow> JobAsync(string jobId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();

        return await db.Jobs.AsNoTracking().SingleAsync(j => j.Id == jobId);
    }

    private async Task<string> ColumnAsync(string jobId, Func<JobRow, string?> read) =>
        read(await JobAsync(jobId))!;
}
