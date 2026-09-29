using System.Net;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// api-spec §2.4: what the adapter said about a run, all the way out to a
/// caller.
///
/// The gap this closes: a note went to the agent's logger and stopped there,
/// so every explanation of an outcome - "this pass is partial", "that account
/// type could not be listed", "the provider states no balance for this card" -
/// lived on whichever machine ran the job, while the caller got a blank and no
/// way to ask why.
/// </summary>
[Collection(ShopApiCollection.Name)]
public sealed class JobNotesTests(ShopApiFactory factory)
{
    private static readonly Dictionary<string, string> Credentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    /// <summary>
    /// A window that excludes some of the fixture but not all of it, so the
    /// mock has something true to say.
    /// </summary>
    private const string NarrowWindow = "2026-07-10";

    private const string WholeWindow = "2026-06-01";

    [Fact]
    public async Task A_fetch_carries_what_the_adapter_said_about_it()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject("notes"), Credentials);
        var ticket = await Flows.ResumeAsync(http, provider, connection);

        var page = await Flows.FetchPageAsync(
            http, provider, $"/v1/{provider}/receipts?since={NarrowWindow}", ticket);

        var notes = page.GetProperty("notes").EnumerateArray().Select(n => n.GetString()!).ToList();

        var note = Assert.Single(notes);
        Assert.Contains("outside the requested window", note, StringComparison.Ordinal);

        // The records the caller DID get are unaffected: a note explains an
        // outcome, it does not change one.
        Assert.NotEmpty(page.GetProperty("data").EnumerateArray());
    }

    /// <summary>
    /// And nothing is carried when the adapter had nothing to say, so a
    /// consumer can render the field's presence as meaning something.
    /// </summary>
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

    /// <summary>
    /// A SIGN-IN CARRIES ITS NOTES TOO, and it is the outcome that carries the
    /// most of them.
    /// </summary>
    /// <remarks>
    /// The fetch path had this from the start; the login path did not, so an
    /// adapter's account of how somebody got connected - which screen the
    /// provider served, whether a form ever opened, what scope came back -
    /// reached the agent's stdout and stopped. On the one provider where it was
    /// checked, eight notes per sign-in went nowhere.
    /// <para>
    /// Read off the session rather than a job, because a caller connecting
    /// polls the session and never learns the login job's id.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// And a sign-in with nothing to explain carries none, so a consumer can
    /// render the field's presence as meaning something.
    /// </summary>
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
