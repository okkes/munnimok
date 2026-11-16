namespace Munni.Api.Lab;

// the operator's own lab connection (#441 L2), sealed for the LAB subject: it shows in no person's app, lands in no space
// the bundle rests here on purpose: it is the operator's own account, like a canary's; a person's never reaches the relay
// kept so the bench can fetch without a new sign-in, and a session can become the canary (which then holds the bundle)
public class LabSession
{
    /// <summary>The control plane's session id (<c>ses_…</c>).</summary>
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    public required string Provider { get; set; }

    public string? Label { get; set; }

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
