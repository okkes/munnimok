using Sentry;

namespace Connector.Api;

/// <summary>
/// What a crash report of the control plane becomes before it leaves
/// (docs/observability.md): tagged with its role, and - when the database did
/// not answer - one of that outage's events rather than an issue of its own.
/// </summary>
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

    /// <summary>
    /// The database did not answer (it restarts, a deploy recreates it, the
    /// host is out of breath): the sweeps, the pump and every request of those
    /// minutes notice in their own words, and each wording used to open an
    /// issue of its own. Under one fingerprint they are one issue whose count
    /// is the size of the outage. A statement the server refused (a
    /// <c>PostgresException</c>) is not this, and neither is one that ran
    /// past its time: a slow query is a fault of its own.
    /// </summary>
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
