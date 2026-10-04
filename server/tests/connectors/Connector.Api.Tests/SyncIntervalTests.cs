using System.Net;
using Connector.Api.Tests.Infrastructure;
using Connector.Kit.Hosting.Endpoints;

namespace Connector.Api.Tests;

/// <summary>
/// The provider's <c>min_interval_seconds</c>, enforced for schedules and
/// for nobody else: a scheduler that comes back inside the interval is told
/// <c>rate_limited</c> and how long to wait, a person who presses the button
/// is not - the interval is about firehoses, and a person is not one.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class SyncIntervalTests(ShopApiFactory factory)
{
    // its manifest asks for 60 s between syncs
    private const string Provider = RotatingStoreAdapter.ProviderId;

    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = RotatingStoreAdapter.Username,
        ["password"] = RotatingStoreAdapter.Password,
    };

    private static string Receipts => $"/v1/{Provider}/{RotatingStoreAdapter.ReceiptsResource}?since=2026-06-01";

    [Fact]
    public async Task A_schedule_inside_the_interval_of_the_last_schedule_is_held_off_and_told_how_long_while_a_person_is_not()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("interval"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        // the clock starts at a SCHEDULED fetch, nothing else
        using (var first = await FetchAsync(http, ticket, "schedule"))
        {
            Assert.True(first.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, first.StatusCode.ToString());
        }

        using (var scheduled = await FetchAsync(http, ticket, "schedule"))
        {
            var error = await ErrorEnvelope.AssertAsync(scheduled, HttpStatusCode.TooManyRequests, "rate_limited");
            Assert.InRange(error.GetProperty("retry_after_seconds").GetInt32(), 1, 60);
            Assert.True(error.GetProperty("retriable").GetBoolean());
        }

        using (var pressed = await FetchAsync(http, ticket, "user"))
        {
            Assert.True(pressed.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, pressed.StatusCode.ToString());
        }

        await Flows.FetchPageAsync(http, Provider, Receipts, ticket);
    }

    /// <summary>
    /// A person's own fetch is attended traffic: it never holds the schedule
    /// off. Counting it did, and on prod the app's syncs on open refused the
    /// nightly scheduled one day after day as rate_limited (2026-10-04).
    /// </summary>
    [Fact]
    public async Task A_persons_fetch_inside_the_interval_does_not_hold_the_schedule_off()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("attended"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        await Flows.FetchPageAsync(http, Provider, Receipts, ticket);

        using var scheduled = await FetchAsync(http, ticket, "schedule");

        Assert.True(scheduled.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, scheduled.StatusCode.ToString());
    }

    [Fact]
    public async Task The_first_schedule_ever_runs()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("first-schedule"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        using var scheduled = await FetchAsync(http, ticket, "schedule");

        Assert.True(scheduled.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, scheduled.StatusCode.ToString());
    }

    [Fact]
    public async Task A_scheduled_login_inside_the_interval_is_held_off_too()
    {
        using var http = factory.CreateAuthorizedClient();
        var subject = Flows.NewSubject("login-interval");
        await Flows.ConnectAsync(http, Provider, subject, Credentials);

        // the clock starts at a scheduled login; the person's own sign-in above does not count
        using (var first = Wire.Post($"/v1/{Provider}/login", new { subject, inputs = Credentials }))
        {
            first.AddHeader(RequestContext.TriggerHeader, "schedule");
            using var started = await http.SendAsync(first);
            Assert.True(started.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted, started.StatusCode.ToString());
        }

        using var request = Wire.Post($"/v1/{Provider}/login", new { subject, inputs = Credentials });
        request.AddHeader(RequestContext.TriggerHeader, "schedule");
        using var scheduled = await http.SendAsync(request);

        var error = await ErrorEnvelope.AssertAsync(scheduled, HttpStatusCode.TooManyRequests, "rate_limited");
        Assert.InRange(error.GetProperty("retry_after_seconds").GetInt32(), 1, 60);

        // and a person can sign in again whenever they like
        await Flows.ConnectAsync(http, Provider, subject, Credentials);
    }

    [Fact]
    public async Task A_trigger_the_connector_does_not_know_is_refused_rather_than_guessed()
    {
        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, Provider, Flows.NewSubject("trigger"), Credentials);
        var ticket = await Flows.ResumeAsync(http, Provider, connection);

        using var response = await FetchAsync(http, ticket, "cron");

        await ErrorEnvelope.AssertAsync(response, HttpStatusCode.BadRequest, "invalid_request");
    }

    private static async Task<HttpResponseMessage> FetchAsync(HttpClient http, string ticket, string trigger)
    {
        using var request = Wire.Get(Receipts);
        request.AddHeader(RequestContext.TicketHeader, ticket);
        request.AddHeader(RequestContext.TriggerHeader, trigger);
        return await http.SendAsync(request);
    }
}
