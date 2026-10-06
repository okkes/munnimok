using System.Net;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// A fetch of a resource already in flight for a connection IS the fetch
/// the caller gets.
///
/// Prod, 2026-10-06: a phone that kept reopening the app queued four Amazon
/// fetches in twelve minutes. One ran for half an hour; the other three
/// waited behind the per-session lease and died as <c>agent_unavailable</c>
/// - and the app, which had never seen the first one finish, started a
/// fifth. The handle of the running job is the same contract as a fresh
/// 202, so answering with it costs the caller nothing and the fleet a lot.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class InFlightFetchTests(ShopApiFactory factory)
{
    private const string Provider = MockStoreAdapters.Simple;

    [Fact]
    public async Task A_second_fetch_of_a_resource_in_flight_is_handed_the_running_job()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("in-flight"),
            new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        // A fetch an agent holds right now: leased, the lease fresh, so neither
        // the inline pump (it leases Queued) nor the sweeper (it requeues
        // expired leases) touches it while this test looks.
        var running = $"job_running_{Guid.NewGuid():N}";
        var now = DateTimeOffset.UtcNow;
        Db.Write(factory, db => db.Jobs.Add(new JobRow
        {
            Id = running,
            SessionId = connection.SessionId,
            ProviderId = Provider,
            Kind = JobKind.Fetch,
            ResourceId = "receipts",
            State = JobState.Leased,
            LeaseOwner = "agt_somebody",
            LeaseExpiresAt = now.AddMinutes(10),
            Attempts = 1,
            Trigger = JobRow.UserTrigger,
            CreatedAt = now,
            UpdatedAt = now,
        }));

        using var fetch = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since=2026-01-01", ticket);
        var body = await fetch.JsonAsync();

        Assert.True(fetch.StatusCode == HttpStatusCode.Accepted, body.ToString());
        Assert.Equal(running, body.Text("job_id"));

        // And nothing new was queued behind it.
        Assert.Equal(
            1,
            Db.Read(factory, db => db.Jobs.Count(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Fetch)));

        // Another connection is another fetch: the dedupe is per session.
        var other = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("in-flight-other"),
            new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });
        using var theirs = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since=2026-01-01", await Flows.ResumeAsync(http, Provider, other));
        Assert.NotEqual(running, (await theirs.JsonAsync()).TextOrNull("job_id"));
    }
}
