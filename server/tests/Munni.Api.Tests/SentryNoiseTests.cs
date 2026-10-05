using Munni.Api;
using Sentry;
using Sentry.Protocol;

namespace Munni.Api.Tests;

public class SentryNoiseTests
{
    private static SentryEvent LogEvent(string logger, string message)
    {
        return new SentryEvent
        {
            Logger = logger,
            Message = new SentryMessage { Formatted = message },
        };
    }

    [Fact]
    public void MutesHandledInsertRaceCommandLogs()
    {
        var ev = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (771ms) [Parameters=[...]]\nINSERT INTO \"UserDevices\" (\"Id\", \"UserId\") VALUES (@p0, @p1);");
        Assert.True(SentryNoise.IsHandledRace(ev));

        var attach = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (238ms)\nINSERT INTO \"SpaceAccountLinks\" (\"Id\") VALUES (@p0);");
        Assert.True(SentryNoise.IsHandledRace(attach));
    }

    [Fact]
    public void MutesThePushesRetriedInsertRaceLogLineButNotItsSpentRetriesException()
    {
        // GlitchTip 10 (2026-10-05): a push racing another device's push on the same new row retries — the failed attempt's log line is noise
        var rows = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (674ms) [Parameters=[@p0='?']]\nINSERT INTO \"EntityRows\" (\"SpaceId\", \"Entity\", \"EntityId\") VALUES (@p0, @p1, @p2);");
        Assert.True(SentryNoise.IsHandledRace(rows));
        var ops = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (12ms)\nINSERT INTO \"SyncOps\" (\"SpaceId\", \"Seq\") VALUES (@p0, @p1);");
        Assert.True(SentryNoise.IsHandledRace(ops));
        // the exception the push throws once its retries are spent still reports: only the Users/UserDevices/links races are swallowed for good
        var spent = new SentryEvent();
        spent.SentryExceptions = new[]
        {
            new SentryException { Type = "Npgsql.PostgresException", Value = "23505: duplicate key value violates unique constraint \"PK_EntityRows\"" },
        };
        Assert.False(SentryNoise.IsHandledRace(spent));
    }

    [Fact]
    public void MutesTheRedundantSaveChangesLogLine()
    {
        var ev = LogEvent(
            "Microsoft.EntityFrameworkCore.Update",
            "An error occurred while saving the entity changes. See the inner exception for details.");
        Assert.True(SentryNoise.IsHandledRace(ev));
    }

    [Fact]
    public void KeepsEveryOtherDatabaseFailure()
    {
        // an insert into a table whose races are NOT handled must report
        var other = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (100ms)\nINSERT INTO \"Transactions\" (\"Id\") VALUES (@p0);");
        Assert.False(SentryNoise.IsHandledRace(other));

        // reads, timeouts, anything without the raced tables
        var timeout = LogEvent(
            "Microsoft.EntityFrameworkCore.Database.Command",
            "Failed executing DbCommand (30000ms)\nSELECT * FROM \"Spaces\";");
        Assert.False(SentryNoise.IsHandledRace(timeout));

        // non-EF loggers never match
        var app = LogEvent("Munni.Api.Banking", "INSERT INTO \"UserDevices\" mentioned in text");
        Assert.False(SentryNoise.IsHandledRace(app));
    }

    [Fact]
    public void MutesTheCaughtUniqueViolationExceptionChain()
    {
        var ev = new SentryEvent();
        ev.SentryExceptions = new[]
        {
            new SentryException
            {
                Type = "Npgsql.PostgresException",
                Value = "23505: duplicate key value violates unique constraint \"IX_SpaceAccountLinks_SpaceId_FeedSpaceId_AccountId\"",
            },
        };
        Assert.True(SentryNoise.IsHandledRace(ev));

        var unrelated = new SentryEvent();
        unrelated.SentryExceptions = new[]
        {
            new SentryException { Type = "Npgsql.PostgresException", Value = "23505: duplicate key value violates unique constraint \"IX_Receipts_Something\"" },
        };
        Assert.False(SentryNoise.IsHandledRace(unrelated));
    }
}
