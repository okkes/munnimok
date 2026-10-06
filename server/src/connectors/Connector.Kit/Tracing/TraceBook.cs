using System.Globalization;

namespace Connector.Kit.Tracing;

/// <summary>
/// The bounded, redacting buffer a recording is written into. Every entry
/// passes <see cref="TraceRedaction"/> on its way in - by name, then by
/// value - so nothing the book holds was ever a secret, and a book that is
/// dropped on the floor leaks nothing.
///
/// Bounded three ways: a body is cut at <see cref="MaxBodyChars"/>, a
/// document snapshot at <see cref="MaxHtmlChars"/>, and the whole book at
/// <see cref="MaxEntries"/> entries or <see cref="MaxTotalChars"/>
/// characters, past which entries are counted and dropped rather than
/// kept. A run that pulls a thousand images must not make its trace the
/// largest row in the database.
/// </summary>
public sealed class TraceBook
{
    public const int MaxEntries = 3_000;

    public const int MaxBodyChars = 64 * 1024;

    public const int MaxHtmlChars = 256 * 1024;

    public const int MaxTotalChars = 6 * 1024 * 1024;

    public const int MaxHeaderChars = 2_048;

    public const int MaxHeaders = 64;

    public const string ViaBrowser = "browser";

    public const string ViaHttp = "http";

    private readonly Lock _gate = new();
    private readonly List<TraceEntry> _entries = [];
    private readonly IReadOnlyCollection<string> _secrets;
    private readonly TimeProvider _time;
    private readonly long _startedTimestamp;

    private long _chars;
    private int _dropped;
    private int _seq;

    public TraceBook(string jobId, string provider, IReadOnlyCollection<string> secrets, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(jobId);
        ArgumentException.ThrowIfNullOrWhiteSpace(provider);
        ArgumentNullException.ThrowIfNull(secrets);

        JobId = jobId;
        Provider = provider;
        _secrets = secrets;
        _time = time ?? TimeProvider.System;
        StartedAt = _time.GetUtcNow();
        _startedTimestamp = _time.GetTimestamp();
    }

    public string JobId { get; }

    public string Provider { get; }

    public DateTimeOffset StartedAt { get; }

    public int Count
    {
        get
        {
            lock (_gate) return _entries.Count;
        }
    }

    public int Dropped
    {
        get
        {
            lock (_gate) return _dropped;
        }
    }

    public void Navigation(string url) =>
        Add(new TraceEntry { Seq = 0, AtMs = 0, Kind = TraceKind.Navigation, Via = ViaBrowser, Url = Clean(url) });

    /// <summary>A request as it left: the browser's or the HTTP client's.</summary>
    public void Request(TraceCall call)
    {
        ArgumentNullException.ThrowIfNull(call);

        var (text, cut) = Body(call.ContentType, call.Body);
        Add(new TraceEntry
        {
            Seq = 0,
            AtMs = 0,
            Kind = TraceKind.Request,
            Via = call.Via,
            Method = call.Method,
            Url = Clean(call.Url),
            ResourceType = call.ResourceType,
            ContentType = call.ContentType,
            Headers = Headers(call.Headers),
            Body = text,
            BodyTruncated = cut,
        });
    }

    /// <summary>A response as it arrived, for the call it answers.</summary>
    public void Response(TraceCall call, int status, long? size)
    {
        ArgumentNullException.ThrowIfNull(call);

        var (text, cut) = Body(call.ContentType, call.Body);
        Add(new TraceEntry
        {
            Seq = 0,
            AtMs = 0,
            Kind = TraceKind.Response,
            Via = call.Via,
            Method = call.Method,
            Url = Clean(call.Url),
            Status = status,
            ResourceType = call.ResourceType,
            ContentType = call.ContentType,
            Size = size,
            Headers = Headers(call.Headers),
            Body = text,
            BodyTruncated = cut,
        });
    }

    public void Console(string level, string text) =>
        Add(new TraceEntry
        {
            Seq = 0,
            AtMs = 0,
            Kind = TraceKind.Console,
            Via = ViaBrowser,
            Level = level,
            Text = Scrub(Cut(text, MaxBodyChars).Text),
        });

    public void Dom(string url, string? digest, string? html)
    {
        var (text, cut) = html is null ? (null, false) : Cut(html, MaxHtmlChars);
        Add(new TraceEntry
        {
            Seq = 0,
            AtMs = 0,
            Kind = TraceKind.Dom,
            Via = ViaBrowser,
            Url = Clean(url),
            Text = digest,
            Html = text is null ? null : Scrub(text),
            HtmlTruncated = cut,
        });
    }

    public void Note(string text) =>
        Add(new TraceEntry { Seq = 0, AtMs = 0, Kind = TraceKind.Note, Text = Scrub(Cut(text, MaxHeaderChars).Text) });

    /// <summary>A cookie as the book keeps it: name and attributes, the value as a fingerprint.</summary>
    public static TraceCookie Cookie(string name, string value, string domain, string path, CookieAttributes attributes)
    {
        ArgumentNullException.ThrowIfNull(name);
        ArgumentNullException.ThrowIfNull(value);
        ArgumentNullException.ThrowIfNull(domain);
        ArgumentNullException.ThrowIfNull(attributes);

        var (length, hash) = TraceRedaction.Fingerprint(value);
        return new TraceCookie
        {
            Name = name,
            Domain = domain,
            Path = string.IsNullOrEmpty(path) ? "/" : path,
            Expires = attributes.Expires,
            HttpOnly = attributes.HttpOnly,
            Secure = attributes.Secure,
            SameSite = attributes.SameSite,
            ValueLength = length,
            ValueHash = hash,
        };
    }

    public JobTrace Build(IEnumerable<TraceCookie>? cookies = null)
    {
        lock (_gate)
        {
            return new JobTrace
            {
                JobId = JobId,
                Provider = Provider,
                StartedAt = StartedAt,
                EndedAt = _time.GetUtcNow(),
                Entries = [.. _entries],
                Cookies = cookies is null ? [] : [.. cookies],
                Truncated = _dropped > 0,
                Dropped = _dropped,
            };
        }
    }

    private void Add(TraceEntry entry)
    {
        var weight = Weigh(entry);
        lock (_gate)
        {
            if (_entries.Count >= MaxEntries || _chars + weight > MaxTotalChars)
            {
                _dropped++;
                return;
            }

            _seq++;
            _chars += weight;
            _entries.Add(entry with
            {
                Seq = _seq,
                AtMs = (long)_time.GetElapsedTime(_startedTimestamp).TotalMilliseconds,
            });
        }
    }

    private static long Weigh(TraceEntry entry) =>
        64
        + (entry.Url?.Length ?? 0)
        + (entry.Body?.Length ?? 0)
        + (entry.Text?.Length ?? 0)
        + (entry.Html?.Length ?? 0)
        + entry.Headers.Sum(h => h.Name.Length + h.Value.Length);

    private string Clean(string url) => Scrub(TraceRedaction.Url(url));

    private string Scrub(string text) => TraceRedaction.Values(text, _secrets);

    private (string? Text, bool Truncated) Body(string? contentType, string? body)
    {
        if (body is null) return (null, false);

        var redacted = TraceRedaction.Body(contentType, body);
        var (text, cut) = Cut(redacted, MaxBodyChars);
        return (Scrub(text), cut);
    }

    private List<TraceHeader> Headers(IEnumerable<KeyValuePair<string, string>> headers)
    {
        var kept = new List<TraceHeader>();
        foreach (var (name, value) in headers)
        {
            if (kept.Count >= MaxHeaders) break;
            if (string.IsNullOrWhiteSpace(name)) continue;

            var redacted = TraceRedaction.Header(name, value ?? string.Empty);
            kept.Add(new TraceHeader(name, Scrub(Cut(redacted, MaxHeaderChars).Text)));
        }

        return kept;
    }

    private static (string Text, bool Truncated) Cut(string text, int max) =>
        text.Length <= max
            ? (text, false)
            : (string.Create(CultureInfo.InvariantCulture, $"{text[..max]}… [{text.Length - max} more]"), true);
}

/// <summary>One call as a surface saw it, before the book redacts it.</summary>
public sealed record TraceCall
{
    /// <summary><see cref="TraceBook.ViaBrowser"/> or <see cref="TraceBook.ViaHttp"/>.</summary>
    public required string Via { get; init; }

    public required string Method { get; init; }

    public required string Url { get; init; }

    public string? ResourceType { get; init; }

    public IEnumerable<KeyValuePair<string, string>> Headers { get; init; } = [];

    public string? ContentType { get; init; }

    /// <summary>A text body, or null for a binary one or one that was not read.</summary>
    public string? Body { get; init; }
}

/// <summary>A cookie's attributes, everything about it that is not its name, its scope or its value.</summary>
public sealed record CookieAttributes(
    DateTimeOffset? Expires = null,
    bool HttpOnly = false,
    bool Secure = false,
    string? SameSite = null);
