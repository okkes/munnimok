using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests;

/// <summary>
/// The live camera - Chromium's own screencast (#429) - against a real
/// browser, because every claim it makes is a claim about what Chromium and
/// Playwright actually do and a fake would simply agree with whatever we
/// assumed.
///
/// Two of these are the fork in the redaction rule made visible: the same
/// page, still holding a password, is refused by the relay's capture and
/// streamed by the live one. Delete either half and one of them fails.
///
/// Every wait here ends on the event it waits for, under a generous deadline;
/// the one stretch of nothing is a caret's blink period, after which a blink
/// would have had to show.
/// </summary>
public sealed class LiveFrameTests(ITestOutputHelper output) : IAsyncLifetime
{
    /// <summary>
    /// The agent's browser is phone-sized so providers serve their mobile
    /// layout, and at scale factor 1 so one image pixel is one CSS pixel.
    /// </summary>
    private const int Width = 390;

    private const int Height = 844;

    private IPlaywright? _playwright;
    private IBrowser? _browser;

    public async Task InitializeAsync()
    {
        _playwright = await Microsoft.Playwright.Playwright.CreateAsync();
        _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions { Headless = true });
        _decoder = new JpegProbe(await _browser.NewPageAsync());
    }

    public async Task DisposeAsync()
    {
        if (_browser is not null) await _browser.CloseAsync();
        _playwright?.Dispose();
    }

    /// <summary>
    /// The size a frame advertises is the size its pixels are.
    ///
    /// This is the whole coordinate contract in one assertion. The consumer
    /// multiplies its fractions by the size in the header; if the encoder
    /// produced anything else every event the human makes lands at the
    /// difference, and nothing in the system notices.
    /// </summary>
    [Fact]
    public async Task A_live_frame_is_a_jpeg_at_the_size_it_says_it_is()
    {
        var page = await NewPageAsync(LoginForm());
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("the first frame");

        Assert.True(Jpeg.Looks(frame.Jpeg), "the live path must produce a JPEG, never a PNG");
        Assert.Equal((Width, Height), (frame.Width, frame.Height));
        Assert.Equal((Width, Height), Jpeg.SizeOf(frame.Jpeg));

        output.WriteLine($"live frame at q{new LiveViewOptions().SettledQuality}, {Width}x{Height}: {frame.Jpeg.Length} B");
    }

    /// <summary>
    /// A retina agent produces a frame at CSS size, not at device size.
    ///
    /// The screencast encodes device pixels unless it is bounded, so without
    /// the bound this page comes back 780x1688 for a 390x844 viewport: twice
    /// the bytes for the same picture, and a size that no longer reads as the
    /// coordinate space every fraction the human sends is multiplied by.
    ///
    /// The agent runs at scale factor 1 today, which is exactly why this test
    /// is here: the bug is invisible until somebody runs a headed agent on a
    /// laptop, and then it is invisible again because it looks like a UI
    /// alignment problem.
    /// </summary>
    [Fact]
    public async Task A_retina_agent_still_produces_a_frame_at_css_size()
    {
        var page = await NewPageAsync(LoginForm(), deviceScaleFactor: 2);
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("the first frame");

        Assert.Equal((Width, Height), (frame.Width, frame.Height));
        Assert.Equal((Width, Height), Jpeg.SizeOf(frame.Jpeg));
    }

    /// <summary>
    /// The relay's refusal, unchanged. A page whose password box holds content
    /// produces no still - and every existing caller depends on that.
    /// </summary>
    [Fact]
    public async Task The_relay_still_refuses_a_page_that_holds_a_secret()
    {
        var page = await NewPageAsync(LoginForm(password: "hunter2"));
        var redactor = Redactor();

        Assert.False(await redactor.IsSafeToCaptureAsync(page, CancellationToken.None));
        Assert.Empty(await redactor.CaptureAsync(page, null, CancellationToken.None));
    }

    /// <summary>
    /// And the live path photographs that same page anyway.
    ///
    /// This is the inversion, and it is deliberately asserted right beside the
    /// test above so the pair reads as one decision. Refusing here would stream
    /// a black rectangle at the exact moment the feature exists for - the human
    /// is typing that password, on purpose, into the provider's own page - and
    /// what makes it acceptable is the custody change around it, not a softer
    /// rule: a streamed provider declares no credential fields, so nothing of
    /// ours was typed in, and the frame is never stored anywhere.
    /// </summary>
    [Fact]
    public async Task The_live_path_photographs_a_page_the_human_is_typing_into()
    {
        var page = await NewPageAsync(LoginForm(password: "hunter2"));
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("a frame of the filled-in form");

        Assert.Equal((Width, Height), Jpeg.SizeOf(frame.Jpeg));
    }

    /// <summary>
    /// The live path leaves the page as it found it, as the page can see it.
    ///
    /// The relay hides secret-bearing elements for the length of a capture and
    /// puts them back; the live path never touches the DOM at all. The one
    /// thing it adds - the rule that steadies the caret - is an inspector
    /// stylesheet, which no script on the page can enumerate. Worth pinning,
    /// because the human is mid-login on this page and a field left invisible,
    /// or a stylesheet the page did not load, in the DOM of a page whose whole
    /// purpose is detecting automation, would be discovered by them and not by
    /// us.
    /// </summary>
    [Fact]
    public async Task The_live_path_does_not_touch_the_page_it_photographs()
    {
        var page = await NewPageAsync(LoginForm(password: "hunter2"));
        var sheets = await page.EvaluateAsync<int>("() => document.styleSheets.length");

        await using var camera = await CameraAsync(page);
        await camera.NextAsync("the first frame");

        Assert.Equal(sheets, await page.EvaluateAsync<int>("() => document.styleSheets.length"));
        Assert.Equal(0, await page.EvaluateAsync<int>("() => document.querySelectorAll('style, [data-connector-vis]').length"));
        Assert.Equal("visible", await page.EvaluateAsync<string>(
            "() => getComputedStyle(document.querySelector('#password')).visibility"));
        Assert.Equal("hunter2", await page.EvaluateAsync<string>(
            "() => document.querySelector('#password').value"));
    }

    /// <summary>
    /// A focused field does not blink pictures into the stream, and the human
    /// still sees where they type.
    ///
    /// A blinking caret is a new compositor frame about every half second for
    /// as long as a field has focus - twice a second of frames that say
    /// nothing. Steadied, a focused field sends nothing until something on the
    /// page changes; and the first picture after a stretch longer than a blink
    /// is then the change, not a blink.
    /// </summary>
    [Fact]
    public async Task A_focused_field_sends_nothing_until_the_page_changes()
    {
        var page = await NewPageAsync(LoginForm());
        await page.FocusAsync("#password");

        await using var camera = await CameraAsync(page);
        await camera.NextAsync("the first frame");

        Assert.Equal("manual", await page.EvaluateAsync<string>(
            "() => getComputedStyle(document.querySelector('#password')).caretAnimation"));

        // A start draws once or twice within a few milliseconds; a quiet spell
        // shorter than a blink ends that, and cannot outlast a caret that still
        // blinks - which the stretch after it, longer than one, then catches.
        await camera.DrainAsync(TimeSpan.FromMilliseconds(250));
        await Task.Delay(BlinkPeriod);
        Assert.True(camera.IsQuiet(), "a focused field drew a frame with nothing on the page changing");

        await page.EvaluateAsync("() => document.querySelector('#error').textContent = 'Onjuist wachtwoord'");
        await camera.NextAsync("the frame that shows the change");
    }

    /// <summary>
    /// A page that DID change sends a new picture, with different bytes, so a
    /// stream that sends nothing cannot be passing merely because it is stuck.
    /// </summary>
    [Fact]
    public async Task A_page_that_changed_sends_a_new_picture()
    {
        var page = await NewPageAsync(LoginForm());
        await using var camera = await CameraAsync(page);

        var before = await camera.NextAsync("the first frame");
        await page.EvaluateAsync("() => document.querySelector('#error').textContent = 'Onjuist wachtwoord'");

        // A start can draw the same picture twice; the change is the one that differs.
        await camera.UntilAsync(
            frame => Task.FromResult(!frame.Jpeg.AsSpan().SequenceEqual(before.Jpeg)), "the frame that shows the change");
    }

    /// <summary>
    /// The newest picture always arrives, however fast the page draws and
    /// however slowly the stream takes them.
    ///
    /// Chromium keeps at most three frames unacknowledged and drops whatever it
    /// composites past that - for good: the last state of an animation drawn
    /// while three were in flight never arrives. So every frame is acknowledged
    /// as it lands, and what waits is only ever the newest. Here nothing is
    /// taken while the page draws sixty frames and ends on red; the one picture
    /// taken afterwards has to be the red one.
    /// </summary>
    [Fact]
    public async Task The_last_state_of_a_busy_page_arrives_however_slowly_it_is_taken()
    {
        var page = await NewPageAsync(LoginForm());
        await using var camera = await CameraAsync(page);
        await camera.NextAsync("the first frame");

        await page.EvaluateAsync(@"() => new Promise(done => {
            let n = 0;
            const h = document.querySelector('h1');
            const tick = () => {
                h.textContent = 'Inloggen ' + (n++);
                if (n < 60) { requestAnimationFrame(tick); return; }
                document.body.style.background = '#ff0000';
                requestAnimationFrame(() => requestAnimationFrame(done));
            };
            requestAnimationFrame(tick);
        })");

        await camera.UntilAsync(frame => _decoder!.IsRedAsync(frame.Jpeg), "the red frame the animation ended on");
    }

    /// <summary>
    /// A context with no viewport - a headed window sized by whoever sits at
    /// it - is streamed at the size the browser says the picture covers, so
    /// the frame still carries the size its fractions are measured against.
    /// </summary>
    [Fact]
    public async Task A_context_with_no_viewport_is_streamed_at_the_size_the_browser_reports()
    {
        var context = await _browser!.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = ViewportSize.NoViewport,
        });

        var page = await context.NewPageAsync();
        await page.SetContentAsync(LoginForm());
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("the first frame");

        Assert.True(frame.Width > 0 && frame.Height > 0);
        Assert.Equal((frame.Width, frame.Height), Jpeg.SizeOf(frame.Jpeg));
    }

    /// <summary>
    /// What the encoder choice actually costs, measured against PNG on both
    /// kinds of page and at both tiers, because the belief it was chosen on is
    /// only half true.
    ///
    /// "PNG of a phone-sized page is a quarter of a megabyte" is a statement
    /// about CONTENT and not about size. A login form is flat white with a few
    /// boxes on it, which is the case deflate was built for - PNG can come back
    /// smaller than JPEG there. The moment there is a photograph on the page,
    /// which every real provider login has, that reverses by an order of
    /// magnitude, and it reverses harder still on the captcha grid this
    /// pipeline also has to carry.
    ///
    /// So the assertions are on the case the decisions rest on - JPEG beats PNG
    /// on real content, the moving tier is the cheaper one - and every number
    /// goes to the log.
    /// </summary>
    [Fact]
    public async Task The_encoder_is_measured_rather_than_assumed()
    {
        var redactor = Redactor();
        var box = new CropRegion(0, 0, Width, Height);

        var flat = await NewPageAsync(LoginForm());
        var flatPng = await redactor.CaptureAsync(flat, box, CancellationToken.None);
        var (flatSharp, flatSoft) = await BothTiersAsync(flat);

        var busy = await NewPageAsync(PhotographicPage());
        var busyPng = await redactor.CaptureAsync(busy, box, CancellationToken.None);
        var (busySharp, busySoft) = await BothTiersAsync(busy);

        var options = new LiveViewOptions();
        output.WriteLine(
            $"flat login form : PNG {flatPng.Length} B, JPEG q{options.SettledQuality} {flatSharp} B, q{options.MovingQuality} {flatSoft} B");
        output.WriteLine(
            $"page with a photo: PNG {busyPng.Length} B, JPEG q{options.SettledQuality} {busySharp} B, q{options.MovingQuality} {busySoft} B");

        Assert.NotEmpty(busyPng);
        Assert.True(busySharp * 3 < busyPng.Length,
            $"JPEG ({busySharp} B) must beat PNG ({busyPng.Length} B) comfortably on real content");
        Assert.True(busySoft < busySharp, $"the moving tier ({busySoft} B) must be the cheaper one ({busySharp} B)");
    }

    /// <summary>
    /// A page that leaves for an origin the stream may not show is never in a
    /// frame: not the first picture of it, not a half-drawn one.
    ///
    /// Checked on the pixels, not on a label: the other origin's page is solid
    /// red, and every frame that surfaced is read back through the browser's
    /// own decoder. The run is not vacuous - the camera says it withheld the
    /// frames that arrived meanwhile.
    /// </summary>
    [Fact]
    public async Task A_page_that_leaves_for_another_origin_is_never_in_a_frame()
    {
        var page = await NewRoutedPageAsync(url => url.Contains("elsewhere.test", StringComparison.Ordinal)
            ? "<!doctype html><html><body style='margin:0;background:#ff0000'><h1>Mijn account</h1></body></html>"
            : LoginForm());
        await page.GotoAsync("https://provider.test/login");

        await using var camera = await CameraAsync(page, url => url?.StartsWith("https://provider.test/", StringComparison.Ordinal) == true);
        var surfaced = new List<CastFrame> { await camera.NextAsync("the first frame") };

        await page.GotoAsync("https://elsewhere.test/account");
        await camera.UntilLeftAsync();

        Assert.True(await camera.WithheldAsync() > 0, "the other page drew nothing, so nothing was tested");
        while (camera.Camera.TryTake(out var late)) surfaced.Add(late);

        foreach (var frame in surfaced)
        {
            Assert.False(await _decoder!.IsRedAsync(frame.Jpeg), "a frame of the other origin's page surfaced");
        }
    }

    /// <summary>
    /// A navigation that stays on the allowed origin streams on: the next
    /// document's first picture arrives once its commit has been checked.
    /// </summary>
    [Fact]
    public async Task A_page_that_navigates_within_its_origin_keeps_its_pictures()
    {
        var page = await NewRoutedPageAsync(url => url.EndsWith("/two", StringComparison.Ordinal)
            ? "<!doctype html><html><body style='margin:0;background:#ff0000'><h1>Stap twee</h1></body></html>"
            : LoginForm());
        await page.GotoAsync("https://provider.test/login");

        await using var camera = await CameraAsync(page, url => url?.StartsWith("https://provider.test/", StringComparison.Ordinal) == true);
        await camera.NextAsync("the first frame");

        await page.GotoAsync("https://provider.test/login/two");

        await camera.UntilAsync(frame => _decoder!.IsRedAsync(frame.Jpeg), "the second page's picture");
        Assert.Null(camera.LeftFor);
    }

    /// <summary>The same page at both encodings, by the browser's own switch: the settled frame first, then the moving one.</summary>
    private static async Task<(int Sharp, int Soft)> BothTiersAsync(IPage page)
    {
        await using var camera = await CameraAsync(page);

        var sharp = await camera.NextAsync("the settled frame");
        await camera.DrainAsync(TimeSpan.FromMilliseconds(250));
        await camera.Camera.SetTierAsync(LiveTier.Moving);
        var soft = await camera.NextAsync("the moving frame");

        return (sharp.Jpeg.Length, soft.Jpeg.Length);
    }

    private static ScreenshotRedactor Redactor() => new(TestRig.Manifest, NullLogger.Instance);

    /// <summary>Longer than Chromium's caret blink (about 530 ms between frames, measured), so a blink has had its chance to draw.</summary>
    private static readonly TimeSpan BlinkPeriod = TimeSpan.FromMilliseconds(700);

    private JpegProbe? _decoder;

    private static async Task<TestCamera> CameraAsync(IPage page, Func<string?, bool>? isAllowed = null)
    {
        var camera = new TestCamera(page, isAllowed ?? (_ => true));
        await camera.Camera.StartAsync(LiveTier.Settled, CancellationToken.None);
        return camera;
    }

    /// <summary>A page on real origins, each request answered with the body the route gives it.</summary>
    private async Task<IPage> NewRoutedPageAsync(Func<string, string> body)
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
            Body = body(route.Request.Url),
        }));

        return page;
    }

    /// <summary>
    /// The camera, driven the way the session drives it: woken when a picture
    /// is waiting, every wait ending on the frame it waits for under a
    /// generous deadline.
    /// </summary>
    private sealed class TestCamera : IAsyncDisposable
    {
        private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(15);

        private readonly SemaphoreSlim _arrived = new(0, int.MaxValue);
        private readonly TaskCompletionSource<string> _left = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TestCamera(IPage page, Func<string?, bool> isAllowed)
        {
            Camera = new LiveScreencast(
                page,
                new LiveViewOptions(),
                isAllowed,
                url => _left.TrySetResult(url),
                () => _arrived.Release(),
                NullLogger.Instance,
                TimeProvider.System);
        }

        public LiveScreencast Camera { get; }

        public string? LeftFor => _left.Task.IsCompleted ? _left.Task.Result : null;

        /// <summary>No picture waiting, and none replaced unseen since the counts were last read.</summary>
        public bool IsQuiet() => !Camera.HasFrame && Camera.TakeCounts().Superseded == 0;

        /// <summary>Takes whatever arrives until nothing has for <paramref name="quietFor"/>, and resets the counts.</summary>
        public async Task DrainAsync(TimeSpan quietFor)
        {
            var deadline = DateTimeOffset.UtcNow + Deadline;
            while (DateTimeOffset.UtcNow < deadline)
            {
                while (Camera.TryTake(out _))
                {
                    // older pictures of the start, not the subject of the test
                }

                if (!await _arrived.WaitAsync(quietFor)) break;
            }

            Camera.TakeCounts();
        }

        /// <summary>Frames that arrived while the camera held them back, read until there is at least one.</summary>
        public async Task<int> WithheldAsync()
        {
            var deadline = DateTimeOffset.UtcNow + Deadline;
            var withheld = 0;
            while ((withheld += Camera.TakeCounts().Withheld) == 0)
            {
                if (DateTimeOffset.UtcNow > deadline) return 0;
                await Task.Delay(20);
            }

            return withheld;
        }

        public async Task<CastFrame> NextAsync(string what)
        {
            var deadline = DateTimeOffset.UtcNow + Deadline;
            while (true)
            {
                if (Camera.TryTake(out var frame)) return frame;

                var remaining = deadline - DateTimeOffset.UtcNow;
                if (remaining <= TimeSpan.Zero) throw new Xunit.Sdk.XunitException($"timed out waiting for {what}");
                await _arrived.WaitAsync(remaining);
            }
        }

        public async Task<CastFrame> UntilAsync(Func<CastFrame, Task<bool>> wanted, string what)
        {
            var deadline = DateTimeOffset.UtcNow + Deadline;
            while (DateTimeOffset.UtcNow < deadline)
            {
                var frame = await NextAsync(what);
                if (await wanted(frame)) return frame;
            }

            throw new Xunit.Sdk.XunitException($"timed out waiting for {what}");
        }

        public Task<string> UntilLeftAsync() => _left.Task.WaitAsync(Deadline);

        public ValueTask DisposeAsync() => Camera.DisposeAsync();
    }

    /// <summary>
    /// Reads a frame's pixels back through the browser's own JPEG decoder -
    /// a page beside the one under test, so a claim about what a picture SHOWS
    /// is checked on the picture.
    /// </summary>
    private sealed class JpegProbe(IPage page)
    {
        public async Task<bool> IsRedAsync(byte[] jpeg)
        {
            var rgb = await page.EvaluateAsync<int[]>(
                @"async (b64) => {
                    const img = new Image();
                    img.src = 'data:image/jpeg;base64,' + b64;
                    await img.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const d = ctx.getImageData(Math.floor(img.width / 2), img.height - 8, 1, 1).data;
                    return [d[0], d[1], d[2]];
                }",
                Convert.ToBase64String(jpeg));

            return rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60;
        }
    }

    private async Task<IPage> NewPageAsync(string html, float deviceScaleFactor = 1)
    {
        var context = await _browser!.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = Width, Height = Height },
            DeviceScaleFactor = deviceScaleFactor,
        });

        var page = await context.NewPageAsync();
        await page.SetContentAsync(html);
        return page;
    }

    /// <summary>
    /// The shape of every provider login: a username in plain text, a password
    /// in dots, a place for an error message, and a submit button. Named
    /// <c>password</c> because that is the key the shared manifest declares
    /// secret, so the redactor has something to refuse.
    /// </summary>
    internal static string LoginForm(string password = "") =>
        "<!doctype html><html><body style='margin:0;background:#ffffff;font:16px sans-serif'>"
        + "<h1 style='margin:24px 16px'>Inloggen</h1>"
        + "<div id='error' style='margin:0 16px;color:#c00;min-height:24px'></div>"
        + "<input id='username' name='username' autocomplete='username' placeholder='E-mailadres' "
        + "style='display:block;margin:8px 16px;width:calc(100% - 32px);height:48px;font-size:16px' />"
        + "<input id='password' name='password' type='password' autocomplete='current-password' "
        + "value='" + password + "' placeholder='Wachtwoord' "
        + "style='display:block;margin:8px 16px;width:calc(100% - 32px);height:48px;font-size:16px' />"
        + "<button id='submit' style='margin:16px;width:calc(100% - 32px);height:48px'>Inloggen</button>"
        + "</body></html>";

    /// <summary>
    /// A verification-code page the way providers build them: one box per
    /// digit, each taking one character and handing the focus on as soon as
    /// it has it. Text that arrives as one insertion lands whole in the first
    /// box; text typed a character at a time fills them one by one.
    /// </summary>
    internal static string CodeForm() =>
        "<!doctype html><html><body style='margin:0;background:#ffffff;font:16px sans-serif'>"
        + "<h1 style='margin:24px 16px'>Controlecode</h1>"
        + "<div style='display:flex;gap:8px;margin:8px 16px'>"
        + "<input id='d1' maxlength='1' inputmode='numeric' style='width:56px;height:56px;font-size:24px;text-align:center' />"
        + "<input id='d2' maxlength='1' inputmode='numeric' style='width:56px;height:56px;font-size:24px;text-align:center' />"
        + "<input id='d3' maxlength='1' inputmode='numeric' style='width:56px;height:56px;font-size:24px;text-align:center' />"
        + "</div>"
        + "<script>for (const box of document.querySelectorAll('input')) box.addEventListener('input', () => { if (box.value.length === 1 && box.nextElementSibling) box.nextElementSibling.focus(); });</script>"
        + "</body></html>";

    /// <summary>
    /// A page with a photograph on it, standing in for the hero image, the
    /// gradients and the antialiased type a real provider login is mostly made
    /// of. A SMOOTH field rather than per-pixel noise, and the difference
    /// matters: white noise is the worst case for both encoders and measures
    /// nothing anybody will ever ship, whereas a smooth field is the case where
    /// deflate finds no runs and the discrete cosine transform finds almost
    /// everything - which is what a photograph is.
    ///
    /// Drawn from a formula so it needs no asset and cannot change under the
    /// test.
    /// </summary>
    internal static string PhotographicPage() =>
        "<!doctype html><html><body style='margin:0'><canvas id='c' width='" + Width + "' height='" + Height
        + "'></canvas><script>"
        + "const x=document.getElementById('c').getContext('2d');"
        + "const d=x.createImageData(" + Width + "," + Height + ");"
        + "for(let y=0;y<" + Height + ";y++){for(let w=0;w<" + Width + ";w++){"
        + "const i=(y*" + Width + "+w)*4;"
        + "d.data[i]=128+120*Math.sin(w/37)*Math.cos(y/53);"
        + "d.data[i+1]=128+120*Math.sin((w+y)/61);"
        + "d.data[i+2]=128+120*Math.cos(w/23)*Math.sin(y/91);"
        + "d.data[i+3]=255;}}"
        + "x.putImageData(d,0,0);</script></body></html>";
}
