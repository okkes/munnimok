using System.Text.Json;
using System.Net;
using System.Net.Http.Json;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

// two rules: the manifest says whether anything upstream happens, and the credential for it is handed back by its holder
// neither may fail the disconnect
[Collection(ShopApiCollection.Name)]
public sealed class DisconnectLogoutTests(ShopApiFactory factory)
{
    private static readonly Dictionary<string, string> MockCredentials = new(StringComparer.Ordinal)
    {
        ["username"] = "shopper",
        ["password"] = "hunter2",
    };

    private static readonly Dictionary<string, string> RotatingCredentials = new(StringComparer.Ordinal)
    {
        ["username"] = RotatingStoreAdapter.Username,
        ["password"] = RotatingStoreAdapter.Password,
    };

    [Fact]
    public async Task A_declared_logout_given_the_bundle_gets_a_job_that_can_actually_use_it()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-armed"), RotatingCredentials);

        Assert.Equal(LogoutSupport.Session, await LogoutSupportOfAsync(http, provider));

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle);
        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);

        Assert.True(
            (await disconnect.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("logged_out").GetBoolean(),
            "a disconnect that queued a logout has to report that it did");

        var logout = Assert.Single(LogoutJobs(connection.SessionId));

        // the logout job carries the credential only when the caller hands the bundle back: it was null for every logout before
        Assert.NotNull(logout.MaterialJson);

        Assert.Contains(
            $"rot-access-0-{connection.SessionId}", logout.MaterialJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_declared_logout_with_no_bundle_offered_is_skipped_rather_than_queued_blind()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-unarmed"), RotatingCredentials);

        using var disconnect = await http.DeleteAsync($"/v1/{provider}/sessions/{connection.SessionId}");

        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);
        Assert.Empty(LogoutJobs(connection.SessionId));

        // the demo client's relay forwarded the DELETE with an empty body and still claimed a logout: the response must say false
        Assert.False(
            (await disconnect.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("logged_out").GetBoolean(),
            "a disconnect that queued nothing must not report a logout");
    }

    /// <summary>
    /// A bundle that does not open is a logout that cannot happen - never a
    /// disconnect that may be refused.
    /// </summary>
    [Theory]
    [InlineData("not-a-bundle")]
    [InlineData("")]
    public async Task A_bundle_that_does_not_open_still_removes_the_connection(string bundle)
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-garbage"), RotatingCredentials);

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, bundle);

        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);
        Assert.Empty(LogoutJobs(connection.SessionId));
        Assert.Equal("disabled", await StateOfAsync(http, provider, connection.SessionId));
    }

    [Fact]
    public async Task A_provider_that_logs_out_nowhere_gets_no_job_even_holding_the_bundle()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-none"), MockCredentials);

        Assert.Equal(LogoutSupport.None, await LogoutSupportOfAsync(http, provider));

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle);

        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);

        Assert.Empty(LogoutJobs(connection.SessionId));
    }

    // "logged_out: false" alone hides which silence it was: "no logout declared" is honest, "no bundle sent" is a consumer bug
    [Fact]
    public async Task A_disconnect_that_told_nobody_says_which_of_the_four_reasons_it_was()
    {
        using var http = factory.CreateAuthorizedClient();

        Assert.Equal(
            "the caller sent no bundle to log out with",
            await ReasonAsync(http, RotatingStoreAdapter.ProviderId, RotatingCredentials, "why-unarmed", bundle: null));

        Assert.Equal(
            "the bundle the caller sent would not open",
            await ReasonAsync(
                http, RotatingStoreAdapter.ProviderId, RotatingCredentials, "why-garbage", bundle: "not-a-bundle"));

        Assert.Equal(
            "the manifest declares no logout",
            await ReasonAsync(http, MockStoreAdapters.Simple, MockCredentials, "why-none", bundle: null));
    }

    // a second disconnect is not a second logout: it reports the state it found, not a forgotten bundle
    [Fact]
    public async Task Disconnecting_an_already_disconnected_session_names_the_state_it_found()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("why-twice"), RotatingCredentials);

        using (var first = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle))
        {
            Assert.True((await first.Content.ReadFromJsonAsync<JsonElement>())
                .GetProperty("logged_out").GetBoolean());
        }

        using var second = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle);
        var body = await second.Content.ReadFromJsonAsync<JsonElement>();

        Assert.False(body.GetProperty("logged_out").GetBoolean());
        Assert.Equal("the session was Disabled, not active", body.GetProperty("reason").GetString());
    }

    // a logout that happened states no reason: a reason beside a true would read as an excuse
    [Fact]
    public async Task A_dispatched_logout_offers_no_excuse()
    {
        const string provider = RotatingStoreAdapter.ProviderId;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("why-silent"), RotatingCredentials);

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle);
        var body = await disconnect.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(body.GetProperty("logged_out").GetBoolean());
        Assert.False(body.TryGetProperty("reason", out var stated) && stated.ValueKind != JsonValueKind.Null);
    }

    // the purge runs after the bundle is opened and before the job is queued: a purged session's bundle no longer opens,
    // and the purge blanks the material on every job of the session
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_local_purge_happens_whether_or_not_anything_is_told(bool declaresLogout)
    {
        var provider = declaresLogout ? RotatingStoreAdapter.ProviderId : MockStoreAdapters.Simple;
        var credentials = declaresLogout ? RotatingCredentials : MockCredentials;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-purge"), credentials);

        using (var disconnect = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle))
        {
            Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);
        }

        var login = Db.Read(factory, db => db.Jobs
            .Single(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Login));

        Assert.Null(login.InputsJson);
        Assert.Null(login.MaterialJson);

        // the session row survives on purpose: it is how a user is told what happened to a connection
        Assert.Equal("disabled", await StateOfAsync(http, provider, connection.SessionId));
    }

    // awaited inside: disposing the request before the send completes takes its content with it
    private static async Task<HttpResponseMessage> DeleteAsync(
        HttpClient http, string provider, string sessionId, string? bundle)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Delete, $"/v1/{provider}/sessions/{sessionId}")
        {
            Content = JsonContent.Create(new { bundle }),
        };

        return await http.SendAsync(request);
    }

    private static async Task<string?> ReasonAsync(
        HttpClient http, string provider, IReadOnlyDictionary<string, string> credentials, string who, string? bundle)
    {
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject(who), credentials);

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, bundle);
        var body = await disconnect.Content.ReadFromJsonAsync<JsonElement>();

        Assert.False(body.GetProperty("logged_out").GetBoolean());

        return body.GetProperty("reason").GetString();
    }

    private static async Task<LogoutSupport> LogoutSupportOfAsync(HttpClient http, string provider)
    {
        using var response = await http.GetAsync($"/v1/providers/{provider}");
        var body = await response.JsonAsync();

        return body.Text("logout") switch
        {
            "session" => LogoutSupport.Session,
            "account" => LogoutSupport.Account,
            _ => LogoutSupport.None,
        };
    }

    private static async Task<string?> StateOfAsync(HttpClient http, string provider, string sessionId)
    {
        using var response = await http.GetAsync($"/v1/{provider}/login/{sessionId}");
        var body = await response.JsonAsync();
        return body.Text("state");
    }

    private List<JobRow> LogoutJobs(string sessionId) =>
        Db.Read(factory, db => db.Jobs
            .Where(j => j.SessionId == sessionId && j.Kind == JobKind.Logout)
            .ToList());
}
