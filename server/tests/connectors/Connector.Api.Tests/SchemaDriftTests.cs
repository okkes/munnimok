using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Microsoft.EntityFrameworkCore;

namespace Connector.Api.Tests;

/// <summary>
/// Start-up refuses a database that is missing something the model has, or
/// that keys a table differently from the way the model does.
///
/// <c>EnsureCreated</c> creates missing TABLES and nothing else. A column added
/// to an entity after the database exists is never created, so the service
/// starts happily and throws a 500 the first time a request writes it - which
/// reads to whoever hit it as a broken provider rather than a schema nobody
/// brought forward.
///
/// That is not hypothetical. Two columns landed in one afternoon
/// (<c>sessions.PendingCredentialBundle</c> and <c>results.RawJson</c>), every
/// test stayed green because the suite builds a fresh SQLite file per run, and
/// the first person to press Connect on a two-day-old Postgres volume got
/// "Something broke on our side."
///
/// A KEY IS THE SAME STORY AND THE COLUMN PROBE CANNOT SEE IT. The night the
/// results key became <c>(Id, Resource)</c>, a developer whose
/// <c>bank-connector.dev.db</c> predated it started HEAD, was told nothing -
/// every column the model wanted was there - and hit "UNIQUE constraint
/// failed: results.Id" on the accounts-then-transactions fetch, which is the
/// exact failure that key change exists to fix.
/// </summary>
public sealed class SchemaDriftTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(), "schema-drift-tests", Guid.NewGuid().ToString("N"));

    public SchemaDriftTests() => Directory.CreateDirectory(_root);

    [Fact]
    public async Task A_database_that_matches_the_model_starts()
    {
        await using var db = Context("match");

        await db.EnsureCreatedOrMigrateAsync();

        // And again, because start-up runs against an EXISTING database far
        // more often than a fresh one.
        Assert.Null(await Record.ExceptionAsync(() => db.EnsureCreatedOrMigrateAsync()));
    }

    [Fact]
    public async Task A_column_the_model_gained_after_the_database_was_created_refuses_to_start()
    {
        await using var db = Context("drift");
        await db.EnsureCreatedOrMigrateAsync();

        // Exactly what an added column looks like from the database's side: the
        // table is there, one of its columns is not.
        await db.Database.ExecuteSqlRawAsync(
            "ALTER TABLE sessions DROP COLUMN \"PendingCredentialBundle\"");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => db.EnsureCreatedOrMigrateAsync());

        // Names the table, so an operator knows where to look rather than
        // reading a stack trace from a request that failed hours later.
        Assert.Contains("'sessions' table", error.Message, StringComparison.Ordinal);
        Assert.Contains("EnsureCreated only ever creates missing tables", error.Message, StringComparison.Ordinal);

        // The database's own answer is kept, because it is the thing that names
        // the column.
        Assert.NotNull(error.InnerException);
        Assert.Contains("PendingCredentialBundle", error.InnerException.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The other column from the same afternoon, on a different table - so this
    /// asserts the check walks the whole model rather than one entity somebody
    /// remembered.
    /// </summary>
    [Fact]
    public async Task The_check_covers_every_table_and_not_just_sessions()
    {
        await using var db = Context("results");
        await db.EnsureCreatedOrMigrateAsync();

        await db.Database.ExecuteSqlRawAsync("ALTER TABLE results DROP COLUMN \"RawJson\"");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => db.EnsureCreatedOrMigrateAsync());

        Assert.Contains("'results' table", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// THE ONE THAT SHIPPED. A database created before the RecordPerResource
    /// migration keys <c>results</c> on the id alone; every column the model
    /// wants is present, so nothing about it is visible to a SELECT.
    /// </summary>
    [Fact]
    public async Task A_results_table_still_keyed_the_old_way_refuses_to_start()
    {
        await using var db = Context("stale-key");

        await db.Database.ExecuteSqlRawAsync(OldKeyScript(db));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => db.EnsureCreatedOrMigrateAsync());

        // The table, and both keys: an operator reading this should not have
        // to go and look up either side of the disagreement.
        Assert.Contains("'results' table", error.Message, StringComparison.Ordinal);
        Assert.Contains("the model keys it on (Id, Resource)", error.Message, StringComparison.Ordinal);
        Assert.Contains("the database keys it on (Id)", error.Message, StringComparison.Ordinal);

        // Same voice as the column refusal beside it, because it is the same
        // instruction: this is a schema nobody brought forward.
        Assert.Contains(
            "Bring the schema forward, or drop the database if it holds nothing worth keeping.",
            error.Message,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// The same construction with nothing swapped out, so what the test above
    /// proves is "the key moved" and not "a hand-built database never starts".
    /// </summary>
    [Fact]
    public async Task A_database_built_from_the_current_model_starts()
    {
        await using var db = Context("current-key");

        await db.Database.ExecuteSqlRawAsync(db.Database.GenerateCreateScript());

        Assert.Null(await Record.ExceptionAsync(() => db.EnsureCreatedOrMigrateAsync()));
    }

    /// <summary>
    /// The model's own schema with the results key wound back to what it was
    /// before RecordPerResource - which is what the developer's file held.
    ///
    /// Generated from the model rather than typed out, so the columns stay
    /// right as the model gains them and the only difference between this
    /// database and a current one is the line under test.
    /// </summary>
    private static string OldKeyScript(ConnectorDbContext db)
    {
        const string Now = "PRIMARY KEY (\"Id\", \"Resource\")";
        const string Then = "PRIMARY KEY (\"Id\")";

        var script = db.Database.GenerateCreateScript();

        // Asserted rather than assumed: if EF ever writes that constraint
        // differently this fixture would quietly build a current database and
        // the test above would pass for no reason at all.
        Assert.Contains(Now, script, StringComparison.Ordinal);

        return script.Replace(Now, Then, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // Sqlite's pool may still hold the file. Not worth failing over.
        }
    }

    private ConnectorDbContext Context(string name)
    {
        var builder = new DbContextOptionsBuilder<ConnectorDbContext>();

        ConnectorDbContext.Configure(builder, new ConnectorDatabaseOptions
        {
            Provider = ConnectorDatabaseProvider.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(_root, name + ".db")}",
        });

        return new ConnectorDbContext(builder.Options);
    }
}
