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

    // performance tracing (user 2026-10-09): the environment's share, read invariantly; nonsense is the default, 0 is errors only
    [Theory]
    [InlineData(null, 0.2)]
    [InlineData("", 0.2)]
    [InlineData("0.5", 0.5)]
    [InlineData("0,5", 0.2)]
    [InlineData("1", 1.0)]
    [InlineData("0", 0.0)]
    [InlineData("7", 0.2)]
    [InlineData("-1", 0.2)]
    [InlineData("all", 0.2)]
    public void ReadsTheTracesSampleRateInvariantlyWithinTheShare(string? configured, double expected)
    {
        Assert.Equal(expected, SentryNoise.TracesSampleRate(configured));
    }

    [Fact]
    public void HeartbeatsAreNeverATransaction()
    {
        Assert.True(SentryNoise.IsHeartbeat("GET /health"));
        Assert.True(SentryNoise.IsHeartbeat("GET /v1/health"));
        Assert.True(SentryNoise.IsHeartbeat("GET /sync/events"));
        Assert.True(SentryNoise.IsHeartbeat("POST /v1/agents/{agentId}/heartbeat"));
        Assert.False(SentryNoise.IsHeartbeat("POST /sync/{spaceId}/push"));
        Assert.False(SentryNoise.IsHeartbeat(null));
    }

    [Fact]
    public void SamplesAtTheRateExceptHeartbeatsAndKeepsTheWebAppsDecision()
    {
        Assert.Equal(0.2, SentryNoise.SampleTrace(new TransactionContext("POST /sync/{spaceId}/push", "http.server"), 0.2));
        Assert.Equal(0, SentryNoise.SampleTrace(new TransactionContext("GET /health", "http.server"), 0.2));
        Assert.Equal(0, SentryNoise.SampleTrace(new TransactionContext("GET /sync/events", "http.server"), 0.2));
        // the sync push of a traced Confirm shows end to end; an unsampled web trace stays unsampled here too
        Assert.Equal(1, SentryNoise.SampleTrace(new TransactionContext("POST /sync/{spaceId}/push", "http.server", isParentSampled: true), 0.2));
        Assert.Equal(0, SentryNoise.SampleTrace(new TransactionContext("POST /sync/{spaceId}/push", "http.server", isParentSampled: false), 0.2));
        // errors only: nothing, whatever the parent said
        Assert.Equal(0, SentryNoise.SampleTrace(new TransactionContext("POST /sync/{spaceId}/push", "http.server", isParentSampled: true), 0));
    }
}
