using System.Net;
using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Security;
using ShopConnector.Adapters.LidlPlus;
using ShopConnector.Adapters.Tests.Support;
using Xunit;

namespace ShopConnector.Adapters.Tests;

// tests the token LOOP: material out of one fetch goes into the next, against an upstream that retires what it rotates;
// Lidl is only the vehicle: refresh, retry and carry-forward live in BearerSession, shared by every T1 adapter
public sealed class RefreshLoopTests
{
    private static readonly DateTimeOffset Day0 = new(2026, 7, 26, 9, 0, 0, TimeSpan.Zero);

    /// <summary>Wide enough that the clock moving a month never changes which receipts are in scope.</summary>
    private static readonly DateOnly Since = new(2026, 1, 1);

    private static readonly IReadOnlyDictionary<string, string> DutchConfig =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["country"] = "NL", ["language"] = "nl" };

    [Fact]
    public async Task An_expired_access_token_refreshes_silently_and_hands_back_material_to_persist()
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock);

        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(-30));

        var handler = new StubHttpHandler(upstream.Route);
        using var ctx = Context(handler, stored);

        var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

        Assert.NotEmpty(result.Receipts);
        Assert.Empty(ctx.Asked);
        Assert.False(ctx.Browser.Started);

        Assert.Equal(1, upstream.TokenCalls);

        var rotated = Assert.IsType<SessionMaterial>(result.RefreshedMaterial);
        Assert.Equal(upstream.AccessToken, rotated.AccessToken);
        Assert.Equal(upstream.RefreshToken, rotated.RefreshToken);
        Assert.NotEqual(stored.AccessToken, rotated.AccessToken);

        // A minute short of the hour the server promised: a token that expires
        // in flight costs a wasted round trip and an avoidable 401.
        Assert.Equal(clock.GetUtcNow().AddSeconds(3600 - 60), rotated.AccessTokenExpiresAt);

        // non-token fields survive rotation: losing the country would send the next fetch to another Lidl deployment
        Assert.Equal("NL", rotated.Extra["country"]);
        Assert.Equal("fixture-device", rotated.DeviceId);
    }

    [Fact]
    public async Task The_rotated_material_serves_the_next_fetch_and_the_one_it_replaced_is_dead()
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock);

        var first = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(-1));
        var superseded = first;

        SessionMaterial second;
        using (var ctx = Context(new StubHttpHandler(upstream.Route), first))
        {
            var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);
            second = Assert.IsType<SessionMaterial>(result.RefreshedMaterial);
        }

        Assert.NotEqual(superseded.RefreshToken, second.RefreshToken);

        clock.Advance(TimeSpan.FromDays(1));
        using (var ctx = Context(new StubHttpHandler(upstream.Route), second))
        {
            var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

            Assert.NotEmpty(result.Receipts);
            Assert.Empty(ctx.Asked);
            Assert.NotNull(result.RefreshedMaterial);
        }

        // the replaced bundle is spent: a client persisting the OLD refresh token looks fine for an hour, then is locked out
        clock.Advance(TimeSpan.FromDays(1));
        using (var ctx = Context(new StubHttpHandler(upstream.Route), superseded))
        {
            var dead = await Assert.ThrowsAsync<ConnectorException>(
                () => Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None));

            Assert.Equal(ErrorCode.SessionExpired, dead.Code);
        }

        Assert.Contains(superseded.RefreshToken!, upstream.Retired);
    }

    [Fact]
    public async Task A_fetch_that_rotated_nothing_reports_no_material_and_leaves_the_stored_bundle_current()
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock);

        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(30));

        using (var ctx = Context(new StubHttpHandler(upstream.Route), stored))
        {
            var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

            Assert.NotEmpty(result.Receipts);

            // null is the whole signal: the control plane seals a new bundle only when this is non-null
            Assert.Null(result.RefreshedMaterial);
            Assert.Equal(0, upstream.TokenCalls);
        }

        clock.Advance(TimeSpan.FromMinutes(5));
        using (var ctx = Context(new StubHttpHandler(upstream.Route), stored))
        {
            var again = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

            Assert.NotEmpty(again.Receipts);
            Assert.Null(again.RefreshedMaterial);
        }
    }

    [Fact]
    public async Task A_dead_refresh_token_is_session_expired_after_exactly_one_attempt()
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock);

        // revoked upstream ("sign out everywhere"): the one thing refreshing cannot recover from
        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(-1));
        upstream.Revoke();

        var handler = new StubHttpHandler(upstream.Route);
        using var ctx = Context(handler, stored);

        var failure = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, failure.Code);
        Assert.Equal(UserAction.Reauth, ErrorCatalog.ActionFor(failure.Code));
        Assert.False(ErrorCatalog.IsRetriable(failure.Code));
        Assert.Contains(failure.Code, ErrorCatalog.NeverRetry);

        // once: re-presenting a refused refresh token makes a provider treat the client as hostile and lock the account
        Assert.Equal(1, upstream.TokenCalls);
        Assert.Equal(0, upstream.TicketCalls);
    }

    [Fact]
    public async Task A_401_on_a_live_looking_token_refreshes_once_and_gives_up_once()
    {
        var clock = new MovingClock(Day0);

        // looks live to us (30 min left) yet refused upstream with the refresh grant gone:
        // how a revocation looks to the expiry clock
        var upstream = new TokenServer(clock);
        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(30));
        upstream.Revoke();

        var handler = new StubHttpHandler(upstream.Route);
        using var ctx = Context(handler, stored);

        var failure = await Assert.ThrowsAsync<ConnectorException>(
            () => Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None));

        Assert.Equal(ErrorCode.SessionExpired, failure.Code);

        // one rejected call, one refresh attempt: no page-by-page storm across the twenty pages the walk allows
        Assert.Equal(1, upstream.TicketCalls);
        Assert.Equal(1, upstream.TokenCalls);
    }

    /// a refresh that says nothing about the refresh token means "the old one stands"; persisting the absence turns a
    /// permanent connection into a one-hour one that only fails when the next access token expires
    [Theory]
    [InlineData(RefreshReissue.Absent)]
    [InlineData(RefreshReissue.Null)]
    [InlineData(RefreshReissue.Blank)]
    [InlineData(RefreshReissue.Whitespace)]
    public async Task A_refresh_that_reissues_nothing_carries_the_stored_refresh_token_forward(RefreshReissue reissue)
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock) { Reissue = reissue };

        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddMinutes(-1));
        var original = stored.RefreshToken;

        SessionMaterial rotated;
        using (var ctx = Context(new StubHttpHandler(upstream.Route), stored))
        {
            var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);
            rotated = Assert.IsType<SessionMaterial>(result.RefreshedMaterial);
        }

        Assert.NotEqual(stored.AccessToken, rotated.AccessToken);
        Assert.Equal(original, rotated.RefreshToken);

        clock.Advance(TimeSpan.FromDays(30));
        using (var ctx = Context(new StubHttpHandler(upstream.Route), rotated))
        {
            var later = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

            Assert.NotEmpty(later.Receipts);
            Assert.Empty(ctx.Asked);
        }
    }

    [Fact]
    public async Task A_month_of_daily_fetches_never_asks_the_human_to_sign_in_again()
    {
        var clock = new MovingClock(Day0);
        var upstream = new TokenServer(clock);

        var stored = Material(upstream.AccessToken, upstream.RefreshToken, clock.GetUtcNow().AddSeconds(3600 - 60));

        var rotations = 0;

        for (var day = 1; day <= 30; day++)
        {
            clock.Advance(TimeSpan.FromDays(1));

            using var ctx = Context(new StubHttpHandler(upstream.Route), stored);
            var result = await Adapter(clock).FetchAsync(ctx, Requests.Receipts(since: Since), CancellationToken.None);

            Assert.NotEmpty(result.Receipts);

            Assert.Empty(ctx.Asked);
            Assert.False(ctx.Browser.Started);
            Assert.False(ctx.CredentialWasSubmitted);

            if (result.RefreshedMaterial is { } fresh)
            {
                stored = fresh;
                rotations++;
            }
        }

        Assert.Equal(30, rotations);
        Assert.Equal(30, upstream.TokenCalls);

        Assert.Equal(upstream.RefreshToken, stored.RefreshToken);
        Assert.Equal(30, upstream.Retired.Count);
        Assert.DoesNotContain(stored.RefreshToken!, upstream.Retired);
    }

    private static LidlPlusAdapter Adapter(TimeProvider clock) => new(new LidlPlusOptions(), clock);

    private static FakeJobContext Context(HttpMessageHandler handler, SessionMaterial material) =>
        new(handler) { Config = DutchConfig, Material = material };

    /// the device id and country ride along: a rotation that keeps only the tokens silently drops them
    private static SessionMaterial Material(string access, string? refresh, DateTimeOffset expiresAt) => new()
    {
        AccessToken = access,
        RefreshToken = refresh,
        AccessTokenExpiresAt = expiresAt,
        DeviceId = "fixture-device",
        Extra = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["country"] = "NL",
            ["language"] = "nl",
        },
    };
}

public enum RefreshReissue
{
    Rotate,

    Absent,

    Null,

    Blank,

    Whitespace,
}

/// a stub accepting any refresh token proves nothing about rotation: this one retires what it rotates
/// and refuses a retired grant with the real endpoint's 400
internal sealed class TokenServer
{
    private readonly TimeProvider _clock;
    private readonly List<string> _retired = [];
    private int _generation;

    public TokenServer(TimeProvider clock)
    {
        _clock = clock;
        AccessToken = "access-0";
        RefreshToken = "refresh-0";
    }

    public string AccessToken { get; private set; }

    public string RefreshToken { get; private set; }

    public RefreshReissue Reissue { get; init; } = RefreshReissue.Rotate;

    public int AccessTokenSeconds { get; init; } = 3600;

    public int TokenCalls { get; private set; }

    public int TicketCalls { get; private set; }

    public IReadOnlyList<string> Retired => _retired;

    public void Revoke()
    {
        _retired.Add(RefreshToken);
        AccessToken = "access-revoked";
        RefreshToken = "refresh-revoked";
    }

    public HttpResponseMessage Route(RecordedRequest request, int _)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.Path.EndsWith("/connect/token", StringComparison.Ordinal)) return Token(request);

        TicketCalls++;

        if (!string.Equals(request.Header("Authorization"), $"Bearer {AccessToken}", StringComparison.Ordinal))
        {
            return Stub.Status(HttpStatusCode.Unauthorized);
        }

        if (request.Path.StartsWith("/api/v3/", StringComparison.Ordinal)) return Stub.Fixture("lidl/ticket-detail.json");

        return request.Query.Contains("pageNumber=1", StringComparison.Ordinal)
            ? Stub.Fixture("lidl/tickets-page-1.json")
            : Stub.Fixture("lidl/tickets-page-2.json");
    }

    private HttpResponseMessage Token(RecordedRequest request)
    {
        TokenCalls++;

        var presented = FormValue(request.Body, "refresh_token");

        // a retired or empty grant gets the real 400, not "unauthorized": a client that dropped its refresh token presents nothing
        if (string.IsNullOrWhiteSpace(presented) || !string.Equals(presented, RefreshToken, StringComparison.Ordinal))
        {
            return Stub.Json("""{"error":"invalid_grant"}""", HttpStatusCode.BadRequest);
        }

        _generation++;
        AccessToken = $"access-{_generation}";

        var body = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["access_token"] = AccessToken,
            ["token_type"] = "Bearer",
            ["expires_in"] = AccessTokenSeconds,
        };

        switch (Reissue)
        {
            case RefreshReissue.Rotate:
                _retired.Add(RefreshToken);
                RefreshToken = $"refresh-{_generation}";
                body["refresh_token"] = RefreshToken;
                break;

            case RefreshReissue.Null:
                body["refresh_token"] = null;
                break;

            case RefreshReissue.Blank:
                body["refresh_token"] = string.Empty;
                break;

            case RefreshReissue.Whitespace:
                body["refresh_token"] = "   ";
                break;

            case RefreshReissue.Absent:
            default:
                break;
        }

        // Referenced so the clock is a real dependency rather than decoration:
        // the expiry the adapter computes is relative to it, not to wall time.
        _ = _clock.GetUtcNow();

        return Stub.Json(JsonSerializer.Serialize(body));
    }

    private static string? FormValue(string? body, string key)
    {
        if (body is null) return null;

        foreach (var pair in body.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0) continue;
            if (!pair.AsSpan(0, separator).SequenceEqual(key)) continue;

            return Uri.UnescapeDataString(pair[(separator + 1)..].Replace('+', ' '));
        }

        return null;
    }
}

/// FixedTimeProvider cannot express an hour passing between fetches;
/// only GetUtcNow is overridden so nothing depends on a fake timer
internal sealed class MovingClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}
