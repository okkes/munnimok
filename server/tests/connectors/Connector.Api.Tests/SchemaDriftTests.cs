using Connector.Kit.Hosting;
using Connector.Kit.Hosting.Data;
using Microsoft.EntityFrameworkCore;

namespace Connector.Api.Tests;

// EnsureCreated creates only missing tables: an added column or a changed key is never brought forward, so start-up refuses
// the column probe cannot see a key change: results became keyed (Id, Resource), a stale dev db failed on UNIQUE results.Id
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

        Assert.Null(await Record.ExceptionAsync(() => db.EnsureCreatedOrMigrateAsync()));
    }

    [Fact]
    public async Task A_column_the_model_gained_after_the_database_was_created_refuses_to_start()
    {
        await using var db = Context("drift");
        await db.EnsureCreatedOrMigrateAsync();

        await db.Database.ExecuteSqlRawAsync(
            "ALTER TABLE sessions DROP COLUMN \"PendingCredentialBundle\"");

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => db.EnsureCreatedOrMigrateAsync());

        Assert.Contains("'sessions' table", error.Message, StringComparison.Ordinal);
        Assert.Contains("EnsureCreated only ever creates missing tables", error.Message, StringComparison.Ordinal);

        Assert.NotNull(error.InnerException);
        Assert.Contains("PendingCredentialBundle", error.InnerException.Message, StringComparison.Ordinal);
    }

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

    // a pre-RecordPerResource database keys results on the id alone with every column present: invisible to a SELECT
    [Fact]
    public async Task A_results_table_still_keyed_the_old_way_refuses_to_start()
    {
        await using var db = Context("stale-key");

        await db.Database.ExecuteSqlRawAsync(OldKeyScript(db));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => db.EnsureCreatedOrMigrateAsync());

        Assert.Contains("'results' table", error.Message, StringComparison.Ordinal);
        Assert.Contains("the model keys it on (Id, Resource)", error.Message, StringComparison.Ordinal);
        Assert.Contains("the database keys it on (Id)", error.Message, StringComparison.Ordinal);

        Assert.Contains(
            "Bring the schema forward, or drop the database if it holds nothing worth keeping.",
            error.Message,
            StringComparison.Ordinal);
    }

    // nothing swapped out, so the test above proves "the key moved", not "a hand-built database never starts"
    [Fact]
    public async Task A_database_built_from_the_current_model_starts()
    {
        await using var db = Context("current-key");

        await db.Database.ExecuteSqlRawAsync(db.Database.GenerateCreateScript());

        Assert.Null(await Record.ExceptionAsync(() => db.EnsureCreatedOrMigrateAsync()));
    }

    private static string OldKeyScript(ConnectorDbContext db)
    {
        const string Now = "PRIMARY KEY (\"Id\", \"Resource\")";
        const string Then = "PRIMARY KEY (\"Id\")";

        var script = db.Database.GenerateCreateScript();

        // asserted: if EF writes that constraint differently this would build a current database and pass for no reason
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
