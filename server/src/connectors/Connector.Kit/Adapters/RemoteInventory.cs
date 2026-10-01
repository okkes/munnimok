using System.Text.Json.Serialization;

namespace Connector.Kit.Adapters;

/// <summary>
/// An adapter behind an account the operator holds at a third party — an
/// open-banking aggregator — can list what that account holds: every consent
/// the aggregator knows, whether or not a session here holds it. Foreign
/// environments' consents and consents left behind by an earlier integration
/// show up here, and the operator revokes them from the admin portal.
/// </summary>
public interface IRemoteInventory
{
    Task<IReadOnlyList<RemoteConsent>> ListRemoteAsync(HttpClient http, CancellationToken ct);

    /// <summary>Revokes one at the party; a consent already gone is not an error.</summary>
    Task RevokeRemoteAsync(HttpClient http, string consentId, CancellationToken ct);
}

public sealed record RemoteConsent
{
    /// <summary>The party's own id — what <see cref="IRemoteInventory.RevokeRemoteAsync"/> takes.</summary>
    public required string Id { get; init; }

    public required string Status { get; init; }

    [JsonPropertyName("created_at")]
    public DateTimeOffset? CreatedAt { get; init; }

    /// <summary>The reference this platform stamped at creation, when it was this platform.</summary>
    public string? Reference { get; init; }

    [JsonPropertyName("institution_id")]
    public string? InstitutionId { get; init; }

    /// <summary>Where the party was told to return — its origin says which environment made it.</summary>
    public string? Origin { get; init; }

    [JsonPropertyName("account_count")]
    public int AccountCount { get; init; }
}
