using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// past a cap work is refused with rate_limited (user_action: wait): an unbounded queue hides a backlog behind a spinner
[Collection(ShopApiCollection.Name)]
public sealed class QueueDepthTests(ShopApiFactory factory)
{
    // fills the queue directly: a hundred real logins would be a hundred browsers
    private static void Flood(ShopApiFactory factory, int count) =>
        Db.Write(factory, db =>
        {
            for (var i = 0; i < count; i++)
            {
                db.Jobs.Add(new JobRow
                {
                    Id = $"job_flood{i:D28}",
                    SessionId = $"ses_flood{i:D28}",
                    ProviderId = "mock-store-simple",
                    Kind = JobKind.Fetch,
                    State = JobState.Queued,
                    Step = JobStep.Queued,
                    ParamsJson = "{}",
                    StepsDoneJson = "[]",
                    ConfigJson = "{}",
                    CreatedAt = DateTimeOffset.UtcNow,
                    UpdatedAt = DateTimeOffset.UtcNow,
                });
            }
        });

    private static void Drain(ShopApiFactory factory) =>
        Db.Write(factory, db => db.Jobs.RemoveRange(db.Jobs.Where(j => j.Id.StartsWith("job_flood"))));

    private static async Task<T> WithQueueAsync<T>(ShopApiFactory factory, Func<ILeasedJobQueue, Task<T>> act)
    {
        using var scope = factory.Services.CreateScope();

        return await act(scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>());
    }

    private static NewJob Job(JobKind kind) => new()
    {
        SessionId = "ses_depth0123456789abcdef01234567",
        ProviderId = "mock-store-simple",
        Kind = kind,
    };

    [Fact]
    public async Task Work_past_the_cap_is_refused_rather_than_queued_behind_a_backlog()
    {
        Flood(factory, 60);

        try
        {
            var refused = await Assert.ThrowsAsync<ConnectorException>(
                () => WithQueueAsync(factory, q => q.EnqueueAsync(Job(JobKind.Fetch), CancellationToken.None)));

            Assert.Equal(ErrorCode.RateLimited, refused.Code);

            Assert.True(ErrorCatalog.IsRetriable(ErrorCode.RateLimited));
            Assert.Equal(UserAction.Wait, ErrorCatalog.ActionFor(ErrorCode.RateLimited));
        }
        finally
        {
            Drain(factory);
        }
    }

    // a logout is never refused, however long the queue: a refused sign-out leaves the bank session running
    [Fact]
    public async Task A_sign_out_is_accepted_even_when_everything_else_is_refused()
    {
        Flood(factory, 60);

        try
        {
            var queued = await WithQueueAsync(
                factory, q => q.EnqueueAsync(Job(JobKind.Logout), CancellationToken.None));

            Assert.Equal(JobState.Queued, queued.State);

            Db.Write(factory, db => db.Jobs.RemoveRange(db.Jobs.Where(j => j.Id == queued.Id)));
        }
        finally
        {
            Drain(factory);
        }
    }

    [Fact]
    public async Task An_ordinary_queue_still_takes_work()
    {
        var queued = await WithQueueAsync(
            factory, q => q.EnqueueAsync(Job(JobKind.Fetch), CancellationToken.None));

        Assert.Equal(JobState.Queued, queued.State);

        Db.Write(factory, db => db.Jobs.RemoveRange(db.Jobs.Where(j => j.Id == queued.Id)));
    }
}
