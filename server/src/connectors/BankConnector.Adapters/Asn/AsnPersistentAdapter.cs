using Connector.Kit.Challenges;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// ASN on the account holder's own machine, signed in and staying that way.
///
/// <para>
/// The same bank, the same screens and the same export as
/// <see cref="AsnAdapter"/> - this adds one thing and subtracts one thing. It
/// adds a profile that outlives the job, so the QR is scanned once instead of
/// every time. It subtracts the sign-out, because signing out would destroy the
/// asset.
/// </para>
///
/// <para>
/// <b>Why this exists now and did not before.</b> The manifest has been here
/// for a while, deliberately unimplemented, and the objection it recorded was
/// exact: building it "against guessed selectors would combine the two worst
/// properties available - a permanently authenticated bank session, and no
/// evidence that any of it does what it says". That objection has been spent.
/// Every screen this drives has since been walked on a live account: the QR
/// sign-in, the account picker, the CAMT.053 format modal, the download, and
/// the balance reconciliation on the way out.
/// </para>
///
/// <para>
/// <b>What is still unverified, stated plainly.</b> That ASN's session survives
/// in a persistent profile at all. That is the claim the whole tier rests on
/// and nobody has measured it - so nothing here assumes it. Every fetch asks
/// the bank whether it is still signed in and says <c>session_expired</c> when
/// it is not, which is a question with a cheap answer rather than a promise.
/// </para>
///
/// <para>
/// The honest caveat this owes a user, and the reason a consumer must render
/// its notes key rather than skip it: an always-signed-in browser profile on
/// their own machine is a real, continuous bank session. Safer than handing a
/// password to a service, more exposed than signing in each time, and theirs to
/// end by removing the agent.
/// </para>
/// </summary>
internal sealed class AsnPersistentAdapter(AsnOptions? options = null, TimeProvider? time = null)
    : IProviderAdapter
{
    public const string ProviderId = AsnPersistentManifest.ProviderId;

    /// <summary>
    /// The input the five-digit browsercode arrives on.
    /// </summary>
    /// <remarks>
    /// AN INPUT AND NEVER MATERIAL. It is held by the client, sent per login,
    /// typed, and gone with the job. Sealing it into the bundle would put both
    /// halves of a two-factor pair in one box - the profile is the thing you
    /// have, the code is the thing you know, and they are only worth anything
    /// apart.
    /// </remarks>
    public const string BrowserCodeKey = "browser_code";

    private readonly AsnOptions _options = options ?? new AsnOptions();

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>
    /// The pooled adapter, driven for the parts that are identical.
    /// </summary>
    /// <remarks>
    /// COMPOSED RATHER THAN COPIED, and the difference is the point: the
    /// selectors, the picker ladder, the format modal and the reconciliation
    /// are the ones a live account proved, not a second set that will drift
    /// away from them. A persistent ASN that fixed a screen the pooled one had
    /// not would be two adapters for one bank.
    /// </remarks>
    private readonly AsnAdapter _asn = new(options, time);

    public ProviderManifest Manifest { get; } = AsnPersistentManifest.Build();

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await LoginAsync(ctx, new AsnPortal(page), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Connect, which on an already-signed-in profile asks for nothing at all.
    /// </summary>
    /// <remarks>
    /// THE WHOLE POINT OF THE TIER, and it is one check. A profile that is
    /// still signed in needs no QR, no phone and no human: this notices, says
    /// so, and hands back a pointer.
    /// <para>
    /// A profile that is not gets whichever sign-in THE PAGE is offering, and
    /// the page is read before the inputs are. ASN's sign-in page tells a
    /// browser what it thinks of it by what it renders: a five-digit box to a
    /// browser it has registered, three method buttons to one it has not. So
    /// which of the four routes below applies is a question about the page
    /// first and the code second - and only the unregistered page, given no
    /// code, is the pooled QR sign-in. The others are its own.
    /// </para>
    /// </remarks>
    internal async Task<LoginResult> LoginAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Progress(JobStep.OpeningProvider);

        // THROUGH THE KIT'S GATE, which is the only thing that changed when
        // this moved onto the seam. A browser handed no profile and no cookie
        // jar cannot be signed in already, and SessionProbe answers "cannot
        // tell" for it without spending the settle window finding that out.
        // For THIS provider the gate is always open - browser_persistent plus
        // a BYO agent means ResolveProfile always hands it a directory - so
        // nothing about a real ASN run is different. What the seam buys is
        // that the question, the two lessons behind it and the rule about
        // when it is worth asking are now written down once for every
        // provider rather than here alone.
        if (await SessionProbe.AskAsync(ctx, (_, t) => PresenceAsync(portal, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            ctx.Note(
                $"{ProviderId}: this profile was still signed in to ASN, so nothing was asked of you - "
                + "which is the whole reason for keeping one");

            ctx.Progress(JobStep.Finalizing);

            return Pointer();
        }

        var code = ctx.Inputs.TryGetValue(BrowserCodeKey, out var given) && !string.IsNullOrWhiteSpace(given)
            ? given
            : null;

        // A TRUSTED BROWSER SIGNS IN WITH FIVE DIGITS.
        //
        // ASN will remember a browser: /online/browser-aanmelden/ registers one
        // against a code the customer chooses, an e-mail code, an SMS code and
        // their debit card. Afterwards this page is not three method buttons -
        // it is "Je logt in als <name>", one five-digit box and Inloggen.
        //
        // Which is the whole point of keeping a profile. Every other route into
        // this bank needs a phone in somebody's hand: the app's QR rotates
        // every few seconds, so it cannot be relayed to anyone who is not
        // holding their phone right then. Five digits can.
        if (await RegisteredAsync(portal, ct).ConfigureAwait(false))
        {
            // AND NOTHING ELSE. A registered browser's sign-in page has no
            // method buttons on it, so there is no QR to fall back to: the
            // pooled sign-in run here hunted for "ASN Bank app" on a page that
            // has never had it, reported the bank as changed, and the
            // catalogue degraded this provider for everybody on the strength
            // of one person leaving a field blank. The field is optional to
            // the validator because a browser has to be registered before it
            // has a code; on THIS page it is missing input, and that is the
            // code it fails with.
            if (code is null)
            {
                throw ConnectorException.InvalidRequest(
                    $"{ProviderId}: input '{BrowserCodeKey}' is required on this browser - ASN has registered "
                    + "it, so its sign-in page offers the five-digit browsercode and no other way in");
            }

            return await BrowserCodeAsync(ctx, portal, code, ct).ConfigureAwait(false);
        }

        // A CODE WITHOUT A REGISTRATION MEANS THEY WANT ONE.
        //
        // The five digits are chosen BY the customer, during registration -
        // ASN's "Kies een browsercode" - so somebody who has decided on a code
        // and has no trusted browser is somebody in the middle of setting one
        // up. Falling back to the QR here would sign them in once, correctly,
        // and leave them exactly as far from an unattended sync as they
        // started.
        if (code is not null)
        {
            return await RegisterAsync(ctx, portal, ct).ConfigureAwait(false);
        }

        // NOT TRUSTED AND NOT ASKED TO BE, so this is an ordinary ASN sign-in
        // on a browser that happens to keep its cookies. The QR, the live view
        // and the wait for the scan are the pooled adapter's, unchanged - and
        // its first checked move is the method button, so a page that offers
        // neither route fails there, with a description of what it did offer.
        await _asn.LoginAsync(ctx, portal, ct).ConfigureAwait(false);

        return Pointer();
    }

    /// <summary>
    /// Whether ASN has registered this browser, asked of the page.
    /// </summary>
    /// <remarks>
    /// ASKED, NOT REMEMBERED. Whether this browser is still trusted is decided
    /// by whether ASN is showing the five-digit box - not by a flag somebody
    /// set once. A registration the bank has withdrawn then reads as an
    /// unregistered browser rather than as five digits typed into a page that
    /// has no box for them.
    /// <para>
    /// TWO WITNESSES, and the box is the first. The greeting - "Je logt in als
    /// <i>name</i>" - is asked only when the box is not there, on a short
    /// budget because the page has had the box's whole budget to render by
    /// then. It is there for the day ASN restyles the input: without it a
    /// registered browser whose box had moved would be sent down the
    /// unregistered route, and the unregistered route on a registered page
    /// ends in <c>provider_changed</c>.
    /// </para>
    /// </remarks>
    private async Task<bool> RegisteredAsync(IAsnPortal portal, CancellationToken ct)
    {
        if (await portal.HasAsync(
                _options.BrowserCodeSelectors, TimeSpan.FromMilliseconds(_options.SelectorTimeoutMs), ct)
            .ConfigureAwait(false))
        {
            return true;
        }

        return await portal.HasHeadingAsync(_options.SignedInAsHeadingPrefix, TimeSpan.FromSeconds(1), ct)
            .ConfigureAwait(false);
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await FetchAsync(ctx, new AsnPortal(page), request, ct).ConfigureAwait(false);
    }

    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx, IAsnPortal portal, ResourceRequest request, CancellationToken ct)
    {
        ctx.Progress(JobStep.OpeningProvider);

        // ASKED, NEVER ASSUMED. Whether ASN's session really survives in a
        // persistent profile is the one claim this tier rests on and the one
        // nobody has measured - so a fetch finds out rather than believing it.
        //
        // The alternative is worse than a failed fetch: the export form is
        // served to a signed-OUT browser as a sign-in page, and an adapter that
        // pressed on would report "the download form has no account picker"
        // about a bank that was simply waiting to be logged into.
        // NOT through SessionProbe's gate, and deliberately. The gate answers
        // "was this browser handed anything?", which is the right question
        // before a LOGIN - there, a browser starting from nothing simply signs
        // in. A fetch is the opposite case: it already believes it has a
        // session, and "there is no profile here" is not a reason to skip the
        // check, it is the worst possible answer to it.
        if (await PresenceAsync(portal, ct).ConfigureAwait(false) is not SessionPresence.SignedIn)
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: the profile on this agent is no longer signed in to ASN, so it has to be "
                + "connected again - on a registered browser that is the five-digit browsercode, and no phone");
        }

        return await _asn.FetchAsync(ctx, portal, request, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The five-digit sign-in a registered browser gets.
    /// </summary>
    /// <remarks>
    /// <b>THE CODE IS THE CLIENT'S AND IS NEVER KEPT HERE.</b> It arrives as a
    /// job input, is typed, and goes when the job does - nothing on this agent
    /// or in the bundle holds it. That is deliberate and it is what makes the
    /// pair safe: the browsercode is worthless without this profile, and this
    /// profile is worthless without the code. Storing them in the same place
    /// would put both factors in one box.
    /// <para>
    /// Only ever reached on a page <see cref="RegisteredAsync"/> has already
    /// read as registered, so a box that cannot be typed into here is a page
    /// that has changed, not a browser that is untrusted.
    /// </para>
    /// </remarks>
    private async Task<LoginResult> BrowserCodeAsync(
        IJobContext ctx, IAsnPortal portal, string code, CancellationToken ct)
    {
        if (!await portal.FillNthAsync(_options.BrowserCodeSelectors, 0, code, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the sign-in page greets a registered browser but has no five-digit box "
                + "to type its browsercode into");
        }

        ctx.Progress(JobStep.Authenticating);

        // LATCHED BEFORE THE DIGITS LEAVE THE MACHINE, and this is the one
        // place on this route where that has to happen. After it a lost lease
        // fails the job instead of requeueing it - see
        // EfLeasedJobQueue.RequeueExpiredLeasesAsync, which puts a job back
        // only while nothing has been submitted upstream.
        //
        // Without it, an agent that stops during the landing wait below - up to
        // thirty seconds of it - sends this job back to the queue, and the next
        // run types the SAME five digits at ASN with nobody watching. The
        // refusal further down already says a refused browsercode "must never
        // be retried on its own"; that is only true of the error it returns.
        // This is what makes it true of a lease that simply lapsed, which is
        // the case nobody is there to see.
        //
        // BEFORE THE CLICK rather than after it, as bol's and BKR's are. What
        // must not exist is a window in which the code has reached the bank and
        // the control plane has not heard - and latching a hair early costs
        // nothing here, because a click that misses ends in provider_changed,
        // which is never retried either way.
        ctx.CredentialSubmitted();

        if (!await portal.ClickLabelAsync(_options.BrowserCodeSubmitLabel, LabelMatch.Exact, ct)
                .ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the browsercode box is on the page but its "
                + $"'{_options.BrowserCodeSubmitLabel}' button is not");
        }

        // CONFIRMED BY LEAVING, exactly as the QR path is. A wrong code leaves
        // the browser on the sign-in page, and the difference between "signed
        // in" and "still asking" is the address rather than anything the page
        // says about itself.
        //
        // ON ITS OWN BUDGET. This borrowed the selector timeout - ten seconds,
        // the budget for a control appearing on a page that is already open -
        // for a bank checking a credential and serving an overview, and a
        // landing that took eleven seconds was reported as a refused code,
        // which marks the profile unhealthy. See BrowserCodeLandingSeconds.
        var landing = TimeSpan.FromSeconds(_options.BrowserCodeLandingSeconds);

        if (!await portal.WaitForPathAsync(
                _options.SignedInPathMarker, without: _options.SignInPathMarker, landing, ct)
            .ConfigureAwait(false)
            && !Landed(portal))
        {
            // WHAT IS KNOWN IS WHERE THE BROWSER IS, and that is what the
            // message says. "ASN did not accept that browsercode" was a
            // reading, stated as a fact, of a page that had simply not moved -
            // and a refused code and a slow landing look identical from the
            // address bar. The code stays invalid_credentials because a
            // refused code is the likeliest reading and the one thing that
            // must never be retried on its own; the message stops asserting
            // more than the page has said.
            if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
            {
                throw ConnectorException.InvalidCredentials(
                    $"{ProviderId}: {landing.TotalSeconds:F0}s after the browsercode was submitted the browser "
                    + "is still on ASN's sign-in page. The likeliest reading is that ASN refused the code - it "
                    + "is the five digits chosen when this browser was registered, and it is not the account's "
                    + "own password - but a sign-in that had not landed yet would look the same from here");
            }

            // NEITHER PAGE. Not refused, because a refused code stays on the
            // sign-in page; not signed in, because the overview never came.
            // ASN moved the browser somewhere this adapter has not seen, and
            // the address is the one fact the first failure can carry out.
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: after the browsercode was submitted the browser went to {portal.Url}, "
                + "which is neither ASN's sign-in page nor its overview");
        }

        ctx.Note($"{ProviderId}: signed in with the browsercode - no phone, no code to scan");
        ctx.Progress(JobStep.Finalizing);

        return Pointer();
    }

    /// <summary>
    /// Teaches ASN to trust this profile, with the account holder driving.
    /// </summary>
    /// <remarks>
    /// <b>STREAMED AND NOT AUTOMATED, on purpose.</b> Registration is a long
    /// human errand: choose a code, confirm it, name the browser, name the
    /// device, pick a confirmation route, type an account number and a card
    /// sequence, read a code out of an e-mail, read another out of a text, and
    /// sign the lot. Twenty screens, two of which wait on messages nobody here
    /// can see.
    /// <para>
    /// Automating that would mean driving a bank's identity flow against
    /// selectors from a single run, with an account lockout for a failure mode
    /// - and it happens ONCE per machine. So the adapter opens the page, hands
    /// over the browser, and gets out of the way. What it contributes is the
    /// only thing the human cannot: the page opens in the AGENT'S profile, so
    /// the trust cookie lands where every later fetch will look for it.
    /// </para>
    /// <para>
    /// The code they choose on ASN's screen has to be the one they gave us -
    /// that is what the copy for this challenge is for, and it is why this runs
    /// on the code being present rather than on a flag.
    /// </para>
    /// <para>
    /// <b>AND NOTHING IS LATCHED HERE, deliberately.</b> The browsercode route
    /// calls <see cref="IJobContext.CredentialSubmitted"/> because it types a
    /// credential and presses a button; this route types nothing and presses
    /// nothing. Everything ASN receives during a registration is typed by the
    /// account holder into their own browser, so a lease that lapses mid-errand
    /// has submitted nothing on their behalf - and the job going back to the
    /// queue reopens the page exactly as the note below promises it will.
    /// Latching that would spend the retry the note has already offered.
    /// </para>
    /// <para>
    /// <b>AND IT ENDS HERE, ONE WAY OR THE OTHER.</b> A registration that ran
    /// out its window used to hand back null, and the caller read null as
    /// "not a registered browser" and went on into the pooled sign-in - which
    /// opens the login address on THE SAME PAGE, on top of a registration
    /// that might have been one screen from done, and then waits five more
    /// minutes for a QR nobody is going to scan. The job's eventual failure
    /// blamed its working budget, which is not what happened. Now the window
    /// lapsing is the failure, it says so, and the browser is left where the
    /// human had it.
    /// </para>
    /// </remarks>
    private async Task<LoginResult> RegisterAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Note(
            $"{ProviderId}: this browser is not registered with ASN yet, so the registration page is open "
            + "above - choose the same five digits you gave us when it asks for a browsercode");

        await portal.GotoAsync(Absolute(_options.BrowserRegistrationPath), ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        using var relay = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // Raised and NOT awaited, which is the shape of every live view here:
        // nobody types an answer back. What ends this is the bank moving the
        // browser on, which the wait below is watching for.
        var asked = ctx.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = AsnPersistentManifest.RegisterKey,
                ExpiresAt = _time.GetUtcNow().AddSeconds(_options.RegistrationSeconds),
            },
            relay.Token);

        try
        {
            // The same terminal signal as every other sign-in on this bank: the
            // browser leaves /inloggen/ behind. Registration ends by offering
            // "Start met online bankieren", which goes to the sign-in page,
            // which now wants five digits - so somebody who finishes the errand
            // finishes the connect with it.
            if (!await portal.WaitForPathAsync(
                    _options.SignedInPathMarker,
                    _options.SignInPathMarker,
                    TimeSpan.FromSeconds(_options.RegistrationSeconds),
                    ct)
                .ConfigureAwait(false)
                // The address gets the last word here too - see Landed. A
                // human who reaches the overview on the twelfth minute, on a
                // page slow to finish loading, has DONE the errand: failing
                // that as "not finished within its window" would send them
                // through twenty screens, an e-mail code, a text and a debit
                // card a second time, for a registration that exists.
                && !Landed(portal))
            {
                ctx.Note(
                    $"{ProviderId}: the registration was not finished, so this browser is still untrusted. "
                    + "Nothing was lost - connect again and the page comes back where it was");

                // MFA TIMEOUT: nobody finished a challenge in its window. The
                // platform's own answer when a challenge goes unanswered, and
                // it says the right things - retriable, "try again" - for an
                // errand that can simply be started over. Not the pooled
                // sign-in, which is what a null here used to mean.
                throw new ConnectorException(
                    ErrorCode.MfaTimeout,
                    $"{ProviderId}: the browser registration was not finished within its "
                    + $"{_options.RegistrationSeconds}s window - the browser never reached a signed-in page, "
                    + "so it is still unregistered and nothing was signed in");
            }
        }
        finally
        {
            await relay.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => t.Exception, TaskScheduler.Default);
        }

        ctx.Note(
            $"{ProviderId}: this browser is registered with ASN now - from here it signs in with the "
            + "browsercode, and no phone");

        ctx.Progress(JobStep.Finalizing);

        return Pointer();
    }

    /// <summary>
    /// Whether this profile is still inside ASN.
    /// </summary>
    /// <remarks>
    /// By a PATH and not a word, the same test the pooled sign-in settles on:
    /// the signed-in pages leave <c>/inloggen/</c> behind, and a path does not
    /// translate for a customer whose bank speaks English to them.
    /// <para>
    /// Both halves are needed. ASN's sign-in address SITS BENEATH its
    /// signed-in one - <c>/online/web/onlinebankieren/inloggen/</c> under
    /// <c>/online/web/onlinebankieren/</c> - so "contains the signed-in
    /// marker" is true on the sign-in page too, and a check built on that
    /// alone would call every signed-out profile signed in.
    /// </para>
    /// <para>
    /// <b>AND THE BOUNCE IS WAITED FOR, NOT RACED.</b> Observed on a live
    /// account on 2026-09-19, on a profile created minutes earlier: ASN
    /// answered the overview address for a signed-out browser with a page
    /// that KEPT that address and rendered a visible profile menu, and only
    /// moved to <c>/inloggen/</c> a moment later. So neither witness this
    /// check had is signed-in-only - not the address, not the menu - and
    /// taking the first positive sign said "this profile was still signed in
    /// to ASN, so nothing was asked of you" about a browser that was signed
    /// out and unregistered. The fetch that followed drove the export form
    /// against ASN's sign-in page and reported the bank as changed.
    /// </para>
    /// <para>
    /// The order is therefore inverted: the page is given the whole window to
    /// say NO - the sign-in address arriving is proof, and it is the only
    /// thing either page does that the other does not - and only a page that
    /// never says it may then be confirmed by the menu. The cost is that a
    /// profile which really is signed in pays that window on every check,
    /// since the bounce it is waiting for never comes. That is the right way
    /// round: the window is seconds, and the answer it buys is the difference
    /// between a fetch that works and a provider degraded for everybody.
    /// </para>
    /// </remarks>
    /// <remarks>
    /// <b>AND THE THIRD ANSWER IS NOT "SIGNED OUT".</b> Only ASN refusing us -
    /// arriving at <c>/inloggen/</c>, before the wait or during it - is
    /// <see cref="SessionPresence.SignedOut"/>. A page that neither refused nor
    /// showed the menu told us nothing, and says so:
    /// <see cref="SessionPresence.CannotTell"/>. Both callers treat the two
    /// alike - the login signs in again, the fetch raises
    /// <c>session_expired</c> - so no run behaves differently for the
    /// distinction; what it buys is that a bank whose menu moved is no longer
    /// recorded as having signed us out.
    /// </remarks>
    private async Task<SessionPresence> PresenceAsync(IAsnPortal portal, CancellationToken ct)
    {
        await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);

        // Bounced already, so there is nothing to wait for.
        if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            return SessionPresence.SignedOut;
        }

        var settle = TimeSpan.FromSeconds(_options.SignedInSettleSeconds);

        // The page saying NO, which is the one thing only a signed-out
        // browser's page does.
        if (await portal.WaitForPathAsync(_options.SignInPathMarker, without: null, settle, ct)
            .ConfigureAwait(false))
        {
            return SessionPresence.SignedOut;
        }

        if (!await UserMenuAsync(portal, settle, ct).ConfigureAwait(false))
        {
            return SessionPresence.CannotTell;
        }

        return portal.Url.Contains(_options.SignedInPathMarker, StringComparison.OrdinalIgnoreCase)
               && !portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase)
            ? SessionPresence.SignedIn
            : SessionPresence.CannotTell;
    }

    /// <summary>
    /// The kit's already-signed-in capability, answered for ASN.
    /// </summary>
    /// <remarks>
    /// <see cref="PresenceAsync"/> navigates to the overview itself, so this
    /// needs nothing but the browser - and both entry points therefore ask the
    /// bank exactly the same question in exactly the same way.
    /// </remarks>
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await PresenceAsync(new AsnPortal(page), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether the browser is on the signed-in overview, asked of the address
    /// alone - the second opinion when a wait for that address gives up.
    /// </summary>
    /// <remarks>
    /// A WAIT THAT RAN OUT IS NOT PROOF THE BROWSER DID NOT ARRIVE. Playwright
    /// matches the address and then, on the same clock, waits for the page's
    /// <c>load</c> event: a bank overview that commits at twenty seconds and
    /// finishes loading at thirty-five fails a thirty-second wait with the
    /// address already correct. Read without this, that ended in
    /// <c>provider_changed</c> naming the overview as "neither ASN's sign-in
    /// page nor its overview" - a sentence contradicted by its own subject,
    /// against a browser that was signed in, and <c>provider_changed</c>
    /// degrades the provider in the catalogue for everybody.
    /// <para>
    /// So the address gets the final word here exactly as it does in
    /// <see cref="PresenceAsync"/>, and only an address that is neither page
    /// is reported as the bank having changed.
    /// </para>
    /// </remarks>
    private bool Landed(IAsnPortal portal) =>
        portal.Url.Contains(_options.SignedInPathMarker, StringComparison.OrdinalIgnoreCase)
        && !portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The user menu, asked for BOTH WAYS, because only one of them was ever
    /// observed and it is not the one the selector is written in.
    /// </summary>
    /// <remarks>
    /// The mapping run reported this control as
    /// <c>button[data-testid='button'] "Profiel menu openen"</c>. The first
    /// half is the SELECTOR the probe builds, and it prefers
    /// <c>data-testid</c> over everything else; the second half is the NAME,
    /// which the probe reads from <c>aria-label</c> OR <c>title</c>. So the
    /// words are observed and the attribute carrying them is not -
    /// <see cref="AsnOptions.UserMenuSelectors"/> picked <c>aria-label</c>, and
    /// a <c>title</c> would make that selector match nothing, forever, on a
    /// page that does have the control.
    /// <para>
    /// That never showed, because the only caller was the sign-out ladder,
    /// where it is one rung of several and the positional rungs below it carry
    /// the run when it misses. Making it the witness for "is this profile
    /// signed in" removed that cover: a miss on a page that IS signed in reads
    /// as signed out, and a signed-out profile holding a browsercode is sent
    /// to REGISTER - ASN's twenty-screen errand, opened on top of a live
    /// session, for a browser that is already trusted.
    /// </para>
    /// <para>
    /// So ask the way the observation was made. <see cref="IAsnPortal.HasLabelAsync"/>
    /// matches a button by its ACCESSIBLE NAME, which the browser computes
    /// from <c>aria-label</c>, <c>title</c> or text alike - the same rule the
    /// probe's own reader approximates. The CSS selector is kept and tried
    /// first, so the day it is right this costs nothing and the sign-out
    /// ladder keeps its meaning.
    /// </para>
    /// </remarks>
    /// <remarks>
    /// EACH ASKED FOR THE WHOLE WINDOW, not half of it each. The window is
    /// how long a signed-in page is given to render its menu, and splitting
    /// it would mean a page that takes twelve seconds is found by neither
    /// probe on a fifteen-second budget - the window would no longer be the
    /// number it says it is. Both are only ever asked on a page that is not
    /// obviously signed out, and the second only when the first has missed.
    /// </remarks>
    private async Task<bool> UserMenuAsync(IAsnPortal portal, TimeSpan budget, CancellationToken ct) =>
        await portal.HasAsync(_options.UserMenuSelectors, budget, ct).ConfigureAwait(false)
        || await portal.HasLabelAsync(_options.UserMenuLabel, budget, ct).ConfigureAwait(false);

    /// <summary>
    /// A bundle with no secret in it.
    /// </summary>
    /// <remarks>
    /// EMPTY ON PURPOSE, and it is the strongest thing this provider offers.
    /// The session lives in a profile directory on the account holder's own
    /// machine; the agent stamps <c>{agent_id, profile_id}</c> onto this on its
    /// way past - see <c>JobRunner.MaterialFor</c> - so what the control plane
    /// stores is a pointer to a machine it cannot reach. There is nothing here
    /// for a breach of this platform to take.
    /// <para>
    /// Carrying the cookie jar here "just in case" would quietly undo that: it
    /// would put a live ASN session in the connector's database, which is the
    /// exact thing this tier exists to avoid.
    /// </para>
    /// </remarks>
    private static LoginResult Pointer() => new() { Material = new SessionMaterial() };

    private string Absolute(string path) =>
        new Uri(new Uri(_options.LoginUrl), path).ToString();
}
