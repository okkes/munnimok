using Connector.Kit.Errors;

namespace Connector.Kit.Agent.Tests;

// notes once stopped at the agent's logger: the person looking at the result saw a blank and could not ask why
public class JobNoteTests
{
    private static ScriptedAdapter Saying(params string[] notes) =>
        new((ctx, _) =>
        {
            foreach (var note in notes) ctx.Note(note);
            return Task.CompletedTask;
        });

    [Fact]
    public async Task What_the_adapter_said_reaches_the_control_plane_in_order()
    {
        using var rig = new TestRig(Saying("first thing", "second thing"));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(["first thing", "second thing"], rig.Control.Result!.Notes);
    }

    // a note is free text about to cross a wire into a database: scrubbed like failure detail
    [Fact]
    public async Task A_note_that_carries_a_credential_loses_it_before_it_leaves()
    {
        // hunter2 is the password on the rig's login job.
        using var rig = new TestRig(Saying("the form was submitted with hunter2 in it"));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        var note = Assert.Single(rig.Control.Result!.Notes);

        Assert.DoesNotContain("hunter2", note, StringComparison.Ordinal);
        Assert.Contains("the form was submitted with", note, StringComparison.Ordinal);
    }

    // a failed run carries no records to explain itself, so its notes matter most
    [Fact]
    public async Task What_the_adapter_said_before_it_failed_travels_with_the_failure()
    {
        using var rig = new TestRig(new ScriptedAdapter((ctx, _) =>
        {
            ctx.Note("the account list came back with one account on it");
            throw ConnectorException.ProviderChanged("the transactions table has no rows");
        }));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        var failure = rig.Control.Failure;

        Assert.NotNull(failure);
        Assert.Equal(["the account list came back with one account on it"], failure.Notes);
    }

    // bounded: an adapter noting per row would post a fetch's worth of prose; the cap is silent (a "dropped" note is a note)
    [Fact]
    public async Task A_runaway_adapter_cannot_post_an_unbounded_amount_of_prose()
    {
        using var rig = new TestRig(Saying([.. Enumerable.Range(0, 500).Select(i => $"note {i}")]));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        var notes = rig.Control.Result!.Notes;

        Assert.Equal(40, notes.Count);

        // the first forty, not the last: adapters say what they find as they find it, so early notes explain the run
        Assert.Equal("note 0", notes[0]);
        Assert.Equal("note 39", notes[^1]);
    }

    // blank notes are dropped: a list of blanks in a consumer's UI is worse than none
    [Fact]
    public async Task Nothing_is_carried_for_an_adapter_that_said_nothing()
    {
        using var rig = new TestRig(Saying("   ", ""));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Empty(rig.Control.Result!.Notes);
    }
}
