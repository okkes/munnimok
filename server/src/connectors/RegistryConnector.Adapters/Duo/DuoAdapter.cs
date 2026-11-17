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

/// ForceAuthn=true: DigiD re-authenticates every sync, so no unattended fetch - except a browser DUO
/// still has a session for (15 min): it starts no authentication and is already inside (PresenceAsync)
/// QR relayed as DigiD's inline PNG bytes (RelayQr): a photographed one fails to decode ~1.5%; klantbeeld: see DuoCalls
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

    // navigates, unlike PresenceAsync: a browser on about:blank is asked from the wrong origin (see IDuoPortal.OpenAsync)
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var portal = new PageDuoPortal(page, _options);

        await portal.OpenAsync(_options.StartUrl, ct).ConfigureAwait(false);

        return await PresenceAsync(ctx, portal, ct).ConfigureAwait(false);
    }

    // behind the page seam so the offline suite needs no browser, account or DigiD
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, IDuoPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);
        ArgumentNullException.ThrowIfNull(portal);

        ctx.Progress(JobStep.OpeningProvider);

        // the protected page and DUO's own redirects, never DigiD's entry URL:
        // a hand-made IdP start address logs in at the IdP and leaves the site signed out
        await page.GotoAsync(_options.StartUrl, ct).ConfigureAwait(false);

        // already inside: nothing is asked; DUO's session is 15 min of inactivity on the browser's cookies
        // ForceAuthn bites when an authentication is initiated; opening a page with a live session initiates none
        // via the kit's gate: a browser with no profile or cookie jar cannot be inside, so no SignedOutBounceSeconds wait
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

        // latched before the human touches anything: a lost lease then fails the job, as a requeued DigiD login
        // is an attempt Logius counts; below the already-inside check, which submitted nothing and must stay requeueable
        ctx.CredentialSubmitted();

        var username = Optional(ctx, "username");
        var password = Optional(ctx, "password");

        // both stored: only the texted six digits are asked of the human; any failure hands the page over
        // that makes label-captured selectors (DUO's chooser, DigiD's method list) safe: a redesign costs a streamed login
        if (username is not null && password is not null)
        {
            try
            {
                // null means "hand over", returned not called: a failure raised by a hand-over inside this try
                // was caught here and the hand-over ran twice
                if (await TypedSignInAsync(ctx, page, watcher, portal, username, password, ct)
                        .ConfigureAwait(false) is { } signedIn)
                {
                    return signedIn;
                }
            }
            catch (ConnectorException ex)
                when (ex.Code is ErrorCode.ProviderChanged or ErrorCode.MfaFailed or ErrorCode.BlockedByProvider)
            {
                // the code and what it said: the code names a category, not a step; Missing() carries "no element for X; tried [...]"
                // no credential can be in it: it is the adapter's own text about its selectors, and notes pass the redactor
                ctx.Note($"{ProviderId}: the typed sign-in did not complete ({ex.Code}): {Said(ex)}. The page " +
                         "is being handed over instead");

                await NoteTheShapeAsync(ctx, portal, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                // the browser refusing an element, not a changed page: Playwright's TimeoutException is no ConnectorException
                // it once escaped the hand-over, showing "This login failed"; an unclickable element is when to hand over
                ctx.Note($"{ProviderId}: the browser could not drive a step of the typed sign-in " +
                         $"({ex.GetType().Name}), so the page is being handed over instead");

                await NoteTheShapeAsync(ctx, portal, ct).ConfigureAwait(false);
            }
        }

        return await LiveSignInAsync(ctx, page, watcher, portal, ct).ConfigureAwait(false);
    }

    /// tier one, and the fallback from tier two; ends when DUO says there is a session, the typed path's terminal signal too
    private async Task<LoginResult> LiveSignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, IDuoPortal portal, CancellationToken ct)
    {
        // the page must hold no secret before it is photographed: a failed typed sign-in hands over with a DigiD
        // password in the form, and the still-capture refuses such a page, so nothing would be relayed
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

                // two conditions: the url gate cannot rule out the protected page itself (it lands on a portal address, then
                // bounces into SAML), so the first look believed a login 80ms in; DUO is asked too, only when the url looks right
                if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null
                    && await SignedInAsync(portal, ct).ConfigureAwait(false))
                {
                    ctx.Progress(JobStep.Finalizing);
                    return await SignedAsync(ctx, ct).ConfigureAwait(false);
                }

                // every pass: whether DigiD expires or rotates its QR is UNKNOWN, so the image is re-read and relayed if changed
                // a stale picture costs the login
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

    /// best-effort: a miss throws ProviderChanged and the caller hands over, so the worst case costs seconds
    /// the blamed step differs from the throwing one: an undriven chooser leaves no form, so step 2's result goes to step 3
    /// returns null when the rest belongs to the streamed hand-over, which the caller runs exactly once
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

        // DUO's own fork, before DigiD: chosen explicitly, as the other option signs in for someone else and fetches their debt
        if (await page.ClickAsync(_options.SelfRadioSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            await page.ClickAsync(_options.ContinueSelectors, _options.StepProbeMs, ct).ConfigureAwait(false);
        }

        // DigiD's "Hoe wilt u inloggen?": four methods, two want an NFC reader, so only these two are driven
        // the result is kept: a miss once surfaced only as "username box is missing", misleading as the page never left the chooser
        // not a failure by itself: a page showing credential boxes without a chooser is signed in today, so the miss goes to step 3
        var method = wantsApp ? _options.AppMethodSelectors : _options.SmsMethodSelectors;
        var chose = await page.ClickAsync(method, _options.StepProbeMs, ct).ConfigureAwait(false);

        // DigiD's follow-up on the app path: always another device (no DigiD app in the agent's browser; the QR reaches a phone)
        // best effort
        if (wantsApp)
        {
            await page.ClickAsync(_options.AppOnOtherDeviceSelectors, _options.StepProbeMs, ct)
                .ConfigureAwait(false);
        }

        // the credentials on one screen: selectors captured by id, so a miss here means the page changed, not a reworded label
        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            // blame whichever step missed: no credential form and no method chosen is one failure,
            // the chooser stranded everything after it
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

        // the app path has nothing left to type (code on the phone, then a QR): back to the streamed loop, which relays the QR
        // handed back, not run from here: the streamed login's failures must not be caught by the typed fallback and run twice
        if (wantsApp) return null;

        // six digits asked for rather than streamed: the challenge protocol carries a code box well
        await FillCodeAsync(ctx, page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        var landed = await watcher.WaitAsync(TimeSpan.FromSeconds(_options.SignInSeconds), ct)
            .ConfigureAwait(false);

        if (landed is null || !await SignedInAsync(portal, ct).ConfigureAwait(false))
        {
            // never "wrong password": a refused code and a refused password look identical; the caller turns this into a hand-over
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{ProviderId}: the typed sign-in did not reach the portal after the code was submitted");
        }

        return await SignedAsync(ctx, ct).ConfigureAwait(false);
    }

    /// the POST carries ONE field, smscode[smscode]; the six boxes are presentation a browser must type into, a digit apiece
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

        // checked before any box is filled: half a code typed is an attempt DigiD counts, and DigiD locks accounts
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

    /// parameters travel as base64 JSON, built per call from today to next month:
    /// a hard-coded month answers about that month for ever
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

    /// every message here is prefixed with the provider id (an exception travels alone);
    /// stripped so a note does not read "duo: ...: duo: ..."
    private static string Said(ConnectorException ex) =>
        ex.Message.StartsWith(ProviderId + ": ", StringComparison.Ordinal)
            ? ex.Message[(ProviderId.Length + 2)..]
            : ex.Message;

    /// the page's shape goes into the notes for the operator; PageShape never reads input values or image bytes
    /// MUST NOT THROW: it runs inside the catch that reaches the hand-over, and an escape once showed "This login failed"
    /// only cancellation passes
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

    // the url may only refuse (a bounce to /isam/ or login.digid.nl); it never says yes: the portal bounces into SAML late
    // unrefused within SignedOutBounceSeconds, the session endpoint decides; alone mid-SAML it answers from the wrong origin
    // staying on DUO's pages with nobody named is CannotTell; only a real bounce into the sign-in chain is SignedOut
    internal async Task<SessionPresence> PresenceAsync(IJobContext ctx, IDuoPortal portal, CancellationToken ct)
    {
        if (await portal
                .BouncesToSignInAsync(TimeSpan.FromSeconds(_options.SignedOutBounceSeconds), ct)
                .ConfigureAwait(false))
        {
            return SessionPresence.SignedOut;
        }

        if (await SignedInAsync(portal, ct).ConfigureAwait(false)) return SessionPresence.SignedIn;

        // said out loud: staying on DUO's own pages and still being nobody looks like a bug from outside
        // the log must state why DigiD starts
        ctx.Note($"{ProviderId}: this browser stayed on DUO's own pages for {_options.SignedOutBounceSeconds}s " +
                 $"and {_options.SessionPath} still named no profile, so there is no session here to reuse and " +
                 "the DigiD sign-in is starting");

        return SessionPresence.CannotTell;
    }

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

        // the browser must be on DUO before anything is read: the page's fetch is same-origin only on mijn.duo.nl, and about:blank
        // (restored cookie jar) made all three die as "Failed to fetch", shown to the user as HTTP 500
        var landed = await portal.OpenAsync(_options.StartUrl, ct).ConfigureAwait(false);

        // where it landed is the cheapest session check: signed out, DUO bounces straight into SAML
        // later it is three failed fetches and a guess
        if (!DuoSignedInWatcher.SignedIn(landed, _options))
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: opening the portal landed on {landed}, which is the sign-in chain - so the " +
                "stored session is over. DUO sets ForceAuthn, so this needs a new DigiD sign-in and there is " +
                "nothing to refresh.");
        }

        // the session endpoint first, the portal's own order: skipping it got a 401 from the debt endpoint
        // it also turns that 401 into a diagnosable "nobody is signed in"
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

        // from here DUO has said whose session this is, so a 401 means this connector missed something DUO's page sends
        // (2026-09-20: a 401 after 200s was reported as expired and sent the holder back through DigiD); see DuoCalls
        const bool SessionConfirmed = true;

        // one clock reading for the whole fetch: the holiday date and the interest-rate date must be the same day across midnight
        var today = DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime);

        var amounts = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(_options.DebtPath, Required: true, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        // enrichment, may be absent: a missing rate says less, a failed fetch says nothing and costs another DigiD sign-in
        var positions = await DuoCalls
            .ReadAsync(
                portal, _options,
                new DuoCall(_options.PositionsPath, Required: false, SessionConfirmed: SessionConfirmed),
                ct, ctx.Note)
            .ConfigureAwait(false);

        // without the peildatum DUO refuses ("Required parameter 'peildatum' is not present"); today, as DUO's own portal passes
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

        // the balances DUO stated at named moments, and the date it calculated interest to (reachable without the customer dossier)
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

        // the dossier only when the ledger was asked: the only place with every booked movement, but it also holds a BSN,
        // parents, tax income, IBANs and addresses; opt-in per fetch, and only the movements and one instalment are read
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

            // the provider's name only: DUO would state the holder's own (profielklantmenu has persoonsId and date of birth)
            // not worth it for a card label
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            ExpiresAt = _time.GetUtcNow().AddSeconds(DuoManifest.SessionTtlSeconds),
        };
    }

    /// the QR as the bytes DigiD drew (196x196 PNG inline in the markup), not a photograph: the live JPEG stream fails ~1.5%
    /// holds state because a QR may be replaced while the person reaches for their phone
    private sealed class RelayQr(IJobContext ctx, DuoOptions options, TimeProvider time) : IAsyncDisposable
    {
        private string? _sent;
        private CancellationTokenSource? _open;
        private Task<ChallengeAnswer>? _asked;

        public async Task OfferAsync(ILoginPage page, CancellationToken ct)
        {
            var source = await page
                .AttributeAsync(options.QrImageSelectors, options.QrImageAttribute, options.QrProbeMs, ct)
                .ConfigureAwait(false);

            // the ordinary answer on nearly every pass: no QR on this screen (also what a page that cannot read attributes says)
            if (string.IsNullOrEmpty(source)) return;

            // three images sit in DigiD's QR block: its 44x44 logo is FIRST, a remote copy in a noscript, the code on a hidden canvas
            // relaying the wrong one would wait out the login on a scan that cannot happen, silently
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

            // the payload the picture encodes (digid-app-auth://...), so a consumer on the phone itself can offer a tap
            var payload = await page
                .AttributeAsync(options.QrBlockSelectors, options.QrPayloadAttribute, options.QrProbeMs, ct)
                .ConfigureAwait(false);

            await CloseAsync().ConfigureAwait(false);

            _sent = source;
            _open = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // nothing is read back: the phone approves, DigiD's page finishes its long poll,
            // and the browser reaching the portal ends the login
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

        private static byte[]? Png(string source)
        {
            var comma = source.IndexOf(',', StringComparison.Ordinal);
            if (comma < 0) return null;

            // base64 only: a percent-encoded data url must not be relayed as though it were a picture
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
