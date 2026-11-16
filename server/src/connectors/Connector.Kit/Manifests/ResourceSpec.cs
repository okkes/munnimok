using System.Text.Json.Serialization;

namespace Connector.Kit.Manifests;

// routes are generated from this: one generic handler, never a controller per provider
public sealed record ResourceSpec
{
    /// <summary>Path segment: <c>/v1/{provider}/{id}</c>.</summary>
    public required string Id { get; init; }

    public required ResourceShape Returns { get; init; }

    public IReadOnlyList<ParamSpec> Params { get; init; } = [];

    public int? MaxHistoryDays { get; init; }

    public int TypicalDurationSeconds { get; init; } = 30;

    // beyond this the fetch paginates with a cursor rather than running for minutes on a heavy account
    public int MaxRecordsPerFetch { get; init; } = 200;

    // a caveat about THIS resource, not the provider: ASN's export is one CAMT.053 for every account the login sees, so
    // the account filter decides what is SHOWN, not what is downloaded
    public string? NotesKey { get; init; }

    public ParamSpec? Param(string key) =>
        Params.FirstOrDefault(p => string.Equals(p.Key, key, StringComparison.Ordinal));
}

// every member needs a record in Normalization and a renderer in the reference consumer; RecordShapes holds the first
// half together, and a member added without one fails its test
[JsonConverter(typeof(JsonStringEnumConverter<ResourceShape>))]
public enum ResourceShape
{
    Account,
    Transaction,
    Receipt,

    CreditRegistration,

    StudentDebt,
}

public sealed record ParamSpec
{
    public required string Key { get; init; }

    public required ParamType Type { get; init; }

    public bool Required { get; init; }

    /// <summary>Whether the caller may pass a comma-separated list.</summary>
    public bool Multi { get; init; }

    public IReadOnlyList<string>? Values { get; init; }

    /// <summary>
    /// True when the adapter uses this but callers may not set it - it is
    /// documented for operators, and rejected from a query string.
    /// </summary>
    public bool Internal { get; init; }
}

[JsonConverter(typeof(JsonStringEnumConverter<ParamType>))]
public enum ParamType
{
    Date,
    Enum,
    Text,
    Number,
    Bool,
}
