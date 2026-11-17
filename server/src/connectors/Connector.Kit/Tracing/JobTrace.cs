using System.Text.Json.Serialization;

namespace Connector.Kit.Tracing;

// a run's recording (#441 L3), secrets removed before anything is written, kept for the operator only.
// Lab runs only: the control plane refuses `record` without the lab trigger, which is the operator's alone
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

    public bool Truncated { get; init; }

    public int Dropped { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<TraceKind>))]
public enum TraceKind
{
    Navigation,

    Request,

    Response,

    Console,

    Dom,

    Note,
}

public sealed record TraceEntry
{
    public required int Seq { get; init; }

    /// <summary>Milliseconds since the recording started.</summary>
    public required long AtMs { get; init; }

    public required TraceKind Kind { get; init; }

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
