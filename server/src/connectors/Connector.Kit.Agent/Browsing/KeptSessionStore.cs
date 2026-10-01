using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

/// <summary>
/// The session cookies a profile's browser was holding when it closed, kept
/// beside the profile so the next browser on it opens still signed in.
///
/// <para>
/// <b>THE PROFILE WAS NEVER THE SESSION</b>, and that is the measurement this
/// exists for. A DUO login through a household's own agent succeeded at
/// 19:44:45; twenty-nine seconds later a fetch on the same session, the same
/// profile id and the same agent failed <c>session_expired</c>, with
/// <c>sessietoken/rest/jwt</c> answered from the sign-in chain rather than
/// from the portal. The only thing that happened between the two jobs is that
/// one browser closed and the next opened. The profile's own cookie database
/// said why: every cookie carrying DUO's session -
/// <c>AMWEBJCT!%2Fisam!JSESSIONID</c>, <c>PD-S-SESSION-ID</c>,
/// <c>PD_STATEFUL_08555070-...</c> - is a SESSION cookie,
/// <c>has_expires=0 is_persistent=0</c>, while the analytics and the language
/// preference beside them are persistent. Chromium writes session cookies into
/// the profile but does not load them on a fresh launch - session RESTORE is
/// what would, and Playwright's persistent context does not do it. So the
/// profile kept the analytics and threw away the login, every job started
/// signed out, and the promise the whole BYO tier is built on - sign in once
/// on your own machine and the next run is free - has never once been true for
/// any provider. It is why ASN's always-on tier could not have worked either.
/// </para>
///
/// <para>
/// <b>ONLY ON THE MACHINE THAT MADE THEM.</b> The gate is
/// <see cref="BrowserLeaseOptions.KeepsSessionAcrossBrowsers"/>, which the job
/// runner sets from the one question the rest of the agent asks - is this
/// somebody's own computer. A pooled agent must never do this: its profiles are
/// wiped between jobs by design, and a datacenter container that resurrected a
/// bank session after the browser closed would be the opposite of what the
/// pooled tier promises.
/// </para>
///
/// <para>
/// <b>Which is not the question <see cref="BrowserLease.StorageStateAsync"/>
/// refuses</b>, although both are about cookies and both say no. That one is
/// about CUSTODY - whether a provider's cookies may be sealed into a bundle
/// and cross the wire to the connector - and it refuses for agent custody
/// wherever the agent happens to run, because the point of that design is that
/// the credential stays in the user's house. Nothing here crosses anything.
/// The cookies are written back into the profile directory they came out of,
/// on the machine that made them, and so the question is not custody but whose
/// machine this is. The two rules agree: cookies stay here, and here is now a
/// place that remembers them.
/// </para>
///
/// <para>
/// <b>AN OFFER, NEVER A CLAIM.</b> Putting a cookie back says nothing about
/// whether the provider still honours it, and nothing here marks a profile
/// healthy, shortens a check or stands in for one. Every persistent adapter
/// asks the provider itself - ASN's <c>SignedInAsync</c>, DUO's session
/// endpoint, which it asks precisely because a landing URL lies - and those
/// questions are as load-bearing after this change as before it. The worst a
/// dead cookie costs is the sign-in that was going to happen anyway.
/// </para>
/// </summary>
internal sealed class KeptSessionStore
{
    /// <summary>
    /// The file, INSIDE the profile it belongs to.
    /// </summary>
    /// <remarks>
    /// So that wiping a profile wipes its session with it and there is no
    /// second place anybody has to remember: <see cref="ProfileStore.WipeAll"/>
    /// deletes profile directories recursively when an agent is revoked, and
    /// the whole point of that sweep is that no residue of a provider session
    /// is left on the machine.
    /// </remarks>
    public const string FileName = "session-cookies.json";

    /// <summary>
    /// Written into the file itself, because the person most likely to open one
    /// is looking through a profile directory wondering what is safe to copy,
    /// and the answer is nothing.
    /// </summary>
    public const string WhatThisIs =
        "live provider sessions for this browser profile: whoever holds these cookies is signed in as its owner. " +
        "They never leave this machine.";

    private readonly ILogger _logger;
    private readonly Lock _writeLock = new();
    private readonly IReadOnlyList<string> _dropFor;

    /// <param name="dropFor">
    /// Hosts whose session this profile must not carry, from the provider's own
    /// manifest. EMPTY IS EVERY PROVIDER THAT SAYS NOTHING and keeps the whole
    /// session, exactly as this store did before the list existed - so the
    /// default here is the behaviour, not merely a convenience for callers.
    /// </param>
    public KeptSessionStore(string profileDirectory, ILogger logger, IReadOnlyList<string>? dropFor = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(profileDirectory);
        ArgumentNullException.ThrowIfNull(logger);

        FilePath = Path.Combine(Path.GetFullPath(profileDirectory), FileName);
        _logger = logger;
        _dropFor = dropFor ?? [];
    }

    public string FilePath { get; }

    /// <summary>
    /// A cookie that dies with the browser, which is the only kind worth
    /// keeping.
    /// </summary>
    /// <remarks>
    /// Playwright's .NET binding types <c>BrowserContextCookiesResult.Expires</c>
    /// as a non-nullable <see cref="float"/> and uses <c>-1</c> for "no expiry
    /// was set", which is exactly what a session cookie is; a persistent one
    /// carries a Unix time in seconds. Asserted against a real Chromium in
    /// <c>KeptSessionLiveTests</c> rather than taken on trust, because a guess
    /// in either direction here keeps nothing or keeps everything.
    /// <para>
    /// Persistent cookies are left to Chromium, which already stores them in
    /// the profile and loads them on the next launch. Copying them in here
    /// would put a second, older copy of a live cookie beside the browser's
    /// own and let whichever we re-added last win.
    /// </para>
    /// </remarks>
    public static bool IsSessionCookie(float expires) => expires < 0;

    /// <summary>
    /// Whether a cookie on <paramref name="domain"/> belongs to one of the
    /// hosts this provider says are not worth keeping.
    /// </summary>
    /// <remarks>
    /// A NAMED HOST COVERS ITSELF AND WHAT IS UNDER IT, and deliberately not
    /// the domain above it. Cookie scoping says a <c>.digid.nl</c> cookie would
    /// also be presented at <c>login.digid.nl</c>, so dropping it would be
    /// defensible arithmetic - but it would also drop it for every other host
    /// under <c>digid.nl</c>, and a provider whose portal and identity provider
    /// share a registrable domain would lose its own session to that. DUO does
    /// not (<c>duo.nl</c> and <c>digid.nl</c> are unrelated) and a rule whose
    /// safety rests on that accident is the wrong rule. Every DigiD cookie in
    /// the profile read on 2026-09-28 was on the named host or under it; a
    /// parent-domain one has never been seen, and if one is, the manifest names
    /// the parent and nothing here changes.
    /// <para>
    /// BOTH SPELLINGS OF A DOMAIN, because the owner's profile held DigiD's
    /// session as both at once: <c>login.digid.nl/DIGID_SAML_SESSION</c>
    /// host-only, and <c>.login.digid.nl/TS01ab71c3</c> as a domain cookie. The
    /// leading dot needs no case of its own - it is exactly what the suffix
    /// below already accepts - so the comparison is written once, with the
    /// candidate given the dot it may not have.
    /// </para>
    /// <para>
    /// THE DOT IN THE SUFFIX IS THE LOAD-BEARING CHARACTER. Without it
    /// <c>notlogin.digid.nl</c> - a different site that merely ends with the
    /// named one - would have its session thrown away too.
    /// </para>
    /// </remarks>
    /// <param name="domain">
    /// The cookie's domain. Nullable because a cookie with no domain is a cookie
    /// belonging to no host, and answering "not dropped" for it leaves it to the
    /// rest of the store, which already survives a file it cannot make sense of.
    /// </param>
    public static bool IsDropped(string? domain, IReadOnlyList<string> dropFor)
    {
        ArgumentNullException.ThrowIfNull(dropFor);

        if (dropFor.Count == 0) return false;

        if (string.IsNullOrEmpty(domain)) return false;

        var dotted = "." + domain.TrimStart('.');

        return dropFor.Any(named => dotted.EndsWith("." + named, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The cookies to put back into a browser opening on this profile, or none.
    /// </summary>
    /// <param name="lifetime">
    /// How old a kept session may be and still be worth offering. Zero or less
    /// turns the whole thing off and restores the browser's own rule, and the
    /// file goes with it.
    /// </param>
    public IReadOnlyList<Cookie> Restore(TimeSpan lifetime, DateTimeOffset now)
    {
        if (lifetime <= TimeSpan.Zero)
        {
            Forget();
            return [];
        }

        if (!File.Exists(FilePath)) return [];

        KeptSession? kept;
        try
        {
            kept = JsonSerializer.Deserialize<KeptSession>(
                File.ReadAllText(FilePath), Transport.AgentJson.Options);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // A file that cannot be read is a sign-in, never a failed job. The
            // adapter is about to ask the provider whether this browser is
            // signed in, and "no" is an answer it already knows how to act on.
            _logger.LogWarning(ex,
                "the session kept at {File} cannot be read; this profile's next browser starts signed out", FilePath);
            Forget();
            return [];
        }

        if (kept is null) return [];

        var age = now - kept.KeptAt;
        if (age > lifetime)
        {
            _logger.LogInformation(
                "the session kept at {File} is {Age:F1}h old and this agent offers one back for {Lifetime:F1}h; " +
                "dropping it",
                FilePath, age.TotalHours, lifetime.TotalHours);

            Forget();
            return [];
        }

        // AND FILTERED ON THE WAY OUT AS WELL AS ON THE WAY IN, which is the
        // one place this looks like belt and braces and is not.
        //
        // The rule is applied in Keep so that an identity provider's live
        // session never lands on anybody's disk at all. But the profile that
        // produced the evidence for this change already HAS a file with
        // DigiD's session in it - written on 2026-09-28 at 10:54, before any of
        // this existed - and filtering only on the way in would hand it back
        // one more time on the very next connect: the run that is supposed to
        // settle whether dropping it fixes the typed sign-in. So the offer is
        // filtered too, and the owner's next connect is clean without anybody
        // deleting a file by hand. The stale entries leave the disk when that
        // browser closes and Keep rewrites the file wholesale.
        var offered = kept.Cookies.Where(cookie => !IsDropped(cookie.Domain, _dropFor)).ToArray();

        if (offered.Length != kept.Cookies.Count)
        {
            _logger.LogInformation(
                "dropped {Count} kept session cookie(s) from {Hosts} rather than offering them back: this " +
                "provider states that session is not worth keeping",
                kept.Cookies.Count - offered.Length,
                string.Join(", ", _dropFor));
        }

        return [.. offered.Select(ToCookie)];
    }

    /// <summary>
    /// Replaces this profile's kept session with the session cookies the
    /// browser is holding now.
    /// </summary>
    /// <remarks>
    /// WHOLESALE, so that a provider whose cookies have been cleared simply
    /// stops appearing. The degenerate case of that is the one worth stating:
    /// a browser that closes holding no session cookie at all is a SIGNED-OUT
    /// browser, and the commonest way to get one is the account holder asking
    /// for it - a logout job ends with the provider's cookies gone. Leaving the
    /// last file in place would offer them back on the next launch and
    /// resurrect a session they had just ended, which is the one failure this
    /// must not have. The opposite mistake - a run that never reached the
    /// provider clearing a session that was still good - costs a sign-in, and
    /// that is the cheaper way to be wrong.
    /// <para>
    /// A browser holding nothing but a DROPPED host's session is that same
    /// signed-out browser, and is treated as one. It is not a stretch: a DUO
    /// profile whose only session cookies are DigiD's got as far as the identity
    /// provider and no further, so there is no DUO session there to offer back.
    /// </para>
    /// </remarks>
    public void Keep(IEnumerable<BrowserContextCookiesResult> cookies, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(cookies);

        // TWO REASONS A SESSION COOKIE IS NOT KEPT, and they are different
        // claims. A persistent cookie is left to Chromium because Chromium
        // already keeps it; a cookie the provider has named is left OUT because
        // holding it is cost with no benefit - DUO's DigiD session cannot save
        // an authentication against ForceAuthn, and it changed the page the
        // typed sign-in met on the owner's machine on 2026-09-28. Dropping it
        // here means it is never written down: a live identity provider session
        // in a file on somebody's disk is exposure that buys nothing, and this
        // file's own note says whoever holds these cookies is signed in as its
        // owner.
        var session = cookies
            .Where(cookie => IsSessionCookie(cookie.Expires) && !IsDropped(cookie.Domain, _dropFor))
            .Select(Of)
            .ToArray();

        if (session.Length == 0)
        {
            Forget();
            return;
        }

        try
        {
            Write(new KeptSession { KeptAt = now, Cookies = session });

            // Offered rather than "signed in", deliberately, because that is
            // all this is: whether the provider still honours them is the
            // adapter's question to ask, and it still asks it.
            _logger.LogInformation(
                "kept {Count} session cookie(s) with this profile, to offer the next browser on it",
                session.Length);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex,
                "this profile's session could not be kept at {File}; its next job will have to sign in", FilePath);
        }
    }

    private void Write(KeptSession session)
    {
        lock (_writeLock)
        {
            // Written whole and then moved into place, for the reason
            // AgentStateStore does it: a write that tears leaves a file that
            // parses as nothing, and the session it half-held is gone. A move
            // within a directory is atomic on every platform an agent runs on,
            // so a reader sees the old session or the new one.
            var temp = FilePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(session, Transport.AgentJson.Options));

            // It holds live provider sessions, which is a stronger claim than
            // the bearer token the same rule protects in the state file.
            Transport.OwnerOnlyFile.Restrict(temp, _logger);

            File.Move(temp, FilePath, overwrite: true);
        }
    }

    private void Forget()
    {
        lock (_writeLock)
        {
            try
            {
                if (File.Exists(FilePath)) File.Delete(FilePath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "a kept session could not be deleted at {File}", FilePath);
            }
        }
    }

    private static KeptCookie Of(BrowserContextCookiesResult cookie) => new()
    {
        Name = cookie.Name,
        Value = cookie.Value,
        Domain = cookie.Domain,
        Path = cookie.Path,
        HttpOnly = cookie.HttpOnly,
        Secure = cookie.Secure,
        SameSite = cookie.SameSite,
        PartitionKey = cookie.PartitionKey,
    };

    /// <summary>
    /// The same shape Playwright itself round-trips a storage state through -
    /// what <c>cookies()</c> returned, handed back to <c>addCookies()</c> -
    /// with the expiry deliberately left unset.
    /// </summary>
    /// <remarks>
    /// Unset is the whole point. Giving it an expiry would put the cookie back
    /// as a PERSISTENT one, which is a different cookie: Chromium would then
    /// write it to disk itself and keep it past the bound below, and the
    /// browser's rule would be broken further than this change means to break
    /// it. Domain and path are carried rather than a url, because a host-only
    /// cookie and a domain cookie are not interchangeable at the provider.
    /// </remarks>
    private static Cookie ToCookie(KeptCookie kept) => new()
    {
        Name = kept.Name,
        Value = kept.Value,
        Domain = kept.Domain,
        Path = kept.Path,
        HttpOnly = kept.HttpOnly,
        Secure = kept.Secure,
        SameSite = kept.SameSite,
        PartitionKey = kept.PartitionKey,
    };
}

/// <summary>
/// The file as it is written: what it holds, when it was taken, and the
/// cookies.
/// </summary>
internal sealed record KeptSession
{
    [JsonPropertyName("note")]
    public string Note { get; init; } = KeptSessionStore.WhatThisIs;

    /// <summary>
    /// When the browser that held these closed, which is what the lifetime
    /// bound is measured from.
    /// </summary>
    [JsonPropertyName("kept_at")]
    public DateTimeOffset KeptAt { get; init; }

    [JsonPropertyName("cookies")]
    public IReadOnlyList<KeptCookie> Cookies { get; init; } = [];
}

/// <summary>
/// One session cookie, in the fields Playwright needs to make it again.
/// </summary>
/// <remarks>
/// <c>required</c> on the four that identify it is deliberate: a file missing
/// one of them is a file that would otherwise put back a cookie with an empty
/// name or an empty domain, and a torn write is exactly how that happens.
/// A missing member is a <see cref="JsonException"/>, which
/// <see cref="KeptSessionStore.Restore"/> already treats as "sign in again".
/// </remarks>
internal sealed record KeptCookie
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("value")]
    public required string Value { get; init; }

    [JsonPropertyName("domain")]
    public required string Domain { get; init; }

    [JsonPropertyName("path")]
    public required string Path { get; init; }

    [JsonPropertyName("http_only")]
    public bool HttpOnly { get; init; }

    [JsonPropertyName("secure")]
    public bool Secure { get; init; }

    [JsonPropertyName("same_site")]
    public SameSiteAttribute SameSite { get; init; }

    /// <summary>
    /// The partition a CHIPS cookie belongs to, carried because an unpartitioned
    /// copy of a partitioned cookie is a cookie the provider never set.
    /// </summary>
    [JsonPropertyName("partition_key")]
    public string? PartitionKey { get; init; }
}
