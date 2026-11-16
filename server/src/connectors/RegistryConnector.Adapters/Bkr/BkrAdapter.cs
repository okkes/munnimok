using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using RegistryConnector.Adapters.Support;

namespace RegistryConnector.Adapters.Bkr;

/// Azure AD B2C asks for a second factor EVERY time and issues no refresh token, so every sync is a fresh sign-in
/// a stored seed (code computed here) deliberately weakens the second factor and is never the default; see connect.bkr.totp
public sealed class BkrAdapter : IProviderAdapter
{
    public const string ProviderId = "bkr";
    public const string CreditsResource = "credits";

    private static readonly ProviderManifest Manifest = BkrManifest.Build();

    private readonly BkrOptions _options;
    private readonly TimeProvider _time;

    public BkrAdapter(BkrOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new BkrOptions();
        _time = time ?? TimeProvider.System;
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var login = new PlaywrightLoginPage(page, Manifest);
        var watcher = new BkrSignedInWatcher(login, _options, _time);

        return await LoginAsync(ctx, login, watcher, ct).ConfigureAwait(false);
    }

    // navigates, unlike PresenceAsync: the answer is which host the browser ends up on,
    // and a browser that has been nowhere is on neither
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var browser = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browser, Manifest);

        await page.GotoAsync(_options.PortalUrl, ct).ConfigureAwait(false);

        return await PresenceAsync(page, ct).ConfigureAwait(false);
    }

    // one witness, the address (no session endpoint to ask): the page gets SignedOutBounceSeconds to say NO first
    // the yes is BkrSignedInWatcher.SignedIn, not "did not bounce": the portal's address also appears on the login host
    private Task<SessionPresence> PresenceAsync(ILoginPage page, CancellationToken ct) =>
        SessionProbe.OnPageAsync(
            page,
            url => url.Contains(_options.LoginHost, StringComparison.OrdinalIgnoreCase),
            _ => Task.FromResult(BkrSignedInWatcher.SignedIn(page.Url, _options)),
            TimeSpan.FromSeconds(_options.SignedOutBounceSeconds),
            TimeSpan.FromMilliseconds(_options.SignedOutPollMs),
            _time,
            ct);

    // behind the page seam so the offline suite can drive all three tiers without a browser or account
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        var username = Optional(ctx, "username");
        var password = Optional(ctx, "password");
        var seed = ReadSeed(ctx);

        await page.GotoAsync(_options.PortalUrl, ct).ConfigureAwait(false);

        // already inside: nothing is asked; BKR demands a second factor every sync and a kept profile's portal cookie skips it
        // before Authenticating and any input read, so no attempt is spent that did not need spending
        if (await SessionProbe.AskAsync(ctx, (_, t) => PresenceAsync(page, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            ctx.Note(
                $"{ProviderId}: this browser was still signed in to the portal, so nothing was asked of you - " +
                "which on a register that demands a second factor every single sync is the whole reason for " +
                "keeping a profile");

            ctx.Progress(JobStep.Finalizing);

            return await SignedAsync(ctx, ct).ConfigureAwait(false);
        }

        ctx.Progress(JobStep.Authenticating);

        if (username is null || password is null)
        {
            return await LiveSignInAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }

        try
        {
            return await TypedSignInAsync(ctx, page, watcher, username, password, seed, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex)
            when (ex.Code is ErrorCode.ProviderChanged or ErrorCode.BlockedByProvider or ErrorCode.MfaFailed)
        {
            // the page moved, BKR refused, or a computed code was rejected (clock drift, mistyped seed, SMS after all):
            // hand over to the human
            return await LiveSignInAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }
    }

    private async Task<LoginResult> TypedSignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher,
        string username, string password, TotpSecret? seed, CancellationToken ct)
    {
        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("the e-mail box", _options.UsernameSelectors);
        }

        // BKR asks on two screens: the password box does not exist until the first button is clicked (confirmed live)
        // probed, not assumed, so a layout change needs no release; short because on the real page it always misses
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.ProbeMs, ct).ConfigureAwait(false))
        {
            // latched first: advancing submits the e-mail, and a lease lost after would requeue a sign-in that reached BKR
            // a retried sign-in locks accounts
            ctx.CredentialSubmitted();

            if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("the 'Start inzage' button", _options.SubmitSelectors);
            }

            if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing(
                    "the password box, on either the first or the second screen", _options.PasswordSelectors);
            }
        }

        // idempotent: the two-screen path may have latched already
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("the sign-in button", _options.SubmitSelectors);
        }

        // no seed: the code is asked for, not streamed; streaming a browser to type six digits is worse
        var code = seed is null
            ? await AskForCodeAsync(ctx, ct).ConfigureAwait(false)
            : seed.Now(_time);

        if (!await page.FillAsync(_options.CodeSelectors, code, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("the code box", _options.CodeSelectors);
        }

        if (!await page.ClickAsync(_options.CodeSubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("the code's submit button", _options.CodeSubmitSelectors);
        }

        ctx.Progress(JobStep.Finalizing);

        var landed = await watcher.WaitAsync(TimeSpan.FromSeconds(_options.SignInSeconds), ct).ConfigureAwait(false);

        if (landed is null)
        {
            // never "wrong password": a refused code and a refused password look identical
            // the caller turns this into a streamed hand-over
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{ProviderId}: the sign-in did not reach the portal after the code was submitted");
        }

        return await SignedAsync(ctx, ct).ConfigureAwait(false);
    }

    private async Task<LoginResult> LiveSignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        // the redactor refuses to photograph a page while a secret field has content: clear it whatever route arrived
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.CredentialSubmitted();
        ctx.Progress(JobStep.AwaitingHuman);

        using var view = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.LiveView,
            PromptKey = MessageKeys.LiveLogin,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds),
        }, view.Token);

        var poll = TimeSpan.FromSeconds(_options.SettlePollSeconds);
        var deadline = _time.GetUtcNow().AddSeconds(_options.LiveLoginSeconds);

        try
        {
            while (_time.GetUtcNow() < deadline)
            {
                ct.ThrowIfCancellationRequested();

                if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null)
                {
                    ctx.Progress(JobStep.Finalizing);
                    return await SignedAsync(ctx, ct).ConfigureAwait(false);
                }

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                $"{ProviderId}: the live sign-in ended without reaching the portal");
        }
        finally
        {
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    private async Task<string> AskForCodeAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = MessageKeys.BkrCode,
            Length = Totp.DefaultDigits,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.CodeChallengeSeconds),
        }, ct).ConfigureAwait(false);

        var code = answer.Value?.Trim();

        return string.IsNullOrWhiteSpace(code)
            ? throw new ConnectorException(ErrorCode.MfaFailed, $"{ProviderId}: no code was given")
            : code;
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, CreditsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        ctx.Progress(JobStep.Downloading);

        // one page: the print block carries every credit's full detail, so no detail page per credit
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        await page.GotoAsync(_options.PortalUrl, new() { Timeout = _options.SelectorTimeoutMs }).ConfigureAwait(false);

        var html = await page.ContentAsync().ConfigureAwait(false);

        ctx.Progress(JobStep.Parsing);

        var credits = Credits(page.Url, html, ctx.SessionId);

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Registrations = credits,
            Complete = true,
            Via = "portal",

            // scraped from a page: the kit's rule is an empty raw, not an invented shape
            Raw = new Dictionary<string, string>(StringComparer.Ordinal),
        };
    }

    // the cookie jar IS the session and must travel: a login returning only a device id looked connected,
    // then every fetch opened a cookieless browser
    // a dead session and a rebuilt portal both arrive as "no print block"; only the URL tells them apart
    internal IReadOnlyList<CreditRegistration> Credits(string? url, string? html, string sessionId)
    {
        // checked before the parser: a signed-out visitor is bounced to B2C,
        // and "provider changed" would send them to wait, not sign in
        if (url is not null && url.Contains(_options.LoginHost, StringComparison.OrdinalIgnoreCase))
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: the portal sent us back to the sign-in page, so the stored session is over. " +
                "BKR issues no refresh token, so this needs a new sign-in.");
        }

        return BkrCreditParser.Parse(html, _options, sessionId);
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
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            ExpiresAt = _time.GetUtcNow().AddSeconds(BkrManifest.SessionTtlSeconds),
        };
    }

    /// an unreadable seed is a refusal, not a silent fall back to asking
    private static TotpSecret? ReadSeed(IJobContext ctx)
    {
        var raw = Optional(ctx, "totp");
        return raw is null ? null : TotpSecretReader.Read(raw);
    }

    private static string? Optional(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for {what}; tried [{string.Join(", ", selectors)}]");
}
