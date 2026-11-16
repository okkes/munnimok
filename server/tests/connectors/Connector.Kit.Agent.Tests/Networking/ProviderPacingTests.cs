using System.Diagnostics;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Networking;

namespace Connector.Kit.Agent.Tests.Networking;

// a browser navigation is Chromium's socket and bypasses the HTTP handler, so GatedPacer paces it (unpaced, Amazon gave 503)
// real 60ms waits: the clocks here override GetUtcNow only, so a fake clock proves a delay was requested, not that it
// happened
public sealed class ProviderPacingTests
{
    private static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(60);

    // the delay and the stopwatch read different clocks and Windows timer granularity is ~15ms: a real wait can measure
    // just under
    private static readonly TimeSpan Slack = TimeSpan.FromMilliseconds(5);

    private static TimeSpan AtLeast(TimeSpan wanted) => wanted - Slack;

    [Fact]
    public async Task A_second_call_to_the_same_provider_waits_for_the_gap()
    {
        var pacer = new GatedPacer(new PolitenessGate(), "amazon-nl", Gap);

        var elapsed = await TimeAsync(async () =>
        {
            (await pacer.EnterAsync(CancellationToken.None)).Dispose();
            (await pacer.EnterAsync(CancellationToken.None)).Dispose();
        });

        // at least, never exactly: the gate adds up to 50% jitter on purpose (exact intervals look machine-shaped)
        Assert.True(elapsed >= AtLeast(Gap), $"the second call came back after {elapsed.TotalMilliseconds:F0}ms");
    }

    // the gap starts when a call finishes: releasing at the request would let it run down while the page loads
    [Fact]
    public async Task The_gap_is_measured_from_the_end_of_the_call_before_it()
    {
        var pacer = new GatedPacer(new PolitenessGate(), "amazon-nl", Gap);

        var elapsed = await TimeAsync(async () =>
        {
            var ticket = await pacer.EnterAsync(CancellationToken.None);
            await Task.Delay(Gap, CancellationToken.None);
            ticket.Dispose();

            (await pacer.EnterAsync(CancellationToken.None)).Dispose();
        });

        Assert.True(
            elapsed >= AtLeast(Gap + Gap),
            $"a call that itself took {Gap.TotalMilliseconds:F0}ms was followed after only " +
            $"{elapsed.TotalMilliseconds:F0}ms");
    }

    // one gate, per-provider pacing: a global limit would let a slow Amazon walk delay Bol's fetch
    [Fact]
    public async Task One_provider_being_slowed_does_not_slow_another()
    {
        var gate = new PolitenessGate();
        var amazon = new GatedPacer(gate, "amazon-nl", TimeSpan.FromSeconds(30));
        var bol = new GatedPacer(gate, "bol", TimeSpan.Zero);

        (await amazon.EnterAsync(CancellationToken.None)).Dispose();

        var elapsed = await TimeAsync(async () =>
            (await bol.EnterAsync(CancellationToken.None)).Dispose());

        Assert.True(
            elapsed < TimeSpan.FromSeconds(5),
            $"bol waited {elapsed.TotalMilliseconds:F0}ms behind amazon's thirty-second gap");
    }

    // two jobs on one provider share one gate: per-job pacing would double the rate at the provider
    [Fact]
    public async Task Two_jobs_on_the_same_provider_share_one_pace()
    {
        var gate = new PolitenessGate();

        var first = new GatedPacer(gate, "amazon-nl", Gap);
        var second = new GatedPacer(gate, "amazon-nl", Gap);

        var elapsed = await TimeAsync(async () =>
        {
            (await first.EnterAsync(CancellationToken.None)).Dispose();
            (await second.EnterAsync(CancellationToken.None)).Dispose();
        });

        Assert.True(
            elapsed >= AtLeast(Gap),
            $"a second job reached the same provider after {elapsed.TotalMilliseconds:F0}ms");
    }

    // a 429's penalty outlives the run that met it: it holds back the next press and every other job in this agent
    [Fact]
    public async Task A_backoff_holds_back_a_pacer_that_never_met_the_refusal()
    {
        var gate = new PolitenessGate();

        var refused = new GatedPacer(gate, "amazon-nl", TimeSpan.Zero);
        var innocent = new GatedPacer(gate, "amazon-nl", TimeSpan.Zero);

        // timed from the penalty: it is a deadline that starts running when set
        var elapsed = await TimeAsync(async () =>
        {
            refused.Backoff(Gap);
            (await innocent.EnterAsync(CancellationToken.None)).Dispose();
        });

        Assert.True(
            elapsed >= AtLeast(Gap),
            $"a pacer with no gap of its own went through after {elapsed.TotalMilliseconds:F0}ms");
    }

    // the default Pacer and what an inline job keeps: its HTTP client already carries the limiter, so pacing would
    // charge two gaps
    [Fact]
    public async Task An_unpaced_provider_costs_nothing_and_swallows_nothing()
    {
        var pacer = UnpacedProvider.Instance;

        var elapsed = await TimeAsync(async () =>
        {
            for (var call = 0; call < 50; call++)
            {
                (await pacer.EnterAsync(CancellationToken.None)).Dispose();
                pacer.Backoff(TimeSpan.FromHours(1));
            }
        });

        // also after an hour-long backoff: a no-op that started honouring one would stall a fleet
        Assert.True(elapsed < TimeSpan.FromSeconds(1), $"fifty free calls took {elapsed.TotalMilliseconds:F0}ms");
    }

    [Fact]
    public async Task A_cancelled_wait_never_leaves_the_provider_locked()
    {
        var gate = new PolitenessGate();
        var pacer = new GatedPacer(gate, "amazon-nl", TimeSpan.Zero);

        pacer.Backoff(TimeSpan.FromMinutes(10));

        using var giveUp = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pacer.EnterAsync(giveUp.Token));

        // the penalty stands, so a call on a different provider through the same gate returning proves the semaphore was released
        var other = new GatedPacer(gate, "bol", TimeSpan.Zero);
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        (await other.EnterAsync(patience.Token)).Dispose();
    }

    private static async Task<TimeSpan> TimeAsync(Func<Task> work)
    {
        var clock = Stopwatch.StartNew();
        await work();
        return clock.Elapsed;
    }
}
