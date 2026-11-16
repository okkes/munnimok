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

// the lease's gap is the larger of the operator's floor and the manifest's own: neither can undercut the other
// amazon.nl walks an invoice per order (~50 on a first connect); a day of that at 800ms preceded Amazon answering 503
[Collection(ShopApiCollection.Name)]
public sealed class RequestGapTests(ShopApiFactory factory)
{
    private const string PacedProvider = "amazon-nl";

    // a browser provider declaring none, chosen over an HTTP one so this does not read as "page walks only"
    private const string UnpacedProvider = "ah";

    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(2);

    [Fact]
    public async Task A_provider_that_asks_to_be_called_slowly_is()
    {
        var leased = await LeaseFetchAsync(PacedProvider);

        Assert.Equal(3_000, leased.Limits.PolitenessMs);
    }

    [Fact]
    public async Task A_provider_that_asks_for_nothing_gets_the_operators_floor()
    {
        var leased = await LeaseFetchAsync(UnpacedProvider);

        Assert.Equal(Floor(), leased.Limits.PolitenessMs);
    }

    // without this the pair above passes on a manifest declaring exactly the floor
    [Fact]
    public async Task The_declared_gap_is_longer_than_the_floor_it_replaced()
    {
        var paced = await LeaseFetchAsync(PacedProvider);

        Assert.True(
            paced.Limits.PolitenessMs > Floor(),
            $"amazon declares {paced.Limits.PolitenessMs}ms against a floor of {Floor()}ms; " +
            "a gap at or below the floor would change nothing");
    }

    private int Floor()
    {
        using var scope = factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<IOptions<ConnectorOptions>>().Value.Timeouts.PolitenessMs;
    }

    // a fetch, since amazon.nl's login needs a headed agent; leases in a loop as the shared host holds other queued jobs
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
                // residential NL: amazon.nl and AH ask for it and CanServe compares the claim; an agent stating no address is never leased
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
            // a subject per job: per-session concurrency is 1, so jobs sharing a session would hide each other
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
