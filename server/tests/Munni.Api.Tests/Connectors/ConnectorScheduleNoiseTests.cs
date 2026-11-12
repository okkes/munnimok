using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Munni.Api.Connectors;
using Xunit;

namespace Munni.Api.Tests.Connectors;

/// <summary>
/// GlitchTip 17–19 (2026-10-05): a deploy, a router swap or a container
/// restart makes a schedule cycle that cannot reach the control plane at
/// all. The next tick handles it, so it is a warning — the error that pages
/// the operator waits for the outage to last three cycles; a fault in the
/// cycle itself still reports at once.
/// </summary>
public class ConnectorScheduleNoiseTests
{
    private sealed class CapturingLogger : ILogger<ConnectorScheduleService>
    {
        public List<(LogLevel Level, string Message)> Lines { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add((logLevel, formatter(state, exception)));
    }

    private static (ConnectorScheduleService Service, CapturingLogger Log) Build(Action<IServiceCollection>? register = null)
    {
        var log = new CapturingLogger();
        var services = new ServiceCollection();
        register?.Invoke(services);
        var scopes = services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>();
        return (new ConnectorScheduleService(scopes, TimeProvider.System, log), log);
    }

    /// <summary>A cycle whose first call times out the way HttpClient reports it: a TaskCanceledException nobody asked for.</summary>
    private static (ConnectorScheduleService Service, CapturingLogger Log) BuildTimingOut() =>
        Build(services => services.AddScoped<ConnectorRelay>(_ => throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout of 10 seconds elapsing.")));

    [Fact]
    public async Task A_call_that_times_out_costs_the_cycle_and_never_the_service()
    {
        var (service, log) = BuildTimingOut();

        // an exception that leaves a BackgroundService stops the host — here that is the whole api
        await service.CycleAsync(CancellationToken.None);

        var line = Assert.Single(log.Lines);
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Contains("cycle 1 of 3", line.Message);
    }

    [Fact]
    public async Task The_hosts_own_stop_still_ends_the_cycle()
    {
        var (service, log) = BuildTimingOut();
        using var stopping = new CancellationTokenSource();
        await stopping.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.CycleAsync(stopping.Token));
        Assert.Empty(log.Lines);
    }

    [Fact]
    public void A_transport_failure_is_what_a_restart_or_a_dead_gateway_looks_like()
    {
        Assert.True(ConnectorScheduleService.IsTransport(new HttpRequestException("Name does not resolve (connector:8080)")));
        Assert.True(ConnectorScheduleService.IsTransport(new HttpRequestException("Response status code does not indicate success: 502 (Bad Gateway).")));
        Assert.True(ConnectorScheduleService.IsTransport(new System.Net.Sockets.SocketException(11001)));
        Assert.True(ConnectorScheduleService.IsTransport(new TaskCanceledException("timed out")));
        Assert.True(ConnectorScheduleService.IsTransport(new ConnectorReplyException(new ConnectorReply(HttpStatusCode.BadGateway, null, null, null, null, null, null))));
        Assert.False(ConnectorScheduleService.IsTransport(new ConnectorReplyException(new ConnectorReply(HttpStatusCode.BadRequest, null, null, null, null, null, null))));
        Assert.False(ConnectorScheduleService.IsTransport(new InvalidOperationException("feed missing")));
    }

    [Fact]
    public void Unreachable_cycles_warn_until_the_third_in_a_row_and_a_fault_reports_at_once()
    {
        var (service, log) = Build();
        var unreachable = new HttpRequestException("Name does not resolve (connector:8080)");

        service.NoteCycleFailure(unreachable);
        service.NoteCycleFailure(unreachable);
        Assert.Equal([LogLevel.Warning, LogLevel.Warning], log.Lines.Select(l => l.Level));
        Assert.Contains("cycle 2 of 3", log.Lines[1].Message);

        service.NoteCycleFailure(unreachable);
        Assert.Equal(LogLevel.Error, log.Lines[2].Level);
        Assert.Contains("unreachable for 3 schedule cycles", log.Lines[2].Message);

        // a fourth stays quiet: the one error names the outage, the next cycle that works resets the count
        service.NoteCycleFailure(unreachable);
        Assert.Equal(LogLevel.Warning, log.Lines[3].Level);

        service.NoteCycleFailure(new InvalidOperationException("feed missing"));
        Assert.Equal(LogLevel.Error, log.Lines[4].Level);
        Assert.Equal("connector schedule cycle failed", log.Lines[4].Message);
    }
}
