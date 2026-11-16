using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Playwright;

namespace Connector.Kit.Agent.Browsing;

// Chromium writes session cookies to a profile but does not load them on a fresh launch: a profile never kept a login
// own machine only (KeepsSessionAcrossBrowsers): a pooled agent's profiles are wiped between jobs; not the custody question
// an offer, never a claim: every persistent adapter still asks the provider whether the session lives
internal sealed class KeptSessionStore
{
    // inside the profile, so wiping it (WipeAll on revoke) wipes its session too
    public const string FileName = "session-cookies.json";

    // written into the file: whoever browses a profile directory should know nothing in it is safe to copy
    public const string WhatThisIs =
        "live provider sessions for this browser profile: whoever holds these cookies is signed in as its owner. " +
        "They never leave this machine.";

    private readonly ILogger _logger;
    private readonly Lock _writeLock = new();
    private readonly IReadOnlyList<string> _dropFor;

    // empty keeps the whole session, as before the list existed
    public KeptSessionStore(string profileDirectory, ILogger logger, IReadOnlyList<string>? dropFor = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(profileDirectory);
        ArgumentNullException.ThrowIfNull(logger);

        FilePath = Path.Combine(Path.GetFullPath(profileDirectory), FileName);
        _logger = logger;
        _dropFor = dropFor ?? [];
    }

    public string FilePath { get; }

    // Playwright .NET types Expires as a float, -1 for a session cookie; asserted against real Chromium in KeptSessionLiveTests
    // persistent cookies are left to Chromium: re-adding them would put an older copy beside the browser's own
    public static bool IsSessionCookie(float expires) => expires < 0;

    // a named host covers itself and what is under it, not the domain above: a parent would lose the session of a provider
    // whose portal and IdP share a domain; both spellings (host-only, .domain) occur in real profiles
    // the dot in the suffix is load-bearing: without it notlogin.digid.nl would match
    public static bool IsDropped(string? domain, IReadOnlyList<string> dropFor)
    {
        ArgumentNullException.ThrowIfNull(dropFor);

        if (dropFor.Count == 0) return false;

        if (string.IsNullOrEmpty(domain)) return false;

        var dotted = "." + domain.TrimStart('.');

        return dropFor.Any(named => dotted.EndsWith("." + named, StringComparison.OrdinalIgnoreCase));
    }

    // zero or less turns the carry off and deletes the file
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
            // an unreadable file is a sign-in, never a failed job
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

        // filtered on the way out too: a file written before the drop rule existed (DigiD's session) would be handed back once more
        // the stale entries leave the disk when that browser closes and Keep rewrites the file
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

    // wholesale: a browser closing with no session cookie is signed out (a logout job); the old file would resurrect it
    // the opposite mistake costs only a sign-in; a browser holding only a dropped host's session counts as signed out
    public void Keep(IEnumerable<BrowserContextCookiesResult> cookies, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(cookies);

        // a dropped host's session is left out: DigiD's cannot save an authentication against ForceAuthn,
        // and a live IdP session in a file is exposure for nothing
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
            // written whole, then moved into place (as AgentStateStore): a torn write loses the session; a same-directory move is atomic
            var temp = FilePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(session, Transport.AgentJson.Options));

            // it holds live provider sessions, a stronger claim than the bearer token this rule protects in the state file
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

    // expiry deliberately unset: one would restore a PERSISTENT cookie that Chromium writes itself and keeps past the bound
    // domain and path, not a url: a host-only cookie and a domain cookie are not interchangeable at the provider
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

internal sealed record KeptSession
{
    [JsonPropertyName("note")]
    public string Note { get; init; } = KeptSessionStore.WhatThisIs;

    // when the browser that held these closed; the lifetime bound is measured from it
    [JsonPropertyName("kept_at")]
    public DateTimeOffset KeptAt { get; init; }

    [JsonPropertyName("cookies")]
    public IReadOnlyList<KeptCookie> Cookies { get; init; } = [];
}

// `required` on the identifying four: a torn file would otherwise restore a cookie with an empty name or domain;
// a missing member is a JsonException, which Restore treats as sign in again
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

    // carried because an unpartitioned copy of a partitioned (CHIPS) cookie is one the provider never set
    [JsonPropertyName("partition_key")]
    public string? PartitionKey { get; init; }
}
