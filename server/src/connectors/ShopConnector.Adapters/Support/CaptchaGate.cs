using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Microsoft.Playwright;

namespace ShopConnector.Adapters.Support;

/// the kinds are different problems: a typed picture, a grid photographed out and tapped back,
/// a widget only someone at the browser can pass
internal enum CaptchaKind
{
    None,

    /// <summary>A widget nothing here can carry to a human who is elsewhere.</summary>
    Interactive,

    Image,

    /// its own kind: clicking it is a legitimate first move, relaying it is not (nothing to show a human yet)
    Checkbox,

    /// the one interactive wall a relay can carry: the answer is taps, not a string - picture out, taps back
    Grid,
}

internal readonly record struct CaptchaWall(CaptchaKind Kind, CropRegion? Crop);

/// taps are page-pixel clicks through the browser's input pipeline, not selectors: the grid sits in a cross-origin iframe
internal interface ITapSurface
{
    /// in CSS pixels (Tap.ToPagePixels); ordered, because a grid asking tiles in sequence cannot be answered out of sequence
    Task TapAsync(IReadOnlyList<(double X, double Y)> points, CancellationToken ct);
}

/// no pauses, jitter or curved travel: those make a machine look human, and these points were really chosen by a person
internal sealed class MouseTapSurface : ITapSurface
{
    private readonly IPage _page;

    public MouseTapSurface(IPage page)
    {
        ArgumentNullException.ThrowIfNull(page);

        _page = page;
    }

    public async Task TapAsync(IReadOnlyList<(double X, double Y)> points, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(points);

        foreach (var (x, y) in points)
        {
            ct.ThrowIfCancellationRequested();
            await _page.Mouse.ClickAsync((float)x, (float)y).ConfigureAwait(false);
        }
    }
}

internal readonly record struct CaptchaOutcome
{
    public static CaptchaOutcome Stuck { get; } = new();

    /// <summary>The human has been asked; the redirect is still the proof.</summary>
    public static CaptchaOutcome Asked { get; } = new() { Handled = true };

    public static CaptchaOutcome Solved(string redirect) => new() { Handled = true, Redirect = redirect };

    public bool Handled { get; private init; }

    public string? Redirect { get; private init; }
}

internal sealed record CaptchaSpec
{
    public required string ProviderId { get; init; }

    public required IReadOnlyList<string> Interactive { get; init; }

    /// empty by default: every widget is then Interactive; a provider opts in by naming the two frames
    /// (a claim about its markup)
    public IReadOnlyList<string> Grid { get; init; } = [];

    public IReadOnlyList<string> Checkbox { get; init; } = [];

    public IReadOnlyList<string> Image { get; init; } = [];

    /// <summary>Where a typed captcha's answer goes, and what decides the kind.</summary>
    public IReadOnlyList<string> Input { get; init; } = [];

    /// <summary>Short probes: a settle loop runs them on every pass.</summary>
    public int ProbeMs { get; init; } = 500;

    /// 3s: a captcha token ages while we wait, but a puzzle image on a home line is slower than one poll;
    /// when it runs out the picture is taken anyway
    public TimeSpan SettleBudget { get; init; } = TimeSpan.FromSeconds(3);

    /// bounds ESCALATIONS, not pictures: a human tapping through a grid does not spend it; a tick that did not take,
    /// or a finished answer that left another wall standing, does
    public int RelayRounds { get; init; } = 4;

    public int ImageSeconds { get; init; } = 300;

    /// longer than a typed captcha on purpose: covers someone noticing a prompt on a phone in another room
    public int InteractiveSeconds { get; init; } = 600;

    public int PollSeconds { get; init; } = 5;
}

/// meets a wall the human owns, never solves one: that is the line between a user's agent and abuse.
/// The grid goes out through the challenge protocol, the human taps in their own app, the taps are replayed.
/// Shared because the decision is not provider-specific.
internal sealed class CaptchaGate
{
    /// backstop on the relay loop: the wall clock is not the bound (asks park the budget, settling restarts
    /// after an answer); well past the longest real escalation (hCaptcha chains a handful of puzzles)
    private const int MaxRelayIterations = 24;

    private enum GridRound
    {
        /// <summary>Nothing could be relayed, or nothing readable came back.</summary>
        Lost,

        /// <summary>The taps were replayed and the human is not finished.</summary>
        More,

        /// <summary>The taps were replayed and the human says this one is done.</summary>
        Done,
    }

    private readonly CaptchaSpec _spec;
    private readonly TimeProvider _time;

    public CaptchaGate(CaptchaSpec spec, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(spec);

        _spec = spec;
        _time = time;
    }

    /// the distinction is about the ANSWER: picture + text box; grid = picture + taps; a widget with neither
    /// is a token minted in someone else's JavaScript, and nothing relays it
    public async Task<CaptchaWall> DetectAsync(ILoginPage page, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);

        // most specific first, load-bearing: the lists overlap (hCaptcha's frames differ by a URL fragment, the container
        // matches whatever is inside), so probing the general widget first reads every grid as the generic widget
        if (await page.FindAsync(_spec.Grid, _spec.ProbeMs, ct).ConfigureAwait(false) is { } grid)
        {
            return new CaptchaWall(CaptchaKind.Grid, grid.Crop);
        }

        if (await page.FindAsync(_spec.Checkbox, _spec.ProbeMs, ct).ConfigureAwait(false) is { } checkbox)
        {
            return new CaptchaWall(CaptchaKind.Checkbox, checkbox.Crop);
        }

        // hCaptcha draws pictures of its own, so the widget is probed before the image
        if (await page.FindAsync(_spec.Interactive, _spec.ProbeMs, ct).ConfigureAwait(false) is { } widget)
        {
            return new CaptchaWall(CaptchaKind.Interactive, widget.Crop);
        }

        if (await page.FindAsync(_spec.Image, _spec.ProbeMs, ct).ConfigureAwait(false) is not { } picture)
        {
            return new CaptchaWall(CaptchaKind.None, null);
        }

        // an image with nowhere to type is as out of reach as a widget: treated as one, not relayed to a human with nothing to do
        var input = await page.FindAsync(_spec.Input, _spec.ProbeMs, ct).ConfigureAwait(false);

        return new CaptchaWall(input is null ? CaptchaKind.Interactive : CaptchaKind.Image, picture.Crop);
    }

    public Task<CaptchaOutcome> FaceAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CaptchaWall wall, CancellationToken ct) =>
        FaceAsync(ctx, page, watcher, wall, taps: null, ct);

    /// taps null: no page to click into, the same as a provider naming no grid; a widget falls back to
    /// the human at the keyboard or a refusal
    public async Task<CaptchaOutcome> FaceAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CaptchaWall wall, ITapSurface? taps,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        // credentials are already upstream; the copy left in the form makes the redactor refuse to photograph (a relayable
        // captcha then waited on a human nobody asked). Clear the DOM, never weaken the redactor; before every branch.
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        if (wall.Kind is CaptchaKind.Image)
        {
            return await RelayImageAsync(ctx, page, wall.Crop, ct).ConfigureAwait(false);
        }

        if (IsRelayable(wall.Kind) && taps is not null)
        {
            return await RelayWidgetAsync(ctx, page, watcher, taps, wall, ct).ConfigureAwait(false);
        }

        return await LeaveToTheKeyboardAsync(ctx, watcher, ct).ConfigureAwait(false);
    }

    private static bool IsRelayable(CaptchaKind kind) => kind is CaptchaKind.Grid or CaptchaKind.Checkbox;

    /// nobody can reach a headless browser in a pool: say so at once rather than hang, so a consumer
    /// can tell the user to connect from a machine they sit at
    private async Task<CaptchaOutcome> LeaveToTheKeyboardAsync(
        IJobContext ctx, IRedirectWaiter watcher, CancellationToken ct)
    {
        if (!ctx.Attended) throw Unrelayable();

        return await AwaitSolvedAsync(ctx, watcher, ct).ConfigureAwait(false);
    }

    private ConnectorException Unrelayable() => ConnectorException.Blocked(
        $"{_spec.ProviderId}: an interactive captcha (hcaptcha/recaptcha) stands in the login, nothing about it " +
        "could be relayed to the account's owner, and this agent is unattended; a widget that shows no grid can " +
        "only be passed in a browser a human can see and touch");

    /// passive: nothing to type back, the widget hands its token to the provider; the redirect is watched
    /// throughout, first arrival wins
    private async Task<CaptchaOutcome> AwaitSolvedAsync(
        IJobContext ctx, IRedirectWaiter watcher, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var expiresAt = _time.GetUtcNow().AddSeconds(_spec.InteractiveSeconds);
        var poll = TimeSpan.FromSeconds(_spec.PollSeconds);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.AppApproval,
            PromptKey = MessageKeys.CaptchaInBrowser,
            ExpiresAt = expiresAt,
        }, ct);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is { } captured)
            {
                // nobody will answer now: the challenge's expiry is observed and dropped, not left as an unobserved
                // failure on a successful job
                _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);

                ctx.Progress(JobStep.Authenticating);
                return CaptchaOutcome.Solved(captured);
            }

            if (asked.IsCompleted)
            {
                // awaited, not ignored: an expired challenge is the platform's own error and must end the job
                await asked.ConfigureAwait(false);

                ctx.Progress(JobStep.Authenticating);
                return CaptchaOutcome.Asked;
            }

            if (_time.GetUtcNow() >= expiresAt) return CaptchaOutcome.Stuck;
        }
    }

    /// attended or not: the account's owner answers on a phone anywhere; nothing here judges a picture,
    /// it photographs and replays
    private async Task<CaptchaOutcome> RelayWidgetAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, ITapSurface taps, CaptchaWall wall,
        CancellationToken ct)
    {
        var relay = new WidgetRelay(wall);

        while (relay.Escalations < _spec.RelayRounds && relay.Iterations < MaxRelayIterations)
        {
            ct.ThrowIfCancellationRequested();

            if (await RoundAsync(ctx, page, watcher, taps, relay, ct).ConfigureAwait(false) is { } outcome)
            {
                return outcome;
            }
        }

        // rounds ran out with the widget standing: only someone at the browser can pass it; if nobody is, say so
        return await LeaveToTheKeyboardAsync(ctx, watcher, ct).ConfigureAwait(false);
    }

    private sealed class WidgetRelay
    {
        public WidgetRelay(CaptchaWall wall)
        {
            Current = wall;
        }

        public CaptchaWall Current { get; set; }

        /// once, ever: the box stays on the page after ticking, so a second pass would undo it
        public bool Ticked { get; set; }

        // Escalations: another wall our last gesture did not get past. Iterations: a backstop on the loop itself.
        // a round answered with taps is neither: counting it dropped logins into the paste-a-URL fallback after four
        // correct puzzles
        public int Escalations { get; set; }

        public int Iterations { get; set; }
    }

    private async Task<CaptchaOutcome?> RoundAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, ITapSurface taps, WidgetRelay relay,
        CancellationToken ct)
    {
        if (relay.Iterations++ > 0)
        {
            relay.Current = await DetectAsync(page, ct).ConfigureAwait(false);

            // the wall came down and the redirect has not arrived: the caller's own watch handles it, not another photograph
            if (relay.Current.Kind is CaptchaKind.None)
            {
                ctx.Progress(JobStep.Authenticating);
                return CaptchaOutcome.Asked;
            }

            if (!IsRelayable(relay.Current.Kind))
            {
                return await LeaveToTheKeyboardAsync(ctx, watcher, ct).ConfigureAwait(false);
            }
        }

        var relayed = await GestureAsync(ctx, page, taps, relay, ct).ConfigureAwait(false);
        if (relayed is GridRound.Lost) return CaptchaOutcome.Stuck;

        // More means the human is mid-answer: the relay working, not the provider resisting
        if (relayed is not GridRound.More) relay.Escalations++;

        // only a finished gesture waits for the provider (a human mid-grid gave it nothing to move on from).
        // the redirect is the only proof
        if (relayed is GridRound.Done
            && await watcher.WaitAsync(TimeSpan.FromSeconds(_spec.PollSeconds), ct).ConfigureAwait(false)
                is { } captured)
        {
            ctx.Progress(JobStep.Authenticating);
            return CaptchaOutcome.Solved(captured);
        }

        return null;
    }

    /// a landed tick is Done: our gesture, not theirs, so a still-standing widget counts against the rounds
    /// like a finished grid
    private async Task<GridRound> GestureAsync(
        IJobContext ctx, ILoginPage page, ITapSurface taps, WidgetRelay relay, CancellationToken ct)
    {
        if (relay.Current.Kind is CaptchaKind.Grid)
        {
            return await RelayGridAsync(ctx, page, taps, _spec.Grid, relay.Current.Crop, ct).ConfigureAwait(false);
        }

        if (relay.Ticked)
        {
            // the tick missed: a click lands mid-element, and mid hCaptcha's checkbox frame is the words beside the box.
            // No guessed offset (wrong invisibly once they restyle): relay the frame like any picture, the human taps their own box
            return await RelayGridAsync(ctx, page, taps, _spec.Checkbox, relay.Current.Crop, ct)
                .ConfigureAwait(false);
        }

        // once, ever: the box stays after ticking, so a second pass would undo it
        if (!await page.ClickAsync(_spec.Checkbox, _spec.ProbeMs, ct).ConfigureAwait(false))
        {
            return GridRound.Lost;
        }

        relay.Ticked = true;

        return GridRound.Done;
    }

    /// the picture and the answer are the widget's own: we neither read, score nor keep them. where must be the
    /// list crop came from, or the taps land on a different rectangle than the human saw
    private async Task<GridRound> RelayGridAsync(
        IJobContext ctx, ILoginPage page, ITapSurface taps, IReadOnlyList<string> where, CropRegion? crop,
        CancellationToken ct)
    {
        // no measurable box: the grid cannot be photographed alone nor its answer placed; relaying the whole viewport is never done
        if (crop is null) return GridRound.Lost;

        ctx.Progress(JobStep.AwaitingHuman);

        // let the widget finish drawing: after a tap hCaptcha clears and fetches the next puzzle, and a photo in
        // that gap is a spinner; best effort, the shutter follows regardless
        await page.SettleAsync(where, _spec.SettleBudget, ct).ConfigureAwait(false);

        // the crop lets the redactor drop the rest of the page, and is the frame the answer is measured against:
        // they must not differ
        var png = await ctx.Browser.ScreenshotAsync(crop, ct).ConfigureAwait(false);

        // no bytes: the redactor declines whatever it cannot verify; asking someone to tap an unseen picture,
        // or clicking an unseen grid, is never done
        if (png.Length == 0)
        {
            throw ConnectorException.Blocked(
                $"{_spec.ProviderId}: the captcha could not be photographed, so there was nothing to show the " +
                "account's owner and nothing they could answer");
        }

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.Image,
            // the one field that makes it relayable: the answer is points, not a string, and a consumer must know
            // to draw the right control
            AnswerKind = ChallengeAnswerKind.Taps,
            // same key as any captcha: answer_kind picks the control, and saying it twice lets the two disagree
            PromptKey = MessageKeys.Captcha,
            Image = png,
            Crop = crop,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_spec.InteractiveSeconds),
        }, ct).ConfigureAwait(false);

        // a consumer ignoring answer_kind sends typed text: never click a point inferred from prose, no human chose it
        if (!TapAnswer.TryParse(answer.Value, out var tapped)) return GridRound.Lost;

        // measured again: the human took time, and a widget that scrolled or re-laid out would offset every tap
        // (looks like a coordinate bug)
        if ((await page.FindAsync(where, _spec.ProbeMs, ct).ConfigureAwait(false))?.Crop is not { } region)
        {
            // the grid is gone or unmeasurable: the taps have nowhere to land
            return GridRound.Lost;
        }

        await taps.TapAsync([.. tapped.Taps.Select(tap => tap.ToPagePixels(region))], ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        // Submit marks the human finished: a widget's verify button is inside the relayed picture, so their last tap
        // presses it; it decides whether the next round waits for the provider
        return tapped.Submit ? GridRound.Done : GridRound.More;
    }

    /// attended or not: a photograph and a typed answer reach the account's owner wherever they are
    private async Task<CaptchaOutcome> RelayImageAsync(
        IJobContext ctx, ILoginPage page, CropRegion? crop, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        // the crop lets the redactor drop the rest of the page rather than merely obscure it
        var png = await ctx.Browser.ScreenshotAsync(crop, ct).ConfigureAwait(false);

        // no bytes: the redactor declined; asking someone to solve an unseen picture is worse than admitting we are stuck
        if (png.Length == 0) return CaptchaOutcome.Stuck;

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.Image,
            PromptKey = MessageKeys.Captcha,
            Image = png,
            Crop = crop,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_spec.ImageSeconds),
        }, ct).ConfigureAwait(false);

        // only the captcha is answered: resubmitting a password that may have counted is how an account gets locked
        if (!await page.AnswerAsync(_spec.Input, answer.Value, _spec.ProbeMs, ct).ConfigureAwait(false))
        {
            // the box is gone since classification: the page has moved on without us
            return CaptchaOutcome.Stuck;
        }

        ctx.Progress(JobStep.Authenticating);
        return CaptchaOutcome.Asked;
    }
}
