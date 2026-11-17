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

// the gate is on the LOGIN alone: a headless agent must still get the provider's fetches, which need nobody
// declared via login_needs_headed_agent: before, a headless agent leased it, met the widget and failed blocked_by_provider
[Collection(ShopApiCollection.Name)]
public sealed class HeadedLoginRoutingTests(ShopApiFactory factory)
{
    // browser-tier, pooled, login_needs_headed_agent: bol's reCAPTCHA mints its token in the browser that rendered it
    private const string HeadedOnlyProvider = "bol";

    // browser-tier, pooled, login streamed to the account's owner wherever they are: any agent may take it
    private const string RelayableProvider = "ah";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    [Fact]
    public async Task A_headless_agent_is_not_offered_a_login_that_needs_somebody_at_the_browser()
    {
        var queued = await QueueAsync(HeadedOnlyProvider, JobKind.Login);

        var leased = await LeaseAsync(headed: false, JobKind.Login);

        Assert.Null(leased);
        Assert.Equal(JobState.Queued, await StateOfAsync(queued));
    }

    [Fact]
    public async Task The_same_headless_agent_is_still_offered_that_providers_fetches()
    {
        var queued = await QueueAsync(HeadedOnlyProvider, JobKind.Fetch);

        var leased = await LeaseAsync(headed: false, JobKind.Fetch);

        // two flags rather than one: withholding the fetch would idle a capable agent for a constraint of the sign-in
        Assert.NotNull(leased);
        Assert.Equal(queued, leased.JobId);
    }

    [Fact]
    public async Task A_headed_agent_is_offered_the_login_the_headless_one_was_refused()
    {
        // coolblue, not jumbo: avoids racing the job the refusal test leaves queued
        const string provider = "coolblue";

        var queued = await QueueAsync(provider, JobKind.Login);

        Assert.Null(await LeaseAsync(headed: false, JobKind.Login, provider));
        Assert.Equal(JobState.Queued, await StateOfAsync(queued));

        Assert.True(
            await LeasedByAsync(headed: true, provider, queued),
            "a headed agent should be offered a login that needs one");
    }

    [Fact]
    public async Task A_login_that_can_be_relayed_still_goes_to_any_agent()
    {
        var queued = await QueueAsync(RelayableProvider, JobKind.Login);

        // AH streams its page to the account's owner: gating on the runtime instead of the declared fact would be wrong
        Assert.True(
            await LeasedByAsync(headed: false, RelayableProvider, queued),
            "a relayable login should not need a headed agent");
    }

    private async Task<string> QueueAsync(string provider, JobKind kind)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var now = DateTimeOffset.UtcNow;
        var session = new SessionRow
        {
            Id = Ids.New(Ids.Session),
            ProviderId = provider,
            // A subject of its own per job: per-session concurrency is 1, so
            // two jobs sharing one session would hide each other.
            Subject = $"u_headed_{Guid.NewGuid():N}",
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
            ProviderId = provider,
            Kind = kind,
            Request = kind == JobKind.Fetch ? new ResourceRequest { ResourceId = "receipts" } : null,
        }, CancellationToken.None);

        return job.Id;
    }

    private async Task<LeasedJob?> LeaseAsync(bool headed, JobKind kind, string? provider = null)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

        var capabilities = new AgentCapabilities
        {
            Providers = [provider ?? HeadedOnlyProvider],
            Headed = headed,

            // the address these providers ask for: CanServe compares it, and an agent claiming nothing gets none of them,
            // so every assertion would be about a lease that never happened
            Egress = new EgressRequirement { Country = "NL", Kind = EgressRequirement.Residential },
        };

        return await queue.TryLeaseAsync(
            Ids.New(Ids.Agent),
            // The operator's own fleet, so ownership never masks the answer.
            ownerSubject: null,
            capabilities,
            [kind],
            Ttl,
            CancellationToken.None);
    }

    // the suite shares one host: other classes leave queued logins for these providers, oldest first, so lease until this job
    private async Task<bool> LeasedByAsync(bool headed, string provider, string jobId)
    {
        for (var attempt = 0; attempt < 25; attempt++)
        {
            var leased = await LeaseAsync(headed, JobKind.Login, provider);
            if (leased is null) return false;
            if (leased.JobId == jobId) return true;
        }

        return false;
    }

    private async Task<JobState> StateOfAsync(string jobId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ConnectorDbContext>();
        return (await db.Jobs.FindAsync(jobId))!.State;
    }
}
