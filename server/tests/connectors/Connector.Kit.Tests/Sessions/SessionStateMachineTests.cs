using Connector.Kit.Sessions;
using Xunit;

namespace Connector.Kit.Tests;

// an illegal transition shows "connected" for a session that never authenticated
public sealed class SessionStateMachineTests
{
    private static readonly SessionState[] All = Enum.GetValues<SessionState>();

    public static TheoryData<SessionState> EveryState()
    {
        var data = new TheoryData<SessionState>();
        foreach (var state in All) data.Add(state);
        return data;
    }

    public static TheoryData<SessionState> TerminalStates()
    {
        var data = new TheoryData<SessionState>();
        data.Add(SessionState.Disabled);
        data.Add(SessionState.Failed);
        data.Add(SessionState.Expired);
        return data;
    }

    [Theory]
    [InlineData(SessionState.Queued, SessionState.Running)]
    [InlineData(SessionState.Running, SessionState.AwaitingInput)]
    [InlineData(SessionState.AwaitingInput, SessionState.Running)]
    [InlineData(SessionState.Running, SessionState.Active)]
    [InlineData(SessionState.Active, SessionState.NeedsReauth)]
    [InlineData(SessionState.NeedsReauth, SessionState.Running)]
    [InlineData(SessionState.Active, SessionState.Disabled)]
    [InlineData(SessionState.Active, SessionState.Blocked)]
    [InlineData(SessionState.Running, SessionState.Blocked)]
    [InlineData(SessionState.Blocked, SessionState.Disabled)]
    [InlineData(SessionState.Blocked, SessionState.Running)]
    [InlineData(SessionState.NeedsReauth, SessionState.Disabled)]
    [InlineData(SessionState.Active, SessionState.Running)]
    [InlineData(SessionState.Queued, SessionState.Failed)]
    [InlineData(SessionState.Running, SessionState.Failed)]
    [InlineData(SessionState.AwaitingInput, SessionState.Failed)]
    [InlineData(SessionState.Queued, SessionState.Expired)]
    [InlineData(SessionState.Running, SessionState.Expired)]
    [InlineData(SessionState.AwaitingInput, SessionState.Expired)]
    [InlineData(SessionState.Active, SessionState.Expired)]
    [InlineData(SessionState.NeedsReauth, SessionState.Expired)]
    public void Allows_a_legal_transition(SessionState from, SessionState to)
    {
        Assert.True(SessionStateMachine.CanTransition(from, to));
        SessionStateMachine.EnsureTransition(from, to);
    }

    [Theory]
    [InlineData(SessionState.Queued, SessionState.Active)]
    [InlineData(SessionState.AwaitingInput, SessionState.Active)]
    [InlineData(SessionState.NeedsReauth, SessionState.Active)]
    [InlineData(SessionState.Blocked, SessionState.Active)]
    [InlineData(SessionState.Queued, SessionState.AwaitingInput)]
    [InlineData(SessionState.Active, SessionState.AwaitingInput)]
    [InlineData(SessionState.Running, SessionState.Queued)]
    [InlineData(SessionState.Active, SessionState.Queued)]
    // an active session that fails becomes needs_reauth or blocked, never failed: "failed" belongs to a connect attempt
    [InlineData(SessionState.Active, SessionState.Failed)]
    [InlineData(SessionState.Disabled, SessionState.Running)]
    [InlineData(SessionState.Failed, SessionState.Running)]
    [InlineData(SessionState.Expired, SessionState.Running)]
    [InlineData(SessionState.Expired, SessionState.Active)]
    public void Refuses_an_illegal_transition(SessionState from, SessionState to)
    {
        Assert.False(SessionStateMachine.CanTransition(from, to));
        Assert.Throws<InvalidOperationException>(() => SessionStateMachine.EnsureTransition(from, to));
    }

    [Theory]
    [MemberData(nameof(TerminalStates))]
    public void A_terminal_state_has_no_exits(SessionState terminal)
    {
        Assert.True(SessionStateMachine.IsTerminal(terminal));
        Assert.All(All, to => Assert.False(SessionStateMachine.CanTransition(terminal, to)));
    }

    [Theory]
    [MemberData(nameof(EveryState))]
    public void Terminal_means_exactly_no_exits(SessionState state)
    {
        // terminal and exits are declared separately in the kit; they must agree
        var hasExit = All.Any(to => SessionStateMachine.CanTransition(state, to));
        Assert.Equal(!SessionStateMachine.IsTerminal(state), hasExit);
    }

    [Theory]
    [MemberData(nameof(EveryState))]
    public void No_state_transitions_to_itself(SessionState state)
    {
        // a self-transition is how a "state changed" webhook fires forever
        Assert.False(SessionStateMachine.CanTransition(state, state));
    }

    [Fact]
    public void Every_state_is_reachable_from_queued()
    {
        var seen = new HashSet<SessionState> { SessionState.Queued };
        var frontier = new Queue<SessionState>([SessionState.Queued]);

        while (frontier.Count > 0)
        {
            var from = frontier.Dequeue();
            foreach (var to in All.Where(t => SessionStateMachine.CanTransition(from, t) && seen.Add(t)))
            {
                frontier.Enqueue(to);
            }
        }

        // an unreachable state is one some code sets by assignment, bypassing the machine
        Assert.Equal(All.Order().ToArray(), seen.Order().ToArray());
    }

    [Theory]
    [MemberData(nameof(EveryState))]
    public void Only_active_can_serve_a_fetch(SessionState state)
    {
        // a fetch on anything else needs a human first: an honest error instead of a spinner
        Assert.Equal(state == SessionState.Active, SessionStateMachine.IsUsable(state));
    }

    [Fact]
    public void The_documented_interactive_login_walk_is_legal_end_to_end()
    {
        SessionState[] walk =
        [
            SessionState.Queued, SessionState.Running, SessionState.AwaitingInput,
            SessionState.Running, SessionState.Active, SessionState.NeedsReauth,
            SessionState.Running, SessionState.Active, SessionState.Disabled,
        ];

        for (var i = 1; i < walk.Length; i++)
        {
            SessionStateMachine.EnsureTransition(walk[i - 1], walk[i]);
        }

        Assert.True(SessionStateMachine.IsTerminal(walk[^1]));
    }

    [Fact]
    public void The_error_names_the_transition_it_refused()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => SessionStateMachine.EnsureTransition(SessionState.Failed, SessionState.Active));

        Assert.Contains("Failed", ex.Message, StringComparison.Ordinal);
        Assert.Contains("Active", ex.Message, StringComparison.Ordinal);
    }
}
