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

/// <summary>
/// amazon.nl - T3, browser or nothing.
///
/// There is no consumer order API. That is settled rather than assumed: three
/// independently maintained projects in three languages - a Python library, a
/// Chrome extension and a Playwright syncer - all scrape HTML, and one of them
/// writes an ANTLR grammar over page text to do it. Nobody writes an ANTLR
/// parser for a JSON endpoint.
///
/// Two decisions here are worth more than the code around them.
///
/// The first is that no language is forced. <c>azad</c> appends
/// <c>&amp;language=en_GB</c> to every non-English storefront to dodge locale
/// parsing, and it would be easy to copy. We do not have the problem it
/// solves - our money unit is declared and our parser reads Dutch - and the
/// parameter is unverified on <c>.nl</c>, so adopting it would put the happy
/// path on an unconfirmed query string whose failure mode is silent. See
/// <see cref="AmazonOptions.LanguageOverride"/>.
///
/// The second is that no challenge is ever solved. The reference library
/// ships first-class integrations for three paid captcha-solving services
/// because Amazon challenges constantly. This adapter ships none: a widget
/// goes to a human sitting at the browser, and an unattended agent says
/// <c>blocked_by_provider</c> immediately rather than pretending.
/// </summary>
public sealed class AmazonAdapter : IProviderAdapter
{
    public const string ProviderId = "amazon-nl";
    public const string ReceiptsResource = "receipts";

    /// <summary>
    /// How long every later call to Amazon waits once Amazon has answered one
    /// with a 429 or a 503.
    ///
    /// Long on purpose, and longer than the run that met it. The observed case
    /// was a whole day's throttling, not a busy minute, so a thirty-second
    /// pause would have expired before the user could plausibly try again and
    /// bought nothing at all.
    /// </summary>
    internal static readonly TimeSpan ThrottlePenalty = TimeSpan.FromMinutes(15);

    private static readonly ProviderManifest Manifest = AmazonManifest.Build();

    /// <summary>Where a path ends and its query or fragment begins.</summary>
    private static readonly char[] PathEnd = ['?', '#'];

    private readonly AmazonOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public AmazonAdapter(AmazonOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new AmazonOptions();
        _time = time ?? TimeProvider.System;

        // The policy is shared with Albert Heijn and Lidl Plus; only the
        // selectors and the patience are Amazon's. Sharing it is the point:
        // "never solve, ask whoever is at the browser, otherwise refuse" is
        // one decision, and three copies of it would be three chances to get
        // it wrong differently.
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

    // ---- login -------------------------------------------------------------

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // Checked before a browser is leased: launching Chromium to discover
        // that a required field is blank holds an agent for nothing.
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        // Deliberately NOT a RedirectWatcher.
        //
        // That helper exists to catch a navigation the browser is not allowed
        // to follow - appie://login-exit, com.lidlplus.app://callback - where
        // there is no page load to await and the event is seen once or never.
        // Amazon has no such callback: it finishes by landing on the order
        // list, which is an ordinary page the browser is sitting on. Watching
        // for that URL would latch on the adapter's OWN opening navigation to
        // exactly that address, and the login would then report success the
        // instant the password was submitted, before Amazon had answered
        // anything - skipping the one-time code and the wall entirely.
        // PresenceAsync is the honest signal, and this only supplies the poll
        // interval.
        var result = await LoginAsync(
            ctx, new PlaywrightLoginPage(page, Manifest), new NoRedirect(_time), ct).ConfigureAwait(false);

        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        // CONFIRMED from the reference's constants:
        // COOKIES_SET_WHEN_AUTHENTICATED = ["x-main"]. A page that looks
        // signed in but left no such cookie has signed nobody in, and sealing
        // that bundle would hand the user a connection that fails on its first
        // scheduled fetch instead of failing here where they can see it.
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

    /// <summary>
    /// The whole sign-in, behind the seam.
    ///
    /// Internal rather than private so the offline suite can drive it: every
    /// branch below decides how a human is treated - whether a wall is relayed
    /// or refused, whether silence is called a wrong password - and none of
    /// them is reachable without a live Chromium and a real Amazon account,
    /// which on this platform is a thing that may be spent about once.
    /// </summary>
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // Deliberately NOT a hand-built /ap/signin URL.
        //
        // The reference hardcodes openid.assoc_handle=usflex - a US value -
        // and its own docstring admits it is not adjusted for other domains.
        // Navigating to the order list instead lets amazon.nl build its own
        // sign-in chain with its own parameters, which is both correct by
        // construction and one fewer unverified constant to carry.
        await page.GotoAsync(OrdersUrl(_time.GetUtcNow().Year, 0), ct).ConfigureAwait(false);

        // A consent wall left standing covers the form; a missing one is the
        // normal case on a fresh profile.
        _ = await page.ClickAsync(_options.ConsentSelectors, _options.ProbeMs, ct).ConfigureAwait(false);

        // THROUGH THE KIT'S GATE, and on this provider the gate is doing real
        // work rather than standing open.
        //
        // Amazon runs on the pooled fleet, which is handed no profile
        // directory at all, so on a FIRST connect there is nothing that could
        // be holding a session and the two probes below would be pure latency
        // on the one run somebody is sitting and watching. On a REFRESH the
        // gate opens again, because the bundle's cookie jar is restored into
        // the browser - which is how this provider's refresh has skipped its
        // sign-in since before the seam existed, and is why the gate asks
        // "was this browser handed anything?" rather than "is this a BYO
        // agent?".
        if (await SessionProbe.AskAsync(ctx, (_, t) => PresenceAsync(page, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            // The lease restored a session that still works. Nothing goes
            // upstream, so CredentialSubmitted is deliberately not latched:
            // no login attempt has been spent and this job is safe to requeue.
            ctx.Progress(JobStep.Finalizing);
            return Result();
        }

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("e-mail field", _options.UsernameSelectors);
        }

        // Amazon asks for the two credentials on two SCREENS. Probed rather
        // than assumed, so a single-page form is still handled by the first
        // attempt and Amazon moving in either direction needs no release. The
        // probe is short on purpose: on the two-step page it always misses,
        // and that wait is pure latency on every single login.
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            // Advancing the wizard submits the e-mail address, so the account
            // is touched from here on. Latch first: a lease lost between the
            // click and the next line would otherwise requeue a login that
            // already reached Amazon.
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

        // Idempotent, so the two-step path above having latched already is
        // fine. After this a lost lease fails the job rather than requeuing
        // it: a retried login is how an account gets locked, and Amazon may
        // already have sent a code.
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
            // The storage state is attached by the public entry point, which
            // is the only place that can read a cookie jar.
            Material = new SessionMaterial(),
            Account = new ProviderAccount { DisplayName = Manifest.Name },
        };
    }

    /// <summary>What one pass of the settle loop found.</summary>
    private enum SettleOutcome
    {
        /// <summary>Nothing recognisable yet: poll again, on the same budget.</summary>
        Waiting,

        /// <summary>
        /// A human was waited on and answered. The budget restarts, because
        /// it measures how long Amazon takes to answer and none of that wait
        /// was Amazon's.
        /// </summary>
        Restart,

        /// <summary>The order list, or the redirect: the sign-in is done.</summary>
        Landed,

        /// <summary>A wall stood and was not passed. Stop, and say so.</summary>
        Unpassed,
    }

    /// <summary>
    /// What the settle loop has already dealt with, so a code is relayed once
    /// and a wall is faced once.
    /// </summary>
    private sealed class SettleState
    {
        public bool ChallengeSeen { get; set; }

        public bool CodeAnswered { get; set; }
    }

    /// <summary>
    /// Waits for the sign-in to resolve into one of five outcomes: the order
    /// list, a one-time code, a stated credential error, a wall, or nothing
    /// recognisable.
    ///
    /// The last case is deliberately not <c>invalid_credentials</c>. Guessing
    /// "wrong password" from silence sends somebody to reset a password that
    /// was fine - and because a credential error is never retried, the mistake
    /// is permanent for that session too.
    /// </summary>
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

        // The password out of the DOM before this fails.
        //
        // Not tidiness - it is the difference between a diagnosable failure and
        // a blind one. The runner photographs a page on its way out of a failed
        // job, and the redactor refuses, correctly, while a field the manifest
        // calls secret still holds content. So every failure on this path
        // logged "no capture: password still holds content" and threw away the
        // one artifact that would say what the browser was actually looking at.
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        throw settle.ChallengeSeen
            ? ConnectorException.Blocked(
                $"{ProviderId}: a challenge stood between the sign-in and the order list and was not passed")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the sign-in neither reached the order list nor stated an error; " +
                $"last url was '{page.Url}'");
    }

    /// <summary>
    /// One pass of the settle loop: every way the page can have resolved, in
    /// the order that keeps the cheap and decisive checks ahead of the slow
    /// ones.
    /// </summary>
    private async Task<SettleOutcome> SettleOnceAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, TimeSpan poll, SettleState settle,
        CancellationToken ct)
    {
        // The passkey nudge, first of all.
        //
        // The password has already been accepted by the time this appears -
        // it is the last thing between a working sign-in and the order
        // list - so it is neither a failure nor a challenge, and treating
        // it as either would report a login that WORKED as broken.
        if (await DeclinePasskeyAsync(page, ct).ConfigureAwait(false))
        {
            // Amazon has to build the next page. The budget restarts
            // because none of the time before this was the provider being
            // slow: it was us not knowing what we were looking at.
            return SettleOutcome.Restart;
        }

        // The wall, before anything else in the loop.
        //
        // It reads one string and costs nothing, while every check below it
        // probes a list of selectors at half a second each - so a pass that
        // starts with those spends fifteen seconds looking for the things
        // that are not there before it ever asks the question that can be
        // answered instantly. Amazon's verification page can come and go
        // between two polls, and a wall seen late is a wall not seen.
        if (!settle.ChallengeSeen && OnChallengePage(page))
        {
            await LiveAsync(ctx, page, watcher, ct).ConfigureAwait(false);
            return SettleOutcome.Landed;
        }

        // The wait is the poll interval. A waiter that answers is a
        // provider whose sign-in ends somewhere the browser cannot follow.
        // Amazon's ends on an ordinary page, so on this provider it is the
        // page itself that says whether we are in.
        if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return SettleOutcome.Landed;

        // NOT through SessionProbe's gate, and deliberately: this is the
        // settle loop after credentials have gone upstream, so it is
        // asking whether the sign-in it just drove has LANDED. The gate
        // answers "was this browser handed anything?", which is the right
        // question before a sign-in and the wrong one after it - shutting
        // this off on a first connect would leave the login waiting for a
        // landing it had already reached.
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

            // The budget measures how long AMAZON takes to answer, so it
            // restarts once a wait on a human is over: the minutes they
            // spent reading a text message are not the provider being
            // slow, and charging them to it fails a login that is about to
            // work.
            return SettleOutcome.Restart;
        }

        if (settle.ChallengeSeen) return SettleOutcome.Waiting;

        var wall = await DetectWallAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return SettleOutcome.Waiting;

        settle.ChallengeSeen = true;
        return await FaceWallAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The two failures the sign-in page states in as many words, thrown as
    /// what they are.
    /// </summary>
    private async Task ThrowIfStatedFailureAsync(ILoginPage page, CancellationToken ct)
    {
        // A refusal before a credential verdict, always. Amazon locking or
        // suspending an account is the provider refusing us; reporting it
        // as a bad password would send the user to change a password that
        // will not help and is not the problem.
        if (await page.FindAsync(_options.RefusalSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            throw ConnectorException.Blocked(
                $"{ProviderId}: the sign-in page states the account is locked or suspended; " +
                "this is a refusal by Amazon, not a credential problem");
        }

        // The page states a credential failure itself. This is the ONLY
        // path that may report invalid_credentials.
        if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the sign-in page stated a credential error");
        }
    }

    /// <summary>
    /// The wall this page is showing, if any: read from the markup, and then
    /// from where the browser is standing.
    /// </summary>
    private async Task<CaptchaWall> DetectWallAsync(ILoginPage page, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);

        // The URL, beside the markup. Amazon's verification flow lives
        // on its own path, and a page still drawing its iframe is
        // already unmistakably a wall by where the browser is standing.
        return wall.Kind is CaptchaKind.None && OnChallengePage(page)
            ? new CaptchaWall(CaptchaKind.Interactive, null)
            : wall;
    }

    /// <summary>
    /// Faces a wall the settle loop has met: a widget goes to whoever owns the
    /// account, a picture goes through the kit's relay.
    /// </summary>
    private async Task<SettleOutcome> FaceWallAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CaptchaWall wall, CancellationToken ct)
    {
        // An AAmation puzzle in an iframe cannot be photographed
        // and typed back - there is no string to send, and the
        // token it mints goes to Amazon rather than to us. The only
        // person who can pass it is one with hands on that browser,
        // so the browser goes to them.
        if (wall.Kind is CaptchaKind.Interactive)
        {
            await LiveAsync(ctx, page, watcher, ct).ConfigureAwait(false);
            return SettleOutcome.Landed;
        }

        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null) return SettleOutcome.Landed;

        return outcome.Handled ? SettleOutcome.Restart : SettleOutcome.Unpassed;
    }

    /// <summary>
    /// Says no to the passkey, and gets on with the sign-in.
    /// </summary>
    /// <remarks>
    /// Declining is the only option this adapter will take. Two of the buttons
    /// on that page REGISTER A NEW CREDENTIAL against the user's Amazon
    /// account, and a connector that added a factor to somebody's account in
    /// order to read their receipts would have done something enormously larger
    /// than it was asked to - so the selector list holds the refusals only.
    ///
    /// Returns false when the page is not the nudge, and also when it is but
    /// nothing dismissable could be found: the second case is left to the wall
    /// check below it, which streams the page to whoever owns the account. A
    /// human looking at a passkey prompt can answer it.
    /// </remarks>
    internal async Task<bool> DeclinePasskeyAsync(ILoginPage page, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(page);

        var onNudge = _options.PasskeyNudgeUrlMarkers.Any(
            marker => page.Url.Contains(marker, StringComparison.OrdinalIgnoreCase));

        if (!onNudge) return false;

        return await page.ClickAsync(_options.PasskeyDeclineSelectors, _options.SelectorTimeoutMs, ct)
            .ConfigureAwait(false);
    }

    /// <summary>Whether the browser is standing on Amazon's verification flow.</summary>
    internal bool OnChallengePage(ILoginPage page)
    {
        ArgumentNullException.ThrowIfNull(page);

        return _options.ChallengeUrlMarkers.Any(
            marker => page.Url.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// Hands the browser to the person whose account it is.
    ///
    /// Amazon decides to challenge on the CLIENT, not on the credentials: the
    /// same e-mail and password that walk straight into the order list from a
    /// browser somebody is looking at land on "Bevestig je identiteit" from a
    /// pooled one. So a correct password is not enough here and no amount of
    /// selector work will make it enough.
    ///
    /// What the platform has for exactly this is the live view, and this
    /// provider was the last one still without it: its manifest named the wall
    /// <c>app_approval</c>, which a consumer renders as "approve it in the
    /// app" - an instruction about a browser the user cannot see, for a puzzle
    /// with no app behind it. Unattended, the alternative was a hard refusal.
    ///
    /// Nothing is typed here. The credentials have already gone upstream and
    /// the form is cleared before the first frame, because the redactor will
    /// not photograph a page while a field the manifest calls secret still
    /// holds one.
    /// </summary>
    internal async Task LiveAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // Raised and awaited on its own. The answer to a live view is the empty
        // one every passive challenge sends, and what actually ends this is the
        // order list appearing - somebody who passes the puzzle and never
        // touches the consumer's UI again still finishes. Linked so the ask can
        // be ENDED rather than merely abandoned, which is what stops the
        // shutter and releases the browser.
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

                // Ungated, exactly as the settle loop above is: the human is
                // signing in on the page in front of them right now, so this
                // is watching for a landing rather than looking for a session
                // somebody left behind.
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

    /// <summary>
    /// Relays Amazon's one-time code. Never solves it, and never stores the
    /// TOTP secret that would let it: see the manifest for why that field does
    /// not exist.
    /// </summary>
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
            // Some code forms submit on the last keystroke and have no button
            // at all, which is what the Enter carries.
            _ = await page.AnswerAsync(_options.OtpSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Which way Amazon says it sent the code, or null.
    ///
    /// Null rather than a guess. A prompt that says "the code we texted you"
    /// to somebody whose code is in an authenticator app sends them to stare
    /// at a phone that will never buzz, and they cannot recover from that on
    /// their own because the challenge expires while they wait. A generic
    /// prompt is worse copy and a better outcome.
    /// </summary>
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

    /// <summary>
    /// Whether the browser is standing on the order list, which on this
    /// provider is the same question as "is anybody signed in".
    /// </summary>
    /// <remarks>
    /// The kit's two lessons, in the shape Amazon's own pages take.
    /// <para>
    /// LESSON ONE - the page is given a bounded chance to say NO - is here as
    /// the FORM PROBE rather than as a wait for a bounce. Amazon does not
    /// serve the order list to a signed-out browser and then move it: it
    /// serves the sign-in chain, and its WAF challenge, from paths that can
    /// still carry the order-list return URL. So the "no" this page has to be
    /// given time to say is a password box appearing on it, and
    /// <see cref="AmazonOptions.ProbeMs"/> is that time.
    /// </para>
    /// <para>
    /// LESSON TWO - a positive is confirmed rather than assumed - is why the
    /// url is never enough on its own, and why the answer here is never
    /// <see cref="SessionPresence.CannotTell"/>: both witnesses are decisive.
    /// An address that is not the order list is the sign-in chain, and an
    /// address that is one with no credential box on it is the list itself.
    /// The sealing check in <see cref="LoginAsync(IJobContext, CancellationToken)"/>
    /// is the third: <c>x-main</c> is the cookie Amazon sets when it has really
    /// authenticated somebody, and a login that leaves none is refused whatever
    /// this said.
    /// </para>
    /// </remarks>
    private async Task<SessionPresence> PresenceAsync(ILoginPage page, CancellationToken ct)
    {
        if (!Any(page.Url, _options.SignedInUrlMarkers)) return SessionPresence.SignedOut;

        // The URL alone is not enough: Amazon serves its sign-in chain and its
        // WAF challenge from paths that can still carry the order-list return
        // URL. A page with a password box on it is not the order list.
        return await page.FindAsync(_options.PasswordSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is null
               && await page.FindAsync(_options.UsernameSelectors, _options.ProbeMs, ct).ConfigureAwait(false) is null
            ? SessionPresence.SignedIn
            : SessionPresence.SignedOut;
    }

    /// <summary>
    /// The kit's already-signed-in capability, answered for Amazon.
    /// </summary>
    /// <remarks>
    /// It navigates and <see cref="PresenceAsync"/> does not, for the same
    /// reason the login navigates before it asks: this question is entirely
    /// about which page the browser is standing on, and a browser restored
    /// from a cookie jar starts on <c>about:blank</c>, which is neither page.
    /// </remarks>
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var browser = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browser, Manifest);

        await page.GotoAsync(OrdersUrl(_time.GetUtcNow().Year, 0), ct).ConfigureAwait(false);
        _ = await page.ClickAsync(_options.ConsentSelectors, _options.ProbeMs, ct).ConfigureAwait(false);

        return await PresenceAsync(page, ct).ConfigureAwait(false);
    }

    // ---- fetch -------------------------------------------------------------

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
            // There is no refresh grant on this provider - the credential is a
            // cookie jar - so a fetch without one cannot recover on its own.
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

        // Amazon rotates its session cookies constantly. Persisting the jar we
        // finished with is what keeps the next fetch from arriving with a
        // state Amazon has already superseded.
        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        return result with { RefreshedMaterial = material with { StorageState = storageState } };
    }

    /// <summary>
    /// The order-list walk: the window it covers, and what it has gathered on
    /// the way, carried from page to page.
    /// </summary>
    private sealed class OrderWalk
    {
        public required ResourceRequest Request { get; init; }

        public required TimeZoneInfo Zone { get; init; }

        public required int Cap { get; init; }

        public required DateOnly Since { get; init; }

        public required DateOnly Until { get; init; }

        /// <summary>Every row inside the window, in the order the pages gave them.</summary>
        public List<AmazonOrderSummary> Collected { get; } = [];

        /// <summary>The cards the list could not place (no readable date): left out of this fetch, named in the notes.</summary>
        public List<string> Skipped { get; } = [];

        /// <summary>Every order id read so far, to notice a page that repeats.</summary>
        public HashSet<string> Seen { get; } = new(StringComparer.Ordinal);

        /// <summary>At least one order card was read, so the card selectors still work.</summary>
        public bool SawCard { get; set; }

        /// <summary>The list said in as many words that there is no history.</summary>
        public bool SawEmptyMarker { get; set; }

        /// <summary>False once a page past the cap has been read.</summary>
        public bool Complete { get; set; } = true;

        /// <summary>The window, or the cap, is behind the walk: no page is worth opening.</summary>
        public bool Stop { get; set; }
    }

    /// <summary>
    /// The order walk, behind the seam. Everything above
    /// <see cref="IAmazonPages"/> is drivable from a recorded page, which is
    /// the only way any of this is testable: there is no API to stub.
    /// </summary>
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

        // An empty result has two very different causes and they must not look
        // alike: a customer with no orders in the window, and a card selector
        // that has expired. The second one silently reports "you have bought
        // nothing", which is the most believable wrong answer this adapter
        // could give.
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

    /// <summary>
    /// The order list, newest year first and page by page, folded into
    /// <paramref name="walk"/> until the window is behind it, the cap is
    /// passed, or the pages run out.
    /// </summary>
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

    /// <summary>
    /// Folds one page of the order list into the walk. False when this year's
    /// list has been read to its end, true when the next page is worth opening.
    /// </summary>
    private bool ReadListPage(OrderWalk walk, AmazonPage fetched, HtmlNode dom)
    {
        var rows = AmazonOrderParser.ParseList(dom, _options, walk.Zone, walk.Skipped);
        if (rows.Count == 0)
        {
            if (Any(fetched.Html, _options.EmptyHistoryMarkers)) walk.SawEmptyMarker = true;
            return false;
        }

        walk.SawCard = true;

        // A page that repeats the previous one means startIndex is not
        // advancing anything upstream. Carrying on would be the same
        // request twenty times against a site that challenges when it
        // is bored - which is how a working session gets escalated
        // into a block.
        var fresh = rows.Where(row => walk.Seen.Add(row.Id)).ToList();
        if (fresh.Count == 0) return false;

        walk.Collected.AddRange(fresh.Where(row => ReceiptFactory.InWindow(row.PurchasedAt, walk.Request)));

        // The list runs newest first, so a page entirely older than the
        // window means every later page - and every earlier year - is
        // too. Stopping here is what keeps three years of history from
        // being walked on every sync.
        if (rows.All(row => DateOnly.FromDateTime(row.PurchasedAt.Date) < walk.Since)) walk.Stop = true;

        // One page past the cap is enough to know the pass is partial;
        // more would be work the caller is about to discard.
        if (walk.Collected.Count > walk.Cap)
        {
            walk.Complete = false;
            walk.Stop = true;
        }

        return AmazonOrderParser.HasNextPage(dom, _options);
    }

    /// <summary>
    /// One receipt out of one list row, or null for an order whose invoice
    /// says it was cancelled.
    /// </summary>
    private async Task<Receipt?> ReceiptAsync(
        IJobContext ctx, IAmazonPages pages, ResourceRequest request, AmazonOrderSummary summary,
        ILoginPage? wall, IRedirectWaiter? redirects, CancellationToken ct)
    {
        IReadOnlyList<ReceiptItem> items = [];
        IReadOnlyList<ReceiptDocument> documents = [];
        var payment = ReceiptFactory.Payment();
        Money? stated = null;

        // The invoice is opened when the card states no total even if the
        // caller asked for no items, because without it there is no total
        // at all and the receipt cannot be built. One extra page for one
        // odd order beats failing the whole fetch.
        var needsInvoice = request.WantsItems || summary.Total is null;

        if (needsInvoice && summary.InvoiceUrl is { } invoiceUrl)
        {
            var (_, dom) = await OpenAsync(
                ctx, pages, invoiceUrl, $"the invoice for '{summary.Id}'", wall, redirects, ct)
                .ConfigureAwait(false);

            // A cancelled order is not a receipt, and its invoice says so
            // in as many words. Skipped rather than parsed: nothing was
            // bought and nothing was paid, so there is no purchase to
            // report - and the empty page it serves would otherwise read as
            // a shape change and fail the whole fetch.
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

        // The card's figure first, because the card and the invoice are two
        // independent statements of the same number and that redundancy is
        // the only integrity check this provider offers. Falling back to
        // the invoice's own total keeps the order rather than dropping it -
        // and reconciliation then compares the invoice against itself,
        // which is weaker but not nothing: it still catches a line the
        // parser missed.
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

    /// <summary>
    /// The invoice PDFs Amazon holds for one order.
    ///
    /// Two requests minimum, and the first one is not optional: the document
    /// URL is <c>/documents/download/{guid}/invoice.pdf</c> with an opaque guid
    /// that appears nowhere else, so it has to be READ from the invoice list -
    /// which is itself an AJAX fragment that only exists as a fetch. Neither
    /// URL can be constructed from the order number.
    ///
    /// Failures here are logged into the receipt's absence, never thrown. A
    /// document is an extra the caller asked for; losing one is not a reason to
    /// fail a fetch that has already read the order correctly, and an order
    /// with no invoice yet is a normal state rather than a fault.
    /// </summary>
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
            // The length, because an empty body and a body full of links we do
            // not recognise are different failures with the same symptom.
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

            // What it says it is, not what it is called. A session that expired
            // between the order list and here answers a URL ending in ".pdf"
            // with an HTML sign-in page, and attaching that would hand somebody
            // a download that opens to nothing.
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

    /// <summary>
    /// Something a person can find again on their own disk.
    ///
    /// Amazon names every one of these <c>invoice.pdf</c>, so four documents
    /// off one order would be four files called the same thing - and saving
    /// them all would leave the user with <c>invoice (3).pdf</c> and no way to
    /// tell which order any of them belongs to. The order number goes in front,
    /// and the index only when there is more than one to tell apart.
    /// </summary>
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

        // Only if a browser is already running. Launching Chromium purely to
        // sign out would hold an agent for a courtesy, and a user
        // disconnecting must always succeed locally whatever Amazon does.
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
            // Logged by the platform, never fatal: a user disconnecting must
            // always succeed locally whatever Amazon does about it.
        }
    }

    // ---- plumbing ----------------------------------------------------------

    /// <summary>
    /// Fetches a page, at this provider's pace, and refuses to hand back
    /// anything that is not order history.
    ///
    /// The pacing is here rather than in the page source because everything
    /// below <see cref="IAmazonPages"/> needs a real Chromium: a gap enforced
    /// down there would be a rule about how Amazon is treated that no test
    /// could ever observe. Above the seam it is exercised by the same recorded
    /// pages as the rest of the walk.
    ///
    /// A wall met here is faced exactly once - by whoever is sitting at the
    /// browser, or not at all - and the proof that it came down is that the
    /// same URL reads as data on the second attempt. An unattended agent never
    /// enters that branch: there is nobody to ask, and hanging until the job's
    /// budget runs out is the failure this rule exists to prevent.
    /// </summary>
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

        // The second attempt, and the last. The same URL either reads as data
        // now or the wall is still standing - and it is not faced again.
        var second = await JudgedAsync(ctx, pages, url, ct).ConfigureAwait(false);
        if (second.Verdict.Kind == AmazonPageKind.Ok) return (second.Page, second.Dom);

        throw AmazonGuard.Failure(second.Verdict, second.Page, what, _options);
    }

    /// <summary>One paced fetch of <paramref name="url"/>, parsed and judged.</summary>
    private async Task<(AmazonPage Page, HtmlNode Dom, AmazonVerdict Verdict)> JudgedAsync(
        IJobContext ctx, IAmazonPages pages, string url, CancellationToken ct)
    {
        var fetched = await PacedAsync(ctx, pages, url, ct).ConfigureAwait(false);
        var dom = HtmlParser.Parse(fetched.Html);
        return (fetched, dom, AmazonGuard.Inspect(fetched, dom, _options));
    }

    /// <summary>
    /// One navigation, with this provider's gap held around it.
    ///
    /// Nothing a browser fetches goes through the politeness limiter: that
    /// handler sits on the job's own HTTP client, and a navigation is
    /// Chromium's socket. So Bol's fetch - which is HTTP - has always been
    /// paced, and this walk has always run flat out: an order list, then an
    /// invoice per order, back to back with nothing between them. On a first
    /// connect that is fifty navigations in as long as Amazon takes to serve
    /// them, and it is the traffic shape a defended site is built to notice.
    ///
    /// The ticket is held across the whole load rather than released at the
    /// request, because the gap is measured from when a call FINISHES; letting
    /// it overlap the page load would pace almost nothing on a slow page.
    /// </summary>
    private static async Task<AmazonPage> PacedAsync(
        IJobContext ctx, IAmazonPages pages, string url, CancellationToken ct)
    {
        using var ticket = await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false);

        var fetched = await pages.OpenAsync(url, ct).ConfigureAwait(false);

        // Told to slow down, so slow down - for longer than this job, which is
        // already lost. A 503 fails the fetch whatever we do here; what the
        // penalty buys is the NEXT attempt arriving later, instead of ten
        // seconds after a user presses the button again on a provider that has
        // just said it has had enough.
        //
        // No Retry-After is read. Amazon has never been observed to send one on
        // a throttled HTML page, and a parser for a header we have never seen
        // would be a guess dressed as protocol handling. The stated penalty is
        // a sound answer either way.
        if (IsThrottled(fetched.Status)) ctx.Pacer.Backoff(ThrottlePenalty);

        return fetched;
    }

    /// <summary>
    /// The answers that mean "you are calling too often", as opposed to the
    /// several that mean "no".
    ///
    /// Exactly the pair the HTTP politeness limiter already backs off on, and
    /// that is the reason it is this pair. One provider is being called through
    /// two doors - our socket and Chromium's - and a rule that differed by door
    /// would mean the same 503 slowed us down or did not depending on which
    /// part of the adapter happened to meet it.
    /// <para>
    /// Notably NOT every status this provider treats as a block. A 403 is
    /// Amazon refusing us and a 502 is a bad minute at a gateway; neither is a
    /// statement about our rate, and pushing the gate out for them would slow
    /// every later job on a diagnosis nothing supports.
    /// </para>
    /// </summary>
    internal static bool IsThrottled(int status) => status is 429 or 503;

    /// <summary>
    /// The order list for one year and one offset.
    ///
    /// <c>language</c> is appended only when an operator has switched it on -
    /// see <see cref="AmazonOptions.LanguageOverride"/> for why the default is
    /// to leave the storefront in Dutch.
    /// </summary>
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

/// <summary>
/// There is no redirect to watch for during a fetch.
///
/// <see cref="CaptchaGate"/> watches a callback URL while a human passes a
/// widget, because on an OAuth provider that redirect is the proof. Amazon has
/// no such URL: the proof that a wall came down is that the page we were
/// already asking for reads as order history on the next attempt. Waiting the
/// full poll rather than returning instantly is what keeps the gate's loop
/// from spinning while somebody walks back to their desk.
/// </summary>
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

/// <summary>
/// The registration point.
///
/// A factory rather than an edit to <c>ShopAdapters.cs</c>: that file is
/// shared with every other provider being written tonight, and a merge there
/// costs more than an indirection here.
/// </summary>
public static class AmazonAdapters
{
    public static IProviderAdapter Create(AmazonOptions? options = null, TimeProvider? time = null) =>
        new AmazonAdapter(options, time);
}
