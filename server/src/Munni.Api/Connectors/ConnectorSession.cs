namespace Munni.Api.Connectors;

// ids and state, never a bundle, inputs or data; one row per connection: a re-login replaces the row
public class ConnectorSession
{
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    public required string Provider { get; set; }

    // kept across re-logins so what a connection pulled is keyed by the connection, not by the session that fetched it
    public required string ConnectionId { get; set; }

    public required string State { get; set; }

    public string? Label { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset LastSeenAt { get; set; }

    // names an agent and a profile, holds no secret (§5.5); null for every other custody: the write-path scan proves a
    // client-custody bundle never lands here
    public string? KeptBundle { get; set; }

    public DateTimeOffset? LastScheduledSyncAt { get; set; }

    public string? LastScheduleError { get; set; }

    // a party's retry_after on a rate-limited refusal (§15): the scheduler waits it out
    public DateTimeOffset? ScheduleNotBefore { get; set; }

    // #460: the older history a scheduled pass left; the next backfill pass asks from BackfillSince up to this day.
    // null when nothing is left
    public DateOnly? BackfillUntil { get; set; }

    // null: the party's floor
    public DateOnly? BackfillSince { get; set; }

    // #441 L1: the failed job whose picture waits on the person's answer; null when nothing waits
    public string? PendingArtifactsJobId { get; set; }
}
