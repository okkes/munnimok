using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Connector.Kit.Hosting.Endpoints;

namespace Connector.Api.Tests.Infrastructure;

internal sealed record Connection(string Subject, string SessionId, string Bundle);

// api-spec §8 as steps: tests start from a real login, since a seeded session would skip the bundle and the subject binding
internal static class Flows
{
    private static readonly TimeSpan SettleBudget = TimeSpan.FromSeconds(45);

    public static string NewSubject(string label) => $"u_{label}_{Guid.NewGuid():N}";

    // an inline provider may finish inside the login request or answer 202 and a poll: both are accepted
    public static async Task<Connection> ConnectAsync(
        HttpClient http,
        string provider,
        string subject,
        IReadOnlyDictionary<string, string> inputs,
        string? deviceClass = null)
    {
        var (sessionId, bundle) = await StartLoginAsync(http, provider, subject, inputs, deviceClass);
        bundle ??= await AwaitBundleAsync(http, provider, sessionId);
        return new Connection(subject, sessionId, bundle);
    }

    public static async Task<(string SessionId, string? Bundle)> StartLoginAsync(
        HttpClient http,
        string provider,
        string subject,
        IReadOnlyDictionary<string, string> inputs,
        string? deviceClass = null)
    {
        ArgumentNullException.ThrowIfNull(http);

        http.ActAs(subject);
        using var request = Wire.Post($"/v1/{provider}/login", new { subject, inputs });
        if (deviceClass is not null) request.AddHeader(RequestContext.DeviceClassHeader, deviceClass);

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();

        Assert.True(
            response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Accepted,
            $"login for {provider} answered {(int)response.StatusCode}: {body}");

        return (body.Text("session_id"), body.TextOrNull("bundle"));
    }

    // takes the first bundle seen, not state == active: it is delivered once and cleared, so skipping one destroys it
    public static async Task<string> AwaitBundleAsync(HttpClient http, string provider, string sessionId)
    {
        ArgumentNullException.ThrowIfNull(http);

        var clock = Stopwatch.StartNew();
        var state = "unknown";

        while (clock.Elapsed < SettleBudget)
        {
            var view = await ReadSessionAsync(http, provider, sessionId);
            if (view.TextOrNull("bundle") is { } bundle) return bundle;

            state = view.Text("state");
            if (state is "failed" or "expired" or "blocked" or "disabled")
            {
                Assert.Fail($"login for {provider} ended as '{state}' with no bundle: {view}");
            }

            await Task.Delay(100);
        }

        Assert.Fail($"login for {provider} was still '{state}' after {SettleBudget.TotalSeconds:0}s");
        throw new UnreachableException();
    }

    // separate from AwaitBundleAsync: the bundle can land one save before the state
    public static async Task<JsonElement> AwaitStateAsync(HttpClient http, string provider, string sessionId, string state)
    {
        ArgumentNullException.ThrowIfNull(http);

        var clock = Stopwatch.StartNew();
        var view = default(JsonElement);

        while (clock.Elapsed < SettleBudget)
        {
            view = await ReadSessionAsync(http, provider, sessionId);
            if (string.Equals(view.Text("state"), state, StringComparison.Ordinal)) return view;

            await Task.Delay(100);
        }

        Assert.Fail($"session {sessionId} never reached '{state}'; last seen: {view}");
        throw new UnreachableException();
    }

    public static async Task<JsonElement> ReadSessionAsync(HttpClient http, string provider, string sessionId)
    {
        ArgumentNullException.ThrowIfNull(http);

        using var response = await http.GetAsync($"/v1/{provider}/login/{sessionId}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.JsonAsync();
    }

    public static async Task<string> ResumeAsync(HttpClient http, string provider, Connection connection)
    {
        ArgumentNullException.ThrowIfNull(http);
        ArgumentNullException.ThrowIfNull(connection);

        http.ActAs(connection.Subject);
        using var request = Wire.Post($"/v1/{provider}/sessions/resume",
            new { subject = connection.Subject, bundle = connection.Bundle });

        using var response = await http.SendAsync(request);
        var body = await response.JsonAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return body.Text("ticket");
    }

    public static async Task<HttpResponseMessage> FetchAsync(HttpClient http, string url, string ticket)
    {
        ArgumentNullException.ThrowIfNull(http);

        using var request = Wire.Get(url);
        request.AddHeader(RequestContext.TicketHeader, ticket);
        return await http.SendAsync(request);
    }

    // 200 and 202 are both correct and depend on load (the inline runner has less CPU in a full run):
    // asserting 200 passes alone and fails in the suite
    public static async Task<JsonElement> FetchPageAsync(HttpClient http, string provider, string url, string ticket)
    {
        ArgumentNullException.ThrowIfNull(http);

        JsonElement body;
        using (var response = await FetchAsync(http, url, ticket))
        {
            body = await response.JsonAsync();

            if (response.StatusCode == HttpStatusCode.OK) return body;

            Assert.True(
                response.StatusCode == HttpStatusCode.Accepted,
                $"fetch answered {(int)response.StatusCode}: {body}");
        }

        var jobId = body.Text("job_id");
        var clock = Stopwatch.StartNew();
        var state = "unknown";

        while (clock.Elapsed < SettleBudget)
        {
            using var poll = await http.GetAsync($"/v1/{provider}/jobs/{jobId}");
            var view = await poll.JsonAsync();
            state = view.Text("state");

            if (string.Equals(state, "succeeded", StringComparison.Ordinal)) return view;

            Assert.False(
                state is "failed" or "expired",
                $"fetch job {jobId} ended as '{state}': {view}");

            await Task.Delay(100);
        }

        Assert.Fail($"fetch job {jobId} was still '{state}' after {SettleBudget.TotalSeconds:0}s");
        throw new UnreachableException();
    }

    public static async Task<HttpResponseMessage> PostWithTicketAsync(HttpClient http, string url, object body, string ticket)
    {
        ArgumentNullException.ThrowIfNull(http);

        using var request = Wire.Post(url, body);
        request.AddHeader(RequestContext.TicketHeader, ticket);
        return await http.SendAsync(request);
    }
}
