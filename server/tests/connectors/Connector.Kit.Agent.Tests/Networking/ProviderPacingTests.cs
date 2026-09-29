using System.Diagnostics;
using Connector.Kit.Adapters;
using Connector.Kit.Agent.Networking;

namespace Connector.Kit.Agent.Tests.Networking;

/// <summary>
/// The gap between two calls to the same provider, and who it applies to.
///
/// <see cref="PolitenessGate"/> has been the platform's rate limit since the
/// beginning and had no test of its own, which was affordable while only one
/// thing used it. It is now two: the delegating handler on every job's HTTP
/// client, and <see cref="GatedPacer"/>, which an adapter holds around work
/// that handler cannot see - a browser navigation is Chromium's socket and
/// never passes through it. The Amazon walk ran unpaced for exactly that
/// reason, and Amazon eventually answered with 503.
///
/// These use real, tiny waits rather than a fake clock. The gate delays through
/// <c>TimeProvider</c>, but the clocks in this repo override
/// <c>GetUtcNow</c> alone and leave <c>CreateTimer</c> on the system timer, so
/// a fake clock here would prove that a delay was requested and never that one
/// happened. Sixty milliseconds is cheap enough to spend on the difference.
/// </summary>
public sealed class ProviderPacingTests
{
    private static readonly TimeSpan Gap = TimeSpan.FromMilliseconds(60);

    /// <summary>
    /// How much short of the gap still counts as having waited it.
    ///
    /// These assertions were written as <c>elapsed &gt;= Gap</c> and one of them
    /// duly failed at "went through after 60ms" against a 60ms gap. The delay
    /// and the stopwatch read different clocks, and Windows' timer granularity
    /// is around 15ms, so a wait that really happened can measure a hair under
    /// the number it was asked for.
    /// <para>
    /// A flaky test is worse than no test: it teaches whoever sees it red to
    /// look away. The signal here is 60ms against 0ms - whether the pacer
    /// waited at all - and five milliseconds of slack does not blunt that while
    /// removing the only way this can lie.
    /// </para>
    /// </summary>
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

        // At least, never exactly: the gate adds up to 50% jitter on purpose,
        // because a fleet whose calls land on an exact interval is more
        // machine-shaped than one that does not.
        Assert.True(elapsed >= AtLeast(Gap), $"the second call came back after {elapsed.TotalMilliseconds:F0}ms");
    }

    /// <summary>
    /// The gap starts when a call FINISHES, not when it starts.
    ///
    /// Which is why the ticket is a disposable rather than a plain await: an
    /// adapter that released at the request would let the gap run down while
    /// the page was still loading, and on any provider slower than the gap
    /// itself that paces precisely nothing.
    /// </summary>
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

        // Work plus gap, not whichever is larger. A gate that started counting
        // at the first entry would let the second call through immediately.
        Assert.True(
            elapsed >= AtLeast(Gap + Gap),
            $"a call that itself took {Gap.TotalMilliseconds:F0}ms was followed after only " +
            $"{elapsed.TotalMilliseconds:F0}ms");
    }

    /// <summary>
    /// One gate, many providers, and no queue between them.
    ///
    /// A single global rate limit would make a slow Amazon walk delay somebody
    /// else's Bol fetch, which is a shared-fate bug dressed as caution: the two
    /// providers have never heard of each other.
    /// </summary>
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

    /// <summary>
    /// Two jobs, one provider, one gate.
    ///
    /// The property the whole design turns on, and the one a per-job delay
    /// cannot give: two users syncing Amazon at the same moment are two
    /// sessions and one Amazon. Pacing each job independently would double the
    /// rate at the far end while both look perfectly well behaved from inside.
    /// </summary>
    [Fact]
    public async Task Two_jobs_on_the_same_provider_share_one_pace()
    {
        var gate = new PolitenessGate();

        // Separate pacers, as two concurrent jobs really get - built per job,
        // never handed around.
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

    /// <summary>
    /// Being told to slow down outlives the run that was told.
    ///
    /// The job that meets a 429 is already lost; the penalty is not for it. It
    /// is for the user who presses the button again ten seconds later, and for
    /// every other job in this agent that would otherwise walk straight into a
    /// provider that has just said stop.
    /// </summary>
    [Fact]
    public async Task A_backoff_holds_back_a_pacer_that_never_met_the_refusal()
    {
        var gate = new PolitenessGate();

        var refused = new GatedPacer(gate, "amazon-nl", TimeSpan.Zero);
        var innocent = new GatedPacer(gate, "amazon-nl", TimeSpan.Zero);

        // Timed from the penalty rather than from the entry, because the
        // penalty is a deadline and it starts running the moment it is set.
        var elapsed = await TimeAsync(async () =>
        {
            refused.Backoff(Gap);
            (await innocent.EnterAsync(CancellationToken.None)).Dispose();
        });

        // Its own gap is zero. Everything it waits is the penalty.
        Assert.True(
            elapsed >= AtLeast(Gap),
            $"a pacer with no gap of its own went through after {elapsed.TotalMilliseconds:F0}ms");
    }

    /// <summary>
    /// A pacer for a context that has nothing to pace really does nothing.
    ///
    /// The default on <see cref="IJobContext.Pacer"/>, and the one an inline
    /// job keeps: it has no browser at all, and its HTTP client already carries
    /// the limiter. Pacing there would charge two gaps for one request.
    /// </summary>
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

        // Including after an hour-long backoff: there is no gate to push out,
        // and a no-op that quietly started honouring one would stall a fleet.
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

        // The penalty stands - that is the point of it - so the proof that the
        // semaphore came back is a call on a DIFFERENT provider through the
        // same gate returning at all. A leaked lock would hang this for ever.
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
