using System.Text.Json.Serialization;

namespace Connector.Kit.Adapters;

// last seen, never persisted: kept by the platform as a fact about the provider and shown to the operator
public sealed record ProviderQuota
{
    public int? Limit { get; init; }

    public int? Remaining { get; init; }

    [JsonPropertyName("reset_at")]
    public DateTimeOffset? ResetAt { get; init; }

    [JsonPropertyName("seen_at")]
    public DateTimeOffset? SeenAt { get; init; }
}
