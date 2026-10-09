using Connector.Kit.AgentProtocol;
using Connector.Kit.Errors;
using Connector.Kit.Hosting.Data;
using Connector.Kit.Hosting.Jobs;
using Connector.Kit.Jobs;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Connector.Api.Tests;

/// <summary>
/// The inline runner's lease renewal ends the way it started: told to
/// stop, waited for, and only then is its stop source disposed.
///
/// GlitchTip #23/#29 (2026-10-06..09, 98 events in production): the source
/// was disposed under a loop still awaiting it, the loop threw
/// ObjectDisposedException into a task nobody awaited, and the finalizer
/// reported it as an unobserved exception - once per inline job. These
/// drive the loop against a queue double, with the ttl in milliseconds.
/// </summary>
public sealed class LeaseRenewalTests
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMilliseconds(60);

    [Fact]
    public async Task Disposal_stops_the_loop_and_waits_for_it_before_the_source_goes()
    {
        var queue = new QueueDouble { Answer = (_, _) => Task.FromResult<DateTimeOffset?>(DateTimeOffset.UtcNow.AddMinutes(1)) };
        var log = new RecordingLog();

        var renewal = LeaseRenewal.Start(Scopes(queue), "job_renewed", InlineJobRunner.AgentId, Ttl, log, CancellationToken.None);
        await queue.RenewedAsync(atLeast: 2);

        await renewal.DisposeAsync();

        Assert.True(renewal.Loop.IsCompletedSuccessfully, "the loop ended by cancellation, observed by the disposal - never faulted");
        var seen = queue.Renewals;
        await Task.Delay(Ttl * 3);
        Assert.Equal(seen, queue.Renewals);
        Assert.Empty(log.Lines(LogLevel.Warning));
        Assert.Equal("agt_inline", queue.Owner);
    }

    [Fact]
    public async Task A_renewal_in_flight_at_disposal_is_cancelled_not_abandoned()
    {
        var queue = new QueueDouble
        {
            Answer = async (_, ct) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return null;
            },
        };

        var renewal = LeaseRenewal.Start(Scopes(queue), "job_slow", InlineJobRunner.AgentId, Ttl, new RecordingLog(), CancellationToken.None);
        await queue.RenewedAsync(atLeast: 1);

        var disposal = renewal.DisposeAsync().AsTask();
        await disposal.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(renewal.Loop.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task A_lost_lease_ends_the_loop_with_a_warning_not_an_error()
    {
        var queue = new QueueDouble { Answer = (_, _) => Task.FromResult<DateTimeOffset?>(null) };
        var log = new RecordingLog();

        await using var renewal = LeaseRenewal.Start(Scopes(queue), "job_lost", InlineJobRunner.AgentId, Ttl, log, CancellationToken.None);
        await renewal.Loop.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(1, queue.Renewals);
        var warning = Assert.Single(log.Lines(LogLevel.Warning));
        Assert.Contains("job_lost", warning, StringComparison.Ordinal);
        Assert.Contains("took the job back", warning, StringComparison.Ordinal);
        Assert.Empty(log.Lines(LogLevel.Error));
    }

    [Fact]
    public async Task A_renewal_that_fails_this_round_is_tried_again_next_round()
    {
        var queue = new QueueDouble
        {
            Answer = (n, _) => n == 1
                ? throw new InvalidOperationException("the database did not answer")
                : Task.FromResult<DateTimeOffset?>(DateTimeOffset.UtcNow.AddMinutes(1)),
        };
        var log = new RecordingLog();

        await using (var renewal = LeaseRenewal.Start(Scopes(queue), "job_hiccup", InlineJobRunner.AgentId, Ttl, log, CancellationToken.None))
        {
            await queue.RenewedAsync(atLeast: 3);
            Assert.False(renewal.Loop.IsCompleted, "one failed round does not end the lease");
        }

        var warning = Assert.Single(log.Lines(LogLevel.Warning));
        Assert.Contains("tried again", warning, StringComparison.Ordinal);
        Assert.Empty(log.Lines(LogLevel.Error));
    }

    private static IServiceScopeFactory Scopes(ILeasedJobQueue queue) =>
        new ServiceCollection()
            .AddSingleton(queue)
            .BuildServiceProvider()
            .GetRequiredService<IServiceScopeFactory>();

    /// <summary>The queue as the renewal sees it: one method answered by the test, every other one out of bounds.</summary>
    private sealed class QueueDouble : ILeasedJobQueue
    {
        private int _renewals;

        public required Func<int, CancellationToken, Task<DateTimeOffset?>> Answer { get; init; }

        public int Renewals => Volatile.Read(ref _renewals);

        public string? Owner { get; private set; }

        public async Task RenewedAsync(int atLeast)
        {
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (Renewals < atLeast)
            {
                Assert.True(DateTime.UtcNow < deadline, $"only {Renewals} renewal(s) in five seconds");
                await Task.Delay(5);
            }
        }

        public Task<DateTimeOffset?> RenewLeaseAsync(string jobId, string agentId, TimeSpan leaseTtl, CancellationToken ct)
        {
            Owner = agentId;
            var n = Interlocked.Increment(ref _renewals);
            return Answer(n, ct);
        }

        public Task<JobRow> EnqueueAsync(NewJob job, CancellationToken ct) => throw new NotSupportedException();

        public Task<LeasedJob?> TryLeaseAsync(string agentId, string? ownerSubject, AgentCapabilities capabilities, IReadOnlyList<JobKind> accept, TimeSpan leaseTtl, CancellationToken ct) => throw new NotSupportedException();

        public Task<JobRow> CompleteAsync(string jobId, string? leaseOwner, CancellationToken ct) => throw new NotSupportedException();

        public Task<JobRow> FailAsync(string jobId, string? leaseOwner, ErrorCode code, string? detail, CancellationToken ct) => throw new NotSupportedException();

        public Task<int> RequeueExpiredLeasesAsync(CancellationToken ct) => throw new NotSupportedException();

        public Task<int> ExpireAbandonedAsync(CancellationToken ct) => throw new NotSupportedException();

        public Task ProgressAsync(string jobId, string? leaseOwner, ProgressReport report, CancellationToken ct) => throw new NotSupportedException();
    }

    private sealed class RecordingLog : ILogger
    {
        private readonly List<(LogLevel Level, string Line)> _lines = [];

        public IReadOnlyList<string> Lines(LogLevel level)
        {
            lock (_lines) return [.. _lines.Where(l => l.Level == level).Select(l => l.Line)];
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            lock (_lines) _lines.Add((logLevel, formatter(state, exception)));
        }
    }
}
