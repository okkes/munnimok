using System.Globalization;
using System.Net;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// api-spec §2.4: what the adapter said about a run reaches the caller, not only the agent's logger
[Collection(ShopApiCollection.Name)]
public sealed class JobNotesTests(ShopApiFactory factory)
{
    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    // two weeks back: excludes part of the fixture, so the mock has something true to say
    private static string NarrowWindow() =>
        DateOnly.FromDateTime(DateTime.UtcNow).AddDays(-14).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Before the store's first day; the platform clamps it to the year the store keeps, so nothing falls outside.</summary>
    private const string WholeWindow = "2026-06-01";

    [Fact]
    public async Task A_fetch_carries_what_the_adapter_said_about_it()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("notes"), Credentials);
        var ticket = await Flows.ResumeAsync(http, provider, connection);

        var page = await Flows.FetchPageAsync(
            http, provider, $"/v1/{provider}/receipts?since={NarrowWindow()}", ticket);

        var notes = page.GetProperty("notes").EnumerateArray().Select(n => n.GetString()!).ToList();

        var note = Assert.Single(notes);
        Assert.Contains("outside the requested window", note, StringComparison.Ordinal);

        Assert.NotEmpty(page.GetProperty("data").EnumerateArray());
    }

    // no notes when the adapter had nothing to say: the field's presence means something
    [Fact]
    public async Task A_run_with_nothing_to_explain_carries_no_notes()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("quiet"), Credentials);
        var ticket = await Flows.ResumeAsync(http, provider, connection);

        var page = await Flows.FetchPageAsync(
            http, provider, $"/v1/{provider}/receipts?since={WholeWindow}", ticket);

        Assert.Empty(page.GetProperty("notes").EnumerateArray());
    }

    // a sign-in carries notes too, read off the session: a connecting caller polls it and never learns the login job's id
    [Fact]
    public async Task A_sign_in_carries_what_the_adapter_said_about_it()
    {
        const string provider = MockStoreAdapters.Sms;

        using var http = factory.CreateAuthorizedClient();

        var notesSubject = Flows.NewSubject("login-notes");
        http.ActAs(notesSubject);
        using var request = Wire.Post(
            $"/v1/{provider}/login",
            new { Subject = notesSubject, Inputs = Credentials });

        using var login = await http.SendAsync(request);
        var accepted = await login.JsonAsync();
        var sessionId = accepted.Text("session_id")!;

        using (var answer = Wire.Post(
            $"/v1/{provider}/login/{sessionId}/answer",
            new { ChallengeId = accepted.GetProperty("challenge").Text("id"), Value = "123456" }))
        using (var answered = await http.SendAsync(answer))
        {
            Assert.Equal(HttpStatusCode.OK, answered.StatusCode);
        }

        await Flows.AwaitStateAsync(http, provider, sessionId, "active");

        using var response = await http.GetAsync($"/v1/{provider}/login/{sessionId}");
        var view = await response.JsonAsync();

        var notes = view.GetProperty("notes").EnumerateArray().Select(n => n.GetString()!).ToList();

        Assert.Equal(
            $"{provider}: this sign-in was interrupted by a code challenge, which the caller answered",
            Assert.Single(notes));
    }

    [Fact]
    public async Task A_sign_in_with_nothing_to_explain_carries_no_notes()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("login-quiet"), Credentials);

        using var response = await http.GetAsync($"/v1/{provider}/login/{connection.SessionId}");
        var view = await response.JsonAsync();

        Assert.Empty(view.GetProperty("notes").EnumerateArray());
    }
}
