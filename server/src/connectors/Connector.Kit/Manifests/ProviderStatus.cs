using System.Text.Json.Serialization;

namespace Connector.Kit.Manifests;

// the kill switch, so a consumer degrades honestly ("Jumbo connections are paused"); only health is state, not definitions
public sealed record ProviderStatus
{
    public required string ProviderId { get; init; }

    public required ProviderState State { get; init; }

    public required DateTimeOffset Since { get; init; }

    /// <summary>Consumer-owned copy key. Never prose.</summary>
    public string? ReasonKey { get; init; }

    // what the party last said about its budget (an aggregator's daily allowance); on the status document only
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Adapters.ProviderQuota? Quota { get; init; }

    // whether the party keeps an inventory at the operator's account (an aggregator's consents); status document only
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Inventory { get; init; }

    public static ProviderStatus Healthy(string providerId, DateTimeOffset at) =>
        new() { ProviderId = providerId, State = ProviderState.Healthy, Since = at };

    public bool AcceptsWork => State is ProviderState.Healthy or ProviderState.Degraded;
}

[JsonConverter(typeof(JsonStringEnumConverter<ProviderState>))]
public enum ProviderState
{
    Healthy,

    /// <summary>Something is wrong and an operator knows; work still flows.</summary>
    Degraded,

    /// <summary>Work is refused. Set by an operator, or automatically after a block.</summary>
    Paused,

    /// <summary>Gone for good. Existing sessions are invalid.</summary>
    Retired,
}
