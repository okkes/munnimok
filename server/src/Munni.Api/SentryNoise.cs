using Npgsql;
using Sentry;

namespace Munni.Api;

/// <summary>
/// Classifies Sentry events produced by DELIBERATE insert races — several
/// parallel first requests JIT-provision the same row, the unique index
/// picks one winner and the losers adopt it. The exception is caught and
/// the request succeeds, but EF Core still logs the failed command at
/// Error level, which the Sentry logging integration forwarded as an
/// event each time. Only the exact tables whose races we handle are
/// muted; every other database failure keeps reporting.
/// </summary>
public static class SentryNoise
{
    private static readonly string[] RacedTables = ["\"Users\"", "\"UserDevices\"", "\"SpaceAccountLinks\""];

    /// <summary>
    /// The sync push retries a unique violation on these up to three times
    /// (two devices pushing the same new row, a push racing the bank
    /// ingest): EF's command-failed log line of a retried attempt is not an
    /// incident (GlitchTip 10). Only the LOG line is muted — the exception
    /// the push throws once the retries are spent still reports.
    /// </summary>
    private static readonly string[] RetriedTables = ["\"EntityRows\"", "\"SyncOps\""];

    public static bool IsHandledRace(SentryEvent sentryEvent)
    {
        // the caught PostgresException / DbUpdateException event chain
        foreach (var ex in sentryEvent.SentryExceptions ?? [])
        {
            if (ex.Type?.Contains("PostgresException") == true &&
                ex.Value?.Contains(PostgresErrorCodes.UniqueViolation) == true &&
                RacedTables.Any(t => ex.Value.Contains(t.Trim('"'))))
            {
                return true;
            }
        }

        // the EF "Failed executing DbCommand … INSERT INTO <raced table>"
        // error log, forwarded by the logging integration
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
}
