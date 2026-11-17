using Connector.Kit.Challenges;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;

namespace BankConnector.Adapters.Asn;

/// Same bank and export as AsnAdapter, plus a profile that outlives the job (QR scanned once), minus the sign-out.
/// UNVERIFIED: that ASN's session survives in a persistent profile; each fetch asks the bank, else session_expired.
/// A continuous bank session on the user's machine: a consumer must render the notes key.
internal sealed class AsnPersistentAdapter(AsnOptions? options = null, TimeProvider? time = null)
    : IProviderAdapter
{
    public const string ProviderId = AsnPersistentManifest.ProviderId;

    /// An input, never material: sealing it into the bundle would put both factors in one box (profile = have, code = know).
    public const string BrowserCodeKey = "browser_code";

    private readonly AsnOptions _options = options ?? new AsnOptions();

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// Composed, not copied: the selectors, picker ladder, format modal and reconciliation stay the proven ones.
    private readonly AsnAdapter _asn = new(options, time);

    public ProviderManifest Manifest { get; } = AsnPersistentManifest.Build();

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await LoginAsync(ctx, new AsnPortal(page), ct).ConfigureAwait(false);
    }

    /// Connect: a still-signed-in profile asks for nothing. Otherwise the page is read first: a five-digit box means a
    /// registered browser, method buttons an unregistered one; only the latter with no code is the pooled QR sign-in.
    internal async Task<LoginResult> LoginAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Progress(JobStep.OpeningProvider);

        // through the kit's SessionProbe gate: a browser with no profile or cookie jar cannot be signed in, answered at once
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

        // a trusted browser signs in with five digits: every other route needs a phone in hand, and the QR rotates too fast to relay
        if (await RegisteredAsync(portal, ct).ConfigureAwait(false))
        {
            // a registered browser's page has no method buttons, so no QR fallback: the pooled sign-in blamed the bank (ProviderChanged)
            // optional to the validator (no code before registration), but missing input on this page: invalid_request
            if (code is null)
            {
                throw ConnectorException.InvalidRequest(
                    $"{ProviderId}: input '{BrowserCodeKey}' is required on this browser - ASN has registered "
                    + "it, so its sign-in page offers the five-digit browsercode and no other way in");
            }

            return await BrowserCodeAsync(ctx, portal, code, ct).ConfigureAwait(false);
        }

        // a code without a registration means they want one: the code is chosen during registration, and a QR sign-in would not help
        if (code is not null)
        {
            return await RegisterAsync(ctx, portal, ct).ConfigureAwait(false);
        }

        await _asn.LoginAsync(ctx, portal, ct).ConfigureAwait(false);

        return Pointer();
    }

    /// Asked, not remembered: a withdrawn registration reads as unregistered. The greeting is a second witness, asked only
    /// when the box is missing, for when ASN restyles the input (else the unregistered route ends in provider_changed).
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

        // asked, never assumed: a signed-out browser is served the export form as a sign-in page, blamed as a missing picker
        // not through SessionProbe's gate: a fetch already believes it has a session, so "no profile" is no reason to skip the check
        if (await PresenceAsync(portal, ct).ConfigureAwait(false) is not SessionPresence.SignedIn)
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: the profile on this agent is no longer signed in to ASN, so it has to be "
                + "connected again - on a registered browser that is the five-digit browsercode, and no phone");
        }

        return await _asn.FetchAsync(ctx, portal, request, ct).ConfigureAwait(false);
    }

    /// The code is the client's: typed per job and never kept, since profile and code are each worthless without the other.
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

        // latch before the digits leave the machine: after it a lost lease fails the job instead of requeueing
        // (EfLeasedJobQueue.RequeueExpiredLeasesAsync), else the next run types the SAME digits unwatched
        ctx.CredentialSubmitted();

        if (!await portal.ClickLabelAsync(_options.BrowserCodeSubmitLabel, LabelMatch.Exact, ct)
                .ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the browsercode box is on the page but its "
                + $"'{_options.BrowserCodeSubmitLabel}' button is not");
        }

        // confirmed by leaving, as the QR path is: a wrong code stays on the sign-in page
        // own budget (BrowserCodeLandingSeconds): the 10s selector timeout reported an 11s landing as a refused code
        var landing = TimeSpan.FromSeconds(_options.BrowserCodeLandingSeconds);

        if (!await portal.WaitForPathAsync(
                _options.SignedInPathMarker, without: _options.SignInPathMarker, landing, ct)
            .ConfigureAwait(false)
            && !Landed(portal))
        {
            // the message states only where the browser is: a refused code and a slow landing look alike; stays invalid_credentials
            // because a refused code is the likeliest reading and must never be retried on its own
            if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
            {
                throw ConnectorException.InvalidCredentials(
                    $"{ProviderId}: {landing.TotalSeconds:F0}s after the browsercode was submitted the browser "
                    + "is still on ASN's sign-in page. The likeliest reading is that ASN refused the code - it "
                    + "is the five digits chosen when this browser was registered, and it is not the account's "
                    + "own password - but a sign-in that had not landed yet would look the same from here");
            }

            // neither page: not refused (a refused code stays on sign-in) and not signed in; the address is the one fact to carry out
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: after the browsercode was submitted the browser went to {portal.Url}, "
                + "which is neither ASN's sign-in page nor its overview");
        }

        ctx.Note($"{ProviderId}: signed in with the browsercode - no phone, no code to scan");
        ctx.Progress(JobStep.Finalizing);

        return Pointer();
    }

    /// Streamed, not automated: a long human errand (e-mail code, SMS code, card) done once per machine, with lockout risk.
    /// The page opens in the AGENT's profile so the trust cookie lands where later fetches look.
    /// Nothing is latched: the human types everything into their own browser, so a lapsed lease has submitted nothing.
    private async Task<LoginResult> RegisterAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Note(
            $"{ProviderId}: this browser is not registered with ASN yet, so the registration page is open "
            + "above - choose the same five digits you gave us when it asks for a browsercode");

        await portal.GotoAsync(Absolute(_options.BrowserRegistrationPath), ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        using var relay = CancellationTokenSource.CreateLinkedTokenSource(ct);

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
            if (!await portal.WaitForPathAsync(
                    _options.SignedInPathMarker,
                    _options.SignInPathMarker,
                    TimeSpan.FromSeconds(_options.RegistrationSeconds),
                    ct)
                .ConfigureAwait(false)
                // the address has the last word (see Landed): a human reaching the overview late must not redo the whole errand
                && !Landed(portal))
            {
                ctx.Note(
                    $"{ProviderId}: the registration was not finished, so this browser is still untrusted. "
                    + "Nothing was lost - connect again and the page comes back where it was");

                // MfaTimeout, not null: a null used to fall into the pooled sign-in on top of a registration that might be nearly done
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

    /// By a path, not a word; both markers, since the sign-in address sits beneath the signed-in one.
    /// Observed 2026-09-19: a signed-out page kept the overview address and a visible profile menu, then moved to /inloggen/:
    /// the page gets the whole window to say NO, and only one that never does is menu-confirmed. Else CannotTell.
    private async Task<SessionPresence> PresenceAsync(IAsnPortal portal, CancellationToken ct)
    {
        await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);
        // the outdated-browser notice stands in front of the answer (#562): passed, and asked again
        if (await AsnAdapter.PastBrowserNoticeAsync(portal, _options, note: null, ct).ConfigureAwait(false))
        {
            await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);
        }

        if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            return SessionPresence.SignedOut;
        }

        var settle = TimeSpan.FromSeconds(_options.SignedInSettleSeconds);

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

    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await PresenceAsync(new AsnPortal(page), ct).ConfigureAwait(false);
    }

    /// A wait that ran out does not prove the browser did not arrive: Playwright also waits for the load event, so an overview
    /// committing at 20s and loading at 35s fails a 30s wait. The address gets the final word, as in PresenceAsync.
    private bool Landed(IAsnPortal portal) =>
        portal.Url.Contains(_options.SignedInPathMarker, StringComparison.OrdinalIgnoreCase)
        && !portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase);

    /// Asked by selector and by accessible name: the name may be an aria-label or a title, so the selector may match nothing.
    /// A miss reads a signed-in page as signed out and sends a browsercode holder to REGISTER. Each gets the whole window.
    private async Task<bool> UserMenuAsync(IAsnPortal portal, TimeSpan budget, CancellationToken ct) =>
        await portal.HasAsync(_options.UserMenuSelectors, budget, ct).ConfigureAwait(false)
        || await portal.HasLabelAsync(_options.UserMenuLabel, budget, ct).ConfigureAwait(false);

    /// Empty on purpose: the session is a profile directory on the holder's machine, and the agent stamps {agent_id, profile_id}
    /// on it (JobRunner.MaterialFor); a cookie jar here would put a live ASN session in the connector's database.
    private static LoginResult Pointer() => new() { Material = new SessionMaterial() };

    private string Absolute(string path) =>
        new Uri(new Uri(_options.LoginUrl), path).ToString();
}
