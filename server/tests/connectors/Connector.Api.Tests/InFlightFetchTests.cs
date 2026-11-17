using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Endpoints;
using Connector.Kit.Hosting.Infrastructure;
using Connector.Kit.Jobs;
using Microsoft.Extensions.DependencyInjection;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// prod incident: a phone reopening the app queued four Amazon fetches in twelve minutes, three died waiting behind the lease
// the running job's handle is the same contract as a fresh 202, so answering with it costs the caller nothing
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

        var running = Running(connection, Since);

        using var fetch = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since={Since}", ticket);
        var body = await fetch.JsonAsync();

        Assert.True(fetch.StatusCode == HttpStatusCode.Accepted, body.ToString());
        Assert.Equal(running, body.Text("job_id"));

        Assert.Equal(
            1,
            Db.Read(factory, db => db.Jobs.Count(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Fetch)));

        // Another connection is another fetch: the dedupe is per session.
        var other = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("in-flight-other"),
            new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });
        using var theirs = await Flows.FetchAsync(http, $"/v1/{Provider}/receipts?since={Since}", await Flows.ResumeAsync(http, Provider, other));
        Assert.NotEqual(running, (await theirs.JsonAsync()).TextOrNull("job_id"));
    }

    // another window is another fetch: handing a pass over older history the newest rows' job would end its walk on them
    [Fact]
    public async Task A_fetch_for_another_window_is_not_handed_the_running_job()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("in-flight-window"),
            new Dictionary<string, string> { ["username"] = "u", ["password"] = "p" });
        var ticket = await Flows.ResumeAsync(http, Provider, connection);
        var running = Running(connection, Since);
        var until = Day(DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-10));

        // It waits behind the running job for the fetch window; the test only needs to see it queued.
        using var abandoned = new CancellationTokenSource();
        using var request = Wire.Get($"/v1/{Provider}/receipts?since={Since}&until={until}");
        request.AddHeader(RequestContext.TicketHeader, ticket);
        var older = http.SendAsync(request, abandoned.Token);

        var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
        JobRow? queued = null;
        while (queued is null && !older.IsCompleted)
        {
            Assert.True(DateTimeOffset.UtcNow < deadline, "the older-history fetch was never queued");
            queued = Db.Read(factory, db => db.Jobs.FirstOrDefault(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Fetch && j.Id != running));
            if (queued is null) await Task.Delay(25);
        }

        if (older.IsCompleted)
        {
            using var answered = await older;
            Assert.NotEqual(running, (await answered.JsonAsync()).TextOrNull("job_id"));
        }

        await abandoned.CancelAsync();
        Assert.NotNull(queued);
        Assert.Contains(until, queued.ParamsJson, StringComparison.Ordinal);
    }

    /// <summary>A window with no clamp in it, so the ask reads the same whenever it is bound.</summary>
    private static readonly string Since = Day(DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-30));

    private static string Day(DateOnly day) => day.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    // leased with a fresh lease, so neither the inline pump (leases Queued) nor the sweeper (requeues expired leases) touches it
    private string Running(Connection connection, string since)
    {
        var manifest = factory.Services.GetRequiredService<IProviderRegistry>().RequireManifest(Provider);
        var asked = ParamBinder.Bind(
            manifest,
            manifest.Resource("receipts")!,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["since"] = [since] },
            DateTimeOffset.UtcNow);

        var running = $"job_running_{Guid.NewGuid():N}";
        var now = DateTimeOffset.UtcNow;
        Db.Write(factory, db => db.Jobs.Add(new JobRow
        {
            Id = running,
            SessionId = connection.SessionId,
            ProviderId = Provider,
            Kind = JobKind.Fetch,
            ResourceId = "receipts",
            ParamsJson = ConnectorJson.Serialize(asked),
            State = JobState.Leased,
            LeaseOwner = "agt_somebody",
            LeaseExpiresAt = now.AddMinutes(10),
            Attempts = 1,
            Trigger = JobRow.UserTrigger,
            CreatedAt = now,
            UpdatedAt = now,
        }));
        return running;
    }
}
