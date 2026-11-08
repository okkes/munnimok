using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;

namespace Munni.Api.Data;

/// <summary>
/// Waits for the database server before the start-up migration. Docker brings
/// a stack back after a daemon or NAS restart without compose's depends_on
/// order, so the api can start before postgres resolves (#573); crashing on
/// that left a restart loop that read as a broken deploy.
/// </summary>
public static class DatabaseStartup
{
    public static async Task WaitForServerAsync(
        DatabaseFacade database, ILogger logger, TimeSpan limit, TimeSpan? pause = null, CancellationToken ct = default)
    {
        if (!database.IsNpgsql()) return;
        var creator = database.GetService<IRelationalDatabaseCreator>();
        var step = pause ?? TimeSpan.FromSeconds(3);
        var deadline = DateTimeOffset.UtcNow + limit;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                // answers true/false once the server talks to us; a missing database is the migration's to create
                await creator.ExistsAsync(ct);
                if (attempt > 1) logger.LogInformation("database server reachable after {Attempts} attempts", attempt);
                return;
            }
            catch (Exception ex) when (Transient(ex) && DateTimeOffset.UtcNow + step < deadline)
            {
                logger.LogWarning("database server not reachable yet (attempt {Attempt}: {Reason}) — waiting", attempt, ex.GetBaseException().Message);
                await Task.Delay(step, ct);
            }
        }
    }

    // the EF execution strategy wraps the driver's transient error in an InvalidOperationException
    private static bool Transient(Exception ex) =>
        ex is NpgsqlException { IsTransient: true } || ex.InnerException is NpgsqlException { IsTransient: true };
}
