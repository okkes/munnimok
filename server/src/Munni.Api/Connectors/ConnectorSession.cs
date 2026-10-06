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

    /// <summary>
    /// The bundle of a household-agent-custody session (§5.5): it names an
    /// agent and a profile and holds no secret, so the relay may keep it and
    /// sync unattended. Null for every other custody — the write-path scan
    /// proves a client-custody bundle never lands here.
    /// </summary>
    public string? KeptBundle { get; set; }

    /// <summary>When the scheduler last ran a sync for this session; null until it has.</summary>
    public DateTimeOffset? LastScheduledSyncAt { get; set; }

    /// <summary>The connector's error code the last scheduled sync ended on; null after a clean one.</summary>
    public string? LastScheduleError { get; set; }

    /// <summary>A party's <c>retry_after</c> on a rate-limited refusal (§15): the scheduler waits it out before the next attempt.</summary>
    public DateTimeOffset? ScheduleNotBefore { get; set; }

    /// <summary>
    /// The failed job whose last picture waits on this person's answer
    /// (#441 L1), as the relay's own scheduled sync saw it — the hub asks
    /// "report this failure?", the answer clears it. Null when nothing waits.
    /// </summary>
    public string? PendingArtifactsJobId { get; set; }
}
