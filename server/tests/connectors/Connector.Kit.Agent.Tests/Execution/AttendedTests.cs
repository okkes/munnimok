namespace Connector.Kit.Agent.Tests;

// an hCaptcha needs drags and clicks and mints its own token, so a relayed screenshot cannot answer it: the owner solves it
// in the window in front of them or the adapter says it is blocked; this flag alone decides which
public class AttendedTests
{
    [Fact]
    public async Task A_headed_agent_is_attended()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges(), headless: false);
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        Assert.True(context.Attended);
    }

    [Fact]
    public async Task A_headless_agent_is_not_attended()
    {
        using var rig = new TestRig(ScriptedAdapter.Wedges(), headless: true);
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        Assert.False(context.Attended);
    }

    [Fact]
    public async Task Headless_is_the_default_so_nobody_is_assumed_to_be_there()
    {
        // claiming a human when none is there hangs the job on a widget nobody can reach until its budget runs out
        Assert.True(new ConnectorAgentOptions().Headless);

        using var rig = new TestRig(ScriptedAdapter.Wedges());
        await using var context = rig.Context(TestRig.Login(budgetSeconds: 30));

        Assert.False(context.Attended);
    }
}
