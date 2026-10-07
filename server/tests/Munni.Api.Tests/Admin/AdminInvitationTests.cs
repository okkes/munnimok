using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Admin;
using Munni.Api.Auth;

namespace Munni.Api.Tests.Admin;

/// <summary>
/// A stand-in Logto Management API: the token endpoint and the one-time-token
/// routes as Logto 1.43 answers them, every request kept for the assertions.
/// One instance per factory — the handler is the fixture's memory.
/// </summary>
public sealed class FakeLogtoHandler : HttpMessageHandler
{
    public sealed record Seen(HttpMethod Method, string Path, string Query, string? Bearer, string? Body);

    private const string TokensPath = "/api/one-time-tokens";

    /// <summary>two open tokens: one good until 2100, one whose end passed in 2023 (Logto still calls it active until someone tries it)</summary>
    private const string Listing = """
        [{"id":"ott-1","email":"one@example.com","token":"t1","status":"active","createdAt":1790000000000,"expiresAt":4102444800000},
         {"id":"ott-2","email":"two@example.com","token":"t2","status":"active","createdAt":1700000000000,"expiresAt":1700172800000}]
        """;

    private readonly List<Seen> _seen = [];

    public IReadOnlyList<Seen> Requests
    {
        get { lock (_seen) return _seen.ToList(); }
    }

    public int TokenMints => Requests.Count(r => r.Path.EndsWith("/oidc/token", StringComparison.Ordinal));

    /// <summary>a forced answer for every Management API route (the token endpoint keeps answering): a Logto that refuses the app</summary>
    public HttpStatusCode? ManagementAnswer { get; set; }

    /// <summary>a forced answer for the token endpoint itself: a wrong app id or secret</summary>
    public HttpStatusCode? TokenAnswer { get; set; }

    /// <summary>a Logto nobody can reach</summary>
    public bool Unreachable { get; set; }

    public int TokenLifetimeSeconds { get; set; } = 3600;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        var path = request.RequestUri!.AbsolutePath;
        lock (_seen) _seen.Add(new Seen(request.Method, path, request.RequestUri.Query, request.Headers.Authorization?.Parameter, body));

        if (Unreachable) throw new HttpRequestException("connection refused");
        if (!path.EndsWith("/oidc/token", StringComparison.Ordinal)) return Management(request.Method, path, body);
        if (TokenAnswer is { } refusedMint) return new HttpResponseMessage(refusedMint);
        return Json(HttpStatusCode.OK, $$"""{"access_token":"tok-{{TokenMints}}","expires_in":{{TokenLifetimeSeconds}} }""");
    }

    private HttpResponseMessage Management(HttpMethod method, string path, string? body)
    {
        if (ManagementAnswer is { } forced) return new HttpResponseMessage(forced);
        if (method == HttpMethod.Post && path.EndsWith(TokensPath, StringComparison.Ordinal)) return Created(body!);
        if (method == HttpMethod.Get && path.EndsWith(TokensPath, StringComparison.Ordinal)) return Json(HttpStatusCode.OK, Listing);
        if (method == HttpMethod.Put && path.StartsWith(TokensPath + "/", StringComparison.Ordinal) && path.EndsWith("/status", StringComparison.Ordinal))
            return path.Contains("/ott-missing/", StringComparison.Ordinal) ? new HttpResponseMessage(HttpStatusCode.NotFound) : Json(HttpStatusCode.OK, "{}");
        if (method == HttpMethod.Delete && path.StartsWith("/api/users/", StringComparison.Ordinal)) return new HttpResponseMessage(HttpStatusCode.NoContent);
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    /// <summary>Logto echoes the address and stamps the token's times in epoch milliseconds</summary>
    private static HttpResponseMessage Created(string posted)
    {
        using var sent = JsonDocument.Parse(posted);
        var email = sent.RootElement.GetProperty("email").GetString();
        return Json(HttpStatusCode.Created, $$"""{"id":"ott-new","email":"{{email}}","token":"s3cr3t+token/x","status":"active","createdAt":1790000000000,"expiresAt":1790172800000}""");
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };
}

/// <summary>the admin host with a machine app configured (unless told otherwise) and the fake Logto behind the logto-m2m client</summary>
public class AdminInvitationFactory : AdminApiFactory
{
    public FakeLogtoHandler Logto { get; } = new();

    /// <summary>false = an environment that has not run its Bootstrap: no Logto:M2mAppId / Logto:M2mAppSecret written back</summary>
    public bool MachineApp { get; init; } = true;

    public bool InviteOnly { get; init; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        if (MachineApp)
        {
            builder.UseSetting("Logto:M2mAppId", "m2m-app");
            builder.UseSetting("Logto:M2mAppSecret", "m2m-secret");
        }
        builder.UseSetting("Auth:Authority", "https://logto.test/oidc");
        builder.UseSetting("Web:Url", "https://app.test/");
        if (InviteOnly) builder.UseSetting(AdminInvitationEndpoints.InviteOnlyKey, "true");
        builder.ConfigureServices(services =>
            services.AddHttpClient(LogtoManagement.ClientName).ConfigurePrimaryHttpMessageHandler(() => Logto));
    }
}

/// <summary>
/// user 2026-10-07: invitation-only sign-up. The portal's invitations are
/// Logto one-time tokens: minted with a two-day expiry, listed with their
/// magic links, revoked by status — and every way Logto can be missing or
/// refuse the machine app is a 503 that names itself.
/// </summary>
public class AdminInvitationTests : IClassFixture<AdminInvitationFactory>
{
    private const string Route = "/admin/invitations";
    private const string TokensPath = "/api/one-time-tokens";

    private readonly AdminInvitationFactory _factory;

    public AdminInvitationTests(AdminInvitationFactory factory) => _factory = factory;

    private static HttpClient ClientFor(WebApplicationFactory<Program> factory, string sub, string? scope = "admin")
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    private static async Task<JsonElement> BodyOf(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static IConfiguration Settings(params (string Key, string? Value)[] pairs) =>
        new ConfigurationBuilder().AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => p.Value)).Build();

    private static IConfiguration MachineAppSettings() => Settings(
        ("Logto:M2mAppId", "m2m-app"), ("Logto:M2mAppSecret", "m2m-secret"), ("Auth:Authority", "https://logto.test/oidc"));

    private sealed class HandlerFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 7, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task Creating_an_invitation_mints_a_two_day_token_and_hands_back_its_link()
    {
        var response = await ClientFor(_factory, "the-admin").PostAsJsonAsync(Route, new { email = "  New.Person@Example.com " });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await BodyOf(response);
        Assert.Equal("ott-new", body.GetProperty("id").GetString());
        // trimmed and lower-cased: the link's address has to match what the person types at Logto
        Assert.Equal("new.person@example.com", body.GetProperty("email").GetString());
        Assert.Equal("https://app.test/invite?token=s3cr3t%2Btoken%2Fx&email=new.person%40example.com", body.GetProperty("link").GetString());
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1790172800000), body.GetProperty("expiresAt").GetDateTimeOffset());

        var posted = Assert.Single(_factory.Logto.Requests, r => r.Method == HttpMethod.Post && r.Path == TokensPath && r.Body!.Contains("new.person@example.com"));
        var sent = JsonDocument.Parse(posted.Body!).RootElement;
        Assert.Equal("new.person@example.com", sent.GetProperty("email").GetString());
        Assert.Equal(172800, sent.GetProperty("expiresIn").GetInt32());
        Assert.StartsWith("tok-", posted.Bearer);
    }

    [Fact]
    public async Task Listing_shows_the_open_invitations_with_their_links_and_marks_the_ones_past_their_end()
    {
        var response = await ClientFor(_factory, "the-admin").GetAsync(Route);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await BodyOf(response);
        Assert.False(body.GetProperty("inviteOnly").GetBoolean());
        var invitations = body.GetProperty("invitations").EnumerateArray().ToList();
        Assert.Equal(2, invitations.Count);
        Assert.Equal("ott-1", invitations[0].GetProperty("id").GetString());
        Assert.Equal("one@example.com", invitations[0].GetProperty("email").GetString());
        Assert.Equal("active", invitations[0].GetProperty("status").GetString());
        Assert.Equal("https://app.test/invite?token=t1&email=one%40example.com", invitations[0].GetProperty("link").GetString());
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1790000000000), invitations[0].GetProperty("createdAt").GetDateTimeOffset());
        // Logto flips a token to `expired` only when someone tries it; the portal must not offer a dead link as open
        Assert.Equal("expired", invitations[1].GetProperty("status").GetString());

        var listed = _factory.Logto.Requests.Last(r => r.Method == HttpMethod.Get && r.Path == TokensPath);
        Assert.Contains("status=active", listed.Query);
    }

    [Fact]
    public async Task Revoking_puts_the_revoked_status_on_the_token()
    {
        var admin = ClientFor(_factory, "the-admin");
        var response = await admin.DeleteAsync($"{Route}/ott-1");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("ott-1", (await BodyOf(response)).GetProperty("revoked").GetString());
        var put = Assert.Single(_factory.Logto.Requests, r => r.Method == HttpMethod.Put && r.Path == $"{TokensPath}/ott-1/status");
        Assert.Equal("revoked", JsonDocument.Parse(put.Body!).RootElement.GetProperty("status").GetString());

        Assert.Equal(HttpStatusCode.NotFound, (await admin.DeleteAsync($"{Route}/ott-missing")).StatusCode);
        // the group's route guard: an id that is not id-shaped never reaches Logto
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.DeleteAsync($"{Route}/not%20an%20id")).StatusCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-an-address")]
    [InlineData("two words@example.com")]
    [InlineData("Ann Example <ann@example.com>")]
    public async Task An_address_that_is_not_one_is_refused_before_Logto_is_asked(string email)
    {
        var before = _factory.Logto.Requests.Count(r => r.Method == HttpMethod.Post);
        var response = await ClientFor(_factory, "the-admin").PostAsJsonAsync(Route, new { email });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(before, _factory.Logto.Requests.Count(r => r.Method == HttpMethod.Post));
    }

    [Fact]
    public async Task An_address_over_254_characters_is_refused()
    {
        var response = await ClientFor(_factory, "the-admin").PostAsJsonAsync(Route, new { email = new string('a', 250) + "@x.yz" });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Without_a_machine_app_every_route_says_logto_unavailable()
    {
        using var bare = new AdminInvitationFactory { MachineApp = false };
        var admin = ClientFor(bare, "the-admin");
        var answers = new[]
        {
            await admin.GetAsync(Route),
            await admin.PostAsJsonAsync(Route, new { email = "ann@example.com" }),
            await admin.DeleteAsync($"{Route}/ott-1"),
        };
        foreach (var response in answers)
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            Assert.Equal(AdminInvitationEndpoints.ErrorUnavailable, (await BodyOf(response)).GetProperty("error").GetString());
        }
        Assert.Empty(bare.Logto.Requests);
    }

    [Fact]
    public async Task A_Logto_that_refuses_the_machine_app_is_a_named_503_and_a_stale_token_is_forgotten()
    {
        using var refusing = new AdminInvitationFactory();
        var admin = ClientFor(refusing, "the-admin");

        // 403 = the app lacks its Management API role; the token itself was fine and the next call reuses it
        refusing.Logto.ManagementAnswer = HttpStatusCode.Forbidden;
        var forbidden = await admin.GetAsync(Route);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, forbidden.StatusCode);
        Assert.Equal(AdminInvitationEndpoints.ErrorRefused, (await BodyOf(forbidden)).GetProperty("error").GetString());
        Assert.Equal(1, refusing.Logto.TokenMints);

        // 401 = the token is stale: refused now, forgotten, minted afresh on the next call
        refusing.Logto.ManagementAnswer = HttpStatusCode.Unauthorized;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await admin.GetAsync(Route)).StatusCode);
        Assert.Equal(1, refusing.Logto.TokenMints);
        refusing.Logto.ManagementAnswer = null;
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(Route)).StatusCode);
        Assert.Equal(2, refusing.Logto.TokenMints);

        // anything else Logto answers is a 502 carrying its status
        refusing.Logto.ManagementAnswer = HttpStatusCode.InternalServerError;
        var failed = await admin.GetAsync(Route);
        Assert.Equal(HttpStatusCode.BadGateway, failed.StatusCode);
        var failure = await BodyOf(failed);
        Assert.Equal(AdminInvitationEndpoints.ErrorFailed, failure.GetProperty("error").GetString());
        Assert.Equal(500, failure.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task A_token_endpoint_that_refuses_the_app_or_a_Logto_out_of_reach_are_named_503s()
    {
        using var shaky = new AdminInvitationFactory();
        var admin = ClientFor(shaky, "the-admin");

        shaky.Logto.TokenAnswer = HttpStatusCode.Unauthorized;
        var refused = await admin.PostAsJsonAsync(Route, new { email = "ann@example.com" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, refused.StatusCode);
        Assert.Equal(AdminInvitationEndpoints.ErrorRefused, (await BodyOf(refused)).GetProperty("error").GetString());

        shaky.Logto.TokenAnswer = null;
        shaky.Logto.Unreachable = true;
        var away = await admin.GetAsync(Route);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, away.StatusCode);
        Assert.Equal(AdminInvitationEndpoints.ErrorUnavailable, (await BodyOf(away)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Non_admins_are_forbidden()
    {
        var user = ClientFor(_factory, "regular-user", scope: null);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync(Route)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync(Route, new { email = "ann@example.com" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.DeleteAsync($"{Route}/ott-1")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync(Route)).StatusCode);
    }

    [Fact]
    public async Task The_token_is_minted_once_and_reused_across_calls()
    {
        using var fresh = new AdminInvitationFactory();
        var admin = ClientFor(fresh, "the-admin");
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(Route)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await admin.PostAsJsonAsync(Route, new { email = "ann@example.com" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.DeleteAsync($"{Route}/ott-1")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.GetAsync(Route)).StatusCode);
        Assert.Equal(1, fresh.Logto.TokenMints);
        var managementCalls = fresh.Logto.Requests.Where(r => r.Path.StartsWith("/api/", StringComparison.Ordinal)).ToList();
        Assert.Equal(4, managementCalls.Count);
        Assert.All(managementCalls, r => Assert.Equal("tok-1", r.Bearer));
    }

    [Fact]
    public async Task Invite_only_is_read_from_configuration_for_the_portal_and_the_health_handshake()
    {
        using var closed = new AdminInvitationFactory { InviteOnly = true };
        var listing = await BodyOf(await ClientFor(closed, "the-admin").GetAsync(Route));
        Assert.True(listing.GetProperty("inviteOnly").GetBoolean());
        var health = await BodyOf(await closed.CreateClient().GetAsync("/health"));
        Assert.True(health.GetProperty("capabilities").GetProperty("inviteOnly").GetBoolean());

        var open = await BodyOf(await _factory.CreateClient().GetAsync("/health"));
        Assert.False(open.GetProperty("capabilities").GetProperty("inviteOnly").GetBoolean());
    }

    [Fact]
    public async Task The_cached_token_is_minted_again_shortly_before_it_expires()
    {
        var logto = new FakeLogtoHandler { TokenLifetimeSeconds = 300 };
        var clock = new FakeClock();
        var management = new LogtoManagement(new HandlerFactory(logto), MachineAppSettings(), clock);

        var session = await management.ConnectAsync(CancellationToken.None);
        Assert.NotNull(session);
        // the endpoint is the authority without its /oidc
        Assert.Equal("https://logto.test", session.Endpoint);
        Assert.Equal("tok-1", session.AccessToken);

        clock.Now += TimeSpan.FromSeconds(100);
        Assert.Equal("tok-1", (await management.ConnectAsync(CancellationToken.None))!.AccessToken);
        Assert.Equal(1, logto.TokenMints);

        // 60 s of slack: at 250 s a 300 s token is as good as gone
        clock.Now += TimeSpan.FromSeconds(150);
        Assert.Equal("tok-2", (await management.ConnectAsync(CancellationToken.None))!.AccessToken);
        Assert.Equal(2, logto.TokenMints);

        // forgotten = minted afresh even though time has not moved
        management.Forget();
        Assert.Equal("tok-3", (await management.ConnectAsync(CancellationToken.None))!.AccessToken);
    }

    [Fact]
    public async Task No_machine_app_means_no_session_and_no_call()
    {
        var logto = new FakeLogtoHandler();
        var management = new LogtoManagement(new HandlerFactory(logto), Settings(("Auth:Authority", "https://logto.test/oidc")), TimeProvider.System);
        Assert.Null(await management.ConnectAsync(CancellationToken.None));
        Assert.Empty(logto.Requests);
    }

    [Theory]
    [InlineData("https://app.example/", null, null, "https://app.example")]
    [InlineData(null, "https://web.example", "https://api.example", "https://web.example")]
    [InlineData(null, null, "https://api.example/some/path", "https://api.example")]
    [InlineData(null, null, null, "")]
    public void The_link_base_is_the_web_url_then_the_first_cors_origin_then_the_audience(string? webUrl, string? firstOrigin, string? audience, string expected)
    {
        // the infra renders the web app as the first CORS origin (render.mjs corsOrigins); Web:Url is the explicit setting
        var config = Settings(("Web:Url", webUrl), ("Cors:Origins:0", firstOrigin), ("Auth:Audience", audience));
        Assert.Equal(expected, AdminInvitationEndpoints.WebUrl(config));
    }
}
