using System.Reflection;
using Connector.Kit.Challenges;
using Xunit;

namespace Connector.Kit.Tests;

// the grammar stands between a human filling a login form and a remote-control channel into a browser authenticated
// as them; the earlier relay (fractions and a terminal marker) made navigate and cookie reads unsayable,
// a keyboard is more, so it is pinned
public sealed class LiveInputTests
{
    // the guarantee is what the record cannot say: no URL, selector, script or path; adding a field is a deliberate
    // act with a failing test
    [Fact]
    public void An_event_names_a_destination_for_one_kind_only_and_that_kind_is_the_explore_runs()
    {
        var carried = typeof(LiveInput)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => p.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();

        string[] expected =
        [
            nameof(LiveInput.DeltaY),
            nameof(LiveInput.Key),
            nameof(LiveInput.Kind),
            nameof(LiveInput.Sequence),
            nameof(LiveInput.Text),
            // the one destination (#441 L3): the Navigate kind's address under the explore rule, refused by the control plane
            // except on explore runs, dispatched only on a view opened with navigation allowed
            nameof(LiveInput.Url),
            nameof(LiveInput.X),
            nameof(LiveInput.Y),
        ];

        Assert.Equal(expected, carried);
    }

    [Fact]
    public void A_navigation_is_well_formed_only_for_a_public_http_address()
    {
        Assert.True(new LiveInput { Kind = LiveInputKind.Navigate, Url = "https://www.example.com/login?x=1" }.IsWellFormed());
        Assert.True(new LiveInput { Kind = LiveInputKind.Back }.IsWellFormed());
        Assert.True(new LiveInput { Kind = LiveInputKind.Reload }.IsWellFormed());

        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "javascript:alert(1)" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "file:///etc/passwd" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "http://localhost:5001/" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "http://10.0.0.1/" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "http://nas.local/" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Navigate, Url = "https://user:pw@www.example.com/" }.IsWellFormed());

        Assert.True(new LiveInputBatch { Events = [new LiveInput { Kind = LiveInputKind.Back }] }.Navigates());
        Assert.False(new LiveInputBatch { Events = [new LiveInput { Kind = LiveInputKind.Key, Key = LiveKey.Enter }] }.Navigates());
    }

    // a modifier turns a click into something else (Ctrl+click opens a tab) and a held one survives to a later event:
    // the set is closed
    [Fact]
    public void No_key_is_a_modifier_and_none_can_be_held()
    {
        var keys = Enum.GetNames<LiveKey>();

        Assert.DoesNotContain("Control", keys);
        Assert.DoesNotContain("Shift", keys);
        Assert.DoesNotContain("Alt", keys);
        Assert.DoesNotContain("Meta", keys);

        // no way to say "hold this": Down and Up are pointer-only
        Assert.DoesNotContain("KeyDown", Enum.GetNames<LiveInputKind>());
        Assert.DoesNotContain("KeyUp", Enum.GetNames<LiveInputKind>());
    }

    [Theory]
    [InlineData(-0.01, 0.5)]
    [InlineData(1.01, 0.5)]
    [InlineData(0.5, -0.01)]
    [InlineData(0.5, 1.01)]
    [InlineData(double.NaN, 0.5)]
    [InlineData(0.5, double.PositiveInfinity)]
    public void A_pointer_outside_the_picture_is_refused_rather_than_clamped(double x, double y)
    {
        // clamping would click where the human did not choose, on a page authenticated as them
        Assert.False(new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y }.IsWellFormed());
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    [InlineData(0.5, 0.5)]
    public void The_edges_of_the_picture_are_inside_it(double x, double y)
    {
        Assert.True(new LiveInput { Kind = LiveInputKind.Move, X = x, Y = y }.IsWellFormed());
    }

    [Fact]
    public void Typed_text_may_be_long_enough_for_a_password_manager()
    {
        var pasted = new string('x', LiveInput.MaxTextLength);
        Assert.True(new LiveInput { Kind = LiveInputKind.Text, Text = pasted }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Text, Text = pasted + "x" }.IsWellFormed());
    }

    [Theory]
    [InlineData("a\nb")]
    [InlineData("a\rb")]
    [InlineData("a\tb")]
    [InlineData("ab")]
    [InlineData("a\0b")]
    public void Typed_text_carries_no_control_characters(string text)
    {
        // a newline in typed text submits a half-filled form and an escape sequence means something to whatever reads
        // the log; Enter is its own key
        Assert.False(new LiveInput { Kind = LiveInputKind.Text, Text = text }.IsWellFormed());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Typing_nothing_is_not_an_event(string? text)
    {
        Assert.False(new LiveInput { Kind = LiveInputKind.Text, Text = text }.IsWellFormed());
    }

    [Fact]
    public void A_password_is_ordinary_text_to_this_grammar()
    {
        // a credential lives here, in transit for one request, instead of in a job's inputs at rest
        Assert.True(new LiveInput { Kind = LiveInputKind.Text, Text = "correct horse battery staple" }
            .IsWellFormed());
    }

    [Fact]
    public void A_key_must_be_one_of_the_named_ones()
    {
        Assert.True(new LiveInput { Kind = LiveInputKind.Key, Key = LiveKey.Enter }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Key, Key = null }.IsWellFormed());
        Assert.False(new LiveInput { Kind = LiveInputKind.Key, Key = (LiveKey)9999 }.IsWellFormed());
    }

    [Fact]
    public void A_batch_is_bounded_at_both_ends()
    {
        LiveInput Move() => new() { Kind = LiveInputKind.Move, X = 0.5, Y = 0.5 };

        Assert.False(new LiveInputBatch { Events = [] }.IsWellFormed());

        Assert.True(new LiveInputBatch
        {
            Events = [.. Enumerable.Range(0, LiveInputBatch.MaxEvents).Select(_ => Move())],
        }.IsWellFormed());

        // otherwise a batch keeps an agent replaying for as long as the sender likes
        Assert.False(new LiveInputBatch
        {
            Events = [.. Enumerable.Range(0, LiveInputBatch.MaxEvents + 1).Select(_ => Move())],
        }.IsWellFormed());
    }

    [Fact]
    public void One_bad_event_refuses_the_whole_batch()
    {
        // not "drop the bad one and replay the rest": events are ordered and a drag with a hole lands somewhere nobody chose
        var batch = new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = 0.1, Y = 0.1 },
                new LiveInput { Kind = LiveInputKind.Move, X = 5.0, Y = 0.1 },
                new LiveInput { Kind = LiveInputKind.Up, X = 0.2, Y = 0.2 },
            ],
        };

        Assert.False(batch.IsWellFormed());
    }

    [Fact]
    public void A_kind_this_build_has_never_heard_of_is_refused()
    {
        // the enum converter accepts an integer, so an undefined kind used to pass validation and throw in the agent's dispatch
        // default arm, faulting the replay loop for the rest of the login; an unknown name was always refused, hence the number
        Assert.False(new LiveInput { Kind = (LiveInputKind)99, X = 0.5, Y = 0.5 }.IsWellFormed());
    }

    [Fact]
    public void An_unknown_kind_is_refused_before_its_own_fields_are_read()
    {
        // an undefined kind with a good payload must still be refused, or the check only runs on paths that already fail
        Assert.False(new LiveInput { Kind = (LiveInputKind)99, Text = "hello" }.IsWellFormed());
        Assert.False(new LiveInput { Kind = (LiveInputKind)(-1), Key = LiveKey.Enter }.IsWellFormed());
    }

    [Fact]
    public void A_frame_states_the_size_it_was_taken_at()
    {
        // the consumer turns a tap on its own screen back into a fraction; a provider re-rendering at another size
        // mid-login would misplace events unnoticed
        var frame = new LiveFrame { Sequence = 12, Width = 390, Height = 844, Bytes = [1, 2, 3] };

        Assert.Equal(12, frame.Sequence);
        Assert.Equal(390, frame.Width);
        Assert.Equal(844, frame.Height);

        // no ToHeaderValue: it used to format "12;390x844", matching neither X-Live-Sequence nor X-Live-Size,
        // a header no reader could parse
        Assert.Null(typeof(LiveFrame).GetMethod("ToHeaderValue"));
    }
}
