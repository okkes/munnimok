using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Connector.Kit.Hosting.Data;

/// <summary>
/// Waits for the database server before the start-up migration. Docker brings
/// a stack back after a daemon or NAS restart without compose's depends_on
/// order, so the connector could start before postgres resolved and crash in
/// a loop (#573: "Name does not resolve", then "Connection refused").
/// </summary>
public static class DatabaseStartup
{
    public static async Task WaitForServerAsync(
        DatabaseFacade database, ILogger logger, TimeSpan limit, TimeSpan? pause = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(database);
        ArgumentNullException.ThrowIfNull(logger);
        if (!database.IsNpgsql()) return;
        var creator = database.GetService<IRelationalDatabaseCreator>();
        var step = pause ?? TimeSpan.FromSeconds(3);
        var deadline = DateTimeOffset.UtcNow + limit;
        var attempt = 0;
        while (true)
        {
            attempt++;
            try
            {
                // answers true/false once the server talks to us; a missing database is the migration's to create
                await creator.ExistsAsync(ct).ConfigureAwait(false);
                if (attempt > 1 && logger.IsEnabled(LogLevel.Information)) logger.LogInformation("database server reachable after {Attempts} attempts", attempt);
                return;
            }
            catch (Exception ex) when (Transient(ex) && DateTimeOffset.UtcNow + step < deadline)
            {
                logger.LogWarning(ex, "database server not reachable yet (attempt {Attempt}) — waiting", attempt);
                await Task.Delay(step, ct).ConfigureAwait(false);
            }
        }
    }

    // the EF execution strategy wraps the driver's transient error in an InvalidOperationException
    private static bool Transient(Exception ex) =>
        ex is NpgsqlException { IsTransient: true } || ex.InnerException is NpgsqlException { IsTransient: true };
}
