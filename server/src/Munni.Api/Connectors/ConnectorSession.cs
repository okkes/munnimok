namespace Munni.Api.Connectors;

/// <summary>
/// The binding between a connector session and the munni user it was
/// started for (docs/connector-integration-plan.md §5.3). Ids and state,
/// never a bundle, never inputs, never data: it exists so the relay can
/// answer "whose session is this" and so an operator's diagnosis can list
/// a user's connections. One row per connection: a re-login of the same
/// connection replaces the row.
/// </summary>
public class ConnectorSession
{
    /// <summary>The connector's session id (<c>ses_…</c>).</summary>
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    /// <summary>The provider id from the catalogue (<c>mock-store-simple</c>, <c>ing</c>, …).</summary>
    public required string Provider { get; set; }

    /// <summary>
    /// The client's stable id for this connection, kept across re-logins so
    /// what a connection pulled is keyed by the connection and not by the
    /// session that happened to fetch it.
    /// </summary>
    public required string ConnectionId { get; set; }

    /// <summary>The connector's session state as last seen (<c>active</c>, <c>awaiting_input</c>, …).</summary>
    public required string State { get; set; }

    /// <summary>The user's own label for the connection, echoed by the connector.</summary>
    public string? Label { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }
}
