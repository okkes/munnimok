using Connector.Kit.Agent.Browsing;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests.Browsing;

/// <summary>
/// Whether a session survives a browser, against a REAL Chromium driven
/// through a real <see cref="BrowserLease"/>.
///
/// <para>
/// It has to be real, because every claim here is a claim about what Chromium
/// and Playwright actually do with a persistent profile, and a fake would
/// agree with whatever we assumed - which is precisely how this bug shipped.
/// "The profile keeps the session" was assumed for the whole life of the BYO
/// tier and was never once true: the first test below is the measurement that
/// found it, made repeatable.
/// </para>
///
/// <para>
/// Two leases on one profile directory is not an artificial arrangement. It is
/// exactly what a connect followed by a fetch is on a household's own agent -
/// the same profile id, the same agent, one browser closing and the next
/// opening - and the live failure it reproduces happened twenty-nine seconds
/// apart.
/// </para>
/// </summary>
public sealed class KeptSessionLiveTests(ITestOutputHelper output) : IDisposable
{
    private const string SessionCookie = "PD-S-SESSION-ID";

    private const string PersistentCookie = "_pk_id";

    /// <summary>
    /// A real https origin, never visited. Cookies are put in through the
    /// browser's own API rather than by serving a page, because what is under
    /// test is what Chromium does with its jar between two launches - not how
    /// the cookie got into it.
    /// </summary>
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

    /// <summary>
    /// THE MEASUREMENT: a persistent profile loses its session cookie between
    /// two browsers, and keeps the analytics beside it.
    /// </summary>
    /// <remarks>
    /// This is the live DUO failure in one test. The profile's own cookie
    /// database had all four of DUO's session cookies in it -
    /// <c>has_expires=0 is_persistent=0</c> - and Chromium simply does not load
    /// them on a fresh launch; session RESTORE is what would, and Playwright's
    /// persistent context does not do it. The persistent cookie coming back
    /// perfectly in the same breath is what made the bug so hard to see: the
    /// profile was obviously working.
    /// <para>
    /// It is ALSO the pooled tier's guarantee, which is why it is asserted
    /// with the carry turned off rather than by deleting the profile. An agent
    /// that is not somebody's own machine must behave exactly like this - a
    /// container that resurrected a bank session after its browser closed would
    /// be the opposite of what that tier promises.
    /// </para>
    /// </remarks>
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

        // And the one Chromium does keep is still there, which is what made
        // "the profile is fine" so believable while every login was being lost.
        Assert.Single(cookies, cookie => cookie.Name == PersistentCookie);
    }

    /// <summary>
    /// THE FIX: on somebody's own machine the next browser on that profile has
    /// the session back.
    /// </summary>
    /// <remarks>
    /// The whole BYO promise in one assertion - sign in once on your own
    /// machine and the next run is free. The value is asserted as well as the
    /// name because a cookie restored empty is a cookie that fails the
    /// provider's check while looking present to ours.
    /// </remarks>
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

        // Still a session cookie, not one we invented an expiry for.
        Assert.True(
            KeptSessionStore.IsSessionCookie(restored.Expires),
            "a restored session cookie must not become a persistent one");

        // Exactly one of the persistent cookie: Chromium loaded it, and the
        // store did not put a stale second copy in beside it.
        Assert.Single(cookies, cookie => cookie.Name == PersistentCookie);
    }

    /// <summary>
    /// AND A SESSION PAST THE BOUND IS NOT OFFERED BACK, on the live path.
    /// </summary>
    /// <remarks>
    /// The bound is the judgment this change rests on - the browser's rule is
    /// that a session cookie dies with the browser, and breaking it is only
    /// defensible with a limit on how far. Zero is the setting that hands the
    /// browser's rule back, and driving it through the lease proves the option
    /// reaches the browser rather than only the store.
    /// </remarks>
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

    /// <summary>
    /// What Playwright's .NET binding actually reports for an expiry, since
    /// the whole filter rests on reading it correctly.
    /// </summary>
    /// <remarks>
    /// <c>BrowserContextCookiesResult.Expires</c> is a non-nullable
    /// <see cref="float"/>, so there is no null to look for: a session cookie
    /// comes back as <c>-1</c> and a persistent one as a Unix time in seconds.
    /// Guessing either way costs everything - too loose and a cookie the
    /// browser was about to drop gets resurrected, too strict and nothing is
    /// ever kept and this change does nothing at all.
    /// </remarks>
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

        // And the reading the store filters on is the one a live browser
        // produces, rather than a second opinion asserted beside it.
        Assert.True(KeptSessionStore.IsSessionCookie(session));
        Assert.False(KeptSessionStore.IsSessionCookie(persistent));
    }

    /// <summary>
    /// Puts one session cookie and one persistent cookie into this browser's
    /// jar, shaped like the pair the DUO capture actually held.
    /// </summary>
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

                // Left unset, which is what makes it a session cookie and what
                // Chromium then declines to load again.
                Expires = null,
            },
            new Cookie
            {
                Name = PersistentCookie,
                Value = "analytics-value",
                Url = Origin,

                // Dated from NOW rather than written down, because a fixed
                // epoch becomes a date in the past and Chromium drops such a
                // cookie on the way in - which reads as "the profile keeps
                // nothing", the exact claim these tests exist to settle.
                Expires = DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeSeconds(),
            },
        ]);
    }

    private static async Task<IReadOnlyList<BrowserContextCookiesResult>> CookiesAsync(BrowserLease lease)
    {
        var page = await lease.PageAsync(CancellationToken.None);
        return await page.Context.CookiesAsync();
    }

    /// <summary>
    /// A lease on ONE profile directory, so two of them in a row are the same
    /// machine's browser opened twice.
    /// </summary>
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
