using Connector.Kit.Jobs;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// A fetch says how much it has gathered as it goes (user request 2026-10-02:
/// a counter that climbs rather than a spinner). The count rides the next
/// progress post under the step it was reported in, and a later step carries
/// the last count along rather than dropping it.
/// </summary>
public class JobFoundTests
{
    [Fact]
    public async Task The_count_an_adapter_reports_rides_the_progress_post_under_its_step()
    {
        using var rig = new TestRig(new ScriptedAdapter((ctx, _) =>
        {
            ctx.Progress(JobStep.Downloading);
            ctx.Found(12);
            ctx.Found(40);
            ctx.Progress(JobStep.Parsing);
            return Task.CompletedTask;
        }));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        var posts = rig.Control.Progress;

        Assert.Contains(posts, p => p.Step == JobStep.Downloading && p.Found == 12);
        Assert.Contains(posts, p => p.Step == JobStep.Downloading && p.Found == 40);
        // the step after the walk carries the last count along
        Assert.Contains(posts, p => p.Step == JobStep.Parsing && p.Found == 40);
        // and nothing before the first count claims one
        Assert.All(posts.TakeWhile(p => p.Step != JobStep.Downloading || p.Found is null), p => Assert.Null(p.Found));
    }

    [Fact]
    public async Task An_adapter_that_never_counted_posts_no_count()
    {
        using var rig = new TestRig(new ScriptedAdapter((ctx, _) =>
        {
            ctx.Progress(JobStep.Downloading);
            return Task.CompletedTask;
        }));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.NotEmpty(rig.Control.Progress);
        Assert.All(rig.Control.Progress, p => Assert.Null(p.Found));
    }
}
