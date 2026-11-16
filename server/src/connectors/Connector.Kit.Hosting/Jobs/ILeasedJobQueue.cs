using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Jobs;
using Connector.Kit.Security;

namespace Connector.Kit.Hosting.Jobs;

// the retry policy is the highest-consequence code in the platform, so it lives here out of an adapter author's reach
// a lost lease requeues the job exactly once, only while no credential went upstream (a retried login locks accounts).
// no code in ErrorCatalog.NeverRetry is ever retried
public interface ILeasedJobQueue
{
    Task<JobRow> EnqueueAsync(NewJob job, CancellationToken ct);

    // claiming is a conditional update: two racing agents give one winner and one retry
    // ownerSubject non-null: only that subject's sessions; null is the in-process runner's explicit opt-out
    Task<LeasedJob?> TryLeaseAsync(
        string agentId,
        string? ownerSubject,
        AgentCapabilities capabilities,
        IReadOnlyList<JobKind> accept,
        TimeSpan leaseTtl,
        CancellationToken ct);

    Task<DateTimeOffset?> RenewLeaseAsync(string jobId, string agentId, TimeSpan leaseTtl, CancellationToken ct);

    Task<JobRow> CompleteAsync(string jobId, string? leaseOwner, CancellationToken ct);

    Task<JobRow> FailAsync(string jobId, string? leaseOwner, ErrorCode code, string? detail, CancellationToken ct);

    Task<int> RequeueExpiredLeasesAsync(CancellationToken ct);

    // the backstop for jobs never leased: every other cleanup keys on an expired lease
    Task<int> ExpireAbandonedAsync(CancellationToken ct);

    /// <summary>Records typed progress and the credential latch. Never prose.</summary>
    Task ProgressAsync(string jobId, string? leaseOwner, ProgressReport report, CancellationToken ct);
}

public sealed record NewJob
{
    public required string SessionId { get; init; }

    public required string ProviderId { get; init; }

    public required JobKind Kind { get; init; }

    public string? ResourceId { get; init; }

    public ResourceRequest? Request { get; init; }

    /// <summary>Login inputs. Nothing else ever carries a credential into the queue.</summary>
    public IReadOnlyDictionary<string, string>? Inputs { get; init; }

    public IReadOnlyDictionary<string, string> Config { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public SessionMaterial? Material { get; init; }

    public string? ProfileId { get; init; }

    // the caller chose the operator's fleet by name: offered to no machine of theirs; mirror of ProfileId
    public bool FleetOnly { get; init; }

    /// <summary>Record this run (#441 L3). The lab's alone; the endpoints refuse it on every other trigger.</summary>
    public bool Record { get; init; }

    // who asked: UserTrigger, ScheduleTrigger (relay's scheduler), null = platform work; a provider's sync interval counts
    // SCHEDULED jobs only (prod 2026-10-04: a person's syncs kept refusing the nightly one as rate_limited)
    public string? Trigger { get; init; }
}
