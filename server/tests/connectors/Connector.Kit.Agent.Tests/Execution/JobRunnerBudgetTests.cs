using Connector.Kit.Errors;

namespace Connector.Kit.Agent.Tests;

// incident: a job parked on a widget was killed by its 300s budget and reported as `internal`
public class JobRunnerBudgetTests
{
    [Fact]
    public async Task A_job_parked_on_a_challenge_outlives_its_own_budget()
    {
        using var rig = new TestRig(ScriptedAdapter.AsksAHuman(TimeSpan.FromMinutes(5)));
        var job = TestRig.Login(budgetSeconds: 1);

        var running = rig.RunAsync(job);
        await Task.Delay(3_000);

        Assert.Null(rig.Control.Failure);
        rig.Control.Answer();

        await running.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(1, rig.Control.ChallengesRaised);
        Assert.Null(rig.Control.Failure);
        Assert.NotNull(rig.Control.Result);
    }

    [Fact]
    public async Task An_adapter_that_raises_no_challenge_still_dies_on_its_budget()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());
        var job = TestRig.Login(budgetSeconds: 1);

        await rig.RunAsync(job).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(0, rig.Control.ChallengesRaised);
        Assert.NotNull(rig.Control.Failure);
        Assert.Null(rig.Control.Result);
    }

    [Fact]
    public async Task A_run_that_uses_up_its_budget_is_not_reported_as_internal()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges());

        await rig.RunAsync(TestRig.Login(budgetSeconds: 1)).WaitAsync(TimeSpan.FromSeconds(30));

        // `internal` is retriable and says "ours": it pages an operator over a run nobody can fix
        Assert.True(rig.Control.FailedWith(ErrorCode.ProviderUnavailable),
            $"expected provider_unavailable, got {rig.Control.FailureCode}");
        Assert.NotEqual(ErrorCatalog.Wire(ErrorCode.Internal), rig.Control.FailureCode);

        Assert.Contains("working budget", rig.Control.Failure!.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_parked_job_keeps_its_lease_alive()
    {
        // renewal fires at half the remaining lease, five-second floor: a short lease and a 12s wait shows more than one round
        using var rig = new TestRig(ScriptedAdapter.AsksAHuman(TimeSpan.FromMinutes(5)));
        var job = TestRig.Login(budgetSeconds: 1, leaseSeconds: 10);

        var running = rig.RunAsync(job, leaseTtlSeconds: 10);
        await Task.Delay(12_000);

        var renewalsWhileParked = rig.Control.Renewals;
        rig.Control.Answer();
        await running.WaitAsync(TimeSpan.FromSeconds(30));

        // without renewals the expiry sweep takes the job back mid-wait and hands it to a second agent
        Assert.True(renewalsWhileParked >= 2,
            $"a job parked for 12s renewed its lease only {renewalsWhileParked} time(s)");
        Assert.Null(rig.Control.Failure);
    }

    // HttpClient.Timeout is a TaskCanceledException, which the renewal loop read as "job finished": one stall ended it
    // this proves a retry comes; that it comes in time is KeepaliveBoundsTests
    [Fact]
    public async Task A_renew_the_client_gives_up_on_is_retried_rather_than_ending_renewal()
    {
        using var rig = new TestRig(ScriptedAdapter.AsksAHuman(TimeSpan.FromMinutes(5)));

        // the keepalive client's bound, since renews go out on it; on the long polls' client the stall would last ten seconds
        rig.Control.KeepaliveTimeout = TimeSpan.FromMilliseconds(250);
        rig.Control.StallRenewals(1);
        var job = TestRig.Login(budgetSeconds: 1, leaseSeconds: 10);

        var running = rig.RunAsync(job, leaseTtlSeconds: 10);

        // the first renew is due at 5s and hangs; the next one landing proves the loop lives (a hung renew is not counted)
        await UntilAsync(() => rig.Control.Renewals >= 1, "a renewal to land after the one the client gave up on");

        rig.Control.Answer();
        await running.WaitAsync(TimeSpan.FromSeconds(30));

        // a lease read as lost cancels the run and posts nothing, so the result landing shows onLost never fired
        Assert.Equal(1, rig.Control.ChallengesRaised);
        Assert.Equal(0, rig.Control.FailureCount);
        Assert.NotNull(rig.Control.Result);
        Assert.True(rig.Control.Result.Complete);
    }

    [Fact]
    public async Task A_challenge_nobody_answers_still_ends_the_run_on_its_own_expiry()
    {
        // suspending the budget is safe only because the challenge carries its own mandatory deadline
        using var rig = new TestRig(ScriptedAdapter.AsksAHuman(TimeSpan.FromSeconds(2)));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(1, rig.Control.ChallengesRaised);
        Assert.True(rig.Control.FailedWith(ErrorCode.MfaTimeout),
            $"expected mfa_timeout, got {rig.Control.FailureCode}");
    }

    // polls on the wall clock (real timers); the renewal floor is 5s, so a fixed wait would cost every run or flake
    // 45s: on a loaded runner a healthy renew can outrun the 250ms bound and count as given up, delaying the first landed one
    private static async Task UntilAsync(Func<bool> done, string what)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(45);

        while (!done())
        {
            Assert.True(DateTimeOffset.UtcNow < deadline, $"timed out waiting for {what}");
            await Task.Delay(25);
        }
    }
}
