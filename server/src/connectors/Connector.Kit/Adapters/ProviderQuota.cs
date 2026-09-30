using System.Text.Json.Serialization;

namespace Connector.Kit.Adapters;

/// <summary>
/// What a party said about its budget in its last answer — an aggregator's
/// per-account daily allowance, typically. Reported by the adapter through
/// <see cref="IJobContext.ReportQuota"/>, kept by the platform as a fact
/// about the provider (last seen, never persisted), shown to the operator.
/// </summary>
public sealed record ProviderQuota
{
    public int? Limit { get; init; }

    public int? Remaining { get; init; }

    [JsonPropertyName("reset_at")]
    public DateTimeOffset? ResetAt { get; init; }

    [JsonPropertyName("seen_at")]
    public DateTimeOffset? SeenAt { get; init; }
}
