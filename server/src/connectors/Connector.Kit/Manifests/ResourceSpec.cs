using System.Text.Json.Serialization;

namespace Connector.Kit.Manifests;

/// <summary>
/// One fetchable resource, e.g. <c>GET /v1/lidl/receipts?since=…</c>.
/// Routes are generated from this: there is exactly one generic handler,
/// never a controller per provider.
/// </summary>
public sealed record ResourceSpec
{
    /// <summary>Path segment: <c>/v1/{provider}/{id}</c>.</summary>
    public required string Id { get; init; }

    public required ResourceShape Returns { get; init; }

    public IReadOnlyList<ParamSpec> Params { get; init; } = [];

    public int? MaxHistoryDays { get; init; }

    /// <summary>Rough expectation, so a consumer can choose to poll or stream.</summary>
    public int TypicalDurationSeconds { get; init; } = 30;

    /// <summary>
    /// Upper bound on records in one pass. Beyond this the fetch paginates
    /// with a cursor rather than running for minutes on a heavy account.
    /// </summary>
    public int MaxRecordsPerFetch { get; init; } = 200;

    /// <summary>
    /// Consumer-owned copy key for a caveat about THIS resource.
    /// </summary>
    /// <remarks>
    /// The provider already has one of these, and it is the wrong place for a
    /// fact about a fetch: somebody reads the connect screen once and the fetch
    /// screen every time. ASN is why there is one here - its export is a single
    /// CAMT.053 document covering every account the login can see, so the
    /// account filter decides what a caller is SHOWN and not what is
    /// downloaded, and a manifest that only listed the filter would have let
    /// somebody believe otherwise.
    /// </remarks>
    public string? NotesKey { get; init; }

    public ParamSpec? Param(string key) =>
        Params.FirstOrDefault(p => string.Equals(p.Key, key, StringComparison.Ordinal));
}

/// <summary>
/// What a row of a resource IS.
///
/// Every member has a record behind it in <see cref="Normalization"/>, a
/// renderer in the reference consumer, and - since the schemas are published -
/// an entry in the API document that a caller can read before it fetches
/// anything. <c>RecordShapes</c> is what holds that first half together, and a
/// member added here without one fails its test rather than reaching a
/// manifest.
///
/// <c>Profile</c> used to sit in this list. Nothing returned it, no record
/// answered to it and no consumer could draw it, so it was a shape a manifest
/// could have declared and nobody could have read. Publishing these as schemas
/// turned that from an unused member into a documented promise with nothing
/// behind it, so it went.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<ResourceShape>))]
public enum ResourceShape
{
    Account,
    Transaction,
    Receipt,

    /// <summary>
    /// One credit as a registry states it: who lent, what kind, how much, and
    /// whether it is still running.
    /// </summary>
    CreditRegistration,

    /// <summary>
    /// What a national student-finance body says somebody owes: the total, the
    /// breakdown behind it, where the debt is in its life, and the interest.
    /// </summary>
    StudentDebt,
}

public sealed record ParamSpec
{
    public required string Key { get; init; }

    public required ParamType Type { get; init; }

    public bool Required { get; init; }

    /// <summary>Whether the caller may pass a comma-separated list.</summary>
    public bool Multi { get; init; }

    /// <summary>Allowed values for <see cref="ParamType.Enum"/>.</summary>
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
