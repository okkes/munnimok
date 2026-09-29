using Connector.Kit.Errors;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// What an adapter SAYS, and where it ends up.
///
/// Notes used to go to the agent's logger and stop there. That put every
/// explanation of an outcome - "this pass is partial", "your savings account
/// could not be listed", "the provider states no balance for this card" - on
/// whichever machine happened to run the job, while the person looking at the
/// result saw a blank and had no way to ask why.
/// </summary>
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

    /// <summary>
    /// A note is free text an adapter assembled, and it is about to cross a
    /// wire and land in a database.
    /// </summary>
    /// <remarks>
    /// SCRUBBED ON THE WAY IN, exactly as failure detail already is. An
    /// adapter that quotes what it sent, or a provider library that echoes a
    /// request body into a message an adapter then notes, is an ordinary thing
    /// - and before this the note went out whole.
    /// </remarks>
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

    /// <summary>
    /// A FAILED run is where the notes matter most, and it is the path that
    /// carries no records to explain themselves.
    /// </summary>
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

    /// <summary>
    /// Bounded, because an adapter that notes per row would otherwise post a
    /// fetch's worth of prose into a database column.
    /// </summary>
    /// <remarks>
    /// The cap is silent by design: a note saying notes were dropped is itself
    /// a note, and an adapter noisy enough to reach this has already said
    /// everything anybody is going to read.
    /// </remarks>
    [Fact]
    public async Task A_runaway_adapter_cannot_post_an_unbounded_amount_of_prose()
    {
        using var rig = new TestRig(Saying([.. Enumerable.Range(0, 500).Select(i => $"note {i}")]));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        var notes = rig.Control.Result!.Notes;

        Assert.Equal(40, notes.Count);

        // The FIRST forty rather than the last: an adapter says what it found
        // as it finds it, so the early ones are the ones that explain the run.
        Assert.Equal("note 0", notes[0]);
        Assert.Equal("note 39", notes[^1]);
    }

    /// <summary>
    /// Blank notes are not notes. An adapter building a sentence out of
    /// optional pieces can produce an empty one, and a list of blanks in a
    /// consumer's UI is worse than no list.
    /// </summary>
    [Fact]
    public async Task Nothing_is_carried_for_an_adapter_that_said_nothing()
    {
        using var rig = new TestRig(Saying("   ", ""));

        await rig.RunAsync(TestRig.Login(budgetSeconds: 30)).WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Empty(rig.Control.Result!.Notes);
    }
}
