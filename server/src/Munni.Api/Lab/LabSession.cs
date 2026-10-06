namespace Munni.Api.Lab;

/// <summary>
/// One of the operator's own connections at a party, made from the lab's
/// test bench (#441 L2). It belongs to the operator's LAB subject — the
/// pseudonym that also carries the control plane's canary marker — so the
/// run shows up in no person's app and lands in no space.
/// </summary>
/// <remarks>
/// The bundle rests here, deliberately. A person's bundle never lands on
/// the relay (the write-path scan over <c>Munni.Api.Connectors</c> proves
/// it) because it is the person's secret; this one is the OPERATOR's own
/// account at the party, the same class of credential the control plane
/// already keeps at rest for a canary — and it is sealed for the lab
/// subject, so it opens for nobody else. Kept so the bench can fetch
/// tomorrow without signing in again, and so a session can become the
/// party's canary with one tap (the canary then holds the bundle and this
/// row goes).
/// </remarks>
public class LabSession
{
    /// <summary>The control plane's session id (<c>ses_…</c>).</summary>
    public required string Id { get; set; }

    /// <summary>The operator who signed in.</summary>
    public Guid UserId { get; set; }

    public required string Provider { get; set; }

    public string? Label { get; set; }

    /// <summary>The control plane's session state as last seen.</summary>
    public required string State { get; set; }

    /// <summary>The sealed bundle the party handed the lab; null until delivered, and after a disconnect.</summary>
    public string? Bundle { get; set; }

    /// <summary>Where the operator asked the run to happen: <c>fleet</c>, an agent id, or nothing.</summary>
    public string? PreferAgent { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset LastUsedAt { get; set; }

    /// <summary>The connector's code the last fetch ended on; null after a clean one.</summary>
    public string? LastError { get; set; }
}
