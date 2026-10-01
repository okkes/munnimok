using System.Text.Json;
using System.Net;
using System.Net.Http.Json;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using ShopConnector.Adapters.Mock;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// <summary>
/// What disconnecting reaches, and what it does not.
///
/// <c>DELETE /sessions/{id}</c> called <c>LogoutAsync</c> on every provider,
/// gated on nothing but session state - and could never have worked. Custody is
/// the user's device, so the control plane holds no credential; the logout job
/// was enqueued carrying none, and the two adapters that implement a logout
/// both failed silently on it. Most of the rest inherit a do-nothing default
/// and were costing a job row, a lease and an agent round trip to reach
/// <c>Task.CompletedTask</c>, while the consuming app told the user it had
/// "logged out upstream" every single time.
///
/// So there are two rules now, and both are asserted here: the manifest says
/// whether anything upstream happens at all, and the credential to make it
/// happen has to be handed back by whoever holds it. Neither may ever fail the
/// disconnect - the user asked to remove a connection, not to prove they can
/// still authenticate.
/// </summary>
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

    // ---- the credential ----------------------------------------------------

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

        // AND IT SAYS SO. The route answered 204 in every case, so a consumer
        // had nothing to go on but the manifest's claim - and the demo client
        // duly told people their provider had been signed out of over
        // disconnects that carried no bundle and dispatched nothing.
        Assert.True(
            (await disconnect.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("logged_out").GetBoolean(),
            "a disconnect that queued a logout has to report that it did");

        var logout = Assert.Single(LogoutJobs(connection.SessionId));

        // The whole point. This was null for every logout this platform had
        // ever run, so the one adapter that did reach a provider on disconnect
        // threw session_expired building its session and swallowed it in its
        // own best-effort catch. That adapter is gone; the gate it exposed is
        // not, which is why this still asserts against a double below.
        Assert.NotNull(logout.MaterialJson);

        // The token this connection actually holds, not merely "something".
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

        // The old shape of this call, and the reason nothing ever happened.
        using var disconnect = await http.DeleteAsync($"/v1/{provider}/sessions/{connection.SessionId}");

        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);
        Assert.Empty(LogoutJobs(connection.SessionId));

        // AND IT ADMITS IT. This is the case the demo client hit on every real
        // disconnect - its relay forwarded the DELETE with an empty body - and
        // it still told the account holder their bank had been signed out of,
        // because a 204 gave it nothing else to say.
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

    // ---- the declaration ---------------------------------------------------

    [Fact]
    public async Task A_provider_that_logs_out_nowhere_gets_no_job_even_holding_the_bundle()
    {
        const string provider = MockStoreAdapters.Simple;

        using var http = factory.CreateAuthorizedClient();
        var connection = await Flows.ConnectAsync(
            http, provider, Flows.NewSubject("logout-none"), MockCredentials);

        Assert.Equal(LogoutSupport.None, await LogoutSupportOfAsync(http, provider));

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, connection.Bundle);

        // The user's side is identical - this is not a degraded disconnect.
        Assert.Equal(HttpStatusCode.OK, disconnect.StatusCode);

        // And nothing was queued to tell a provider that has no way of being
        // told. This is the row, the lease and the agent round trip that used
        // to be spent reaching Task.CompletedTask.
        Assert.Empty(LogoutJobs(connection.SessionId));
    }

    // ---- and why not -------------------------------------------------------

    /// <summary>
    /// EACH OF THE FOUR SILENCES NAMES ITSELF.
    /// </summary>
    /// <remarks>
    /// <c>logged_out: false</c> is true of all four and actionable on none of
    /// them, and they are not equivalent: "no logout declared" is the provider
    /// being honest, while "the caller sent no bundle" is a bug in the consumer
    /// that reads exactly like it. That confusion is not hypothetical - it is
    /// what hid a broken disconnect in this very repo for months.
    /// </remarks>
    [Fact]
    public async Task A_disconnect_that_told_nobody_says_which_of_the_four_reasons_it_was()
    {
        using var http = factory.CreateAuthorizedClient();

        // 1. The caller kept its bundle to itself.
        Assert.Equal(
            "the caller sent no bundle to log out with",
            await ReasonAsync(http, RotatingStoreAdapter.ProviderId, RotatingCredentials, "why-unarmed", bundle: null));

        // 2. It sent one, and it was not openable.
        Assert.Equal(
            "the bundle the caller sent would not open",
            await ReasonAsync(
                http, RotatingStoreAdapter.ProviderId, RotatingCredentials, "why-garbage", bundle: "not-a-bundle"));

        // 3. The provider offers nowhere to log out of.
        Assert.Equal(
            "the manifest declares no logout",
            await ReasonAsync(http, MockStoreAdapters.Simple, MockCredentials, "why-none", bundle: null));
    }

    /// <summary>
    /// A SECOND DISCONNECT IS NOT A SECOND LOGOUT, and says so rather than
    /// reporting the same silence as a caller who forgot the bundle.
    /// </summary>
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

    /// <summary>
    /// A logout that HAPPENED states no reason, because there is nothing to
    /// excuse. A reason beside a true would read as one.
    /// </summary>
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

    // ---- the purge ---------------------------------------------------------

    /// <summary>
    /// The purge happens either way, and it happens AFTER the bundle is opened
    /// and BEFORE the job is queued. Both orderings are load-bearing: a purged
    /// session's bundle no longer opens, and the purge blanks the material on
    /// every job the session has - which silently disarmed the logout job when
    /// it was created first.
    /// </summary>
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

        // The login's own credentials are gone. They were already cleared when
        // it went terminal - the plaintext window is the run, not the row's
        // lifetime - and the purge is what guarantees it for anything left.
        var login = Db.Read(factory, db => db.Jobs
            .Single(j => j.SessionId == connection.SessionId && j.Kind == JobKind.Login));

        Assert.Null(login.InputsJson);
        Assert.Null(login.MaterialJson);

        // The session row survives on purpose: it is how a user is told what
        // happened to a connection.
        Assert.Equal("disabled", await StateOfAsync(http, provider, connection.SessionId));
    }

    // ---- helpers -----------------------------------------------------------

    /// <summary>
    /// A DELETE carrying the bundle, exactly as the consuming app sends it.
    /// Awaited inside, because disposing the request before the send completes
    /// takes its content with it.
    /// </summary>
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

    /// <summary>
    /// Connect, disconnect, and hand back what the connector said about the
    /// logout it did not do.
    /// </summary>
    private static async Task<string?> ReasonAsync(
        HttpClient http, string provider, IReadOnlyDictionary<string, string> credentials, string who, string? bundle)
    {
        var connection = await Flows.ConnectAsync(http, provider, Flows.NewSubject(who), credentials);

        using var disconnect = await DeleteAsync(http, provider, connection.SessionId, bundle);
        var body = await disconnect.Content.ReadFromJsonAsync<JsonElement>();

        Assert.False(body.GetProperty("logged_out").GetBoolean());

        return body.GetProperty("reason").GetString();
    }

    /// <summary>Read from the catalogue, so this asserts what a consumer is actually told.</summary>
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
