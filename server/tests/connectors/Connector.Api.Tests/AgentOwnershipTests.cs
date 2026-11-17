using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// an agent may only serve the user who enrolled it; TryLeaseAsync once never asked whose job it handed over
/// agent-tier provider on purpose: InlineJobRunner serves only Inline && !Required manifests, so the job stays queued
[Collection(ShopApiCollection.Name)]
public sealed class AgentOwnershipTests(ShopApiFactory factory)
{
    private const string AgentTierProvider = "ah";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    /// a residential Dutch line, because the provider asks for one:
    /// without it nobody leases anything and ownership never decides
    private static AgentCapabilities Capabilities => new()
    {
        Providers = [AgentTierProvider],
        Egress = new EgressRequirement { Country = "NL", Kind = EgressRequirement.Residential },
    };

    [Fact]
    public async Task An_agent_is_never_handed_a_job_belonging_to_another_subject()
    {
        var owner = NewSubject();
        var stranger = NewSubject();

        // the stranger queues FIRST on purpose: candidates are OrderBy(CreatedAt), so without the ownership rule their job wins
        var strangersJob = await QueueLoginAsync(stranger, "strangers-password");
        var ownersJob = await QueueLoginAsync(owner, "owners-password");

        var leased = await LeaseAsync(ownerScope: owner);

        Assert.NotNull(leased);
        Assert.Equal(ownersJob, leased.JobId);

        Assert.NotEqual(strangersJob, leased.JobId);
        Assert.DoesNotContain("strangers-password", leased.Inputs.Values);
        Assert.Contains("owners-password", leased.Inputs.Values);
    }

    [Fact]
    public async Task An_agent_scoped_to_a_subject_with_no_work_is_told_there_is_nothing_rather_than_given_someone_elses()
    {
        var stranger = NewSubject();
        var idle = NewSubject();

        await QueueLoginAsync(stranger, "strangers-password");

        var leased = await LeaseAsync(ownerScope: idle);

        Assert.Null(leased);
    }

    [Fact]
    public async Task The_operators_own_fleet_is_the_one_caller_that_may_cross_subjects()
    {
        var somebody = NewSubject();
        var queued = await QueueLoginAsync(somebody, "a-password");

        // a null scope is the in-process runner and a configured fleet agent; the fleet takes the oldest job, and earlier tests
        // leave strangers' jobs queued, so it leases until it reaches ours
        var seen = new List<string>();
        LeasedJob? leased;
        do
        {
            leased = await LeaseAsync(ownerScope: null);
            Assert.NotNull(leased);
            seen.Add(leased.JobId);
        } while (leased.JobId != queued && seen.Count < 25);

        Assert.Equal(queued, leased.JobId);
    }

    private static string NewSubject() => $"u_own_{Guid.NewGuid():N}";

    /// straight into the tables: POST /login would drag consent, idempotency and manifest validation into this test
    private async Task<string> QueueLoginAsync(string subject, string password)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = AgentTierProvider,
            Subject = subject,
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
            ProviderId = AgentTierProvider,
            Kind = JobKind.Login,
            Inputs = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["username"] = subject,
                ["password"] = password,
            },
        }, CancellationToken.None);

        return job.Id;
    }

    private async Task<LeasedJob?> LeaseAsync(string? ownerScope)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        return await queue.TryLeaseAsync(
            Ids.New(Ids.Agent),
            ownerScope,
            Capabilities,
            [JobKind.Login],
            Ttl,
            CancellationToken.None);
    }
}
