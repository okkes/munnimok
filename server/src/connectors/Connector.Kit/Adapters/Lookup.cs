using System.Text.Json.Serialization;
using Connector.Kit.Manifests;

namespace Connector.Kit.Adapters;

/// <summary>
/// An adapter whose manifest declares a <see cref="FieldType.Lookup"/> field
/// answers this: the values a person may pick, listed at connect time from
/// the party itself. An aggregator's two thousand institutions are the
/// motivating case — too many for <see cref="FieldSpec.Options"/> and
/// changing under the manifest's feet.
/// </summary>
/// <remarks>
/// The lookup runs on the control plane with the platform's provider HTTP
/// client and no session: it is a public list, not a person's data. The
/// adapter caches as it sees fit (an institution list changes weekly, not
/// per keystroke); the platform caches nothing but the logos.
/// </remarks>
public interface ILookupProvider
{
    /// <summary>The options for <paramref name="field"/> matching <paramref name="query"/>.</summary>
    Task<IReadOnlyList<LookupOption>> LookupAsync(HttpClient http, string field, LookupQuery query, CancellationToken ct);

    /// <summary>
    /// The logo of one option, when <see cref="LookupOption.HasLogo"/> said
    /// there is one; the platform vendors the bytes so no person's browser
    /// fetches from the party's CDN. Null when the party has none after all.
    /// </summary>
    Task<LookupLogo?> LookupLogoAsync(HttpClient http, string field, string value, CancellationToken ct);
}

/// <summary>What the person typed and the step's other values (a country, say).</summary>
public sealed record LookupQuery
{
    public string Text { get; init; } = string.Empty;

    public IReadOnlyDictionary<string, string> Context { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public string? Get(string key) =>
        Context.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;
}

public sealed record LookupOption
{
    public required string Value { get; init; }

    public required string Label { get; init; }

    /// <summary>The platform serves it at <c>options/{field}/{value}/logo</c> when true.</summary>
    [JsonPropertyName("has_logo")]
    public bool HasLogo { get; init; }
}

public sealed record LookupLogo(byte[] Bytes, string ContentType);
