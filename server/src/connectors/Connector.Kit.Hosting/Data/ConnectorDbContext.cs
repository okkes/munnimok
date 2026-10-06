using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace Connector.Kit.Hosting.Data;

/// <summary>
/// One context, two providers.
///
/// Every mapping here is deliberately provider-agnostic: enums are stored as
/// strings, structured values as JSON <em>text</em> rather than <c>jsonb</c>,
/// and every timestamp is a <see cref="DateTimeOffset"/> written in UTC. That
/// is what lets the identical schema run on Postgres in production and on
/// Sqlite in a test, so the tests exercise the real queries instead of a
/// stand-in.
/// </summary>
public sealed class ConnectorDbContext(DbContextOptions<ConnectorDbContext> options) : DbContext(options)
{
    public DbSet<SessionRow> Sessions => Set<SessionRow>();

    public DbSet<JobRow> Jobs => Set<JobRow>();

    public DbSet<ChallengeRow> Challenges => Set<ChallengeRow>();

    public DbSet<ResultRow> Results => Set<ResultRow>();

    public DbSet<AgentRow> Agents => Set<AgentRow>();

    public DbSet<ProfileRow> Profiles => Set<ProfileRow>();

    public DbSet<ProviderStatusRow> ProviderStatuses => Set<ProviderStatusRow>();

    public DbSet<EnrollmentRow> Enrollments => Set<EnrollmentRow>();

    public DbSet<PrivateAgentRequestRow> PrivateAgentRequests => Set<PrivateAgentRequestRow>();

    /// <summary>Operator-owned connections, run on a schedule. See <see cref="CanaryRow"/>.</summary>
    public DbSet<CanaryRow> Canaries => Set<CanaryRow>();

    /// <summary>What failed runs left behind, kept with the person's leave or for the operator's own runs. See <see cref="JobArtifactRow"/>.</summary>
    public DbSet<JobArtifactRow> JobArtifacts => Set<JobArtifactRow>();

    public DbSet<JobTraceRow> JobTraces => Set<JobTraceRow>();

    /// <summary>
    /// Applies migrations when the assembly carries any, and falls back to
    /// <c>EnsureCreated</c> otherwise.
    ///
    /// The migrations this assembly carries are scaffolded for Npgsql, so
    /// Postgres - production - is brought forward properly, key changes and
    /// all. Every other provider takes <c>EnsureCreated</c>, which creates
    /// missing tables and touches nothing that already exists. That is the
    /// whole reason <see cref="AssertSchemaMatchesModelAsync"/> follows it:
    /// on that path the database is the only thing that knows what it really
    /// holds, so it gets asked rather than assumed.
    /// </summary>
    public async Task EnsureCreatedOrMigrateAsync(CancellationToken ct = default)
    {
        // Migrations only where they exist, and they are scaffolded for Npgsql
        // alone: a migration carries the SQL of the provider it was generated
        // for, so replaying Postgres DDL onto Sqlite would fail on the first
        // statement. Sqlite therefore takes EnsureCreated - and it is NOT the
        // fresh file per run this comment once claimed: a developer's
        // bank-connector.dev.db is a path in appsettings.Development.json and
        // outlives every schema change made after it. Which is exactly how a
        // key that moved got to sit there unmentioned until a fetch failed.
        if (Database.IsNpgsql() && Database.GetMigrations().Any())
        {
            await Database.MigrateAsync(ct);
            return;
        }

        await Database.EnsureCreatedAsync(ct);
        await AssertSchemaMatchesModelAsync(ct);
    }

    /// <summary>
    /// Refuses to start against a database that is missing something the model
    /// has, or that keys a table differently from the way the model does.
    ///
    /// <c>EnsureCreated</c> creates missing TABLES and nothing else. A column
    /// added to an entity after the database exists is simply never created, so
    /// the service starts perfectly happily and then throws a 500 the first
    /// time a request writes that column - which reads to whoever hit it as a
    /// broken provider rather than a schema that was never brought forward.
    /// That happened: two columns landed in one afternoon and the first user to
    /// press Connect got "Something broke on our side."
    ///
    /// One empty SELECT per table, naming every column the model expects. It
    /// costs a handful of round trips at start-up, uses the database's own
    /// answer rather than a hand-rolled diff, and works on any relational
    /// provider because it is just SQL. A mismatch becomes a refusal to start
    /// with the table named - the same call this file's neighbours make about
    /// a manifest that lies.
    ///
    /// Then the key, per table, because that SELECT cannot see one - see
    /// <see cref="AssertPrimaryKeyMatchesModelAsync"/>.
    /// </summary>
    private async Task AssertSchemaMatchesModelAsync(CancellationToken ct)
    {
        foreach (var entity in Model.GetEntityTypes())
        {
            if (entity.GetTableName() is not { } table) continue;

            var columns = entity.GetProperties()
                .Select(p => p.GetColumnName())
                .Where(c => !string.IsNullOrEmpty(c))
                .Select(Quote)
                .ToList();

            if (columns.Count == 0) continue;

            // Built here rather than interpolated at the call site so it is
            // plain that nothing in it came from a request: every identifier is
            // read off the EF model this assembly was compiled with, and each
            // one goes through Quote. WHERE 1 = 0 so this reads nothing and
            // still has to resolve every name.
            var probe = "SELECT " + string.Join(", ", columns) + " FROM " + Quote(table) + " WHERE 1 = 0";

            try
            {
#pragma warning disable S2077 // built from the model's own quoted identifiers, never from a request
                await Database.ExecuteSqlRawAsync(probe, ct);
#pragma warning restore S2077
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    $"the '{table}' table does not match the model this build expects. " +
                    "EnsureCreated only ever creates missing tables, so a column added since " +
                    "this database was created is absent and every write touching it fails at " +
                    "request time. Bring the schema forward, or drop the database if it holds " +
                    "nothing worth keeping.",
                    ex);
            }

            await AssertPrimaryKeyMatchesModelAsync(entity, table, ct);
        }
    }

    /// <summary>
    /// Refuses to start against a table whose primary key has moved on.
    ///
    /// The probe above cannot see this one. <c>SELECT "Id", "Resource" FROM
    /// results WHERE 1 = 0</c> resolves perfectly well against a table still
    /// keyed on <c>Id</c> alone, so a key that changed after the database was
    /// created stays invisible right up to the first write the new key was
    /// widened to allow - which comes back as a 500 that reads like a broken
    /// provider. That happened the night the results key became
    /// <c>(Id, Resource)</c>: a developer whose <c>bank-connector.dev.db</c>
    /// predated it started HEAD, was told nothing, and then hit "UNIQUE
    /// constraint failed: results.Id" on the accounts-then-transactions
    /// fetch - the exact failure that key change exists to fix, on the very
    /// machine it had been reproduced on.
    ///
    /// Deliberately scoped to this path and to the providers this build knows
    /// how to ask - see <see cref="ReadPrimaryKeyAsync"/>. A stale key can
    /// only survive a start-up that never rewrites it, and Postgres never
    /// reaches here: it migrates, and the migration carries its own
    /// DropPrimaryKey/AddPrimaryKey pair.
    /// </summary>
    private async Task AssertPrimaryKeyMatchesModelAsync(IEntityType entity, string table, CancellationToken ct)
    {
        if (entity.FindPrimaryKey() is not { } key) return;

        var actual = await ReadPrimaryKeyAsync(table, ct);
        if (actual is null) return;

        // IKey.Properties is in key order, and so is what the database gives
        // back, because (Id, Resource) and (Resource, Id) are not the same
        // key: they index differently and a composite lookup on the wrong one
        // scans. Ordinal, since these are identifiers this assembly emitted.
        var wanted = key.Properties.Select(p => p.GetColumnName()).ToList();

        if (wanted.SequenceEqual(actual, StringComparer.Ordinal)) return;

        throw new InvalidOperationException(
            $"the '{table}' table is keyed differently from the model this build expects: " +
            $"the model keys it on {Describe(wanted)} and the database keys it on {Describe(actual)}. " +
            "EnsureCreated only ever creates missing tables, so a key that changed since this " +
            "database was created is still the old one and the first write the new key was meant " +
            "to allow fails at request time. Bring the schema forward, or drop the database if it " +
            "holds nothing worth keeping.");
    }

    /// <summary>
    /// The database's own answer to what a table is keyed on, in key order -
    /// or <c>null</c> when this build has no way to put the question to this
    /// provider, which leaves the column probe as the only guard rather than
    /// refusing a start-up over an answer nobody asked for.
    ///
    /// There is no portable SQL for this. A key lives in <c>pg_index</c> on
    /// Postgres and behind a PRAGMA on Sqlite, and Sqlite has no
    /// <c>information_schema</c> to meet halfway. So what is general here is
    /// the seam - one method, one dialect per provider, an honest <c>null</c>
    /// for anything else - rather than one query pretending to be portable.
    /// Sqlite is the only dialect written because Sqlite is the only provider
    /// that arrives here holding a database it did not just create: Npgsql
    /// migrates instead, and a third provider would be a branch here.
    /// </summary>
    private async Task<IReadOnlyList<string>?> ReadPrimaryKeyAsync(string table, CancellationToken ct)
    {
        if (!Database.IsSqlite()) return null;

        var columns = new List<(long Ordinal, string Name)>();

        // ADO rather than ExecuteSqlRaw because this one reads rows back, and
        // the connection is opened and closed around it: at start-up EF holds
        // nothing open, and OpenConnection/CloseConnection count their nesting
        // so this leaves the facade exactly as it found it.
        await Database.OpenConnectionAsync(ct);
        try
        {
            await using var command = Database.GetDbConnection().CreateCommand();

            // pragma_table_info is the table-valued form of PRAGMA
            // table_info, which is what lets the table name go in as a
            // parameter instead of into the text. Its `pk` is 0 for a column
            // outside the key and its 1-based position within it otherwise.
            command.CommandText = "SELECT \"name\", \"pk\" FROM pragma_table_info($table) WHERE \"pk\" > 0";

            var parameter = command.CreateParameter();
            parameter.ParameterName = "$table";
            parameter.Value = table;
            command.Parameters.Add(parameter);

            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                columns.Add((reader.GetInt64(1), reader.GetString(0)));
            }
        }
        finally
        {
            await Database.CloseConnectionAsync();
        }

        // Sorted here rather than in the statement: a subquery's ORDER BY is
        // the sort of thing a planner is entitled to drop, and key order is
        // the whole point of reading the ordinal.
        return columns.OrderBy(c => c.Ordinal).Select(c => c.Name).ToList();
    }

    /// <summary>A key as an operator would write it, and "nothing" for a table that has none.</summary>
    private static string Describe(IReadOnlyList<string> columns) =>
        columns.Count == 0 ? "nothing" : "(" + string.Join(", ", columns) + ")";

    private static string Quote(string identifier) =>
        '"' + identifier.Replace("\"", "\"\"", StringComparison.Ordinal) + '"';

    /// <summary>
    /// The provider switch, exposed so a test can build a context without the
    /// whole platform.
    /// </summary>
    public static void Configure(DbContextOptionsBuilder builder, ConnectorDatabaseOptions database)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(database);

        switch (database.Provider)
        {
            case ConnectorDatabaseProvider.Postgres:
                builder.UseNpgsql(database.ConnectionString);
                break;
            case ConnectorDatabaseProvider.Sqlite:
                builder.UseSqlite(database.ConnectionString);
                break;
            default:
                throw new ArgumentOutOfRangeException(
                    nameof(database), database.Provider, "unknown database provider");
        }
    }

    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        ArgumentNullException.ThrowIfNull(configurationBuilder);

        configurationBuilder.Properties<DateTimeOffset>()
            .HaveConversion<UtcInstantConverter>()
            .HaveMaxLength(UtcInstantConverter.StoredLength)
            .AreUnicode(false);
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);

        modelBuilder.Entity<SessionRow>(e =>
        {
            e.ToTable("sessions");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(128);
            e.Property(x => x.State).HasConversion<string>().HasMaxLength(32);
            e.Property(x => x.DeviceClass).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.AgentId).HasMaxLength(64);
            e.Property(x => x.ProfileId).HasMaxLength(64);
            e.Property(x => x.Label).HasMaxLength(128);
            e.Property(x => x.ConsentTermsVersion).HasMaxLength(32);
            // Every authorisation check is (subject, provider); nothing else
            // may reach a session, so this is the index that matters.
            e.HasIndex(x => new { x.Subject, x.ProviderId });
            e.HasIndex(x => x.ExpiresAt);
        });

        modelBuilder.Entity<JobRow>(e =>
        {
            e.ToTable("jobs");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.SessionId).HasMaxLength(64);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.ResourceId).HasMaxLength(64);
            e.Property(x => x.LeaseOwner).HasMaxLength(64);
            e.Property(x => x.ProfileId).HasMaxLength(64);
            e.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.State).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Step).HasConversion<string>().HasMaxLength(32);
            e.Property(x => x.Trigger).HasMaxLength(16);
            e.Property(x => x.ErrorCode).HasConversion<string>().HasMaxLength(32);
            // The leasing query filters on exactly this pair, and a lease
            // that scans the table is a lease that loses races.
            e.HasIndex(x => new { x.State, x.ProviderId });
            e.HasIndex(x => x.SessionId);
            e.HasIndex(x => x.LeaseExpiresAt);
            // The operator reads the history by provider, newest first, and
            // health is a month of one provider's rows (#441 L1): without this
            // pair both are a scan of a table that is never purged.
            e.HasIndex(x => new { x.ProviderId, x.CreatedAt });
        });

        modelBuilder.Entity<ChallengeRow>(e =>
        {
            e.ToTable("challenges");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.JobId).HasMaxLength(64);
            e.Property(x => x.Type).HasConversion<string>().HasMaxLength(32);
            e.HasIndex(x => x.JobId);
            e.HasIndex(x => x.ExpiresAt);
        });

        modelBuilder.Entity<ResultRow>(e =>
        {
            e.ToTable("results");

            // A RECORD ID IS UNIQUE PER RESOURCE OF A SESSION, not per session,
            // and the key has to say the same thing as the index below it. The
            // id is minted from (session, external_id) alone - deliberately,
            // because a transaction names its account by that id and the tie
            // only holds if the account staged alongside the transactions
            // carries the id it carried on the accounts page. So the same
            // account lands under two resources of one session, once each,
            // and every bank provider does exactly that on its second fetch.
            //
            // The key was the id alone, which refused that second row: the
            // fetch failed as internal, the inline host expired the session
            // and an agent host left the job on the queue until its lease
            // burned. Nothing else in the dedupe, the index or the readers
            // ever looked a row up by id without its resource, so this is the
            // only line that said something different.
            e.HasKey(x => new { x.Id, x.Resource });
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.JobId).HasMaxLength(64);
            e.Property(x => x.SessionId).HasMaxLength(64);
            e.Property(x => x.Resource).HasMaxLength(64);
            e.Property(x => x.ExternalId).HasMaxLength(256);
            e.Property(x => x.ContentHash).HasMaxLength(80);
            e.Property(x => x.Cursor).HasMaxLength(64);
            // (session, resource, external_id) uniqueness is what makes a
            // re-run free for the caller: a repeat never duplicates.
            e.HasIndex(x => new { x.SessionId, x.Resource, x.ExternalId }).IsUnique();
            e.HasIndex(x => x.Cursor);
            e.HasIndex(x => x.CreatedAt);
        });

        modelBuilder.Entity<AgentRow>(e =>
        {
            e.ToTable("agents");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.Name).HasMaxLength(128);
            e.Property(x => x.Class).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.OwnerSubject).HasMaxLength(128);
            e.Property(x => x.TokenHash).HasMaxLength(80);
            e.HasIndex(x => x.TokenHash).IsUnique();
            e.HasIndex(x => x.OwnerSubject);
        });

        modelBuilder.Entity<ProfileRow>(e =>
        {
            e.ToTable("profiles");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.AgentId).HasMaxLength(64);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(128);
            e.HasIndex(x => x.AgentId);

            // ONE PROFILE PER MACHINE, PROVIDER AND ACCOUNT HOLDER, held here
            // rather than asserted in a comment. A persistent profile IS a
            // browser directory: two of them for the same person and provider
            // on one agent means two browsers, and a bank that trusts one of
            // them does not trust the other.
            //
            // Null subjects stay distinct, on both providers this runs on, and
            // that is load-bearing rather than tolerated: a heartbeat inserts
            // profiles the agent derived on its own, has no subject to give
            // them, and must never be refused by this index. The last time a
            // profile insert could fail it took the agent's liveness with it.
            e.HasIndex(x => new { x.AgentId, x.ProviderId, x.Subject }).IsUnique();
        });

        modelBuilder.Entity<ProviderStatusRow>(e =>
        {
            e.ToTable("provider_status");
            e.HasKey(x => x.ProviderId);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.State).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.ReasonKey).HasMaxLength(128);
        });

        modelBuilder.Entity<CanaryRow>(e =>
        {
            e.ToTable("canaries");

            // One per provider. A second canary for the same provider would
            // double the schedule and halve the meaning of its verdict.
            e.HasKey(x => x.ProviderId);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(128);
            e.Property(x => x.ResourceId).HasMaxLength(64);
            e.Property(x => x.LastJobId).HasMaxLength(64);
            e.Property(x => x.LastVerdict).HasMaxLength(512);
        });

        modelBuilder.Entity<JobArtifactRow>(e =>
        {
            e.ToTable("job_artifacts");
            e.HasKey(x => x.JobId);
            e.Property(x => x.JobId).HasMaxLength(64);
            e.Property(x => x.SessionId).HasMaxLength(64);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.DomDigest).HasMaxLength(128);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.SessionId);
            e.HasIndex(x => new { x.ProviderId, x.Status });
        });

        modelBuilder.Entity<JobTraceRow>(e =>
        {
            e.ToTable("job_traces");
            e.HasKey(x => x.JobId);
            e.Property(x => x.JobId).HasMaxLength(64);
            e.Property(x => x.SessionId).HasMaxLength(64);
            e.Property(x => x.ProviderId).HasMaxLength(64);
            e.HasIndex(x => x.ExpiresAt);
            e.HasIndex(x => x.SessionId);
            e.HasIndex(x => x.ProviderId);
        });

        modelBuilder.Entity<EnrollmentRow>(e =>
        {
            e.ToTable("enrollments");
            e.HasKey(x => x.CodeHash);
            e.Property(x => x.CodeHash).HasMaxLength(80);
            e.Property(x => x.Subject).HasMaxLength(128);
            e.Property(x => x.Name).HasMaxLength(128);
            e.HasIndex(x => x.ExpiresAt);
        });

        modelBuilder.Entity<PrivateAgentRequestRow>(e =>
        {
            e.ToTable("private_agent_requests");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.Subject).HasMaxLength(128);
            e.Property(x => x.State).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.AgentId).HasMaxLength(64);
            e.HasIndex(x => x.Subject);
            e.HasIndex(x => x.State);
        });
    }
}
