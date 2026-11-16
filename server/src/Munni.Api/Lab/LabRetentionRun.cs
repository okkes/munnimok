namespace Munni.Api.Lab;

// retention bench run (#441 L4): the report outlives the tab, and the history says which agent kept which login when
public class LabRetentionRun
{
    /// <summary><c>lrr_…</c></summary>
    public required string Id { get; set; }

    public Guid UserId { get; set; }

    /// <summary>The agent the run was pinned to; null for "whatever the queue decides".</summary>
    public string? AgentId { get; set; }

    public string? AgentName { get; set; }

    public required string Provider { get; set; }

    public required string Resource { get; set; }

    public string? Label { get; set; }

    /// <summary><c>running</c>, <c>passed</c>, <c>failed</c> or <c>aborted</c>.</summary>
    public required string State { get; set; }

    /// <summary>The steps as a JSON array of <c>{ name, state, detail, jobId, sessionId, at }</c>, in the order they were taken.</summary>
    public string StepsJson { get; set; } = "[]";

    public string? SessionId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}
