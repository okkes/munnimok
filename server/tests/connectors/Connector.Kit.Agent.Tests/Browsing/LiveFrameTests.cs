using Connector.Kit.Agent.Browsing;
using Connector.Kit.Challenges;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace Connector.Kit.Agent.Tests;

/// real Chromium on purpose: every claim is about what Chromium and Playwright do, a fake agrees with our assumptions (#429)
/// the same password page is refused by the relay's capture and streamed by the live one: the fork in the redaction rule
public sealed class LiveFrameTests(ITestOutputHelper output) : IAsyncLifetime
{
    /// phone-sized so providers serve their mobile layout; scale factor 1 so one image pixel is one CSS pixel
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

    /// the size in the frame header is the coordinate space the consumer multiplies fractions by;
    /// a mismatch misplaces every event silently
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

    /// the screencast encodes device pixels unless bounded: a 390x844 viewport at scale 2 would come back 780x1688
    [Fact]
    public async Task A_retina_agent_still_produces_a_frame_at_css_size()
    {
        var page = await NewPageAsync(LoginForm(), deviceScaleFactor: 2);
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("the first frame");

        Assert.Equal((Width, Height), (frame.Width, frame.Height));
        Assert.Equal((Width, Height), Jpeg.SizeOf(frame.Jpeg));
    }

    [Fact]
    public async Task The_relay_still_refuses_a_page_that_holds_a_secret()
    {
        var page = await NewPageAsync(LoginForm(password: "hunter2"));
        var redactor = Redactor();

        Assert.False(await redactor.IsSafeToCaptureAsync(page, CancellationToken.None));
        Assert.Empty(await redactor.CaptureAsync(page, null, CancellationToken.None));
    }

    /// the live path photographs a password page the human is typing into on purpose; a streamed provider declares no
    /// credential fields and the frame is never stored
    [Fact]
    public async Task The_live_path_photographs_a_page_the_human_is_typing_into()
    {
        var page = await NewPageAsync(LoginForm(password: "hunter2"));
        await using var camera = await CameraAsync(page);

        var frame = await camera.NextAsync("a frame of the filled-in form");

        Assert.Equal((Width, Height), Jpeg.SizeOf(frame.Jpeg));
    }

    /// the live path only adds an inspector stylesheet, invisible to page scripts:
    /// a page that detects automation must see no DOM change
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

    /// a blinking caret is a compositor frame about every half second;
    /// steadied, a focused field sends nothing until the page changes
    [Fact]
    public async Task A_focused_field_sends_nothing_until_the_page_changes()
    {
        var page = await NewPageAsync(LoginForm());
        await page.FocusAsync("#password");

        await using var camera = await CameraAsync(page);
        await camera.NextAsync("the first frame");

        Assert.Equal("manual", await page.EvaluateAsync<string>(
            "() => getComputedStyle(document.querySelector('#password')).caretAnimation"));

        // a start draws once or twice within milliseconds; a quiet spell shorter than a blink ends that, and the
        // stretch after it, longer than a blink, catches a caret that still blinks
        await camera.DrainAsync(TimeSpan.FromMilliseconds(250));
        await Task.Delay(BlinkPeriod);
        Assert.True(camera.IsQuiet(), "a focused field drew a frame with nothing on the page changing");

        await page.EvaluateAsync("() => document.querySelector('#error').textContent = 'Onjuist wachtwoord'");
        await camera.NextAsync("the frame that shows the change");
    }

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

    /// Chromium keeps at most three frames unacknowledged and drops the rest for good:
    /// every frame is acknowledged on landing, so the newest always arrives
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

    /// PNG vs JPEG depends on content: a flat login form can favour PNG, a photograph reverses it by an order of magnitude;
    /// the assertions cover real content and the cheaper moving tier, every number goes to the log
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

    /// checked on pixels: the other origin's page is solid red, and the camera reports the frames it withheld,
    /// so the run is not vacuous
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

    /// named password because that is the key the shared manifest declares secret, so the redactor has something to refuse
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

    /// one box per digit, focus moves on at once: text inserted whole lands in the first box,
    /// text typed per character fills them
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

    /// a SMOOTH field, not noise: noise is the worst case for both encoders; on a smooth field deflate finds no runs
    /// and the DCT finds almost everything, like a photograph. Drawn from a formula so it needs no asset
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
