using Connector.Kit;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Sessions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// How fast an agent is told it may call a provider.
///
/// The number reaches the agent on the lease, and until now it came from one
/// place: the operator's own politeness setting, the same for every provider in
/// the fleet. That is the right floor and the wrong ceiling. A provider that
/// answers six calls per fetch is fine at 800ms; amazon.nl walks an order list
/// and then an invoice per order - fifty of them on a first connect - and a day
/// of that at 800ms is what preceded Amazon answering 503 and continuing to.
///
/// So a manifest may now ask for more of its own, and the larger of the two
/// wins. The direction matters: an operator tuning the fleet cannot quietly
/// undo a gap an adapter author widened for a reason, and an adapter author
/// cannot undercut an operator who has decided to be slower than the manifests.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class RequestGapTests(ShopApiFactory factory)
{
    /// <summary>The one provider that declares a gap of its own.</summary>
    private const string PacedProvider = "amazon-nl";

    /// <summary>
    /// A browser provider that declares none. Chosen over an HTTP one on
    /// purpose: this must not read as "the gap only applies to page walks".
    /// </summary>
    private const string UnpacedProvider = "ah";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    [Fact]
    public async Task A_provider_that_asks_to_be_called_slowly_is()
    {
        var leased = await LeaseFetchAsync(PacedProvider);

        // The manifest's own 3s, not the operator's 800ms.
        Assert.Equal(3_000, leased.Limits.PolitenessMs);
    }

    [Fact]
    public async Task A_provider_that_asks_for_nothing_gets_the_operators_floor()
    {
        var leased = await LeaseFetchAsync(UnpacedProvider);

        Assert.Equal(Floor(), leased.Limits.PolitenessMs);
    }

    /// <summary>
    /// And the two are actually different.
    ///
    /// Without this the pair above would both pass on a manifest that declared
    /// exactly the floor - a field that is read, plumbed, tested, and changes
    /// nothing whatsoever.
    /// </summary>
    [Fact]
    public async Task The_declared_gap_is_longer_than_the_floor_it_replaced()
    {
        var paced = await LeaseFetchAsync(PacedProvider);

        Assert.True(
            paced.Limits.PolitenessMs > Floor(),
            $"amazon declares {paced.Limits.PolitenessMs}ms against a floor of {Floor()}ms; " +
            "a gap at or below the floor would change nothing");
    }

    // ---- setup -------------------------------------------------------------

    private int Floor()
    {
        using var scope = factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<IOptions<ConnectorOptions>>().Value.Timeouts.PolitenessMs;
    }

    /// <summary>
    /// Queues a fetch for this provider and leases until it is the one handed
    /// over.
    ///
    /// A fetch rather than a login because amazon.nl's login needs a headed
    /// agent, and the gap has nothing to do with that. Leasing in a loop
    /// because the suite shares one host: other classes leave queued jobs for
    /// these providers behind, and candidates come back oldest first.
    /// </summary>
    private async Task<LeasedJob> LeaseFetchAsync(string provider)
    {
        var queued = await QueueFetchAsync(provider);

        for (var attempt = 0; attempt < 25; attempt++)
        {
            using var scope = factory.Services.CreateScope();
            var queue = scope.ServiceProvider.GetRequiredService<ILeasedJobQueue>();

            var leased = await queue.TryLeaseAsync(
                Ids.New(Ids.Agent),
                ownerSubject: null,
                // Residential NL, because amazon.nl and AH both ask for it and
                // CanServe compares the claim: an agent that states no address
                // is handed neither, and this suite would measure the pacing of
                // a job nobody ever leased.
                new AgentCapabilities
                {
                    Providers = [provider],
                    Headed = true,
                    Egress = new EgressRequirement { Country = "NL", Kind = EgressRequirement.Residential },
                },
                [JobKind.Fetch],
                Ttl,
                CancellationToken.None);

            if (leased is null) break;
            if (leased.JobId == queued) return leased;
        }

        throw new InvalidOperationException($"the queued {provider} fetch was never leased back");
    }

    private async Task<string> QueueFetchAsync(string provider)
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
            Subject = $"u_gap_{Guid.NewGuid():N}",
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
            Kind = JobKind.Fetch,
            Request = new ResourceRequest { ResourceId = "receipts" },
        }, CancellationToken.None);

        return job.Id;
    }
}
