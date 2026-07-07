using Microsoft.EntityFrameworkCore;

namespace Munni.Api.Data;

/// <summary>
/// One-time self-heal for databases created by the old EnsureCreated
/// startup (before migrations existed). Those databases have the core
/// tables but no __EFMigrationsHistory (and possibly no GoCardless
/// tables), so a plain Migrate() dies on "relation already exists".
///
/// If we find core tables without migration history: create the missing
/// GoCardless tables idempotently, then record the Initial migration as
/// applied. Safe to delete once every deployment has run it once.
/// </summary>
public static class LegacyBaseline
{
    // must match Migrations/20260707074154_Initial.cs
    private const string InitialMigrationId = "20260707074154_Initial";
    private const string EfProductVersion = "10.0.9";

    public static async Task ApplyIfNeededAsync(AppDbContext db, ILogger logger)
    {
        var hasUsers = await TableExistsAsync(db, "Users");
        if (!hasUsers) return; // fresh database — plain migrate handles it

        var applied = await db.Database.GetAppliedMigrationsAsync();
        if (applied.Any()) return; // already on migrations

        logger.LogWarning("legacy EnsureCreated database detected — baselining to {Migration}", InitialMigrationId);

        // tables added after the last EnsureCreated-era image; IF NOT EXISTS
        // keeps this idempotent whichever legacy image built the schema
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS "GcLinkedAccounts" (
                "GcAccountId" text NOT NULL,
                "SpaceId" text NOT NULL,
                "AccountEntityId" text NOT NULL,
                "Iban" text NOT NULL,
                "Currency" text NOT NULL,
                "RequisitionId" uuid NOT NULL,
                "LastFetchAt" timestamp with time zone,
                CONSTRAINT "PK_GcLinkedAccounts" PRIMARY KEY ("GcAccountId")
            );
            CREATE INDEX IF NOT EXISTS "IX_GcLinkedAccounts_SpaceId" ON "GcLinkedAccounts" ("SpaceId");
            CREATE TABLE IF NOT EXISTS "GcRequisitions" (
                "Id" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "SpaceId" text NOT NULL,
                "InstitutionId" text NOT NULL,
                "RequisitionId" text NOT NULL,
                "Status" text NOT NULL,
                "CreatedAt" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_GcRequisitions" PRIMARY KEY ("Id")
            );
            CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" (
                "MigrationId" character varying(150) NOT NULL,
                "ProductVersion" character varying(32) NOT NULL,
                CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId")
            );
            """);
        await db.Database.ExecuteSqlAsync(
            $"""INSERT INTO "__EFMigrationsHistory" ("MigrationId", "ProductVersion") VALUES ({InitialMigrationId}, {EfProductVersion}) ON CONFLICT DO NOTHING;""");

        logger.LogWarning("legacy database baselined successfully");
    }

    private static async Task<bool> TableExistsAsync(AppDbContext db, string table)
    {
        var conn = db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = @name)";
        var p = cmd.CreateParameter();
        p.ParameterName = "@name";
        p.Value = table;
        cmd.Parameters.Add(p);
        return (bool)(await cmd.ExecuteScalarAsync() ?? false);
    }
}
