using System.Text.Json.Serialization;

namespace Connector.Kit.Tracing;

/// <summary>
/// A recording of one run (#441 L3): what the browser and the HTTP client
/// did, in order, with the secrets taken out before anything was written
/// down. Made on the agent (or inline on the control plane for an HTTP-tier
/// party), posted once when the run ends, kept on the control plane for the
/// operator and nobody else.
///
/// Only a lab run is ever recorded. A person's login or sync never carries
/// the flag that starts one - the control plane refuses <c>record</c>
/// without the lab trigger, and the lab trigger is the operator's alone.
/// </summary>
public sealed record JobTrace
{
    public int Version { get; init; } = 1;

    public required string JobId { get; init; }

    public required string Provider { get; init; }

    public required DateTimeOffset StartedAt { get; init; }

    public required DateTimeOffset EndedAt { get; init; }

    public IReadOnlyList<TraceEntry> Entries { get; init; } = [];

    /// <summary>The cookie jar when the run ended. Names and attributes; a value is only ever a length and a hash.</summary>
    public IReadOnlyList<TraceCookie> Cookies { get; init; } = [];

    /// <summary>True when the book ran out of room and dropped entries; <see cref="Dropped"/> says how many.</summary>
    public bool Truncated { get; init; }

    public int Dropped { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<TraceKind>))]
public enum TraceKind
{
    /// <summary>The main frame moved to a new address.</summary>
    Navigation,

    /// <summary>A request left - the browser's or the HTTP client's.</summary>
    Request,

    /// <summary>A response arrived.</summary>
    Response,

    /// <summary>A console line or a page error.</summary>
    Console,

    /// <summary>A snapshot of the document after a page settled: its shape digest and, when it fit, its HTML.</summary>
    Dom,

    /// <summary>Something the recorder itself wanted to say: the run's end, a dropped body, a refused navigation.</summary>
    Note,
}

public sealed record TraceEntry
{
    public required int Seq { get; init; }

    /// <summary>Milliseconds since the recording started.</summary>
    public required long AtMs { get; init; }

    public required TraceKind Kind { get; init; }

    /// <summary><c>browser</c> or <c>http</c>: which of the two surfaces saw it.</summary>
    public string? Via { get; init; }

    public string? Method { get; init; }

    public string? Url { get; init; }

    public int? Status { get; init; }

    /// <summary>The browser's word for what the request was for (document, xhr, fetch, script, image, …); <c>http</c> for the client's calls.</summary>
    public string? ResourceType { get; init; }

    public string? ContentType { get; init; }

    public long? Size { get; init; }

    public IReadOnlyList<TraceHeader> Headers { get; init; } = [];

    /// <summary>A text body, redacted and capped; null for a binary one or one that was not read.</summary>
    public string? Body { get; init; }

    public bool BodyTruncated { get; init; }

    /// <summary>A console line, a note, a document's digest.</summary>
    public string? Text { get; init; }

    /// <summary>The console level, or the DOM snapshot's HTML.</summary>
    public string? Level { get; init; }

    public string? Html { get; init; }

    public bool HtmlTruncated { get; init; }
}

public sealed record TraceHeader(string Name, string Value);

public sealed record TraceCookie
{
    public required string Name { get; init; }

    public required string Domain { get; init; }

    public string Path { get; init; } = "/";

    public DateTimeOffset? Expires { get; init; }

    public bool HttpOnly { get; init; }

    public bool Secure { get; init; }

    public string? SameSite { get; init; }

    public int ValueLength { get; init; }

    /// <summary>The first twelve hex characters of the value's SHA-256: enough to tell two cookies apart, nothing to replay.</summary>
    public required string ValueHash { get; init; }
}
