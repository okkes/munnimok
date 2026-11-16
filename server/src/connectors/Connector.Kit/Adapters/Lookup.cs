using System.Text.Json.Serialization;
using Connector.Kit.Manifests;

namespace Connector.Kit.Adapters;

// values a person may pick, listed at connect time from the party: too many (an aggregator's two thousand institutions) for
// FieldSpec.Options and changing under the manifest. Runs on the control plane with the provider HTTP client and no session
// (a public list); the adapter caches, the platform caches only logos
public interface ILookupProvider
{
    Task<IReadOnlyList<LookupOption>> LookupAsync(HttpClient http, string field, LookupQuery query, CancellationToken ct);

    // the platform vendors the bytes so no person's browser fetches from the party's CDN; null when the party has none after all
    Task<LookupLogo?> LookupLogoAsync(HttpClient http, string field, string value, CancellationToken ct);
}

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
