using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Munni.Api.Data;
using Npgsql;
using ConnectorStartup = Connector.Kit.Hosting.Data.DatabaseStartup;

namespace Munni.Api.Tests;

// #573: after a NAS restart docker starts the api and the connector before postgres resolves;
// both wait for the server up to a deadline instead of crashing into a restart loop
public class DatabaseStartupTests
{
    private static AppDbContext Unreachable() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=munni-db.invalid;Port=5432;Database=munni;Username=munni;Password=x;Timeout=2")
            .Options);

    [Fact]
    public async Task An_unreachable_server_is_retried_until_the_deadline_then_the_start_fails_with_the_cause()
    {
        using var db = Unreachable();
        var watch = Stopwatch.StartNew();
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            DatabaseStartup.WaitForServerAsync(db.Database, NullLogger.Instance, TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(100)));
        Assert.True(watch.Elapsed >= TimeSpan.FromMilliseconds(800), $"waited {watch.Elapsed} before giving up");
        Assert.IsType<NpgsqlException>(ex as NpgsqlException ?? ex.InnerException, exactMatch: false);
    }

    [Fact]
    public async Task The_connector_waits_the_same_way()
    {
        using var db = Unreachable();
        var watch = Stopwatch.StartNew();
        var ex = await Assert.ThrowsAnyAsync<Exception>(() =>
            ConnectorStartup.WaitForServerAsync(db.Database, NullLogger.Instance, TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(100)));
        Assert.True(watch.Elapsed >= TimeSpan.FromMilliseconds(800), $"waited {watch.Elapsed} before giving up");
        Assert.IsType<NpgsqlException>(ex as NpgsqlException ?? ex.InnerException, exactMatch: false);
    }

    [Fact]
    public async Task A_provider_without_a_server_does_not_wait()
    {
        using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase("startup-wait").Options);
        var watch = Stopwatch.StartNew();
        await DatabaseStartup.WaitForServerAsync(db.Database, NullLogger.Instance, TimeSpan.FromMinutes(5));
        await ConnectorStartup.WaitForServerAsync(db.Database, NullLogger.Instance, TimeSpan.FromMinutes(5));
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), $"waited {watch.Elapsed} for a provider that has no server");
    }
}
