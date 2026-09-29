using System.Globalization;
using System.Text;

using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using RegistryConnector.Adapters.Support;

namespace RegistryConnector.Adapters.Duo;

/// <summary>
/// DUO - the Dutch student-finance body - through mijn.duo.nl.
///
/// The login is DigiD, and that decides the whole design. DUO's SAML request
/// carries <c>ForceAuthn=true</c>, so DigiD re-authenticates the human on every
/// single sync whatever session anybody holds: there is no unattended fetch
/// here and there never will be.
///
/// WITH ONE EXACT EXCEPTION, and it is the reason a BYO agent is worth
/// running. ForceAuthn binds an authentication that is STARTED, and a browser
/// DUO still has a session for starts none - it opens the portal and is
/// already inside. So a connect made while that fifteen minutes is alive asks
/// for nothing at all: see <see cref="PresenceAsync"/>, which is careful about
/// the one way that question can be answered wrongly, and
/// <see cref="SessionProbe"/> for when it is worth asking at all.
///
/// So nothing is typed by us. The flow is <see cref="AuthFlow.RemoteBrowser"/>,
/// which the manifest validator will only accept from a provider declaring no
/// fields at all - the DigiD username and password go into login.digid.nl's own
/// form, typed by the only person who should ever type them, and this platform
/// holds no credential to lose. That is a structural guarantee rather than a
/// promise: a manifest cannot express the other thing.
///
/// The human picks their own method on DigiD's screen. An sms arrives on their
/// phone and needs nothing from us. The app path shows a QR, and that is the
/// one place this adapter does more than stream: DigiD draws the code as a PNG
/// inline in the markup, so <see cref="RelayQr"/> reads those exact bytes and
/// relays them rather than photographing the screen. A photographed QR fails to
/// decode about 1.5% of the time - almost always working, which is the worst
/// possible way for a login to fail.
///
/// The data is the opposite of BKR: a real JSON API, three small calls, no
/// markup at all. What it deliberately does NOT call is
/// <c>raadplegen/klantbeeld</c> - see <see cref="DuoCalls.ReadAsync"/>.
/// </summary>
public sealed class DuoAdapter : IProviderAdapter
{
    public const string ProviderId = "duo";
    public const string DebtResource = "student-debt";

    private static readonly ProviderManifest Manifest = DuoManifest.Build();

    private readonly DuoOptions _options;
    private readonly TimeProvider _time;

    public DuoAdapter(DuoOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new DuoOptions();
        _time = time ?? TimeProvider.System;
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var login = new PlaywrightLoginPage(page, Manifest);
        var watcher = new DuoSignedInWatcher(login, _options, _time);

        return await LoginAsync(ctx, login, watcher, new PageDuoPortal(page, _options), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The kit's already-signed-in capability, answered for DUO.
    /// </summary>
    /// <remarks>
    /// It NAVIGATES and <see cref="PresenceAsync"/> does not, which is the only
    /// difference between them. The login below has already opened the portal
    /// by the time it asks, so navigating again there would be a second load of
    /// the same page; a caller holding nothing but a context has not, and
    /// asking DUO about a browser sitting on <c>about:blank</c> answers from
    /// the wrong origin - the failure <see cref="IDuoPortal.OpenAsync"/> exists
    /// to prevent.
    /// </remarks>
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var portal = new PageDuoPortal(page, _options);

        await portal.OpenAsync(_options.StartUrl, ct).ConfigureAwait(false);

        return await PresenceAsync(ctx, portal, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The login, behind the page seam so the offline suite can drive it
    /// without a browser, an account, or a citizen's DigiD.
    /// </summary>
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, IDuoPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);
        ArgumentNullException.ThrowIfNull(portal);

        ctx.Progress(JobStep.OpeningProvider);

        // The protected page, and DUO's own redirects from there. Never
        // DigiD's entry URL: hand-crafting an identity provider's start
        // address is how a login succeeds at the IdP and leaves the site
        // signed out.
        await page.GotoAsync(_options.StartUrl, ct).ConfigureAwait(false);

        // ALREADY INSIDE? THEN NOTHING IS ASKED, and that is the entire reason
        // a browser profile on somebody's own machine is worth keeping.
        //
        // DUO's session is fifteen minutes of inactivity riding on the
        // browser's own cookies - see DuoManifest.SessionTtlSeconds, which was
        // watched counting down and snapping back - so a second connect inside
        // that window opens the portal and is simply there.
        //
        // ForceAuthn does not contradict this, although it reads as though it
        // must. It makes DigiD re-authenticate whenever an AUTHENTICATION IS
        // INITIATED, and opening a page DUO already holds a session for
        // initiates none: the SAML chain is never entered, so there is nothing
        // for DigiD to be strict about.
        //
        // THROUGH THE KIT'S GATE rather than asked outright, which is the one
        // thing that changed when this moved onto the seam. A browser handed
        // no profile and no cookie jar - the fleet's first connect - cannot be
        // inside DUO, and SessionProbe answers CannotTell for it without
        // spending SignedOutBounceSeconds finding that out. Everything the
        // question itself learnt is unchanged and lives in PresenceAsync.
        if (await SessionProbe.AskAsync(ctx, (c, t) => PresenceAsync(c, portal, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            ctx.Note($"{ProviderId}: this profile was still inside DUO, so nothing was asked of you and DigiD " +
                     "was never reached - which is the whole reason for keeping a browser profile on your own " +
                     "machine");

            ctx.Progress(JobStep.Finalizing);

            return await SignedAsync(ctx, ct).ConfigureAwait(false);
        }

        ctx.Progress(JobStep.Authenticating);

        // Latched before the human touches anything. After this a lost lease
        // fails the job rather than requeueing it - and a requeued DigiD login
        // is a second authentication attempt against an account whose failures
        // Logius counts.
        //
        // AND BELOW THE CHECK ABOVE, which is the whole of the care this
        // needed. That reasoning is about the paths that authenticate, and a
        // profile that was already inside submitted nothing: latching for it
        // would turn a connect that touched neither DigiD nor DUO's login
        // chain into a job that can never be requeued, so an agent restarting
        // mid-connect would cost a sign-in it had not made. Everything from
        // here down types at DigiD or hands DigiD's own page to the human, and
        // both of those are attempts Logius counts.
        ctx.CredentialSubmitted();

        var username = Optional(ctx, "username");
        var password = Optional(ctx, "password");

        // Tier two: both stored, so the only thing asked of the human is the
        // six digits DigiD texts them.
        //
        // Anything that goes wrong in there hands the page over instead of
        // ending the connect. That is not politeness - it is what makes the
        // weaker selectors safe to ship: DUO's own chooser and DigiD's method
        // list were captured by their labels rather than their ids, so a
        // redesign finds nothing, and finding nothing has to cost a streamed
        // login rather than a failed one.
        if (username is not null && password is not null)
        {
            try
            {
                // NULL MEANS "HAND OVER", and it is a return rather than a call
                // for one reason: the app path used to finish by calling the
                // streamed sign-in ITSELF, from inside this try. So a failure
                // raised BY the hand-over was caught here as "the typed
                // sign-in did not complete" and answered by running the
                // hand-over again - the same wall, twice, described as
                // something else both times.
                if (await TypedSignInAsync(ctx, page, watcher, portal, username, password, ct)
                        .ConfigureAwait(false) is { } signedIn)
                {
                    return signedIn;
                }
            }
            catch (ConnectorException ex)
                when (ex.Code is ErrorCode.ProviderChanged or ErrorCode.MfaFailed or ErrorCode.BlockedByProvider)
            {
                // THE CODE AND WHAT IT SAID, because the code alone names a
                // category and not a step.
                //
                // On 2026-09-28 the owner connected DUO twice on their own
                // machine and the first attempt landed here. All the evidence
                // said was "the typed sign-in did not complete
                // (ProviderChanged)" - and ProviderChanged covers DUO's own
                // chooser, DigiD's method list, either credential box, the
                // sign-in button and all six code boxes, which are entirely
                // different repairs. The exception already carried the answer:
                // Missing() builds "no element for DigiD's username box; tried
                // [...]" and it was being thrown away one line from the note.
                //
                // NO CREDENTIAL CAN BE IN IT. It is this adapter's own prose
                // about its own selectors, built in one place from
                // DuoOptions - nothing it is handed is ever a typed value - and
                // every note goes through the redactor on the way out anyway
                // (AgentJobContext.Note runs SecretScrubber over the job's
                // secret values, the DigiD password among them).
                ctx.Note($"{ProviderId}: the typed sign-in did not complete ({ex.Code}): {Said(ex)}. The page " +
                         "is being handed over instead");

                await NoteTheShapeAsync(ctx, portal, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // The browser refusing an element, not the page having changed.
                //
                // Added because the first live run of this tier died here and
                // the hand-over never fired: Playwright raises a
                // TimeoutException for a click it cannot perform, that is not
                // a ConnectorException, and the catch above let it past. What
                // the account holder saw was "This login failed" at the
                // "Signing in" step - the one outcome this whole tier was
                // built to be incapable of.
                //
                // An element that is present but unclickable is exactly the
                // case for handing over: the human's own pointer has no
                // trouble with a styled radio.
                ctx.Note($"{ProviderId}: the browser could not drive a step of the typed sign-in " +
                         $"({ex.GetType().Name}), so the page is being handed over instead");

                await NoteTheShapeAsync(ctx, portal, ct).ConfigureAwait(false);
            }
        }

        return await LiveSignInAsync(ctx, page, watcher, portal, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// DigiD's own page, streamed to whoever owns the account.
    ///
    /// Tier one, and the fallback from tier two. Ends when DUO says there is a
    /// session, which is the same terminal signal the typed path settles on -
    /// so somebody who signs in and never returns to the consumer's UI still
    /// finishes.
    /// </summary>
    private async Task<LoginResult> LiveSignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, IDuoPortal portal, CancellationToken ct)
    {
        // Whatever route arrived here, the page must hold no secret before it
        // is photographed.
        //
        // Version 1 of this adapter deliberately did NOT do this, and the
        // reasoning was sound at the time: nothing was ever typed, so there was
        // nothing to clear, and a clear running a moment late would wipe what
        // the human was halfway through typing into DigiD's own box. Tier two
        // changed that. A typed sign-in that fails hands over with a DigiD
        // password sitting in the form, and the still-capture path refuses to
        // photograph a page in that state - so the hand-over would relay
        // nothing at all.
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        using var view = CancellationTokenSource.CreateLinkedTokenSource(ct);
        await using var qr = new RelayQr(ctx, _options, _time);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.LiveView,
            PromptKey = MessageKeys.DuoLiveLogin,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds),
        }, view.Token);

        var poll = TimeSpan.FromSeconds(_options.SettlePollSeconds);
        var deadline = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds);

        try
        {
            while (_time.GetUtcNow() < deadline)
            {
                ct.ThrowIfCancellationRequested();

                // TWO CONDITIONS, and the second is the one that matters.
                //
                // The url gate is cheap and rules out the login chain, but it
                // cannot rule out the protected page itself: opening
                // mijn.duo.nl redirects to the dashboard and only THEN bounces
                // into SAML, so the first thing this loop ever sees is a
                // portal address belonging to nobody. Believing it shipped a
                // login that reported success 80ms after the live view opened,
                // having asked the human for nothing at all.
                //
                // So DUO is asked. The session endpoint costs 99 bytes and is
                // only reached when the url already looks right - twice in a
                // whole sign-in, not once per poll.
                if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null
                    && await SignedInAsync(portal, ct).ConfigureAwait(false))
                {
                    ctx.Progress(JobStep.Finalizing);
                    return await SignedAsync(ctx, ct).ConfigureAwait(false);
                }

                // Every pass, not once. Whether DigiD expires or rotates its
                // QR is UNKNOWN - the captured session went from code to scan
                // in about six seconds and nothing refreshed in that window -
                // so this re-reads the image and relays it again if it
                // changed. Re-reading an unchanged QR costs nothing; handing
                // somebody a stale picture costs them the login.
                await qr.OfferAsync(page, ct).ConfigureAwait(false);

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                $"{ProviderId}: the DigiD sign-in ended without reaching the portal");
        }
        finally
        {
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    /// <summary>
    /// The typed sign-in: DUO's chooser, DigiD's method, the credentials, and
    /// then six digits from the human.
    ///
    /// Every step is best-effort by design. A miss throws
    /// <see cref="ErrorCode.ProviderChanged"/>, which the caller turns into a
    /// streamed hand-over - so the worst this path can do is spend a few
    /// seconds and land the human exactly where they would have been anyway.
    ///
    /// WHICH STEP IS BLAMED IS A SEPARATE QUESTION from which step throws, and
    /// the method chooser is why. A chooser that could not be driven leaves no
    /// credential form behind it, so the throw comes from the form - and a note
    /// naming the form sends the next reader to a page that was never reached.
    /// So step 2's answer is carried forward to step 3 and spoken about there.
    /// </summary>
    /// <returns>
    /// The finished session, or NULL when the rest of this login belongs to the
    /// streamed hand-over - which the caller then runs, exactly once.
    /// </returns>
    private async Task<LoginResult?> TypedSignInAsync(
        IJobContext ctx,
        ILoginPage page,
        IRedirectWaiter watcher,
        IDuoPortal portal,
        string username,
        string password,
        CancellationToken ct)
    {
        var wantsApp = string.Equals(Method(ctx), _options.AppMethod, StringComparison.OrdinalIgnoreCase);

        // 1. DUO's own fork, and it comes BEFORE DigiD: "voor mijzelf" or "als
        //    gemachtigde". Chosen explicitly rather than by accepting whatever
        //    is selected, because the other option signs in on somebody else's
        //    behalf and would fetch a different person's debt.
        if (await page.ClickAsync(_options.SelfRadioSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            await page.ClickAsync(_options.ContinueSelectors, _options.StepProbeMs, ct).ConfigureAwait(false);
        }

        // 2. DigiD's "Hoe wilt u inloggen?". Four methods are offered and two
        //    of them want an NFC document reader, so only these two are ever
        //    driven.
        //
        //    AND THE RESULT IS KEPT, which until 2026-09-28 it was not. This
        //    click ignored its own answer, and the ONLY way a miss here could
        //    ever surface was two statements later as "DigiD's username box is
        //    missing" - true, and misleading, because the box is absent
        //    precisely because the page never left the chooser. That is the
        //    note the owner's own machine produced when the typed sign-in fell
        //    back to the hand-over and they drove this very chooser by hand,
        //    and it pointed the next reader at DigiD's credential form, which
        //    was fine.
        //
        //    It is still not a failure BY ITSELF, and that distinction is the
        //    whole of the fix. A page that shows the credential boxes without
        //    having asked which method to use is a page this signs in on today
        //    - DigiD decides some of its own routing - and turning a best-effort
        //    step into a throw would hand that page over for no reason. So the
        //    answer is carried to the step whose miss it would otherwise be
        //    blamed for.
        var method = wantsApp ? _options.AppMethodSelectors : _options.SmsMethodSelectors;
        var chose = await page.ClickAsync(method, _options.StepProbeMs, ct).ConfigureAwait(false);

        // 2b. And DigiD's follow-up on the app path: this device, or another
        //     one. Always another. There is no DigiD app in the agent's
        //     browser, and the QR relayed further down exists precisely to
        //     reach a phone that is somewhere else.
        //
        //     Best effort like the step above it. A miss here leaves the human
        //     one click to make on a page that is about to be streamed to them
        //     anyway, which is what they were doing before this existed.
        if (wantsApp)
        {
            await page.ClickAsync(_options.AppOnOtherDeviceSelectors, _options.StepProbeMs, ct)
                .ConfigureAwait(false);
        }

        // 3. The credentials, on one screen. This is the step whose selectors
        //    were captured with their ids, so a miss here really does mean the
        //    page changed rather than that a label was reworded.
        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            // WHICHEVER STEP ACTUALLY MISSED. No credential form and no method
            // chosen is one failure and not two: the chooser is what stranded
            // everything after it, and naming the box that the chooser was
            // standing in front of sends the next reader to the wrong page.
            //
            // The selectors Missing() prints say WHICH method was wanted, so
            // the sentence does not have to name it twice.
            throw chose
                ? Missing("DigiD's username box", _options.UsernameSelectors)
                : Missing(
                    "DigiD's method choice on \"Hoe wilt u inloggen?\", so the page never left it and the " +
                    "credential form behind it does not exist yet",
                    method);
        }

        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("DigiD's password box", _options.PasswordSelectors);
        }

        if (!await page.ClickAsync(_options.ContinueSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            throw Missing("DigiD's sign-in button", _options.ContinueSelectors);
        }

        // The app path has nothing left to type: a code appears on the phone,
        // is typed into DigiD's own page, and then a QR is shown. That is the
        // human's work on their own screen, so it goes back to the streamed
        // loop - which relays the QR losslessly when it appears.
        //
        // Handed BACK rather than run from here, so that what the streamed
        // login raises is not caught by the typed path's own fallback and
        // answered by starting the streamed login a second time.
        if (wantsApp) return null;

        // 4. Six digits, asked for rather than streamed. A code box is a
        //    question the challenge protocol already carries well, and
        //    streaming a whole browser to type six characters is the worse
        //    experience by a distance.
        await FillCodeAsync(ctx, page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        var landed = await watcher.WaitAsync(TimeSpan.FromSeconds(_options.SignInSeconds), ct)
            .ConfigureAwait(false);

        if (landed is null || !await SignedInAsync(portal, ct).ConfigureAwait(false))
        {
            // Never "wrong password". A refused code and a refused password
            // look identical from here, and telling somebody to reset a DigiD
            // password that was fine sends them to a municipality with a
            // passport. The caller turns this into a hand-over, where DigiD's
            // own page can say which it was.
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{ProviderId}: the typed sign-in did not reach the portal after the code was submitted");
        }

        return await SignedAsync(ctx, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Asks for the texted code and types it into DigiD's six boxes.
    /// </summary>
    /// <remarks>
    /// The POST carries ONE field, <c>smscode[smscode]</c>, so the six boxes
    /// are presentation - but they are the presentation a browser has to type
    /// into, one digit apiece.
    /// </remarks>
    private async Task FillCodeAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(
            new Challenge
            {
                Type = ChallengeType.MfaCode,
                PromptKey = MessageKeys.DuoSmsCode,
                Delivery = _options.SmsMethod,
                Length = _options.CodeLength,
                ExpiresAt = _time.GetUtcNow().AddSeconds(_options.CodeChallengeSeconds),
            },
            ct).ConfigureAwait(false);

        var code = answer.Value?.Trim() ?? string.Empty;

        // Checked before a single box is filled. Half a code typed into
        // DigiD's form is an attempt DigiD counts, and DigiD locks accounts.
        if (code.Length != _options.CodeBoxSelectors.Count || !code.All(char.IsAsciiDigit))
        {
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{ProviderId}: expected {_options.CodeBoxSelectors.Count} digits and got " +
                $"{code.Length} character(s)");
        }

        for (var i = 0; i < _options.CodeBoxSelectors.Count; i++)
        {
            if (!await page.FillAsync([_options.CodeBoxSelectors[i]], code[i].ToString(), _options.StepProbeMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing($"DigiD's code box {i + 1}", [_options.CodeBoxSelectors[i]]);
            }
        }

        if (!await page.ClickAsync(_options.ContinueSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            throw Missing("the code's submit button", _options.ContinueSelectors);
        }
    }

    /// <summary>
    /// The months-remaining call, whose parameters travel as base64 JSON.
    /// </summary>
    /// <remarks>
    /// DUO's own portal builds exactly this, for the month containing today
    /// through the next one:
    /// <code>
    /// {"beginmaandPeriode":"2026-08","eindmaandPeriode":"2026-09",
    ///  "grondslaggegevens":[{"definitieNaam":"RESTEREND_AANTAL_MAANDEN_AFLOSFASE","contextId":"1"}],
    ///  "normenVerlengen":true}
    /// </code>
    /// Built rather than pasted, because the months move: a request hard-coded
    /// to August answers a question about August for ever.
    /// </remarks>
    private string MonthsRemainingPath(DateOnly today)
    {
        var request = string.Create(
            CultureInfo.InvariantCulture,
            $$"""
            {"beginmaandPeriode":"{{today:yyyy-MM}}","eindmaandPeriode":"{{today.AddMonths(1):yyyy-MM}}","grondslaggegevens":[{"definitieNaam":"{{_options.MonthsRemainingCode}}","contextId":"1"}],"normenVerlengen":true}
            """);

        var encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(request));

        return $"{_options.GrondslagPath}?{_options.GrondslagParam}={Uri.EscapeDataString(encoded)}";
    }

    private string Method(IJobContext ctx) =>
        ctx.Config.TryGetValue(_options.MethodConfigKey, out var method) && !string.IsNullOrWhiteSpace(method)
            ? method
            : _options.SmsMethod;

    private static string? Optional(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{DuoAdapter.ProviderId}: no element for {what}; tried [{string.Join(", ", selectors)}]");

    /// <summary>
    /// What an exception said, without repeating the provider id the note
    /// carrying it has already stated.
    /// </summary>
    /// <remarks>
    /// Every message raised in this file is prefixed with the provider id,
    /// because a ConnectorException travels alone to a consumer and has to say
    /// whose it is. Quoted inside a note that opens with the same word it would
    /// read "duo: ... : duo: no element for ...", which is noise in the one
    /// place somebody is reading carefully.
    /// </remarks>
    private static string Said(ConnectorException ex) =>
        ex.Message.StartsWith(ProviderId + ": ", StringComparison.Ordinal)
            ? ex.Message[(ProviderId.Length + 2)..]
            : ex.Message;

    /// <summary>
    /// Adds what the page was made of to the notes, for the moment a typed
    /// sign-in gave up.
    /// </summary>
    /// <remarks>
    /// THE SAME INSTRUMENT ASN CARRIES on every ConnectorException, and it is
    /// worth more here than there: a hand-over is about to stream this exact
    /// page to the account holder, so the only person a shape could tell
    /// anything is already looking at the page - while the operator reading the
    /// notes tomorrow is not. What travels is selectors, roles and counts; see
    /// PageShape, which never reads an input's value or an image's bytes.
    /// <para>
    /// <b>IT MUST NOT THROW, and that is not defensive habit.</b> This runs
    /// inside a catch clause whose entire job is to reach the hand-over, and
    /// this tier has already shipped the opposite twice: an exception escaping
    /// on the way to the fallback reached the account holder as "This login
    /// failed" at the "Signing in" step - the one outcome the tier was built to
    /// be incapable of. A diagnosis that costs a login is worth less than no
    /// diagnosis, so a failed probe is written down as a failed probe. Only
    /// cancellation passes, because a cancelled job has no hand-over left to
    /// protect and the streamed sign-in below would raise it at its first await
    /// regardless.
    /// </para>
    /// </remarks>
    private static async Task NoteTheShapeAsync(IJobContext ctx, IDuoPortal portal, CancellationToken ct)
    {
        string shape;

        try
        {
            shape = await portal.DescribeAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            shape = $"it could not be read ({ex.GetType().Name})";
        }

        ctx.Note($"{ProviderId}: when that happened, the page was - {shape}");
    }

    /// <summary>
    /// Whether this browser is still inside DUO, which on a kept profile is
    /// the ordinary answer and means nobody is asked anything at all.
    ///
    /// Assumes the browser is ALREADY on a DUO page - the login opens the
    /// portal as its first move, and <see cref="AlreadySignedInAsync"/> opens
    /// it for a caller who has not.
    /// </summary>
    /// <remarks>
    /// The kit's two lessons, answered through DUO's own portal seam rather
    /// than through <see cref="SessionProbe.OnPageAsync"/>: that helper reads
    /// an <c>ILoginPage</c>'s address, and DUO's second witness is a JSON call
    /// made from inside the page, which no address-shaped helper can express.
    /// The shape is identical and this is where it was first paid for.
    /// <para>
    /// TWO WITNESSES, AND THE FIRST ONE ONLY EVER SAYS NO. The url is asked
    /// first and is allowed to refuse and nothing else: a browser that leaves
    /// for <c>/isam/</c> or <c>login.digid.nl</c> has been sent to authenticate
    /// and is therefore signed out, full stop, and answering from that costs
    /// no services call at all - which matters, because a call made from
    /// inside the SAML chain comes back as a login page and reads in the log
    /// as a session that just died.
    /// <para>
    /// It may never say YES, and that is the lesson this platform has now
    /// learnt twice. Opening the portal lands on a <c>/particulier/portaal/</c>
    /// address and only afterwards bounces into SAML, so the address alone
    /// reported a finished login 80ms after the live view opened - and ASN's
    /// own overview page did the same thing to the bank adapter in September,
    /// with a profile menu on screen for good measure. So a url that has not
    /// refused within <see cref="DuoOptions.SignedOutBounceSeconds"/> is
    /// handed to DUO, and DUO's own session endpoint decides.
    /// </para>
    /// <para>
    /// The two cannot be collapsed into the session endpoint alone. Asked
    /// while the browser is halfway into the SAML chain it answers from the
    /// wrong origin or from a destroyed page, which arrives as "not reached"
    /// and is read as "signed out" - the right answer by accident rather than
    /// by observation. The window is what makes the question worth asking:
    /// whatever answers it is a page that has settled.
    /// </para>
    /// <para>
    /// WHICH IS ALSO WHY THE THIRD ANSWER IS NOT "SIGNED OUT". A browser that
    /// never left DUO's pages and whose session endpoint named nobody has told
    /// us nothing either way - DUO refused us no more than it welcomed us - so
    /// this reports <see cref="SessionPresence.CannotTell"/>, and only an
    /// actual bounce into the sign-in chain is
    /// <see cref="SessionPresence.SignedOut"/>. Both start the DigiD sign-in,
    /// so no run behaves differently; what differs is what the note beside them
    /// is allowed to claim.
    /// </para>
    /// </remarks>
    internal async Task<SessionPresence> PresenceAsync(IJobContext ctx, IDuoPortal portal, CancellationToken ct)
    {
        if (await portal
                .BouncesToSignInAsync(TimeSpan.FromSeconds(_options.SignedOutBounceSeconds), ct)
                .ConfigureAwait(false))
        {
            return SessionPresence.SignedOut;
        }

        if (await SignedInAsync(portal, ct).ConfigureAwait(false)) return SessionPresence.SignedIn;

        // Said out loud, because this is the one shape of "sign in again" that
        // looks like a bug from the outside: the browser sat on DUO's own
        // pages for the whole window and was still nobody. Left silent, the
        // next reader of an agent log has a connect that opened the portal,
        // waited, and then streamed DigiD for no stated reason.
        ctx.Note($"{ProviderId}: this browser stayed on DUO's own pages for {_options.SignedOutBounceSeconds}s " +
                 $"and {_options.SessionPath} still named no profile, so there is no session here to reuse and " +
                 "the DigiD sign-in is starting");

        return SessionPresence.CannotTell;
    }

    /// <summary>
    /// Asks DUO whether this session is real, rather than inferring it.
    /// </summary>
    private async Task<bool> SignedInAsync(IDuoPortal portal, CancellationToken ct)
    {
        var reading = await portal
            .ReadAsync(_options.ServicesRoot + _options.SessionPath, ct)
            .ConfigureAwait(false);

        return DuoSession.Confirmed(reading.Body, _options);
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await FetchAsync(ctx, request, new PageDuoPortal(page, _options), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The fetch, behind the portal seam. Three calls and no markup.
    /// </summary>
    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx, ResourceRequest request, IDuoPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(portal);

        if (!string.Equals(request.ResourceId, DebtResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        ctx.Progress(JobStep.Downloading);

        // THE BROWSER HAS TO BE ON DUO BEFORE ANYTHING IS READ.
        //
        // Every read below goes through the page's own fetch, which is
        // same-origin only while the page is on mijn.duo.nl. A browser
        // restored from a cookie jar starts on about:blank, where all three
        // are cross-origin requests that die as "TypeError: Failed to fetch" -
        // and reached a user as "something broke on our side, HTTP 500",
        // which was both unhelpful and untrue.
        var landed = await portal.OpenAsync(_options.StartUrl, ct).ConfigureAwait(false);

        // And where it landed is the cheapest possible session check: signed
        // out, DUO bounces this straight into the SAML chain. Caught here, it
        // is one navigation and a clear answer; caught later, it is three
        // failed fetches and a guess about why.
        if (!DuoSignedInWatcher.SignedIn(landed, _options))
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: opening the portal landed on {landed}, which is the sign-in chain - so the " +
                "stored session is over. DUO sets ForceAuthn, so this needs a new DigiD sign-in and there is " +
                "nothing to refresh.");
        }

        // THE SESSION ENDPOINT FIRST, because that is the order the portal
        // itself uses.
        //
        // In the capture, sessietoken/rest/jwt is the first service call the
        // dashboard makes - before deployed-apps, before mijnschuld, before
        // the debt summary. Skipping it got a 401 back from the debt endpoint
        // on a browser that had just signed in successfully seven seconds
        // earlier and was sitting on the portal with its cookies restored.
        //
        // It also turns that 401 into a better sentence. "DUO says nobody is
        // signed in" is diagnosable; "the debt endpoint refused us" leaves a
        // reader guessing whether the session died or the endpoint moved.
        var session = await DuoCalls
            .ReadAsync(portal, _options, new DuoCall(_options.SessionPath, Required: false), ct, ctx.Note)
            .ConfigureAwait(false);

        if (!DuoSession.Confirmed(session, _options))
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: {_options.SessionPath} did not name a profile, so DUO has no session for this " +
                "browser even though it is on the portal. DUO sets ForceAuthn, so this needs a new DigiD " +
                "sign-in and there is nothing to refresh.");
        }

        // FROM HERE ON, DUO HAS SAID WHOSE SESSION THIS IS, and every call
        // below is told so.
        //
        // It changes what a 401 means, and that is the whole point. On
        // 2026-09-20 two live runs got 200 and {"profiel":"PP",…} out of this
        // very call, then 200s with real figures out of the next two or three,
        // and then a 401 - which was reported as an expired session and sent
        // the account holder back through DigiD. DUO had said the opposite
        // about itself seconds earlier, in the line above it in the same log.
        // A refusal after this point is this connector missing something DUO's
        // own page sends, not a session that ended; see DuoCalls, which is
        // where the two are told apart.
        const bool SessionConfirmed = true;

        // One clock reading for the whole fetch: the day the payment holiday is
        // asked about and the day the interest rate is resolved for must be the
        // same day, or a fetch running at midnight would answer as of two.
        var today = DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime);

        // Required. This is the fetch: eight amounts, one per debt kind.
        var amounts = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(_options.DebtPath, Required: true, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        // Enrichment, and allowed to be absent. A missing interest rate is a
        // record that says less; a failed fetch is a record that says nothing,
        // and it costs a human another DigiD sign-in to try again.
        var positions = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(_options.PositionsPath, Required: false, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        // With the peildatum it refuses: "Required parameter 'peildatum' is
        // not present." Today, which is what DUO's own portal passes.
        var holiday = await DuoCalls
            .ReadAsync(
                portal,
                _options,
                new DuoCall(
                    $"{_options.PaymentHolidayPath}?{_options.AsOfParam}={today:yyyy-MM-dd}",
                    Required: false,
                    SessionConfirmed: SessionConfirmed),
                ct,
                ctx.Note)
            .ConfigureAwait(false);

        // The balances DUO has stated at named moments - and the date it
        // calculated interest to, which this connector spent three captures
        // believing was unreachable without the customer dossier.
        var history = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(_options.HistoryPath, Required: false, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        var grondslag = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(MonthsRemainingPath(today), Required: false, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        // THE DOSSIER, and only because the caller asked for the ledger.
        //
        // Every movement DUO has booked exists in exactly one place, and that
        // place also holds a BSN, both parents, twenty years of tax income,
        // IBANs and every address the account holder has lived at. So it is
        // opt-in per fetch, never a default, and what the reader takes out of
        // it is the movements and one instalment - nothing else in the payload
        // is read at all.
        string? dossier = null;

        if (request.WantsLedger)
        {
            ctx.Note($"{ProviderId}: the ledger was asked for, so {_options.DossierPath} is being read - it is " +
                     "the only place DUO publishes booked movements, and it carries the whole customer dossier");

            dossier = await DuoCalls
                .ReadAsync(
                    portal, _options,
                    new DuoCall(
                        _options.DossierPath, Required: false, Dossier: true, SessionConfirmed: SessionConfirmed),
                    ct, ctx.Note)
                .ConfigureAwait(false);
        }

        if (positions is null) ctx.Note($"{ProviderId}: {_options.PositionsPath} gave nothing, so no phase or rate");
        if (holiday is null) ctx.Note($"{ProviderId}: {_options.PaymentHolidayPath} gave nothing");
        if (history is null) ctx.Note($"{ProviderId}: {_options.HistoryPath} gave nothing, so no as-of date");

        ctx.Progress(JobStep.Parsing);

        var debt = DuoDebtReader.Read(
            new DuoPayloads(amounts, positions, holiday, history, grondslag, dossier),
            today, _options, ctx.SessionId, note: ctx.Note);

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Debts = [debt],
            Complete = true,
            Via = "portal",
            Raw = request.WantsRaw
                ? new Dictionary<string, string>(StringComparer.Ordinal) { [debt.ExternalId] = amounts! }
                : new Dictionary<string, string>(StringComparer.Ordinal),
        };
    }

    private async Task<LoginResult> SignedAsync(IJobContext ctx, CancellationToken ct)
    {
        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        return new LoginResult
        {
            Material = new SessionMaterial
            {
                StorageState = storageState,
                DeviceId = ctx.Material?.DeviceId ?? Guid.NewGuid().ToString(),
            },

            // The provider's name and nothing else. DUO will happily state the
            // account holder's own - it is in profielklantmenu, beside a
            // persoonsId and a date of birth - and a label on a connection card
            // is not worth reading any of that for.
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            ExpiresAt = _time.GetUtcNow().AddSeconds(DuoManifest.SessionTtlSeconds),
        };
    }

    /// <summary>
    /// The QR, relayed as the bytes DigiD drew rather than a photograph of
    /// them.
    ///
    /// This is what the second live capture was run to settle. DigiD renders
    /// its login QR as a 196x196 PNG inline in the markup - the code is drawn
    /// on a hidden canvas and exported into an <c>img</c> with a
    /// <c>data:image/png;base64,</c> source - so the exact bytes are in the DOM
    /// and can be handed on untouched. Lossless by construction rather than by
    /// care, which is the point: the live view's own JPEG stream fails to
    /// decode roughly 1.5% of QR codes.
    ///
    /// It holds state because a QR may be replaced while somebody is reaching
    /// for their phone, and relaying the same picture twice would be noise.
    /// </summary>
    private sealed class RelayQr(IJobContext ctx, DuoOptions options, TimeProvider time) : IAsyncDisposable
    {
        private string? _sent;
        private CancellationTokenSource? _open;
        private Task<ChallengeAnswer>? _asked;

        /// <summary>
        /// Relays the QR currently on the page, if there is one and it is not
        /// the one already sent.
        /// </summary>
        public async Task OfferAsync(ILoginPage page, CancellationToken ct)
        {
            var source = await page
                .AttributeAsync(options.QrImageSelectors, options.QrImageAttribute, options.QrProbeMs, ct)
                .ConfigureAwait(false);

            // The ordinary answer on nearly every pass: no QR on this screen.
            // It is also what a page that cannot read attributes says, which
            // costs the app path a crisper picture and costs the sms path
            // nothing at all.
            if (string.IsNullOrEmpty(source)) return;

            // The guard that makes the selector's assumption enforceable.
            //
            // There are three images in DigiD's QR block and only one is the
            // code: its own 44x44 logo is FIRST, a remote copy sits inside a
            // noscript, and a hidden canvas is where the code is drawn. An
            // adapter that relayed the wrong one would send a DigiD logo to
            // somebody's phone and then wait out the whole login on a scan
            // that cannot happen - silently, because a picture did arrive.
            if (!source.StartsWith(options.QrDataUriPrefix, StringComparison.OrdinalIgnoreCase))
            {
                ctx.Note($"{ProviderId}: the element matched for the QR is not an inline image, so nothing " +
                         "was relayed; the sign-in continues on the live view");
                return;
            }

            if (string.Equals(source, _sent, StringComparison.Ordinal)) return;

            if (Png(source) is not { } bytes)
            {
                ctx.Note($"{ProviderId}: the QR's data url would not decode, so nothing was relayed");
                return;
            }

            // The same payload the picture encodes, verbatim off the block's
            // own data-code attribute: digid-app-auth://app_session_id=...
            // Carried beside the image so a consumer running ON the phone can
            // offer a tap - somebody cannot photograph the screen they are
            // reading the QR from.
            var payload = await page
                .AttributeAsync(options.QrBlockSelectors, options.QrPayloadAttribute, options.QrProbeMs, ct)
                .ConfigureAwait(false);

            await CloseAsync().ConfigureAwait(false);

            _sent = source;
            _open = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // Nothing is read back from this. There is no answer to a scanned
            // QR: the phone approves, DigiD's own page finishes its long poll,
            // and what ends the login is the browser arriving at the portal -
            // which the caller is already watching for.
            _asked = ctx.AskAsync(new Challenge
            {
                Type = ChallengeType.QrDisplay,
                PromptKey = MessageKeys.DuoQr,
                Image = bytes,
                Url = payload,
                ExpiresAt = time.GetUtcNow().AddSeconds(options.QrChallengeSeconds),
            }, _open.Token);
        }

        public async ValueTask DisposeAsync() => await CloseAsync().ConfigureAwait(false);

        private async Task CloseAsync()
        {
            if (_open is null) return;

            await _open.CancelAsync().ConfigureAwait(false);
            _open.Dispose();
            _open = null;

            if (_asked is not null)
            {
                _ = _asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
                _asked = null;
            }
        }

        /// <summary>The bytes out of a data url, or null when it is not one.</summary>
        private static byte[]? Png(string source)
        {
            var comma = source.IndexOf(',', StringComparison.Ordinal);
            if (comma < 0) return null;

            // Base64 only. A data url may also be percent-encoded text, and
            // this must not silently relay markup as though it were a picture.
            if (!source[..comma].Contains("base64", StringComparison.OrdinalIgnoreCase)) return null;

            try
            {
                return Convert.FromBase64String(source[(comma + 1)..]);
            }
            catch (FormatException)
            {
                return null;
            }
        }
    }
}
