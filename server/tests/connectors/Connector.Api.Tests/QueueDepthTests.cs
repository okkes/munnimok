using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// What happens when more work arrives than the fleet can drain.
///
/// <para>
/// The fleet is scaled by running more agents, each taking exactly one job at a
/// time - see <c>AgentExclusivityTests</c>. That makes throughput small and
/// knowable, and it makes the queue the thing that absorbs a burst. A queue
/// nobody bounds absorbs it invisibly: the job is accepted, the user watches a
/// spinner that is really a waiting list, and nothing tells them so.
/// </para>
///
/// <para>
/// So past a cap the work is refused with <c>rate_limited</c>, which carries
/// <c>user_action: wait</c> - a consumer can say "busy, try shortly" instead of
/// rendering progress that is not progressing.
/// </para>
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class QueueDepthTests(ShopApiFactory factory)
{
    /// <summary>
    /// Fills the queue directly rather than through the API, because what is
    /// under test is the queue's own rule and a hundred real logins would be a
    /// hundred browsers.
    /// </summary>
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

            // The code is the contract: retriable, and the user is told to
            // wait rather than to do anything.
            Assert.True(ErrorCatalog.IsRetriable(ErrorCode.RateLimited));
            Assert.Equal(UserAction.Wait, ErrorCatalog.ActionFor(ErrorCode.RateLimited));
        }
        finally
        {
            Drain(factory);
        }
    }

    /// <summary>
    /// A LOGOUT IS NEVER REFUSED, however long the queue is.
    /// </summary>
    /// <remarks>
    /// Disconnecting must always succeed - the platform says so on every other
    /// path - and somebody told "too busy to sign you out of your bank" is
    /// somebody whose only remaining option is to leave the session running.
    /// That is the exact opposite of what a shed is for.
    /// </remarks>
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

    /// <summary>
    /// And an ordinary queue accepts work, so the cap is a backstop rather than
    /// a throttle somebody meets on a quiet system.
    /// </summary>
    [Fact]
    public async Task An_ordinary_queue_still_takes_work()
    {
        var queued = await WithQueueAsync(
            factory, q => q.EnqueueAsync(Job(JobKind.Fetch), CancellationToken.None));

        Assert.Equal(JobState.Queued, queued.State);

        Db.Write(factory, db => db.Jobs.RemoveRange(db.Jobs.Where(j => j.Id == queued.Id)));
    }
}
