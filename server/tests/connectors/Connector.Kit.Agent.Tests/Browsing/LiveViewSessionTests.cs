using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The whole live view, end to end, against a real headless Chromium and a
/// stubbed control plane.
///
/// A fake browser cannot answer any of the questions here. Whether a frame
/// costs 30 ms or 300 decides whether this is a live view or a slideshow;
/// whether a relayed fraction lands on the password box is a fact about
/// Chromium's hit testing; and whether a stream really stops when the page
/// leaves its origin is a fact about when Playwright raises
/// <c>FrameNavigated</c>. So the provider is a real origin served by a route
/// handler - no server, no network, but a real navigation with a real host.
/// </summary>
public sealed class LiveViewSessionTests(ITestOutputHelper output) : IAsyncLifetime
{
    private const int Width = 390;

    private const int Height = 844;

    private const string LoginUrl = "https://provider.test/login";

    private const string ElsewhereUrl = "https://elsewhere.test/account";

    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        _playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Headless = true });
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null) await _browser.CloseAsync();
        _playwright?.Dispose();
    }

    /// <summary>
    /// Frames arrive numbered, in order, carrying the size they were taken at.
    ///
    /// The sequence is what lets a viewer showing frame 40 ignore 39 arriving
    /// late; the size is what every returned fraction is multiplied by. Neither
    /// is optional and neither has anywhere else to come from.
    /// </summary>
    [Fact]
    public async Task Frames_arrive_numbered_and_carrying_the_size_they_were_taken_at()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        await ShowAnErrorAsync(page);
        await UntilAsync(() => control.Frames.Count >= 2, "the frame that shows the change");

        var frames = control.Frames;
        Assert.Equal([1L, 2L], frames.Take(2).Select(f => f.Sequence));
        Assert.All(frames, f => Assert.Equal($"{Width}x{Height}", f.Size));
        Assert.All(frames, f => Assert.True(f.Bytes > 0));
    }

    /// <summary>
    /// A SECOND live view in the same job carries on counting where the first
    /// stopped.
    ///
    /// The sequence is monotonic per JOB, and the connector enforces it by
    /// keeping one slot and discarding any frame not numbered higher than the
    /// one it holds - while answering 200, so the agent is never told. A counter
    /// that restarted per view therefore made every frame of a job's second live
    /// view disappear at the connector, with the consumer still displaying the
    /// last picture of the first: a stale login page, and a human typing a
    /// password into it. Nothing at either end logged a thing.
    ///
    /// So the fake counts what the connector would throw away, and the assertion
    /// is that it threw away nothing.
    /// </summary>
    [Fact]
    public async Task A_second_live_view_in_one_job_continues_the_count()
    {
        var (page, control) = await OpenAsync();

        // One counter, because there is one job. This is the whole fix: it is
        // owned above the session, so it outlives one.
        var frames = new LiveFrameSequence();

        await using (var first = Session(page, control, frames: frames))
        {
            first.Start(CancellationToken.None);
            await UntilAsync(() => control.Frames.Count >= 1, "a frame from the first view");
        }

        var afterFirst = control.Frames.Count;

        await using (var second = Session(page, control, frames: frames))
        {
            second.Start(CancellationToken.None);
            await UntilAsync(() => control.Frames.Count > afterFirst, "a frame from the second view");
        }

        Assert.Equal(0, control.DiscardedFrames);
        Assert.True(
            control.Frames[afterFirst].Sequence > control.Frames[afterFirst - 1].Sequence,
            $"the second view restarted the count at {control.Frames[afterFirst].Sequence}");
    }

    /// <summary>
    /// A page nobody is touching sends its picture once, and the next one it
    /// sends is the change.
    ///
    /// This is the entire bandwidth argument: a login form is static until
    /// somebody types, and a stream that re-sends the same picture for the
    /// ninety seconds a human spends reading it is the version of this feature
    /// that gets switched off. The heartbeat (<c>MaxSilence</c>) is pushed out
    /// of the way so the test measures the stream and not the heartbeat; the
    /// focused field is there because a blinking caret would be the one thing
    /// on this page that draws by itself. The proof is the numbering: whatever
    /// the machine's load, the change is frame two only if nothing went out in
    /// between.
    /// </summary>
    [Fact]
    public async Task A_page_nobody_is_touching_sends_its_picture_once()
    {
        var (page, control) = await OpenAsync();
        await page.FocusAsync("#password");
        await using var session = Session(page, control, o => o with
        {
            IdleInterval = TimeSpan.FromMilliseconds(40),
            MaxSilence = TimeSpan.FromMinutes(5),
        });

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        // Longer than one caret blink, and a dozen idle gaps.
        await Task.Delay(TimeSpan.FromMilliseconds(700));
        await ShowAnErrorAsync(page);
        await UntilAsync(() => control.Frames.Count >= 2, "the frame that shows the change");

        Assert.Equal([1L, 2L], control.Frames.Select(f => f.Sequence));
    }

    /// <summary>
    /// A moving pointer is streamed softer, and the page is sent sharp again
    /// once it settles - one fresh frame at the higher quality, without the
    /// page having to change.
    /// </summary>
    [Fact]
    public async Task A_moving_pointer_is_streamed_softer_and_the_page_sharp_once_it_settles()
    {
        var (page, control) = await OpenAsync(LiveFrameTests.PhotographicPage());
        await using var session = Session(page, control, o => o with { MaxSilence = TimeSpan.FromMinutes(5) });

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first, settled frame");
        var settled = control.Frames[0].Bytes;

        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Move, X = 0.2, Y = 0.2, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Move, X = 0.4, Y = 0.4, Sequence = 2 },
            ],
        });

        await UntilAsync(() => control.Frames.Any(f => f.Bytes < settled * 0.85), "a softer frame while the pointer moves");
        var soft = control.Frames.Count;

        await UntilAsync(
            () => control.Frames.Skip(soft).Any(f => f.Bytes > settled * 0.85),
            "one sharp frame after the pointer settled");
    }

    /// <summary>
    /// The heartbeat: an unchanged page still sends something eventually.
    ///
    /// Silence and death look identical from the viewer's side, and a viewer
    /// that attached after the last frame was posted would otherwise have
    /// nothing at all to draw.
    /// </summary>
    [Fact]
    public async Task An_unchanged_page_is_re_sent_when_the_silence_gets_too_long()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control, o => o with
        {
            IdleInterval = TimeSpan.FromMilliseconds(40),
            MaxSilence = TimeSpan.FromMilliseconds(200),
        });

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 3, "three heartbeat frames");
    }

    /// <summary>
    /// What the human did on a picture of the page happens on the page.
    ///
    /// The one test that exercises the whole loop: a fraction measured against
    /// the frame's own size becomes a click that focuses the provider's real
    /// password box, and the characters that follow it are typed into it. If
    /// the coordinate mapping is out by the crop origin, by the device scale
    /// factor, or by the difference between the viewport and the frame, this is
    /// where it shows up - the field stays empty.
    /// </summary>
    [Fact]
    public async Task A_tap_and_some_typing_land_on_the_provider_s_own_field()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#password");
        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "correct-horse", Sequence = 3 },
            ],
        });

        await UntilAsync(
            async () => await ValueOfAsync(page, "#password") == "correct-horse",
            "the password box to hold what was typed");
    }

    /// <summary>
    /// Typed text reaches the page one character at a time, each with its own
    /// key events.
    ///
    /// A verification-code page keeps one box per digit and moves the focus
    /// on the moment a box has its character. The whole code inserted at once
    /// landed in the first box (user ss 2026-10-05, Albert Heijn's SMS code);
    /// typed a beat apart, each digit finds its own box.
    /// </summary>
    [Fact]
    public async Task Typed_text_arrives_a_character_at_a_time_so_a_segmented_code_takes_one_digit_a_box()
    {
        var (page, control) = await OpenAsync(LiveFrameTests.CodeForm());
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#d1");
        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "123", Sequence = 3 },
            ],
        });

        await UntilAsync(
            async () => await ValueOfAsync(page, "#d3") == "3",
            "the third box to hold the third digit");
        Assert.Equal("1", await ValueOfAsync(page, "#d1"));
        Assert.Equal("2", await ValueOfAsync(page, "#d2"));
    }

    /// <summary>
    /// A key arrives as the key it names and nothing else.
    ///
    /// Enter on a form submits it, which is the whole reason the key channel
    /// exists - and the reason a relayed string must never reach
    /// <c>PressAsync</c>, which would read one as a chord.
    /// </summary>
    [Fact]
    public async Task A_named_key_reaches_the_page_as_that_key()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#password");
        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "abc", Sequence = 3 },
                new LiveInput { Kind = LiveInputKind.Key, Key = LiveKey.Backspace, Sequence = 4 },
            ],
        });

        await UntilAsync(
            async () => await ValueOfAsync(page, "#password") == "ab",
            "backspace to remove exactly one character");
    }

    /// <summary>
    /// A batch delivered twice is replayed once.
    ///
    /// The hazard is not a duplicated character. It is a duplicated Enter: the
    /// provider counts the attempt, and a platform rule says a submitted
    /// credential is never retried. Every other channel on this agent retries
    /// by default, so this has to be refused rather than merely not attempted.
    /// </summary>
    [Fact]
    public async Task A_batch_delivered_twice_is_replayed_once()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#password");
        var batch = new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "once", Sequence = 3 },
            ],
        };

        control.SendLiveInput(batch);
        control.SendLiveInput(batch);

        await UntilAsync(
            async () => await ValueOfAsync(page, "#password") == "once",
            "the typing to arrive");

        // The re-delivery handed over, and one more poll after it: the agent
        // asks again only once it has dealt with what it was given.
        await UntilAsync(() => control.PendingInput == 0, "the re-delivered batch to be handed over");
        var handed = control.InputPolls;
        await UntilAsync(() => control.InputPolls > handed, "the poll that follows the re-delivery");

        Assert.Equal("once", await ValueOfAsync(page, "#password"));
    }

    /// <summary>
    /// The page leaves the origin it opened on and not one further frame is
    /// posted.
    ///
    /// This is the rule standing between a login relay and a live remote view
    /// of an authenticated account: the moment the provider redirects to the
    /// signed-in pages, the browser is holding the user's address and order
    /// history and the stream must already be dead. Terminal - there is no path
    /// that resumes it.
    /// </summary>
    [Fact]
    public async Task A_page_that_leaves_its_origin_stops_the_stream_for_good()
    {
        var (page, control) = await OpenAsync();
        var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        await page.GotoAsync(ElsewhereUrl);
        await UntilAsync(() => session.Stopped, "the stream to latch shut");

        // Disposing waits both loops out, so everything that will ever be
        // posted has been: none of it is the other origin's.
        await session.DisposeAsync();

        Assert.True(session.Stopped);
        Assert.All(control.Frames, f => Assert.Equal("https://provider.test", f.Origin));
    }

    /// <summary>
    /// Navigating WITHIN the allowed origin does not stop anything. A login
    /// flow that posts a form and lands on a second page of its own site is
    /// ordinary, and a latch that fired on it would make the feature useless.
    /// </summary>
    [Fact]
    public async Task A_page_that_stays_on_its_origin_keeps_streaming()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");
        var before = control.Frames.Count;

        await page.GotoAsync("https://provider.test/login/step-two");
        await UntilAsync(() => control.Frames.Count > before, "the next page's picture");

        Assert.False(session.Stopped);
    }

    /// <summary>
    /// A frame POST the HTTP client gives up on is one lost frame, not the end
    /// of the stream.
    ///
    /// <c>HttpClient.Timeout</c> surfaces as a <c>TaskCanceledException</c>,
    /// which derives from <c>OperationCanceledException</c> - the same type the
    /// shutter loop uses to recognise "we are being stopped". Treating the two
    /// as one meant a single stalled POST ended the shutter permanently and
    /// silently: the retry budget saw no failure, no line was logged above
    /// debug, and the viewer kept the last picture on screen.
    /// </summary>
    [Fact]
    public async Task A_frame_post_the_client_gives_up_on_is_retried_rather_than_ending_the_stream()
    {
        var (page, control) = await OpenAsync();
        control.ClientTimeout = TimeSpan.FromMilliseconds(250);
        control.StallFrames(1);

        // A still page sends its next picture on the heartbeat, so the
        // heartbeat comes round quickly here.
        await using var session = Session(page, control, o => o with
        {
            IdleInterval = TimeSpan.FromMilliseconds(40),
            MaxSilence = TimeSpan.FromMilliseconds(300),
        });

        session.Start(CancellationToken.None);

        await UntilAsync(() => control.Frames.Count >= 1, "a frame to land after the stalled one");
        Assert.False(session.Stopped);
    }

    /// <summary>
    /// And the same on the other leg: an input long poll the client gives up on
    /// leaves the human's keyboard connected.
    ///
    /// The worse of the two failures, because it is invisible from the outside.
    /// Frames carry on arriving, so the view looks alive; every tap and every
    /// keystroke from that moment on does nothing at all, for the rest of the
    /// login, and the only trace is one debug line when the session is disposed.
    /// </summary>
    [Fact]
    public async Task An_input_poll_the_client_gives_up_on_leaves_the_channel_open()
    {
        var (page, control) = await OpenAsync();
        control.ClientTimeout = TimeSpan.FromMilliseconds(250);
        control.StallInputPolls(1);

        await using var session = Session(page, control, o => o with
        {
            InputRetryDelay = TimeSpan.FromMilliseconds(100),
        });

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#password");
        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 1 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "still-listening", Sequence = 3 },
            ],
        });

        await UntilAsync(
            async () => await ValueOfAsync(page, "#password") == "still-listening",
            "the input channel to survive a poll the client timed out");
    }

    /// <summary>
    /// A batch this build cannot read costs the batch and nothing more.
    ///
    /// The enum converter takes an integer as readily as a name, so a kind
    /// nobody has a word for is a thing that can arrive. It used to reach a
    /// <c>default:</c> arm marked unreachable, throw a type no catch filter
    /// around it matched, and fault the input task for the rest of the login.
    /// The contract refuses it now; this asserts the whole chain, which is the
    /// only place the consequence was ever visible - the human types again and
    /// it works.
    /// </summary>
    [Fact]
    public async Task A_batch_this_build_cannot_read_does_not_end_the_input_channel()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        var (x, y) = await CentreOfAsync(page, "#password");
        control.SendLiveInput(new LiveInputBatch
        {
            Events = [new LiveInput { Kind = (LiveInputKind)99, X = x, Y = y, Sequence = 1 }],
        });

        control.SendLiveInput(new LiveInputBatch
        {
            Events =
            [
                new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = 2 },
                new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = 3 },
                new LiveInput { Kind = LiveInputKind.Text, Text = "after", Sequence = 4 },
            ],
        });

        await UntilAsync(
            async () => await ValueOfAsync(page, "#password") == "after",
            "the input channel to outlive an event nobody has a word for");
    }

    /// <summary>
    /// A control plane that will not take a frame is a stop, not a retry. It is
    /// how a revoked capability or a finished challenge reaches the shutter.
    /// </summary>
    [Fact]
    public async Task A_control_plane_with_no_live_channel_stops_the_shutter()
    {
        var (page, control) = await OpenAsync();
        control.LiveChannelGone = true;

        await using var session = Session(page, control);
        session.Start(CancellationToken.None);

        await UntilAsync(() => session.Stopped, "the stream to give up");
        Assert.Empty(control.Frames);
    }

    /// <summary>
    /// A wildcard origin is refused rather than expanded, so nothing streams at
    /// all. An adapter that declared <c>*.provider.test</c> would keep the
    /// stream running straight through a successful login.
    /// </summary>
    [Fact]
    public async Task A_wildcard_origin_streams_nothing()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control, o => o with { Origins = ["*.provider.test"] });

        session.Start(CancellationToken.None);
        await UntilAsync(() => session.Stopped, "the stream to refuse to open");

        Assert.Empty(control.Frames);
    }

    /// <summary>
    /// What a frame costs, on a real page, with the real pipeline, written into
    /// the test output.
    ///
    /// Not an assertion about speed - a shared build machine would make that
    /// flake, and the number is wanted for judgement rather than for a gate.
    /// The only thing asserted is that the measurement HAPPENS: nobody had
    /// measured this before, every cadence and bandwidth figure in the design
    /// scales with it, and a stream that reports nothing is the one thing that
    /// must not survive a refactor.
    /// </summary>
    [Fact]
    public async Task The_cost_of_a_frame_is_measured_and_written_down()
    {
        var (page, control) = await OpenAsync();

        // The fake's empty input poll answers after 50 ms where a real one
        // holds for its window; the floor that keeps a fast answer from
        // becoming a spin would otherwise be most of what is measured.
        await using var session = Session(
            page,
            control,
            o => o with { MeterInterval = TimeSpan.FromSeconds(1), EmptyPollFloor = TimeSpan.FromMilliseconds(1) },
            log: true);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        // Typing keeps the stream in its burst tier and keeps the page
        // changing, which is the expensive case and the one worth timing: a
        // keystroke every 250 ms, and how long each takes to come back as a
        // picture the control plane holds.
        var (x, y) = await CentreOfAsync(page, "#password");
        var sequence = 0L;
        var reactions = new List<double>();

        for (var i = 0; i < 12; i++)
        {
            var before = control.Frames.Count;
            var sent = System.Diagnostics.Stopwatch.StartNew();

            control.SendLiveInput(new LiveInputBatch
            {
                Events =
                [
                    new LiveInput { Kind = LiveInputKind.Down, X = x, Y = y, Sequence = ++sequence },
                    new LiveInput { Kind = LiveInputKind.Up, X = x, Y = y, Sequence = ++sequence },
                    new LiveInput { Kind = LiveInputKind.Text, Text = "a", Sequence = ++sequence },
                ],
            });

            await UntilAsync(() => control.Frames.Count > before, "the keystroke's picture");
            reactions.Add(sent.Elapsed.TotalMilliseconds);

            var rest = TimeSpan.FromMilliseconds(250) - sent.Elapsed;
            if (rest > TimeSpan.Zero) await Task.Delay(rest);
        }

        var bytes = control.Frames.Sum(f => (long)f.Bytes);
        reactions.Sort();
        output.WriteLine($"{control.Frames.Count} frames, {bytes / 1024} KB total, " +
                         $"{bytes / control.Frames.Count} B mean; keystroke to posted frame " +
                         $"{reactions[reactions.Count / 2]:0} ms median, {reactions[^1]:0} ms worst " +
                         "(the input poll's own 50 ms window included)");
    }

    /// <summary>
    /// A session, wired to a real page and a stubbed control plane. Silent by
    /// default: only the measurement test wants a running commentary.
    /// </summary>
    private LiveViewSession Session(
        IPage page,
        FakeControlPlane control,
        Func<LiveViewOptions, LiveViewOptions>? tune = null,
        bool log = false,
        LiveFrameSequence? frames = null)
    {
        var options = new LiveViewOptions();
        if (tune is not null) options = tune(options);

        return new LiveViewSession(
            page,
            new ControlPlaneClient(control, NullLogger<ControlPlaneClient>.Instance),
            "job_live_test",
            frames ?? new LiveFrameSequence(),
            options,
            log ? new TestOutputLogger(output) : NullLogger.Instance,
            TimeProvider.System);
    }

    /// <summary>
    /// A page on a real origin, served from a route handler.
    ///
    /// <c>SetContentAsync</c> would leave the page on <c>about:blank</c>, which
    /// has no host - so the origin latch would refuse to open, and every test
    /// here would be testing that refusal instead of what it says it does.
    /// Fulfilling the request locally keeps it a genuine navigation with a
    /// genuine host and still contacts nothing.
    /// </summary>
    private async Task<(IPage Page, FakeControlPlane Control)> OpenAsync(string? body = null)
    {
        var context = await _browser!.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = Width, Height = Height },
            DeviceScaleFactor = 1,
        });

        var page = await context.NewPageAsync();
        await page.RouteAsync("**/*", route => route.FulfillAsync(new RouteFulfillOptions
        {
            ContentType = "text/html",
            Body = body ?? LiveFrameTests.LoginForm(),
        }));

        await page.GotoAsync(LoginUrl);
        return (page, new FakeControlPlane());
    }

    /// <summary>
    /// An element's centre as a fraction of the frame - the same arithmetic the
    /// consumer does when a finger lands on the picture.
    /// </summary>
    private static async Task<(double X, double Y)> CentreOfAsync(IPage page, string selector)
    {
        var box = await page.Locator(selector).BoundingBoxAsync()
                  ?? throw new InvalidOperationException($"'{selector}' is not on the page");

        return ((box.X + (box.Width / 2)) / Width, (box.Y + (box.Height / 2)) / Height);
    }

    private static async Task<string> ValueOfAsync(IPage page, string selector) =>
        await page.EvaluateAsync<string>($"() => document.querySelector('{selector}').value");

    /// <summary>The one thing on a login page that changes by itself: an error message being drawn.</summary>
    private static Task<System.Text.Json.JsonElement?> ShowAnErrorAsync(IPage page) =>
        page.EvaluateAsync("() => { document.querySelector('#error').textContent = 'Onjuist wachtwoord'; }");

    private static Task UntilAsync(Func<bool> condition, string what) =>
        UntilAsync(() => Task.FromResult(condition()), what);

    /// <summary>
    /// Polls rather than sleeps a fixed amount.
    ///
    /// A stream is a clock, so every test here is about time passing - and a
    /// fixed sleep long enough to be reliable on a loaded build machine would
    /// make the suite slower than the feature it measures.
    /// </summary>
    private static async Task UntilAsync(Func<Task<bool>> condition, string what)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(15);

        while (DateTimeOffset.UtcNow < deadline)
        {
            if (await condition()) return;
            await Task.Delay(25);
        }

        Assert.Fail($"timed out waiting for {what}");
    }
}
