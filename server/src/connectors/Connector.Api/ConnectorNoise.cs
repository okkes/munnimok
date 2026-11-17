using Sentry;

namespace Connector.Api;

public static class ConnectorNoise
{
    public const string UnreachableFingerprint = "database-unreachable";

    public static SentryEvent? Quiet(SentryEvent sentryEvent)
    {
        ArgumentNullException.ThrowIfNull(sentryEvent);
        if (IsConnectionLogLine(sentryEvent)) return null;
        sentryEvent.SetTag("role", "control-plane");
        if (IsDatabaseUnreachable(sentryEvent)) sentryEvent.SetFingerprint(UnreachableFingerprint);
        return sentryEvent;
    }

    // the database did not answer (restart, deploy, overloaded host): sweeps, pump and requests each worded it differently and
    // opened their own issue; one fingerprint makes the count the outage's size. A refused statement (PostgresException) or a
    // timed-out query (a slow query is its own fault) is not this
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
}
