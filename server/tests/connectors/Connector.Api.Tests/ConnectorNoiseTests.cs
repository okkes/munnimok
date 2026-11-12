using Connector.Api;
using Sentry;
using Sentry.Protocol;

namespace Connector.Api.Tests;

public class ConnectorNoiseTests
{
    private static SentryEvent Thrown(params (string Type, string Value)[] chain)
    {
        var ev = new SentryEvent();
        ev.SentryExceptions = chain.Select(c => new SentryException { Type = c.Type, Value = c.Value }).ToArray();
        return ev;
    }

    [Fact]
    public void A_database_that_did_not_answer_is_one_issue_whoever_noticed()
    {
        // the expiry sweep and an agent's heartbeat of the same minutes: different words, one outage
        var sweep = Thrown(
            ("System.Net.Sockets.SocketException", "Name does not resolve"),
            ("Npgsql.NpgsqlException", "Name does not resolve"),
            ("System.InvalidOperationException", "An exception has been raised that is likely due to a transient failure."));
        var heartbeat = Thrown(
            ("System.TimeoutException", "Timeout during connection attempt"),
            ("Npgsql.NpgsqlException", "Failed to connect to 172.31.0.9:5432"));

        Assert.Equal([ConnectorNoise.UnreachableFingerprint], ConnectorNoise.Quiet(sweep)!.Fingerprint);
        Assert.Equal([ConnectorNoise.UnreachableFingerprint], ConnectorNoise.Quiet(heartbeat)!.Fingerprint);
    }

    [Fact]
    public void Efs_own_connection_line_never_reports_beside_its_exception()
    {
        var line = new SentryEvent
        {
            Logger = "Microsoft.EntityFrameworkCore.Database.Connection",
            Message = new SentryMessage { Formatted = "An error occurred using the connection to database 'connector' on server 'tcp://postgres:5432'." },
        };
        Assert.Null(ConnectorNoise.Quiet(line));
    }

    [Fact]
    public void Everything_else_leaves_as_itself_with_the_role_it_came_from()
    {
        var refused = ConnectorNoise.Quiet(Thrown(("Npgsql.PostgresException", "42703: column \"Nope\" does not exist")))!;
        Assert.Empty(refused.Fingerprint);
        Assert.Equal("control-plane", refused.Tags["role"]);

        // a query that ran past its time is a slow query, not an outage
        var slow = ConnectorNoise.Quiet(Thrown(
            ("System.TimeoutException", "Timeout during reading attempt"),
            ("Npgsql.NpgsqlException", "Exception while reading from stream"),
            ("System.InvalidOperationException", "An exception has been raised that is likely due to a transient failure.")))!;
        Assert.Empty(slow.Fingerprint);

        var changed = ConnectorNoise.Quiet(new SentryEvent { Message = new SentryMessage { Formatted = "job job_1 (Login/asn) failed: provider_changed" } })!;
        Assert.Empty(changed.Fingerprint);
        Assert.Equal("control-plane", changed.Tags["role"]);
    }
}
