using System.Globalization;
using System.Net;
using System.Text.Json;
using Connector.Kit.Jobs;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// api-spec §8 steps 3-5 as a loop: the bundle out of one fetch is the bundle into the next, with no human
// refresh semantics (expiry, 401 retry, dead grant) are proved in ShopConnector.Adapters.Tests.RefreshLoopTests
[Collection(ShopApiCollection.Name)]
public sealed class RefreshLoopApiTests(ShopApiFactory factory)
{
    private static readonly Dictionary<string, string> RotatingCredentials = new(StringComparer.Ordinal)
    {
        ["username"] = RotatingStoreAdapter.Username,
        ["password"] = RotatingStoreAdapter.Password,
    };

    private static readonly Dictionary<string, string> SimpleCredentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    private const string FixtureWindow = "2026-06-01";

    // read once after the fetch finished, no poll: the inline runner flushes progress before reporting
    // every fetch job, not "the latest": Db.LatestJob breaks CreatedAt ties on a random id and once named the login job
    private void AssertFetchesRecorded(string sessionId, string step)
    {
        var seen = Db.Read(factory, db => db.Jobs
            .Where(j => j.SessionId == sessionId && j.Kind == JobKind.Fetch)
            .Select(j => j.StepsDoneJson)
            .ToList());

        Assert.Equal(2, seen.Count);
        Assert.All(seen, steps => Assert.Contains(step, steps, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task The_rotated_bundle_serves_the_next_fetch_and_the_connector_keeps_no_copy_of_it()
    
    {
        // wrapped in Postmortem so an intermittent failure carries the run with it
        string? sessionId = null;

        await Postmortem.WatchAsync(factory, () => sessionId, async () =>
        {
            const string provider = RotatingStoreAdapter.ProviderId;

            using var http = factory.CreateAuthorizedClient();
            var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("loop-once"), RotatingCredentials);
            sessionId = connection.SessionId;

            var first = await FetchAsync(http, provider, connection);
            Assert.NotEmpty(first.GetProperty("data").EnumerateArray());

            var rotated = RotatedBundleOf(first);
            Assert.NotEqual(connection.Bundle, rotated);

            // the connector keeps no copy of a delivered bundle: a secret at rest with no reason to exist
            Assert.Null(PendingBundle(connection.SessionId));

            var second = await FetchAsync(http, provider, connection with { Bundle = rotated });
            Assert.NotEmpty(second.GetProperty("data").EnumerateArray());

            var again = RotatedBundleOf(second);
            Assert.NotEqual(rotated, again);
            Assert.NotEqual(connection.Bundle, again);

            // typed progress is written by the guarded statement that stops a straggling report resurrecting a finished job
            AssertFetchesRecorded(connection.SessionId, "downloading");

            Assert.Equal(1, LoginJobs(connection.SessionId));
            Assert.Equal("active", (await Flows.ReadSessionAsync(http, provider, connection.SessionId)).Text("state"));
    
        });
    }

    [Fact]
    public async Task A_fetch_that_rotated_nothing_returns_no_session_block_and_the_stored_bundle_stays_current()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("loop-static"), SimpleCredentials);

        var first = await FetchAsync(http, provider, connection, FixtureWindow);

        // no session block rather than `rotated: false`: there is nothing to persist
        Assert.False(first.TryGetProperty("session", out _), "an unrotated fetch must not re-issue a bundle");
        Assert.Null(PendingBundle(connection.SessionId));

        var second = await FetchAsync(http, provider, connection, FixtureWindow);

        Assert.NotEmpty(second.GetProperty("data").EnumerateArray());
        Assert.False(second.TryGetProperty("session", out _));
        Assert.Equal(1, LoginJobs(connection.SessionId));
    }

    // every way a session stops being usable answers session_expired + reauth, so a probing caller learns nothing
    // disconnect is the offline route; the dead refresh grant is driven against a real token endpoint in the adapter suite
    [Fact]
    public async Task A_session_that_can_no_longer_be_refreshed_answers_reauth_once_and_queues_no_work()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("loop-dead"), RotatingCredentials);

        using (var disconnect = await http.DeleteAsync($"/v1/{provider}/sessions/{connection.SessionId}"))
        {
            Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);
        }

        var jobsBefore = AllJobs(connection.SessionId);

        for (var attempt = 1; attempt <= 3; attempt++)
        {
            using var resume = Wire.Post($"/v1/{provider}/sessions/resume",
                new { subject = connection.Subject, bundle = connection.Bundle });

            using var response = await http.SendAsync(resume);
            var error = await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Unauthorized, "session_expired");

            Assert.Equal("reauth", error.Text("user_action"));
            Assert.False(error.GetProperty("retriable").GetBoolean());
        }

        using (var oneShot = Wire.Post($"/v1/{provider}/{RotatingStoreAdapter.ReceiptsResource}:fetch", new
        {
            subject = connection.Subject,
            bundle = connection.Bundle,
            @params = new Dictionary<string, object>(StringComparer.Ordinal) { ["since"] = FixtureWindow },
        }))
        {
            using var response = await http.SendAsync(oneShot);
            await ErrorEnvelope.AssertAsync(response, HttpStatusCode.Unauthorized, "session_expired");
        }

        // four rejections, none created a job: queued work would send an adapter upstream with a refused credential
        Assert.Equal(jobsBefore, AllJobs(connection.SessionId));
    }

    [Fact]
    public async Task A_month_of_fetches_never_asks_the_human_to_sign_in_again()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("loop-month"), RotatingCredentials);

        var seen = new HashSet<string>(StringComparer.Ordinal) { connection.Bundle };

        for (var day = 1; day <= 30; day++)
        {
            var page = await FetchAsync(http, provider, connection);

            Assert.NotEmpty(page.GetProperty("data").EnumerateArray());

            // per-session concurrency is 1: a job stuck non-terminal would silently stop the loop, later fetches never leased
            Assert.Equal(0, UnfinishedJobs(connection.SessionId));

            Assert.False(page.TryGetProperty("challenge", out _), $"day {day} stopped to ask a question");

            var rotated = RotatedBundleOf(page);
            Assert.True(seen.Add(rotated), $"day {day} re-issued a bundle the caller had already seen");

            connection = connection with { Bundle = rotated };
        }

        Assert.Equal(1, LoginJobs(connection.SessionId));

        var view = await Flows.ReadSessionAsync(http, provider, connection.SessionId);
        Assert.Equal("active", view.Text("state"));

        // each rotation re-seals the session so its deadline moves out; expiry from the FIRST login would force a re-login
        Assert.True(
            view.GetProperty("expires_at").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddDays(29),
            "a month of successful syncs must not leave the connection about to expire");
    }

    private static async Task<JsonElement> FetchAsync(
        HttpClient http, string provider, Connection connection, string? since = null)
    {
        var ticket = await Flows.ResumeAsync(http, provider, connection);

        var window = since ?? DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-30)
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        return await Flows.FetchPageAsync(http, provider, $"/v1/{provider}/receipts?since={window}", ticket);
    }

    private static string RotatedBundleOf(JsonElement page)
    {
        Assert.True(page.TryGetProperty("session", out var session), "a rotated fetch must re-issue a bundle");
        Assert.True(session.GetProperty("rotated").GetBoolean(), "rotated must be true when a bundle is re-issued");

        var bundle = session.Text("bundle");
        Assert.StartsWith("sb_v1.", bundle, StringComparison.Ordinal);
        return bundle;
    }

    private string? PendingBundle(string sessionId) =>
        Db.Read(factory, db => db.Sessions.Where(s => s.Id == sessionId).Select(s => s.PendingBundle).Single());

    private int LoginJobs(string sessionId) =>
        Db.Read(factory, db => db.Jobs.Count(j => j.SessionId == sessionId && j.Kind == JobKind.Login));

    private int AllJobs(string sessionId) =>
        Db.Read(factory, db => db.Jobs.Count(j => j.SessionId == sessionId));

    // a stuck non-terminal job blocks the session's next job silently, with no wire surface: asserted from the tables
    private int UnfinishedJobs(string sessionId) =>
        Db.Read(factory, db => db.Jobs.Count(j => j.SessionId == sessionId
                                                  && (j.State == JobState.Leased
                                                      || j.State == JobState.Running
                                                      || j.State == JobState.AwaitingInput)));
}
