using Connector.Kit.Agent.Browsing;
using Connector.Kit.Agent.Transport;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests;

/// real headless Chromium, stubbed control plane: frame cost, hit testing and when FrameNavigated fires are Chromium
/// facts a fake cannot answer; the provider is a real origin served by a route handler
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

    /// the sequence lets a viewer ignore a late frame; the size is what every returned fraction is multiplied by
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

    /// the sequence is monotonic per JOB: the connector keeps one slot and silently discards (answering 200) frames not
    /// numbered higher, so a per-view counter made a second view's frames vanish behind a stale login page
    [Fact]
    public async Task A_second_live_view_in_one_job_continues_the_count()
    {
        var (page, control) = await OpenAsync();

        // one counter per job, owned above the session so it outlives one
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

    /// a static login form must not be re-sent while a human reads it. MaxSilence is pushed out and the field focused
    /// because a blinking caret would draw by itself; frame two proves nothing went out between
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

    /// silence and death look identical from the viewer's side, and a viewer attaching after the last frame would have
    /// nothing to draw
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

    /// the whole loop: a mapping out by the crop origin, the device scale factor or viewport vs frame leaves the field empty
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

    /// a code page has one box per digit and moves focus on at once: the whole code inserted at once landed in the first
    /// box (Albert Heijn SMS code); typed a beat apart, each digit finds its box
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

    /// Enter submits a form, which is why the key channel exists; a relayed string must never reach PressAsync,
    /// which reads chords
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

    /// a duplicated Enter makes the provider count the attempt, and a submitted credential is never retried: every other
    /// channel retries by default, so the re-delivery must be refused
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

        // the agent polls again only once it has dealt with what it was given
        await UntilAsync(() => control.PendingInput == 0, "the re-delivered batch to be handed over");
        var handed = control.InputPolls;
        await UntilAsync(() => control.InputPolls > handed, "the poll that follows the re-delivery");

        Assert.Equal("once", await ValueOfAsync(page, "#password"));
    }

    /// terminal: once the page leaves its origin the browser holds the signed-in account (address, order history)
    /// and no path resumes the stream
    [Fact]
    public async Task A_page_that_leaves_its_origin_stops_the_stream_for_good()
    {
        var (page, control) = await OpenAsync();
        var session = Session(page, control);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        await page.GotoAsync(ElsewhereUrl);
        await UntilAsync(() => session.Stopped, "the stream to latch shut");

        // disposing waits both loops out, so everything that will ever be posted has been
        await session.DisposeAsync();

        Assert.True(session.Stopped);
        Assert.All(control.Frames, f => Assert.Equal("https://provider.test", f.Origin));
    }

    /// a login that posts a form and lands on a second page of its own site is ordinary;
    /// a latch firing on it would make the feature useless
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

    /// HttpClient.Timeout surfaces as TaskCanceledException, an OperationCanceledException like the shutter's stop signal;
    /// treated as one, a single stalled POST ended the shutter silently and permanently
    [Fact]
    public async Task A_frame_post_the_client_gives_up_on_is_retried_rather_than_ending_the_stream()
    {
        var (page, control) = await OpenAsync();
        control.ClientTimeout = TimeSpan.FromMilliseconds(250);
        control.StallFrames(1);

        // a still page sends its next picture on the heartbeat, so it comes round quickly here
        await using var session = Session(page, control, o => o with
        {
            IdleInterval = TimeSpan.FromMilliseconds(40),
            MaxSilence = TimeSpan.FromMilliseconds(300),
        });

        session.Start(CancellationToken.None);

        await UntilAsync(() => control.Frames.Count >= 1, "a frame to land after the stalled one");
        Assert.False(session.Stopped);
    }

    /// the worse failure, invisible from outside: frames carry on so the view looks alive
    /// while every tap and keystroke does nothing
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

    /// the enum converter accepts integers; an unknown kind once hit an "unreachable" default arm and faulted the input task
    /// for the rest of the login. The contract refuses it now; this asserts the whole chain
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

    /// a control plane that will not take a frame is a stop, not a retry:
    /// how a revoked capability or finished challenge reaches the shutter
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

    /// a wildcard origin is refused, not expanded: <c>*.provider.test</c> would keep streaming through a successful login
    [Fact]
    public async Task A_wildcard_origin_streams_nothing()
    {
        var (page, control) = await OpenAsync();
        await using var session = Session(page, control, o => o with { Origins = ["*.provider.test"] });

        session.Start(CancellationToken.None);
        await UntilAsync(() => session.Stopped, "the stream to refuse to open");

        Assert.Empty(control.Frames);
    }

    /// not an assertion about speed (a shared build machine would flake) but that the measurement HAPPENS: every cadence
    /// and bandwidth figure scales with it, and a stream that reports nothing must not survive a refactor
    [Fact]
    public async Task The_cost_of_a_frame_is_measured_and_written_down()
    {
        var (page, control) = await OpenAsync();

        // the fake's empty input poll answers after 50 ms where a real one holds;
        // the floor against a spin would dominate the measure
        await using var session = Session(
            page,
            control,
            o => o with { MeterInterval = TimeSpan.FromSeconds(1), EmptyPollFloor = TimeSpan.FromMilliseconds(1) },
            log: true);

        session.Start(CancellationToken.None);
        await UntilAsync(() => control.Frames.Count >= 1, "the first frame");

        // typing keeps the stream in its burst tier and the page changing: the expensive case worth timing
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

    /// SetContentAsync leaves the page on about:blank, which has no host: the origin latch would refuse to open
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

    private static async Task<(double X, double Y)> CentreOfAsync(IPage page, string selector)
    {
        var box = await page.Locator(selector).BoundingBoxAsync()
                  ?? throw new InvalidOperationException($"'{selector}' is not on the page");

        return ((box.X + (box.Width / 2)) / Width, (box.Y + (box.Height / 2)) / Height);
    }

    private static async Task<string> ValueOfAsync(IPage page, string selector) =>
        await page.EvaluateAsync<string>($"() => document.querySelector('{selector}').value");

    private static Task<System.Text.Json.JsonElement?> ShowAnErrorAsync(IPage page) =>
        page.EvaluateAsync("() => { document.querySelector('#error').textContent = 'Onjuist wachtwoord'; }");

    private static Task UntilAsync(Func<bool> condition, string what) =>
        UntilAsync(() => Task.FromResult(condition()), what);

    /// a fixed sleep long enough to be reliable on a loaded build machine would make the suite slower than the feature
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
