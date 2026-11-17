using System.Globalization;
using Npgsql;
using Sentry;
using Sentry.AspNetCore;

namespace Munni.Api;

// mutes the events of DELIBERATE insert races: parallel first requests provision one row, the unique index picks a winner,
// yet EF logs the loser at Error; only the exact raced tables are muted, every other database failure keeps reporting
public static class SentryNoise
{
    private static readonly string[] RacedTables = ["\"Users\"", "\"UserDevices\"", "\"SpaceAccountLinks\""];

    public static void Configure(SentryAspNetCoreOptions options, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(configuration);
        // explicit empty string = SDK disabled (unset would throw at boot)
        options.Dsn = configuration["Sentry:Dsn"] ?? string.Empty;
        options.SendDefaultPii = false;
        // performance tracing (docs/observability.md): health probes and the SSE stream never count,
        // and a trace the web app started keeps its decision
        var tracesSampleRate = TracesSampleRate(configuration["Sentry:TracesSampleRate"]);
        options.TracesSampler = context => SampleTrace(context.TransactionContext, tracesSampleRate);
        // trace headers travel only to the connector control plane, never to a third party
        options.TracePropagationTargets.Clear();
        if (configuration["Connectors:BaseUrl"] is { Length: > 0 } relay) options.TracePropagationTargets.Add(relay);
        // deliberate insert races are handled, not incidents (GlitchTip 66–74); a database that did not answer is one incident
        options.SetBeforeSend((sentryEvent, _) => Quiet(sentryEvent));
        // upstream 5xx are retried by the fetch loop; real failures still surface as exceptions and LogError
        options.CaptureFailedRequests = false;
    }

    // the sync push retries a unique violation on these up to 3 times; only the LOG line of a retried attempt is muted
    // the exception thrown once the retries are spent still reports
    private static readonly string[] RetriedTables = ["\"EntityRows\"", "\"SyncOps\""];

    public static bool IsHandledRace(SentryEvent sentryEvent)
    {
        foreach (var ex in sentryEvent.SentryExceptions ?? [])
        {
            if (ex.Type?.Contains("PostgresException") == true &&
                ex.Value?.Contains(PostgresErrorCodes.UniqueViolation) == true &&
                RacedTables.Any(t => ex.Value.Contains(t.Trim('"'))))
            {
                return true;
            }
        }

        if (sentryEvent.Logger?.StartsWith("Microsoft.EntityFrameworkCore") == true)
        {
            var text = sentryEvent.Message?.Formatted ?? sentryEvent.Message?.Message ?? string.Empty;
            if (text.Contains("INSERT INTO") && RacedTables.Concat(RetriedTables).Any(text.Contains)) return true;
            // DbUpdateException log line carries no command text — the
            // paired CommandError right before it already told the story
            if (sentryEvent.Logger.StartsWith("Microsoft.EntityFrameworkCore.Update") &&
                text.Contains("An error occurred while saving the entity changes"))
            {
                return true;
            }
        }

        return false;
    }

    public static SentryEvent? Quiet(SentryEvent sentryEvent)
    {
        ArgumentNullException.ThrowIfNull(sentryEvent);
        if (IsHandledRace(sentryEvent) || IsConnectionLogLine(sentryEvent)) return null;
        if (IsDatabaseUnreachable(sentryEvent)) sentryEvent.SetFingerprint(UnreachableFingerprint);
        return sentryEvent;
    }

    internal const string UnreachableFingerprint = "database-unreachable";

    // the database did not answer (restart, deploy): under one fingerprint the outage's many wordings are one issue
    // whose count is its size; a refused statement (PostgresException) or one that ran past its time is not this
    public static bool IsDatabaseUnreachable(SentryEvent sentryEvent)
    {
        ArgumentNullException.ThrowIfNull(sentryEvent);
        var chain = sentryEvent.SentryExceptions?.ToList() ?? [];
        if (chain.Exists(ex => ex.Value?.Contains(SlowStatement, StringComparison.Ordinal) == true)) return false;
        return chain.Exists(ex =>
            ex.Type == "Npgsql.NpgsqlException" ||
            ex.Value?.Contains("likely due to a transient failure", StringComparison.Ordinal) == true);
    }

    /// <summary>Npgsql's words for a statement that was sent and did not come back within its command timeout.</summary>
    private const string SlowStatement = "Timeout during reading attempt";

    /// <summary>EF's own "An error occurred using the connection" line: the exception it announces reports by itself.</summary>
    public static bool IsConnectionLogLine(SentryEvent sentryEvent)
    {
        ArgumentNullException.ThrowIfNull(sentryEvent);
        return sentryEvent.Logger?.StartsWith("Microsoft.EntityFrameworkCore.Database.Connection", StringComparison.Ordinal) == true;
    }

    // the share of requests that become transactions, 0..1; unset or unreadable is the default 0.2, 0 means errors only
    public static double TracesSampleRate(string? configured, double fallback = 0.2) =>
        double.TryParse(configured, NumberStyles.Float, CultureInfo.InvariantCulture, out var rate) && rate is >= 0 and <= 1
            ? rate
            : fallback;

    // never a transaction: health probes, SSE streams (they would read as the slowest request) and agent heartbeats
    private static readonly string[] HeartbeatPaths = ["/health", "/sync/events", "/live/stream", "/heartbeat"];

    public static bool IsHeartbeat(string? transactionName) =>
        transactionName is not null && HeartbeatPaths.Any(p => transactionName.Contains(p, StringComparison.OrdinalIgnoreCase));

    // heartbeats never; a trace the web app started keeps its decision (a slow Confirm shows its sync push end to end)
    public static double SampleTrace(ITransactionContext context, double rate)
    {
        if (rate <= 0 || IsHeartbeat(context.Name)) return 0;
        if (context.IsParentSampled is { } parentSampled) return parentSampled ? 1 : 0;
        return rate;
    }
}
