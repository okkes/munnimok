using Connector.Kit.Agent.Execution;

namespace Connector.Kit.Agent.Tests;

public class JobBudgetTests
{
    private static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(300);

    [Fact]
    public async Task A_job_that_only_works_dies_when_its_budget_runs_out()
    {
        using var budget = new JobBudget(Budget, TimeProvider.System);
        using var stop = new CancellationTokenSource();
        var watching = budget.WatchAsync(stop.Token);

        await watching.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(budget.Expired);
        Assert.Equal(TimeSpan.Zero, budget.HumanWait);
    }

    [Fact]
    public async Task Time_parked_on_a_human_does_not_count_against_the_budget()
    {
        using var budget = new JobBudget(Budget, TimeProvider.System);
        using var stop = new CancellationTokenSource();
        var watching = budget.WatchAsync(stop.Token);

        using (budget.Park())
        {
            await Task.Delay(Budget * 4);
            Assert.False(budget.Expired);
        }

        await watching.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(budget.Expired);
        Assert.True(budget.HumanWait >= Budget * 3, $"human wait was only {budget.HumanWait}");
    }

    [Fact]
    public async Task The_budget_resumes_the_moment_the_answer_arrives()
    {
        using var budget = new JobBudget(TimeSpan.FromSeconds(30), TimeProvider.System);
        using var stop = new CancellationTokenSource();
        var watching = budget.WatchAsync(stop.Token);

        using (budget.Park()) await Task.Delay(200);

        var afterPark = budget.HumanWait;
        await Task.Delay(200);

        Assert.False(budget.Expired);
        Assert.Equal(afterPark, budget.HumanWait);

        await stop.CancelAsync();
        await watching.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.False(budget.Expired);
    }

    [Fact]
    public async Task Overlapping_parks_cannot_leave_the_budget_suspended()
    {
        using var budget = new JobBudget(Budget, TimeProvider.System);
        using var stop = new CancellationTokenSource();
        var watching = budget.WatchAsync(stop.Token);

        var outer = budget.Park();
        var inner = budget.Park();
        inner.Dispose();

        await Task.Delay(Budget * 2);
        Assert.False(budget.Expired);

        outer.Dispose();
        await watching.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.True(budget.Expired);
    }

    [Fact]
    public async Task A_job_that_ends_first_is_never_reported_as_a_timeout()
    {
        using var budget = new JobBudget(TimeSpan.FromSeconds(30), TimeProvider.System);
        using var stop = new CancellationTokenSource();
        var watching = budget.WatchAsync(stop.Token);

        await stop.CancelAsync();
        await watching.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.False(budget.Expired);
    }
}
