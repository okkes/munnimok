using Connector.Kit.Agent.Browsing;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests.Browsing;

// real Chromium on purpose: a fake agrees with what we assumed, which is how "the profile keeps the session" shipped untrue
// two leases on one profile dir = a connect then a fetch on a household's own agent
public sealed class KeptSessionLiveTests(ITestOutputHelper output) : IDisposable
{
    private const string SessionCookie = "PD-S-SESSION-ID";

    private const string PersistentCookie = "_pk_id";

    // a real https origin, never visited: cookies go in through the browser API, as the jar between launches is under test
    private const string Origin = "https://mijn.duo.nl/";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "connector-kept-session-live", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
                return;
            }
            catch (IOException)
            {
                // Chromium can hold a handle for a moment after teardown.
                Thread.Sleep(200);
            }
        }
    }

    // DUO's session cookies (has_expires=0, is_persistent=0) are not loaded on a fresh launch; persistent ones are
    // also the pooled tier's guarantee, asserted with the carry off: a container must not resurrect a bank session
    [Fact]
    public async Task A_browser_that_may_not_keep_a_session_loses_it_exactly_as_chromium_does()
    {
        await using (var first = Lease(keepsSession: false))
        {
            await SeedAsync(first);
        }

        await using var second = Lease(keepsSession: false);
        var cookies = await CookiesAsync(second);

        Assert.DoesNotContain(cookies, cookie => cookie.Name == SessionCookie);

        Assert.Single(cookies, cookie => cookie.Name == PersistentCookie);
    }

    // the BYO promise: sign in once, the next run is free; the value is asserted as an empty cookie fails the provider's check
    [Fact]
    public async Task A_session_cookie_is_back_in_the_next_browser_on_that_profile()
    {
        await using (var first = Lease(keepsSession: true))
        {
            await SeedAsync(first);
        }

        await using var second = Lease(keepsSession: true);
        var cookies = await CookiesAsync(second);

        var restored = Assert.Single(cookies, cookie => cookie.Name == SessionCookie);
        Assert.Equal("pd-session-value", restored.Value);
        Assert.Equal("mijn.duo.nl", restored.Domain);

        Assert.True(
            KeptSessionStore.IsSessionCookie(restored.Expires),
            "a restored session cookie must not become a persistent one");

        Assert.Single(cookies, cookie => cookie.Name == PersistentCookie);
    }

    // the bound limits how far the browser's rule is broken; zero hands it back, proving the option reaches the browser
    [Fact]
    public async Task A_session_past_its_bound_is_not_put_back()
    {
        await using (var first = Lease(keepsSession: true))
        {
            await SeedAsync(first);
        }

        await using var second = Lease(keepsSession: true, lifetime: TimeSpan.Zero);

        Assert.DoesNotContain(await CookiesAsync(second), cookie => cookie.Name == SessionCookie);
    }

    // Playwright .NET's Expires is a non-nullable float: a session cookie is -1, a persistent one a Unix time in seconds
    [Fact]
    public async Task Playwright_reports_a_session_cookie_as_having_no_expiry()
    {
        await using var lease = Lease(keepsSession: false);
        await SeedAsync(lease);

        var cookies = await CookiesAsync(lease);

        var session = Assert.Single(cookies, cookie => cookie.Name == SessionCookie).Expires;
        var persistent = Assert.Single(cookies, cookie => cookie.Name == PersistentCookie).Expires;

        Assert.Equal(-1f, session);
        Assert.True(persistent > 0, "a persistent cookie carries a Unix time in seconds");

        Assert.True(KeptSessionStore.IsSessionCookie(session));
        Assert.False(KeptSessionStore.IsSessionCookie(persistent));
    }

    private static async Task SeedAsync(BrowserLease lease)
    {
        var page = await lease.PageAsync(CancellationToken.None);

        await page.Context.AddCookiesAsync(
        [
            new Cookie
            {
                Name = SessionCookie,
                Value = "pd-session-value",
                Url = Origin,
                HttpOnly = true,
                Secure = true,

                Expires = null,
            },
            new Cookie
            {
                Name = PersistentCookie,
                Value = "analytics-value",
                Url = Origin,

                // dated from now: a fixed epoch goes stale and Chromium drops the cookie, which reads as "the profile keeps nothing"
                Expires = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeSeconds(),
            },
        ]);
    }

    private static async Task<IReadOnlyList<BrowserContextCookiesResult>> CookiesAsync(BrowserLease lease)
    {
        var page = await lease.PageAsync(CancellationToken.None);
        return await page.Context.CookiesAsync();
    }

    private BrowserLease Lease(bool keepsSession, TimeSpan? lifetime = null)
    {
        var logger = new TestOutputLogger(output);

        return new BrowserLease(
            new BrowserLeaseOptions
            {
                Headless = true,
                ProfileDirectory = Path.Combine(_root, "own-agt_test-duo"),
                KeepsSessionAcrossBrowsers = keepsSession,
                KeptSessionLifetime = lifetime ?? TimeSpan.FromHours(12),
            },
            new ScreenshotRedactor(TestRig.Manifest, logger),
            logger);
    }
}
