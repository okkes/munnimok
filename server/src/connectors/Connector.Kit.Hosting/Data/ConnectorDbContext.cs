using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace Connector.Kit.Hosting.Data;

/// one schema on Postgres (production) and Sqlite (tests): enums as strings, JSON as text not jsonb, UTC DateTimeOffset
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

    public DbSet<CanaryRow> Canaries => Set<CanaryRow>();

    public DbSet<JobArtifactRow> JobArtifacts => Set<JobArtifactRow>();

    public DbSet<JobTraceRow> JobTraces => Set<JobTraceRow>();

    /// migrations are scaffolded for Npgsql only; other providers take EnsureCreated, which creates missing tables
    /// and touches nothing existing, hence AssertSchemaMatchesModelAsync follows it
    public async Task EnsureCreatedOrMigrateAsync(CancellationToken ct = default)
    {
        // a migration carries one provider's SQL, so Sqlite takes EnsureCreated; a dev .db persists and keeps an old schema
        if (Database.IsNpgsql() && Database.GetMigrations().Any())
        {
            await Database.MigrateAsync(ct);
            return;
        }

        await Database.EnsureCreatedAsync(ct);
        await AssertSchemaMatchesModelAsync(ct);
    }

    /// EnsureCreated adds no columns to existing tables: a stale database boots, then 500s on the first write of one
    /// one empty SELECT per table naming every model column; a mismatch refuses start-up with the table named
    /// the key is checked separately: that SELECT cannot see it
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

            // WHERE 1 = 0 reads nothing but resolves every name; identifiers come from the compiled EF model via Quote
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

    /// the column probe cannot see a moved primary key: it resolves against a table still keyed on Id alone
    /// that hit a dev .db when results became keyed (Id, Resource): UNIQUE constraint failed: results.Id
    /// only on the EnsureCreated path: Postgres migrates and its migration carries the key change
    private async Task AssertPrimaryKeyMatchesModelAsync(IEntityType entity, string table, CancellationToken ct)
    {
        if (entity.FindPrimaryKey() is not { } key) return;

        var actual = await ReadPrimaryKeyAsync(table, ct);
        if (actual is null) return;

        // key order matters: (Id, Resource) and (Resource, Id) index differently; ordinal compare, these are our identifiers
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

    /// null when this build cannot ask the provider, leaving the column probe as the only guard
    /// no portable SQL for keys (pg_index vs a PRAGMA); only Sqlite is written, the only one arriving with an old database
    private async Task<IReadOnlyList<string>?> ReadPrimaryKeyAsync(string table, CancellationToken ct)
    {
        if (!Database.IsSqlite()) return null;

        var columns = new List<(long Ordinal, string Name)>();

        // ADO because this reads rows back; Open/CloseConnection nest, so the facade is left as found
        await Database.OpenConnectionAsync(ct);
        try
        {
            await using var command = Database.GetDbConnection().CreateCommand();

            // pragma_table_info takes the table name as a parameter; pk is 0 outside the key, else its 1-based position
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

        // sorted here: a planner may drop a subquery's ORDER BY, and key order is the point
        return columns.OrderBy(c => c.Ordinal).Select(c => c.Name).ToList();
    }

    private static string Describe(IReadOnlyList<string> columns) =>
        columns.Count == 0 ? "nothing" : "(" + string.Join(", ", columns) + ")";

    private static string Quote(string identifier) =>
        '"' + identifier.Replace("\"", "\"\"", StringComparison.Ordinal) + '"';

    /// exposed so a test can build a context without the whole platform
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
            // every authorisation check is (subject, provider); nothing else reaches a session
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
            e.Property(x => x.AgentId).HasMaxLength(64);
            e.HasIndex(x => x.AgentId);
            e.Property(x => x.ProfileId).HasMaxLength(64);
            e.Property(x => x.Kind).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.State).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Step).HasConversion<string>().HasMaxLength(32);
            e.Property(x => x.Trigger).HasMaxLength(16);
            e.Property(x => x.ErrorCode).HasConversion<string>().HasMaxLength(32);
            // the leasing query filters on this pair; a lease that scans loses races
            e.HasIndex(x => new { x.State, x.ProviderId });
            e.HasIndex(x => x.SessionId);
            e.HasIndex(x => x.LeaseExpiresAt);
            // the operator reads history by provider newest first, and health is a month of one provider's rows (#441 L1)
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

            // a record id is unique per resource of a session: minted from (session, external_id) so a transaction's account tie holds
            // the same account lands under two resources, once each, on every bank provider's second fetch
            // the key was the id alone, which refused that row and failed the fetch as internal
            e.HasKey(x => new { x.Id, x.Resource });
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.JobId).HasMaxLength(64);
            e.Property(x => x.SessionId).HasMaxLength(64);
            e.Property(x => x.Resource).HasMaxLength(64);
            e.Property(x => x.ExternalId).HasMaxLength(256);
            e.Property(x => x.ContentHash).HasMaxLength(80);
            e.Property(x => x.Cursor).HasMaxLength(64);
            // makes a re-run free for the caller: a repeat never duplicates
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

            // one profile per machine, provider and account holder: two for one person on one agent are two browsers
            // null subjects stay distinct: a heartbeat inserts agent-derived profiles with no subject and must never be refused
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

            // one per provider: a second canary would double the schedule and halve the meaning of its verdict
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
