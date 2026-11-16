using System.Text.Json.Serialization;

namespace Connector.Kit.Jobs;

[JsonConverter(typeof(JsonStringEnumConverter<JobKind>))]
public enum JobKind
{
    // the only kind that submits a credential: never enqueued by a scheduler, never retried after a credential has gone upstream
    Login,

    Fetch,

    /// <summary>A silent session renewal. Only where the manifest says reauth is cheap.</summary>
    Refresh,

    Logout,
}

[JsonConverter(typeof(JsonStringEnumConverter<JobState>))]
public enum JobState
{
    Queued,
    Leased,
    Running,
    AwaitingInput,
    Succeeded,
    Failed,
    Expired,
}

// a closed enum, not free text: a status string cannot be translated or drive a progress bar, and becomes a de-facto
// API once matched on
[JsonConverter(typeof(JsonStringEnumConverter<JobStep>))]
public enum JobStep
{
    Queued,
    AgentAssigned,
    OpeningProvider,
    Authenticating,
    AwaitingHuman,
    SelectingAccounts,
    Downloading,
    Parsing,
    Normalizing,
    Finalizing,
    LoggingOut,
}

public static class JobStateMachine
{
    private static readonly Dictionary<JobState, JobState[]> Allowed = new()
    {
        [JobState.Queued] = [JobState.Leased, JobState.Expired, JobState.Failed],
        [JobState.Leased] = [JobState.Running, JobState.Queued, JobState.Failed, JobState.Expired],
        [JobState.Running] =
        [
            JobState.AwaitingInput, JobState.Succeeded, JobState.Failed, JobState.Expired,
            // a lost lease returns the job to the queue - exactly once
            JobState.Queued,
        ],
        [JobState.AwaitingInput] = [JobState.Running, JobState.Failed, JobState.Expired],
        [JobState.Succeeded] = [],
        [JobState.Failed] = [],
        [JobState.Expired] = [],
    };

    public static bool CanTransition(JobState from, JobState to) =>
        Allowed.TryGetValue(from, out var next) && next.Contains(to);

    public static bool IsTerminal(JobState state) =>
        state is JobState.Succeeded or JobState.Failed or JobState.Expired;

    public static void EnsureTransition(JobState from, JobState to)
    {
        if (!CanTransition(from, to))
        {
            throw new InvalidOperationException($"illegal job transition {from} -> {to}");
        }
    }
}

public sealed record ResourceRequest
{
    public const string IncludeParam = "include";

    // named once so the registry that may withhold it and the request that reads it cannot drift
    public const string RawInclude = "raw";

    // not a flavour of Raw: raw is the payload a record was DERIVED from, for diagnosing shape changes; a document is a
    // file the provider issued to the user, who may want it whether or not this connector parsed it correctly
    public const string InvoiceInclude = "invoice";

    public required string ResourceId { get; init; }

    public DateOnly? Since { get; init; }

    public DateOnly? Until { get; init; }

    /// <summary>Multi-valued params, e.g. <c>accounts=savings,credit_card</c>.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Selections { get; init; } =
        new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

    public IReadOnlyList<string> Include =>
        Selections.TryGetValue(IncludeParam, out var v) ? v : [];

    public IReadOnlyList<string> Accounts =>
        Selections.TryGetValue("accounts", out var v) ? v : [];

    public const string LedgerInclude = "ledger";

    public bool WantsItems => Include.Contains("items", StringComparer.Ordinal);

    // opt-in: on DUO this history exists only in a 2.5 MB dossier (BSN, parents, tax income, IBANs, addresses); the adapter
    // keeps only the movements but the request is still made, so a plain fetch never touches the dossier
    public bool WantsLedger => Include.Contains(LedgerInclude, StringComparer.Ordinal);

    // opt-in, never default: raw is the more sensitive (it puts back what normalisation drops) and exists to diagnose shape
    // changes from real traffic; it rides the record's row, so one ack purges both
    public bool WantsRaw => Include.Contains(RawInclude, StringComparer.Ordinal);

    // opt-in for size: an Amazon invoice is 80-190 KB of PDF, up to four per order, so a fifty-order fetch would ship megabytes
    public bool WantsInvoice => Include.Contains(InvoiceInclude, StringComparer.Ordinal);
}
