using Connector.Kit.Agent.Browsing;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Tests.Browsing;

/// <summary>
/// What a browser profile keeps when its browser closes.
///
/// <para>
/// The bug these are written from is a measurement, not a theory. A DUO login
/// on a household's own agent succeeded; a fetch on the same profile
/// twenty-nine seconds later failed <c>session_expired</c>, and the only thing
/// between them was one browser closing and the next opening. Every cookie
/// carrying DUO's session is a SESSION cookie - <c>has_expires=0</c>,
/// <c>is_persistent=0</c> - and Chromium writes those into the profile without
/// loading them again. So the profile kept the analytics and the language
/// preference, threw away the login, and the promise the BYO tier is built on
/// was never true for any provider.
/// </para>
///
/// <para>
/// These cover the store on its own, offline. That a real Chromium loses a
/// session cookie between two launches of the same profile, and that the store
/// puts it back, is asserted against a real browser in
/// <see cref="KeptSessionLiveTests"/> - because both halves of that are claims
/// about what Chromium does, and a fake would simply agree with whatever we
/// assumed.
/// </para>
/// </summary>
public sealed class KeptSessionTests : IDisposable
{
    /// <summary>The bound the agent ships with, so the cases read in its terms.</summary>
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

    /// <summary>
    /// THE ROUND TRIP: what one browser closed holding is what the next is
    /// offered, field for field.
    /// </summary>
    /// <remarks>
    /// Every field is asserted rather than the name alone, because a cookie
    /// that comes back on the wrong domain, without <c>Secure</c>, or with a
    /// <c>SameSite</c> it did not have is a cookie the provider never set - and
    /// it would be sent, or not sent, on requests nobody chose.
    /// </remarks>
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

        // And it goes back as the SESSION cookie it was. An expiry here would
        // make Chromium write it to disk itself and keep it past the bound
        // below, which breaks the browser's rule further than this means to.
        Assert.Null(restored.Expires);
    }

    /// <summary>
    /// AND A PERSISTENT COOKIE IS LEFT TO CHROMIUM, which already keeps it.
    /// </summary>
    /// <remarks>
    /// The profile really does reload these - the DUO capture has
    /// <c>.digid.nl</c>'s locale and <c>.duo.nl</c>'s analytics coming back
    /// perfectly, which is what made the missing login so confusing. Copying
    /// them in here would put a second, older copy of a live cookie beside the
    /// browser's own and let whichever was re-added last win.
    /// </remarks>
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

        // Not merely absent from the restore: never written down at all.
        Assert.DoesNotContain("analytics-value", File.ReadAllText(Store().FilePath), StringComparison.Ordinal);
    }

    /// <summary>
    /// A session cookie is the one with NO EXPIRY, which is what Playwright's
    /// binding reports as a negative one.
    /// </summary>
    /// <remarks>
    /// <c>BrowserContextCookiesResult.Expires</c> is a non-nullable
    /// <see cref="float"/> in the .NET binding, so there is no null to test
    /// and the sentinel is the whole rule. That a real Chromium actually
    /// produces it is asserted in <see cref="KeptSessionLiveTests"/>; this pins
    /// the reading of it, including the case that matters most - an expiry in
    /// the past is a cookie the browser is about to drop, not a session cookie
    /// to resurrect.
    /// </remarks>
    [Theory]
    [InlineData(-1f, true)]
    [InlineData(0f, false)]
    [InlineData(1_774_000_000f, false)]
    public void A_session_cookie_is_the_one_whose_expiry_is_not_set(float expires, bool isSession) =>
        Assert.Equal(isSession, KeptSessionStore.IsSessionCookie(expires));

    /// <summary>
    /// IT LIVES INSIDE THE PROFILE, so wiping the profile wipes the session.
    /// </summary>
    /// <remarks>
    /// <see cref="ProfileStore.WipeAll"/> is what a revoked agent runs, and its
    /// whole point is that no residue of a provider session is left on the
    /// machine. A session file anywhere else would be exactly that residue,
    /// and nobody would be left to delete it.
    /// </remarks>
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

    /// <summary>
    /// A TORN OR MISSING FILE IS A SIGN-IN, never a failed job.
    /// </summary>
    /// <remarks>
    /// The write is whole-then-move precisely so this should not happen, but
    /// "should not" is not a reason to throw out of a browser launch: the
    /// adapter is about to ask the provider whether it is signed in, and "no"
    /// is an answer the whole platform already knows how to act on.
    /// </remarks>
    [Theory]
    [InlineData("")]
    [InlineData("{\"cookies\":[")]
    [InlineData("{\"kept_at\":\"2026-09-20T19:44:45+00:00\",\"cookies\":[{\"value\":\"orphan\"}]}")]
    public void A_file_that_cannot_be_read_is_survived(string torn)
    {
        File.WriteAllText(Path.Combine(_profile, KeptSessionStore.FileName), torn);

        Assert.Empty(Store().Restore(Lifetime, Closed));

        // And it is cleared rather than re-read on every launch for ever.
        Assert.False(File.Exists(Store().FilePath));
    }

    /// <summary>
    /// AND A PROFILE THAT HAS NEVER KEPT ONE DOES NOT REPORT ITSELF AS BROKEN.
    /// </summary>
    /// <remarks>
    /// A first connect has no file, and the catch above would handle that
    /// perfectly well - by warning that this profile's session cannot be read,
    /// in an operator's log, on every first run for ever. The guard earns its
    /// place by keeping the log honest, so the log is what is asserted: there
    /// is nothing wrong with a profile nobody has signed in on yet.
    /// </remarks>
    [Fact]
    public void A_profile_that_has_never_kept_a_session_offers_nothing_and_says_nothing()
    {
        var log = new RecordingLogger();

        Assert.Empty(new KeptSessionStore(_profile, log).Restore(Lifetime, Closed));

        Assert.False(File.Exists(Store().FilePath));
        Assert.Empty(log.Warnings);
    }

    /// <summary>
    /// A SESSION DOES NOT OUTLIVE WHAT IT IS WORTH.
    /// </summary>
    /// <remarks>
    /// The browser's rule is that a session cookie dies with the browser, and
    /// this breaks it deliberately - so how far is a decision, and it is the
    /// agent's <c>KeptSessionLifetime</c>. A cookie offered back a week later
    /// is dead weight the provider rejects anyway, and a live bank session
    /// sitting in a file across a weekend is exposure nobody asked for.
    /// </remarks>
    [Fact]
    public void A_session_older_than_the_bound_is_dropped_rather_than_offered()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        // On the bound it is still offered; a second past it, it is not.
        Assert.Single(Store().Restore(Lifetime, Closed + Lifetime));

        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.Empty(Store().Restore(Lifetime, Closed + Lifetime + TimeSpan.FromSeconds(1)));
        Assert.False(File.Exists(Store().FilePath));
    }

    /// <summary>
    /// AND ZERO HANDS THE BROWSER'S OWN RULE BACK, which is what makes the
    /// bound an option rather than a constant worth arguing about.
    /// </summary>
    [Fact]
    public void Turning_the_lifetime_off_keeps_nothing_and_leaves_nothing()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Assert.Empty(Store().Restore(TimeSpan.Zero, Closed));
        Assert.False(File.Exists(Store().FilePath));
    }

    /// <summary>
    /// A BROWSER THAT CLOSED SIGNED OUT FORGETS, which is the case that would
    /// otherwise do real harm.
    /// </summary>
    /// <remarks>
    /// A logout job ends with the provider's cookies cleared, and that browser
    /// closes holding no session cookie for it. Leaving the last file in place
    /// would offer them back on the next launch and resurrect a session the
    /// account holder had just ended. The opposite mistake - a run that never
    /// reached the provider clearing a session that was still good - costs one
    /// sign-in, which is the cheaper way to be wrong.
    /// </remarks>
    [Fact]
    public void A_signed_out_browser_clears_the_session_it_was_keeping()
    {
        Store().Keep([Session("PD-S-SESSION-ID", "pd-session-value")], Closed);

        Store().Keep([Persistent("_pk_id", "analytics-value")], Closed + TimeSpan.FromMinutes(1));

        Assert.Empty(Store().Restore(Lifetime, Closed + TimeSpan.FromMinutes(1)));
        Assert.False(File.Exists(Store().FilePath));
    }

    /// <summary>
    /// THE FILE SAYS WHAT IT HOLDS, and nothing is left beside it.
    /// </summary>
    /// <remarks>
    /// The person most likely to open one is looking through a profile
    /// directory wondering what is safe to copy, and the answer is nothing - so
    /// the file says so in itself rather than only in this repository. The
    /// leftover check is the whole-then-move made visible: the bytes are
    /// written to a temp file and moved, because a write that tears is a
    /// session lost, and a <c>.tmp</c> still sitting there afterwards would
    /// mean the move never happened.
    /// </remarks>
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

    // ── the part of a session that is worth keeping ──────────────────────

    /// <summary>
    /// AN IDENTITY PROVIDER'S SESSION IS NEITHER KEPT NOR OFFERED BACK, when
    /// the provider says it is not worth keeping - and the provider's own is,
    /// which is the half that must not break.
    /// </summary>
    /// <remarks>
    /// Written from four connects on the owner's live DUO account on
    /// 2026-09-28, twice on the operator's fleet and twice on their own machine.
    /// On the fleet - which keeps no profile at all, so its browser reached
    /// login.digid.nl holding nothing - the typed DigiD sign-in completed both
    /// times with no notes. On their own machine it did not: it fell back to the
    /// streamed hand-over and they drove DigiD's "Hoe wilt u inloggen?" chooser
    /// by hand. Their profile's kept session held five cookies of DigiD's,
    /// DIGID_SAML_SESSION among them.
    /// <para>
    /// And DUO's SAML request carries ForceAuthn=true, so DigiD
    /// re-authenticates the human every time whatever session anybody holds:
    /// that restored session could not have saved one authentication, by the
    /// provider's own design, while it demonstrably changed the page the typed
    /// sign-in met.
    /// </para>
    /// <para>
    /// DUO's own four session cookies stay, and that is not a detail. They are
    /// what makes "this profile was still inside DUO, so nothing was asked of
    /// you" work - seen twice by the owner on the same day - which is the whole
    /// reason a browser profile on somebody's own machine is worth keeping.
    /// </para>
    /// </remarks>
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

        // NOT MERELY ABSENT FROM THE RESTORE: never written down at all. A live
        // DigiD session sitting in a file on somebody's disk is exposure that
        // buys nothing, and this file's own note says whoever holds these
        // cookies is signed in as its owner.
        var text = File.ReadAllText(Store().FilePath);
        Assert.DoesNotContain("saml-session-value", text, StringComparison.Ordinal);
        Assert.DoesNotContain("f5-session-value", text, StringComparison.Ordinal);
        Assert.Contains("duo-session-value", text, StringComparison.Ordinal);
    }

    /// <summary>
    /// AND A PROVIDER THAT NAMES NOTHING KEEPS EVERYTHING, exactly as every
    /// provider did before this rule existed.
    /// </summary>
    /// <remarks>
    /// The default has to be today's behaviour rather than a judgment about
    /// which host looks like an identity provider, because the kit cannot make
    /// that judgment: <c>login.digid.nl</c> is an identity provider to a
    /// manifest and a hostname to a browser. Only the adapter that read DUO's
    /// SAML request knows the session there is worthless.
    /// </remarks>
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

        // Said twice on purpose: the emptiness IS the rule, so the predicate is
        // pinned as well as the store that uses it.
        Assert.False(KeptSessionStore.IsDropped(Digid, []));
    }

    /// <summary>
    /// AND A SESSION KEPT BEFORE THE RULE EXISTED IS FILTERED ON THE WAY BACK
    /// OUT, which is the only reason the offer is filtered at all.
    /// </summary>
    /// <remarks>
    /// The profile that produced the evidence for this change already has a
    /// file with DigiD's session in it, written at 10:54 on 2026-09-28. Filtering
    /// only on the way in would hand it back one more time on the very next
    /// connect - the run that is meant to settle whether dropping it fixes the
    /// typed sign-in - so the owner would have to delete a file by hand for
    /// their own machine to test the fix. The stale entries leave the disk when
    /// that browser closes and <c>Keep</c> rewrites the file wholesale.
    /// </remarks>
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

    /// <summary>
    /// A NAMED HOST COVERS ITSELF AND WHAT IS UNDER IT, in both the spellings a
    /// browser writes, and NOT the domain above it.
    /// </summary>
    /// <remarks>
    /// Both spellings appear because the owner's profile held DigiD's session as
    /// both at once: <c>login.digid.nl/DIGID_SAML_SESSION</c> host-only and
    /// <c>.login.digid.nl/TS01ab71c3</c> as a domain cookie. A rule matching one
    /// of them would have carried the other forward and left the change looking
    /// as though it worked.
    /// <para>
    /// The parent is deliberately left alone. Cookie scoping says a
    /// <c>.digid.nl</c> cookie would also be presented at
    /// <c>login.digid.nl</c>, so dropping it would be defensible arithmetic -
    /// but it would drop it for every other host under <c>digid.nl</c> too, and
    /// a provider whose portal and identity provider shared a registrable
    /// domain would lose its own session to that. DUO does not, and a rule whose
    /// safety rests on that accident is the wrong rule. Every DigiD cookie in
    /// the profile read on 2026-09-28 was on the named host or under it.
    /// </para>
    /// <para>
    /// <c>notlogin.digid.nl</c> is the case that pins the dot: it ends with the
    /// named host and is a different site.
    /// </para>
    /// </remarks>
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

    /// <summary>DigiD's own host, as DUO's manifest names it.</summary>
    private const string Digid = "login.digid.nl";

    private KeptSessionStore Store() => new(_profile, NullLogger.Instance);

    /// <summary>
    /// The same store, told which hosts this provider says are not worth
    /// keeping.
    /// </summary>
    private KeptSessionStore Dropping(params string[] hosts) =>
        new(_profile, NullLogger.Instance, hosts);

    /// <summary>
    /// A cookie shaped like DUO's: no expiry, which is what the browser throws
    /// away.
    /// </summary>
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

    /// <summary>
    /// One of DigiD's, on the host DUO's manifest names - or on the dotted
    /// spelling of it, which the owner's profile held at the same time.
    /// </summary>
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

    /// <summary>One the profile already reloads by itself - DUO's analytics.</summary>
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

    /// <summary>
    /// A logger that keeps what it was warned about, because one of the claims
    /// here is about what is NOT said.
    /// </summary>
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
