using System.Globalization;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Amazon;

/// amazon.nl, T3: browser or nothing; there is no consumer order API, every known project scrapes HTML.
/// No language is forced: azad's language=en_GB is unverified on .nl and fails silently (AmazonOptions.LanguageOverride).
/// No challenge is ever solved: a widget goes to a human at the browser, an unattended agent says blocked_by_provider.
public sealed class AmazonAdapter : IProviderAdapter
{
    public const string ProviderId = "amazon-nl";
    public const string ReceiptsResource = "receipts";

    /// wait after a 429 or 503; long on purpose: the observed case was a day of throttling,
    /// so a 30 s pause would expire before anyone retried
    internal static readonly TimeSpan ThrottlePenalty = TimeSpan.FromMinutes(15);

    private static readonly ProviderManifest Manifest = AmazonManifest.Build();

    private static readonly char[] PathEnd = ['?', '#'];

    private readonly AmazonOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public AmazonAdapter(AmazonOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new AmazonOptions();
        _time = time ?? TimeProvider.System;

        // the policy is shared with Albert Heijn and Lidl Plus (one decision, not three copies);
        // only the selectors and the patience are Amazon's
        _captcha = new CaptchaGate(new CaptchaSpec
        {
            ProviderId = ProviderId,
            Interactive = _options.InteractiveCaptchaSelectors,
            Image = _options.ImageCaptchaSelectors,
            Input = _options.CaptchaInputSelectors,
            ProbeMs = _options.ProbeMs,
            ImageSeconds = _options.ChallengeSeconds,
            InteractiveSeconds = _options.InteractiveCaptchaSeconds,
            PollSeconds = _options.RedirectPollSeconds,
        }, _time);
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // before a browser is leased: launching Chromium to find a blank field holds an agent for nothing
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        // not a RedirectWatcher: Amazon ends on the ordinary order list, and watching that URL latches on the adapter's own
        // opening navigation, reporting success before Amazon answered (skipping code and wall); PresenceAsync is the signal
        var result = await LoginAsync(
            ctx, new PlaywrightLoginPage(page, Manifest), new NoRedirect(_time), ct).ConfigureAwait(false);

        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        // CONFIRMED from the reference: COOKIES_SET_WHEN_AUTHENTICATED = ["x-main"]; a page that looks signed in without it is not,
        // and sealing it would fail on the first scheduled fetch instead of here
        if (!AmazonCookies.HasAny(storageState, _options.AuthCookieNames))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the login left no [{string.Join(", ", _options.AuthCookieNames)}] cookie behind");
        }

        return result with
        {
            Material = result.Material with { StorageState = storageState },
        };
    }

    /// internal so the offline suite can drive it: no live Chromium and Amazon account is available to it
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // not a hand-built /ap/signin URL: the reference hardcodes the US openid.assoc_handle=usflex;
        // the order list lets amazon.nl build its own sign-in chain
        await page.GotoAsync(OrdersUrl(_time.GetUtcNow().Year, 0), ct).ConfigureAwait(false);

        // a consent wall left standing covers the form
        _ = await page.ClickAsync(_options.ConsentSelectors, _options.ProbeMs, ct).ConfigureAwait(false);

        // through the kit's gate: the pooled fleet gets no profile directory, so on a FIRST connect the probes are pure
        // latency; on a REFRESH the restored cookie jar opens it (the gate asks "was this browser handed anything?")
        if (await SessionProbe.AskAsync(ctx, (_, t) => PresenceAsync(page, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            // a restored session still works: nothing went upstream, so CredentialSubmitted is not latched; safe to requeue
            ctx.Progress(JobStep.Finalizing);
            return Result();
        }

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("e-mail field", _options.UsernameSelectors);
        }

        // Amazon may ask for the credentials on two screens: probed so a one-page form still works;
        // the probe is short because it always misses on the two-step page
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            // advancing the wizard submits the e-mail: latch first, or a lost lease requeues a login that reached Amazon
            ctx.CredentialSubmitted();

            if (!await page.ClickAsync(_options.ContinueSelectors, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("continue button", _options.ContinueSelectors);
            }

            if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("password field, on either the first or the second screen", _options.PasswordSelectors);
            }
        }

        // idempotent. After this a lost lease fails the job: a retried login locks an account and Amazon may have sent a code
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("sign-in submit", _options.SubmitSelectors);
        }

        await SettleAsync(ctx, page, watcher, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);
        return Result();

        static LoginResult Result() => new()
        {
            // the storage state is attached by the public entry point, the only place that can read a cookie jar
            Material = new SessionMaterial(),
            Account = new ProviderAccount { DisplayName = Manifest.Name },
        };
    }

    private enum SettleOutcome
    {
        Waiting,

        /// a human wait ended: the budget restarts, as it measures Amazon's own latency
        Restart,

        Landed,

        Unpassed,
    }

    private sealed class SettleState
    {
        public bool ChallengeSeen { get; set; }

        public bool CodeAnswered { get; set; }
    }

    /// the last case is not invalid_credentials: guessing "wrong password" from silence is permanent, as it is never retried
    internal async Task SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
        var poll = TimeSpan.FromSeconds(_options.RedirectPollSeconds);
        var settle = new SettleState();

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var outcome = await SettleOnceAsync(ctx, page, watcher, poll, settle, ct).ConfigureAwait(false);

            if (outcome is SettleOutcome.Landed) return;
            if (outcome is SettleOutcome.Unpassed) break;

            if (outcome is SettleOutcome.Restart)
            {
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        // the password out of the DOM before failing: the runner photographs a failed page and the redactor refuses while a secret
        // field holds content, which lost the one capture showing what the browser saw
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        throw settle.ChallengeSeen
            ? ConnectorException.Blocked(
                $"{ProviderId}: a challenge stood between the sign-in and the order list and was not passed")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the sign-in neither reached the order list nor stated an error; " +
                $"last url was '{page.Url}'");
    }

    private async Task<SettleOutcome> SettleOnceAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, TimeSpan poll, SettleState settle,
        CancellationToken ct)
    {
        // the passkey nudge first: the password was already accepted, so it is neither failure nor challenge
        if (await DeclinePasskeyAsync(page, ct).ConfigureAwait(false))
        {
            // the budget restarts: the time before was us not knowing the page, not Amazon being slow
            return SettleOutcome.Restart;
        }

        // the wall first: one string read, while each check below probes selectors at 0.5 s apiece;
        // the verification page can vanish between polls
        if (!settle.ChallengeSeen && OnChallengePage(page))
        {
            await LiveAsync(ctx, page, watcher, ct).ConfigureAwait(false);
            return SettleOutcome.Landed;
        }

        // the waiter is only the poll interval: Amazon ends on an ordinary page, so the page itself says whether we are in
        if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return SettleOutcome.Landed;

        // not through SessionProbe's gate: it asks "was this browser handed anything?", wrong after credentials went upstream;
        // on a first connect it would shut this off and miss a landing already reached
        if (await PresenceAsync(page, ct).ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            return SettleOutcome.Landed;
        }

        await ThrowIfStatedFailureAsync(page, ct).ConfigureAwait(false);

        if (!settle.CodeAnswered
            && await page.FindAsync(_options.OtpSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            await SubmitCodeAsync(ctx, page, ct).ConfigureAwait(false);
            settle.CodeAnswered = true;

            // the budget restarts after a human wait: minutes spent reading a text message are not Amazon being slow
            return SettleOutcome.Restart;
        }

        if (settle.ChallengeSeen) return SettleOutcome.Waiting;

        var wall = await DetectWallAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return SettleOutcome.Waiting;

        settle.ChallengeSeen = true;
        return await FaceWallAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
    }

    private async Task ThrowIfStatedFailureAsync(ILoginPage page, CancellationToken ct)
    {
        // a refusal before a credential verdict: a locked or suspended account is Amazon refusing us, not a bad password
        if (await page.FindAsync(_options.RefusalSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            throw ConnectorException.Blocked(
                $"{ProviderId}: the sign-in page states the account is locked or suspended; " +
                "this is a refusal by Amazon, not a credential problem");
        }

        // the ONLY path that may report invalid_credentials
        if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the sign-in page stated a credential error");
        }
    }

    private async Task<CaptchaWall> DetectWallAsync(ILoginPage page, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);

        // the URL beside the markup: a page still drawing its iframe is already a wall by where the browser stands
        return wall.Kind is CaptchaKind.None && OnChallengePage(page)
            ? new CaptchaWall(CaptchaKind.Interactive, null)
            : wall;
    }

    private async Task<SettleOutcome> FaceWallAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CaptchaWall wall, CancellationToken ct)
    {
        // an AAmation puzzle cannot be photographed and typed back, and its token goes to Amazon:
        // only a person on that browser can pass it
        if (wall.Kind is CaptchaKind.Interactive)
        {
            await LiveAsync(ctx, page, watcher, ct).ConfigureAwait(false);
            return SettleOutcome.Landed;
        }

        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null) return SettleOutcome.Landed;

        return outcome.Handled ? SettleOutcome.Restart : SettleOutcome.Unpassed;
    }

    /// declining is the only option: two buttons on that page REGISTER A NEW CREDENTIAL on the user's account.
    /// False also when nothing dismissable is found: the wall check below then streams the page to its owner.
    internal async Task<bool> DeclinePasskeyAsync(ILoginPage page, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);

        var onNudge = _options.PasskeyNudgeUrlMarkers.Any(
            marker => page.Url.Contains(marker, StringComparison.OrdinalIgnoreCase));

        if (!onNudge) return false;

        return await page.ClickAsync(_options.PasskeyDeclineSelectors, _options.SelectorTimeoutMs, ct)
            .ConfigureAwait(false);
    }

    internal bool OnChallengePage(ILoginPage page)
    {
        ArgumentNullException.ThrowIfNull(page);

        return _options.ChallengeUrlMarkers.Any(
            marker => page.Url.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    /// Amazon challenges on the CLIENT, not the credentials: the login that reaches the order list from a watched browser
    /// lands on a verification page from a pooled one. The live view replaces the old app_approval wall, which pointed
    /// at an app that does not exist for this puzzle. The form is cleared first: the redactor refuses a filled secret field.
    internal async Task LiveAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // raised and awaited on its own: the live view's answer is the empty one every passive challenge sends,
        // the order list appearing ends it; linked so the ask can be ENDED, which stops the shutter and releases the browser
        using var view = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.LiveView,
            PromptKey = MessageKeys.LiveLogin,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds),
        }, view.Token);

        var poll = TimeSpan.FromSeconds(_options.RedirectPollSeconds);
        var deadline = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds);

        try
        {
            while (_time.GetUtcNow() < deadline)
            {
                ct.ThrowIfCancellationRequested();

                if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return;

                // ungated like the settle loop: this watches for a landing, not for a session somebody left behind
                if (await PresenceAsync(page, ct).ConfigureAwait(false) is SessionPresence.SignedIn) return;

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                $"{ProviderId}: the streamed sign-in ended without reaching the order list; " +
                "the verification Amazon asked for was not completed");
        }
        finally
        {
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    /// relays Amazon's one-time code; never solves it or stores a TOTP secret (see the manifest)
    private async Task SubmitCodeAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        var delivery = await DeliveryAsync(page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = MessageKeys.VerificationCode,
            Delivery = delivery,
            Length = _options.CodeLength,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.CodeChallengeSeconds),
        }, ct).ConfigureAwait(false);

        if (!await page.FillAsync(_options.OtpSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("one-time code field", _options.OtpSelectors);
        }

        ctx.Progress(JobStep.Authenticating);

        if (!await page.ClickAsync(_options.OtpSubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            // some code forms submit on the last keystroke and have no button: Enter carries it
            _ = await page.AnswerAsync(_options.OtpSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false);
        }
    }

    /// null rather than a guess: a wrong "we texted you" prompt strands someone whose code is in an authenticator app,
    /// and the challenge expires meanwhile
    private async Task<string?> DeliveryAsync(ILoginPage page, CancellationToken ct)
    {
        if (await page.FindAsync(_options.OtpAppSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is not null)
        {
            return "app";
        }

        if (await page.FindAsync(_options.OtpSmsSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is not null)
        {
            return "sms";
        }

        return await page.FindAsync(_options.OtpEmailSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is not null
            ? "email"
            : null;
    }

    /// on this provider the order list is the same question as "signed in". Amazon serves its sign-in chain and WAF challenge
    /// from paths that can carry the order-list return URL, so the "no" is a password box appearing (AmazonOptions.ProbeMs).
    /// The url alone never suffices and CannotTell is never answered; the x-main check in LoginAsync is the third witness.
    private async Task<SessionPresence> PresenceAsync(ILoginPage page, CancellationToken ct)
    {
        if (!Any(page.Url, _options.SignedInUrlMarkers)) return SessionPresence.SignedOut;

        // the URL alone is not enough: the sign-in chain and WAF challenge can carry the order-list return URL;
        // a password box means this is not the list
        return await page.FindAsync(_options.PasswordSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is null
               && await page.FindAsync(_options.UsernameSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is null
            ? SessionPresence.SignedIn
            : SessionPresence.SignedOut;
    }

    /// navigates, unlike PresenceAsync: a browser restored from a cookie jar starts on about:blank, which is neither page
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var browser = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browser, Manifest);

        await page.GotoAsync(OrdersUrl(_time.GetUtcNow().Year, 0), ct).ConfigureAwait(false);
        _ = await page.ClickAsync(_options.ConsentSelectors, _options.ProbeMs, ct).ConfigureAwait(false);

        return await PresenceAsync(page, ct).ConfigureAwait(false);
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        var material = ctx.Material
                       ?? throw ConnectorException.SessionExpired($"{ProviderId}: the job carries no session");

        if (string.IsNullOrWhiteSpace(material.StorageState))
        {
            // no refresh grant on this provider (the credential is a cookie jar): a fetch without one cannot recover
            throw ConnectorException.SessionExpired($"{ProviderId}: the session carries no browser state");
        }

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        var result = await FetchAsync(
            ctx,
            request,
            new PlaywrightAmazonPages(page, _options.SelectorTimeoutMs),
            new PlaywrightLoginPage(page, Manifest),
            new NoRedirect(_time),
            ct).ConfigureAwait(false);

        // Amazon rotates its session cookies constantly: persisting the jar keeps the next fetch from a superseded state
        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        return result with { RefreshedMaterial = material with { StorageState = storageState } };
    }

    private sealed class OrderWalk
    {
        public required ResourceRequest Request { get; init; }

        public required TimeZoneInfo Zone { get; init; }

        public required int Cap { get; init; }

        public required DateOnly Since { get; init; }

        public required DateOnly Until { get; init; }

        public List<AmazonOrderSummary> Collected { get; } = [];

        /// <summary>The cards the list could not place (no readable date): left out of this fetch, named in the notes.</summary>
        public List<string> Skipped { get; } = [];

        public HashSet<string> Seen { get; } = new(StringComparer.Ordinal);

        /// <summary>At least one order card was read, so the card selectors still work.</summary>
        public bool SawCard { get; set; }

        public bool SawEmptyMarker { get; set; }

        public bool Complete { get; set; } = true;

        public bool Stop { get; set; }
    }

    /// behind the seam so a recorded page can drive it: there is no API to stub
    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx,
        ResourceRequest request,
        IAmazonPages pages,
        ILoginPage? wall,
        IRedirectWaiter? redirects,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(pages);

        ctx.Progress(JobStep.Downloading);

        var zone = RetailZones.Dutch;
        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(_time.GetUtcNow(), zone).DateTime);
        var until = request.Until ?? today;
        var since = request.Since ?? until.AddYears(-1);

        var walk = new OrderWalk
        {
            Request = request,
            Zone = zone,
            Cap = cap,
            Since = since,
            Until = until,
        };

        await WalkListAsync(ctx, pages, wall, redirects, walk, ct).ConfigureAwait(false);

        // empty has two causes: no orders in the window, or an expired card selector, which would silently say "you bought nothing"
        if (!walk.SawCard && !walk.SawEmptyMarker)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the order list showed neither an order nor an empty-history notice; " +
                $"tried cards [{string.Join(", ", _options.OrderCardSelectors)}]");
        }

        var complete = walk.Complete;
        var ordered = walk.Collected.OrderByDescending(row => row.PurchasedAt).ToList();
        if (ordered.Count > cap)
        {
            ordered = [.. ordered.Take(cap)];
            complete = false;
        }

        var receipts = new List<Receipt>(ordered.Count);

        foreach (var summary in ordered)
        {
            ct.ThrowIfCancellationRequested();

            if (await ReceiptAsync(ctx, pages, request, summary, wall, redirects, ct).ConfigureAwait(false)
                is { } receipt)
            {
                receipts.Add(receipt);
            }
        }

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Receipts = receipts,
            Complete = complete,

            // No raw on this provider, deliberately - see the class summary.
            Via = Via(request),
        };
    }

    private async Task WalkListAsync(
        IJobContext ctx, IAmazonPages pages, ILoginPage? wall, IRedirectWaiter? redirects,
        OrderWalk walk, CancellationToken ct)
    {
        for (var year = walk.Until.Year;
             year >= walk.Since.Year && walk.Until.Year - year < _options.MaxYears && !walk.Stop;
             year--)
        {
            for (var index = 0; index < _options.MaxPagesPerYear && !walk.Stop; index++)
            {
                ct.ThrowIfCancellationRequested();

                var (fetched, dom) = await OpenAsync(
                    ctx, pages, OrdersUrl(year, index * _options.PageSize),
                    $"the {year} order list", wall, redirects, ct).ConfigureAwait(false);

                ctx.Progress(JobStep.Parsing);

                var before = walk.Skipped.Count;
                var more = ReadListPage(walk, fetched, dom);
                ctx.Found(walk.Collected.Count);
                if (walk.Skipped.Count > before)
                {
                    ctx.Note($"the {year} order list: {walk.Skipped.Count - before} card(s) without a readable order date left out of this fetch " +
                             $"({string.Join(", ", walk.Skipped.Skip(before))}) — the selectors in AmazonOptions.OrderDateLabels/OrderDateSelectors do not cover their layout");
                }
                if (!more) break;
            }
        }
    }

    private bool ReadListPage(OrderWalk walk, AmazonPage fetched, HtmlNode dom)
    {
        var rows = AmazonOrderParser.ParseList(dom, _options, walk.Zone, walk.Skipped);
        if (rows.Count == 0)
        {
            if (Any(fetched.Html, _options.EmptyHistoryMarkers)) walk.SawEmptyMarker = true;
            return false;
        }

        walk.SawCard = true;

        // a repeated page means startIndex advances nothing upstream; carrying on invites a block from a site that challenges
        // when bored
        var fresh = rows.Where(row => walk.Seen.Add(row.Id)).ToList();
        if (fresh.Count == 0) return false;

        walk.Collected.AddRange(fresh.Where(row => ReceiptFactory.InWindow(row.PurchasedAt, walk.Request)));

        // newest first: a page wholly older than the window means every later page and earlier year is too
        if (rows.All(row => DateOnly.FromDateTime(row.PurchasedAt.Date) < walk.Since)) walk.Stop = true;

        // one page past the cap proves the pass is partial
        if (walk.Collected.Count > walk.Cap)
        {
            walk.Complete = false;
            walk.Stop = true;
        }

        return AmazonOrderParser.HasNextPage(dom, _options);
    }

    private async Task<Receipt?> ReceiptAsync(
        IJobContext ctx, IAmazonPages pages, ResourceRequest request, AmazonOrderSummary summary,
        ILoginPage? wall, IRedirectWaiter? redirects, CancellationToken ct)
    {
        IReadOnlyList<ReceiptItem> items = [];
        IReadOnlyList<ReceiptDocument> documents = [];
        var payment = ReceiptFactory.Payment();
        Money? stated = null;

        // the invoice is opened when the card states no total even without items: no total means no receipt,
        // and one extra page beats failing the fetch
        var needsInvoice = request.WantsItems || summary.Total is null;

        if (needsInvoice && summary.InvoiceUrl is { } invoiceUrl)
        {
            var (_, dom) = await OpenAsync(
                ctx, pages, invoiceUrl, $"the invoice for '{summary.Id}'", wall, redirects, ct)
                .ConfigureAwait(false);

            // a cancelled order is not a receipt: skipped, as its empty invoice page would read as a shape change and fail the fetch
            if (AmazonOrderParser.IsCancelled(dom, _options)) return null;

            var invoice = AmazonOrderParser.ParseInvoice(dom, _options);
            items = request.WantsItems ? invoice.Items : [];
            payment = invoice.Payment;
            stated = invoice.StatedTotal;
        }

        if (request.WantsInvoice)
        {
            documents = await DocumentsAsync(ctx, pages, summary, ct).ConfigureAwait(false);
        }

        // the card's figure first: card and invoice are two independent statements of one number, the only integrity check here;
        // the invoice total as fallback keeps the order and still catches a line the parser missed
        var total = summary.Total ?? stated
            ?? throw ConnectorException.ProviderChanged(
                $"{ProviderId}: order '{summary.Id}' states no total on the list card and its " +
                "invoice states none either, so there is no figure to report");

        return ReceiptFactory.Build(
            ctx.SessionId,
            summary.Id,
            MerchantOf(),
            summary.PurchasedAt,
            total,
            payment,
            items) with
        {
            Documents = documents,
        };
    }

    /// <summary>
    /// Which upstream recipe answered, so the next breakage is diagnosable.
    /// </summary>
    private static string Via(ResourceRequest request)
    {
        var via = request.WantsItems ? "orders-html+print-invoice" : "orders-html";
        return request.WantsInvoice ? via + "+invoice-pdf" : via;
    }

    /// two requests minimum: the document URL has an opaque guid found only in the invoice list (an AJAX fragment);
    /// neither URL can be built from the order number. Failures are noted, never thrown: documents are an extra,
    /// and an order with no invoice yet is normal.
    private async Task<IReadOnlyList<ReceiptDocument>> DocumentsAsync(
        IJobContext ctx, IAmazonPages pages, AmazonOrderSummary summary, CancellationToken ct)
    {
        if (summary.DocumentsUrl is not { } listUrl)
        {
            ctx.Note($"order '{summary.Id}': the list card carried no invoice link; " +
                     $"tried [{string.Join(", ", _options.InvoiceListLinkSelectors)}]");
            return [];
        }

        string fragment;
        try
        {
            using var ticket = await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false);
            fragment = await pages.FragmentAsync(listUrl, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex)
        {
            ctx.Note($"order '{summary.Id}': the invoice list could not be fetched ({ex.Code}: {ex.Detail})");
            return [];
        }

        var links = AmazonOrderParser.ParseDocuments(HtmlParser.Parse(fragment), _options);
        if (links.Count == 0)
        {
            // the length: an empty body and a body of unrecognised links are different failures with one symptom
            ctx.Note($"order '{summary.Id}': the invoice list held no document link " +
                     $"({fragment.Length} chars, markers [{string.Join(", ", _options.DocumentPathMarkers)}])");
            return [];
        }

        var documents = new List<ReceiptDocument>(links.Count);

        foreach (var link in links.Take(_options.MaxDocumentsPerOrder))
        {
            ct.ThrowIfCancellationRequested();

            AmazonDownload fetched;
            try
            {
                using var ticket = await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false);
                fetched = await pages.DownloadAsync(link.Href, ct).ConfigureAwait(false);
            }
            catch (ConnectorException ex)
            {
                ctx.Note($"order '{summary.Id}': '{link.Href}' could not be downloaded " +
                         $"({ex.Code}: {ex.Detail})");
                continue;
            }

            if (IsThrottled(fetched.Status)) ctx.Pacer.Backoff(ThrottlePenalty);

            // by media type, not by name: an expired session answers a ".pdf" URL with an HTML sign-in page
            var wanted = _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase);
            if (fetched.Status is not 200 || !wanted || fetched.Bytes.Length == 0)
            {
                ctx.Note($"order '{summary.Id}': '{link.Href}' answered {fetched.Status} " +
                         $"'{fetched.MediaType}' with {fetched.Bytes.Length} byte(s); not attached");
                continue;
            }

            documents.Add(new ReceiptDocument
            {
                Kind = ReceiptDocumentKinds.Invoice,
                MediaType = fetched.MediaType,
                Name = link.Label,
                Filename = Filename(link.Href, summary.Id, documents.Count),
                SizeBytes = fetched.Bytes.Length,
                ContentBase64 = Convert.ToBase64String(fetched.Bytes),
            });
        }

        ctx.Note($"order '{summary.Id}': attached {documents.Count} of {links.Count} invoice document(s)");
        return documents;
    }

    /// Amazon names every one invoice.pdf: the order number goes in front, the index only when there are several
    private static string Filename(string href, string orderId, int alreadyTaken)
    {
        var extension = Path.GetExtension(new Uri(href, UriKind.RelativeOrAbsolute).IsAbsoluteUri
            ? new Uri(href).AbsolutePath
            : href.Split(PathEnd)[0]);

        if (string.IsNullOrEmpty(extension)) extension = ".pdf";

        var suffix = alreadyTaken == 0 ? string.Empty : $"-{alreadyTaken + 1}";
        return $"amazon-{orderId}-invoice{suffix}{extension}";
    }

    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // only if a browser already runs: launching Chromium just to sign out holds an agent,
        // and a disconnect must always succeed locally
        if (!ctx.Browser.Started) return;

        try
        {
            ctx.Progress(JobStep.LoggingOut);

            var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
            _ = await new PlaywrightAmazonPages(page, _options.SelectorTimeoutMs)
                .OpenAsync(_options.BaseUrl.TrimEnd('/') + _options.SignOutPath, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ConnectorException || PageOps.IsSelectorMiss(ex))
        {
            // logged by the platform, never fatal: a disconnect must succeed locally whatever Amazon does
        }
    }

    /// pacing sits above the IAmazonPages seam so recorded pages exercise it. A wall is faced once, by whoever is at
    /// the browser; it came down if the same URL reads as data again. An unattended agent refuses rather than hang.
    private async Task<(AmazonPage Page, HtmlNode Dom)> OpenAsync(
        IJobContext ctx, IAmazonPages pages, string url, string what,
        ILoginPage? wall, IRedirectWaiter? redirects, CancellationToken ct)
    {
        var first = await JudgedAsync(ctx, pages, url, ct).ConfigureAwait(false);
        if (first.Verdict.Kind == AmazonPageKind.Ok) return (first.Page, first.Dom);

        var facable = first.Verdict.Kind is AmazonPageKind.Interactive or AmazonPageKind.Image;
        if (!facable || !ctx.Attended || wall is null || redirects is null)
        {
            throw AmazonGuard.Failure(first.Verdict, first.Page, what, _options);
        }

        var kind = first.Verdict.Kind == AmazonPageKind.Image ? CaptchaKind.Image : CaptchaKind.Interactive;
        var crop = await wall.FindAsync(
            kind == CaptchaKind.Image ? _options.ImageCaptchaSelectors : _options.InteractiveCaptchaSelectors,
            _options.ProbeMs, ct).ConfigureAwait(false);

        var outcome = await _captcha
            .FaceAsync(ctx, wall, redirects, new CaptchaWall(kind, crop?.Crop), ct).ConfigureAwait(false);

        if (!outcome.Handled) throw AmazonGuard.Failure(first.Verdict, first.Page, what, _options);

        // the second attempt is the last: the wall is not faced again
        var second = await JudgedAsync(ctx, pages, url, ct).ConfigureAwait(false);
        if (second.Verdict.Kind == AmazonPageKind.Ok) return (second.Page, second.Dom);

        throw AmazonGuard.Failure(second.Verdict, second.Page, what, _options);
    }

    private async Task<(AmazonPage Page, HtmlNode Dom, AmazonVerdict Verdict)> JudgedAsync(
        IJobContext ctx, IAmazonPages pages, string url, CancellationToken ct)
    {
        var fetched = await PacedAsync(ctx, pages, url, ct).ConfigureAwait(false);
        var dom = HtmlParser.Parse(fetched.Html);
        return (fetched, dom, AmazonGuard.Inspect(fetched, dom, _options));
    }

    /// browser navigations bypass the politeness limiter (it sits on the job's HTTP client): a first connect is about fifty
    /// back-to-back navigations, a shape a defended site notices. The ticket is held across the whole load:
    /// the gap is measured from when a call FINISHES.
    private static async Task<AmazonPage> PacedAsync(
        IJobContext ctx, IAmazonPages pages, string url, CancellationToken ct)
    {
        using var ticket = await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false);

        var fetched = await pages.OpenAsync(url, ct).ConfigureAwait(false);

        // back off for longer than this job: the penalty makes the NEXT attempt arrive later;
        // no Retry-After is read, Amazon has never been seen to send one on a throttled page
        if (IsThrottled(fetched.Status)) ctx.Pacer.Backoff(ThrottlePenalty);

        return fetched;
    }

    /// exactly the pair the HTTP politeness limiter backs off on, so one provider has one rule through both doors.
    /// Not every block status: a 403 is a refusal and a 502 a bad gateway minute, neither a statement about our rate.
    internal static bool IsThrottled(int status) => status is 429 or 503;

    /// <c>language</c> is appended only when an operator switches on AmazonOptions.LanguageOverride
    internal string OrdersUrl(int year, int startIndex)
    {
        var query = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["timeFilter"] = _options.TimeFilterTemplate.Replace(
                "{year}", year.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal),
            ["startIndex"] = startIndex.ToString(CultureInfo.InvariantCulture),
        };

        if (!string.IsNullOrWhiteSpace(_options.LanguageOverride))
        {
            query["language"] = _options.LanguageOverride;
        }

        return UrlBuilder.WithQuery(_options.BaseUrl.TrimEnd('/') + _options.OrdersPath, query);
    }

    private static Merchant MerchantOf() => new() { Id = ProviderId, Name = Manifest.Name };

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"{ProviderId}: '{key}' is required");

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");

    private static bool Any(string haystack, IReadOnlyList<string> needles) =>
        needles.Any(needle => haystack.Contains(needle, StringComparison.OrdinalIgnoreCase));
}

/// no redirect to watch during a fetch: the proof a wall came down is the same URL reading as order history again;
/// waiting the full poll keeps the gate's loop from spinning
internal sealed class NoRedirect : IRedirectWaiter
{
    private readonly TimeProvider _time;

    public NoRedirect(TimeProvider time) => _time = time;

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        await Task.Delay(timeout, _time, ct).ConfigureAwait(false);
        return null;
    }
}

public static class AmazonAdapters
{
    public static IProviderAdapter Create(AmazonOptions? options = null, TimeProvider? time = null) =>
        new AmazonAdapter(options, time);
}
