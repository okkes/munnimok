using Connector.Kit.Agent.Browsing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tests.Browsing;

// a DUO fetch on the same profile 29 s after a login failed session_expired: its session cookies have no expiry
// and Chromium writes them without reloading; the real-Chromium half is in KeptSessionLiveTests
public sealed class KeptSessionTests : IDisposable
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    private static readonly DateTimeOffset Closed = new(2026, 9, 20, 19, 44, 45, TimeSpan.Zero);

    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "connector-kept-session", Guid.NewGuid().ToString("N"));

    private readonly string _profile;

    public KeptSessionTests()
    {
        _profile = Path.Combine(_root, "own-agt_test-duo");
        Directory.CreateDirectory(_profile);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A temp directory the OS is still holding is not a test failure.
        }
    }

    // every field asserted: a cookie on the wrong domain, without Secure or with another SameSite is one the provider never set
    [Fact]
    public void A_session_cookie_one_browser_made_is_offered_to_the_next()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        var restored = Assert.Single(Store().Restore(Lifetime, Closed + TimeSpan.FromSeconds(29)));

        Assert.Equal("PD-S-SESSION-ID", restored.Name);
        Assert.Equal("pd-session-value", restored.Value);
        Assert.Equal("mijn.duo.nl", restored.Domain);
        Assert.Equal("/", restored.Path);
        Assert.True(restored.HttpOnly);
        Assert.True(restored.Secure);
        Assert.Equal(SameSiteAttribute.Lax, restored.SameSite);

        // restored as a session cookie: an expiry would make Chromium persist it itself and keep it past the bound
        Assert.Null(restored.Expires);
    }

    // persistent cookies are left to Chromium: copying them would put a stale second copy beside the browser's own
    [Fact]
    public void A_persistent_cookie_is_left_to_the_browser_that_already_keeps_it()
    {
        Store().Keep(
            [
                Session("AMWEBJCT!%2Fisam!JSESSIONID", "jsession-value"),
                Persistent("_pk_id", "analytics-value"),
            ],
            Closed);

        var restored = Assert.Single(Store().Restore(Lifetime, Closed));
        Assert.Equal("AMWEBJCT!%2Fisam!JSESSIONID", restored.Name);

        Assert.DoesNotContain("analytics-value", File.ReadAllText(Store().FilePath), StringComparison.Ordinal);
    }

    // Expires is a non-nullable float, so -1 is the sentinel; a past expiry is a cookie about to be dropped, not a session
    [Theory]
    [InlineData(-1f, true)]
    [InlineData(0f, false)]
    [InlineData(1_774_000_000f, false)]
    public void A_session_cookie_is_the_one_whose_expiry_is_not_set(float expires, bool isSession) =>
        Assert.Equal(isSession, KeptSessionStore.IsSessionCookie(expires));

    // lives inside the profile so WipeAll (a revoked agent) leaves no residue of a provider session
    [Fact]
    public void A_wiped_profile_carries_no_session()
    {
        var profiles = new ProfileStore(Path.Combine(_root, "profiles"), NullLogger<ProfileStore>.Instance);
        var directory = profiles.DirectoryFor("own-agt_test-duo", "duo");

        var store = new KeptSessionStore(directory, NullLogger.Instance);
        store.Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.StartsWith(directory, store.FilePath, StringComparison.Ordinal);
        Assert.Single(store.Restore(Lifetime, Closed));

        profiles.WipeAll();

        Assert.False(File.Exists(store.FilePath));
        Assert.Empty(store.Restore(Lifetime, Closed));
    }

    // a torn or missing file is a sign-in, never a failed job: "not signed in" is an answer the platform already handles
    [Theory]
    [InlineData("")]
    [InlineData("{\"cookies\":[")]
    [InlineData("{\"kept_at\":\"2026-09-20T19:44:45+00:00\",\"cookies\":[{\"value\":\"orphan\"}]}")]
    public void A_file_that_cannot_be_read_is_survived(string torn)
    {
        File.WriteAllText(Path.Combine(_profile, KeptSessionStore.FileName), torn);

        Assert.Empty(Store().Restore(Lifetime, Closed));

        Assert.False(File.Exists(Store().FilePath));
    }

    // a first connect has no file and must not log a warning: a profile nobody signed in on is not broken
    [Fact]
    public void A_profile_that_has_never_kept_a_session_offers_nothing_and_says_nothing()
    {
        var log = new RecordingLogger();

        Assert.Empty(new KeptSessionStore(_profile, log).Restore(Lifetime, Closed));

        Assert.False(File.Exists(Store().FilePath));
        Assert.Empty(log.Warnings);
    }

    // the browser's rule is broken only up to KeptSessionLifetime: an old cookie is rejected anyway and is exposure on disk
    [Fact]
    public void A_session_older_than_the_bound_is_dropped_rather_than_offered()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.Single(Store().Restore(Lifetime, Closed + Lifetime));

        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.Empty(Store().Restore(Lifetime, Closed + Lifetime + TimeSpan.FromSeconds(1)));
        Assert.False(File.Exists(Store().FilePath));
    }

    [Fact]
    public void Turning_the_lifetime_off_keeps_nothing_and_leaves_nothing()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.Empty(Store().Restore(TimeSpan.Zero, Closed));
        Assert.False(File.Exists(Store().FilePath));
    }

    // a signed-out browser clears the kept session, or the old file would resurrect it; a wrongly cleared one costs one sign-in
    [Fact]
    public void A_signed_out_browser_clears_the_session_it_was_keeping()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Store().Keep([Persistent("_pk_id", "analytics-value")], Closed + TimeSpan.FromMinutes(1));

        Assert.Empty(Store().Restore(Lifetime, Closed + TimeSpan.FromMinutes(1)));
        Assert.False(File.Exists(Store().FilePath));
    }

    // the file says it holds a live session (whoever holds it is signed in as its owner); written to temp, then moved whole
    [Fact]
    public void The_file_announces_itself_and_is_moved_into_place_whole()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        var text = File.ReadAllText(Store().FilePath);
        Assert.Contains("\"note\"", text, StringComparison.Ordinal);
        Assert.Contains("signed in as its owner", text, StringComparison.Ordinal);

        Assert.Equal(
            [KeptSessionStore.FileName],
            Directory.EnumerateFiles(_profile).Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }

    // DigiD's session is dropped: DUO's SAML request carries ForceAuthn=true, so DigiD re-authenticates anyway
    // DUO's own session cookies stay: they make "still inside DUO, nothing asked" work, the point of keeping a profile
    [Fact]
    public void An_identity_providers_session_is_neither_written_down_nor_offered_back()
    {
        Dropping(Digid).Keep(
            [
                Session("PD-S-SESSION-ID", "duo-session-value"),
                Identity("DIGID_SAML_SESSION", "saml-session-value", Digid),
                Identity("TS01ab71c3", "f5-session-value", "." + Digid),
            ],
            Closed);

        var restored = Assert.Single(Dropping(Digid).Restore(Lifetime, Closed));

        Assert.Equal("PD-S-SESSION-ID", restored.Name);
        Assert.Equal("mijn.duo.nl", restored.Domain);

        // never written down at all: a live DigiD session on disk buys nothing
        var text = File.ReadAllText(Store().FilePath);
        Assert.DoesNotContain("saml-session-value", text, StringComparison.Ordinal);
        Assert.DoesNotContain("f5-session-value", text, StringComparison.Ordinal);
        Assert.Contains("duo-session-value", text, StringComparison.Ordinal);
    }

    // the default keeps everything: the kit cannot tell an identity provider from a hostname, only the adapter can
    [Fact]
    public void A_provider_that_names_nothing_keeps_the_whole_session()
    {
        Store().Keep(
            [
                Session("PD-S-SESSION-ID", "duo-session-value"),
                Identity("DIGID_SAML_SESSION", "saml-session-value", Digid),
            ],
            Closed);

        Assert.Equal(
            ["PD-S-SESSION-ID", "DIGID_SAML_SESSION"],
            Store().Restore(Lifetime, Closed).Select(c => c.Name));

        // pinned as well: the emptiness IS the rule
        Assert.False(KeptSessionStore.IsDropped(Digid, []));
    }

    // filtered on the way out too: a file written before the rule would hand DigiD's session back once more
    [Fact]
    public void A_session_kept_before_the_rule_existed_is_dropped_when_it_is_offered_back()
    {
        Store().Keep(
            [
                Session("PD-S-SESSION-ID", "duo-session-value"),
                Identity("DIGID_SAML_SESSION", "saml-session-value", Digid),
            ],
            Closed);

        var restored = Assert.Single(Dropping(Digid).Restore(Lifetime, Closed));

        Assert.Equal("PD-S-SESSION-ID", restored.Name);
    }

    // both spellings (host-only login.digid.nl, domain .login.digid.nl) were in the profile: matching one carries the other
    // the parent digid.nl is left alone: dropping it would hit every host under it; notlogin.digid.nl pins the dot
    [Theory]
    [InlineData("login.digid.nl", true)]
    [InlineData(".login.digid.nl", true)]
    [InlineData("sso.login.digid.nl", true)]
    [InlineData("digid.nl", false)]
    [InlineData(".digid.nl", false)]
    [InlineData("notlogin.digid.nl", false)]
    [InlineData("mijn.duo.nl", false)]
    public void A_named_host_covers_itself_and_what_is_under_it(string domain, bool dropped) =>
        Assert.Equal(dropped, KeptSessionStore.IsDropped(domain, [Digid]));

    private const string Digid = "login.digid.nl";

    private KeptSessionStore Store() => new(_profile, NullLogger.Instance);

    private KeptSessionStore Dropping(params string[] hosts) =>
        new(_profile, NullLogger.Instance, hosts);

    private static BrowserContextCookiesResult Session(string name, string value) => new()
    {
        Name = name,
        Value = value,
        Domain = "mijn.duo.nl",
        Path = "/",
        Expires = -1,
        HttpOnly = true,
        Secure = true,
        SameSite = SameSiteAttribute.Lax,
    };

    private static BrowserContextCookiesResult Identity(string name, string value, string domain) => new()
    {
        Name = name,
        Value = value,
        Domain = domain,
        Path = "/",
        Expires = -1,
        HttpOnly = true,
        Secure = true,
        SameSite = SameSiteAttribute.None,
    };

    private static BrowserContextCookiesResult Persistent(string name, string value) => new()
    {
        Name = name,
        Value = value,
        Domain = ".duo.nl",
        Path = "/",
        Expires = 1_774_000_000,
        HttpOnly = false,
        Secure = false,
        SameSite = SameSiteAttribute.Lax,
    };

    private sealed class RecordingLogger : ILogger
    {
        private readonly List<string> _warnings = [];

        public IReadOnlyList<string> Warnings => _warnings;

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel level) => true;

        public void Log<TState>(
            LogLevel level,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);

            if (level >= LogLevel.Warning) _warnings.Add(formatter(state, exception));
        }
    }
}
