using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.LidlPlus;

/// Lidl Plus (T2): a browser drives the OAuth login once; the refresh token then serves every fetch over plain HTTP.
public sealed class LidlPlusAdapter : IProviderAdapter
{
    public const string ProviderId = "lidl";
    public const string ReceiptsResource = "receipts";

    private const string CountryKey = "country";
    private const string LanguageKey = "language";

    private static readonly ProviderManifest Manifest = LidlPlusManifest.Build();

    private readonly LidlPlusOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public LidlPlusAdapter(LidlPlusOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new LidlPlusOptions();
        _time = time ?? TimeProvider.System;

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

        // reCAPTCHA Enterprise scores the browser, so headless Chromium fails; the user's own browser needs a native shell
        // to catch com.lidlplus.app://. Streaming to a real person passes the scoring and the redirect lands here.
        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        // attach before anything is typed: Lidl ends by redirecting to a scheme Chromium cannot open, so no page load to await
        using var watcher = new RedirectWatcher(page, _options.RedirectUri, _time);

        return await LoginAsync(ctx, new PlaywrightLoginPage(page, Manifest), watcher, ct).ConfigureAwait(false);
    }

    /// internal so the offline suite can drive it without a live Chromium and real credentials (spendable once)
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var settings = LidlSettings.From(ctx.Config, ctx.Material);

        var username = OptionalInput(ctx, "username");
        var password = OptionalInput(ctx, "password");

        // challenge goes out in the authorize URL, verifier in the later exchange: one object so the verifier is not forgotten
        var pkce = PkceChallenge.Create();

        // kept: the failure path re-opens it, so nobody is handed a page with Lidl's error box
        var authorizeUrl = AuthorizeUrl(pkce, settings);

        await page.GotoAsync(authorizeUrl, ct).ConfigureAwait(false);

        var redirect = await ReachRedirectAsync(ctx, page, watcher, username, password, authorizeUrl, ct)
            .ConfigureAwait(false);

        var code = AuthorizationCode(redirect);
        var tokens = await ExchangeAsync(ctx, code, pkce.Verifier, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        return new LoginResult
        {
            Material = new SessionMaterial
            {
                AccessToken = tokens.AccessToken,
                RefreshToken = tokens.RefreshToken,
                AccessTokenExpiresAt = tokens.ExpiresAt,
                // also in Extra: every ticket URL and header needs them, and a fetch can arrive without config
                Extra = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [CountryKey] = settings.Country,
                    [LanguageKey] = settings.Language,
                },
            },
            Account = new ProviderAccount { DisplayName = Manifest.Name },
        };
    }


    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"lidl: no resource '{request.ResourceId}'");
        }

        var settings = LidlSettings.From(ctx.Config, ctx.Material);
        var zone = RetailZones.For(settings.Country);
        var session = new BearerSession(ctx.Material, ProviderId, _time);

        ctx.Progress(JobStep.Downloading);

        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;
        var (summaries, walked) = await ListAsync(ctx, session, settings, zone, request, cap, ct)
            .ConfigureAwait(false);

        // both limits count: partial when more rows exist than the cap, or when the walk ran out of pages before history
        var complete = walked && summaries.Count <= cap;
        var selected = complete ? summaries : summaries.Take(cap).ToList();

        ctx.Progress(JobStep.Parsing);

        // a paginating list repeats rows, and a detail call is the expensive part
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var receipts = new List<Receipt>(selected.Count);

        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var summary in selected)
        {
            ct.ThrowIfCancellationRequested();
            if (!seen.Add(summary.Id)) continue;

            var (receipt, document) = await ReceiptAsync(ctx, session, settings, zone, summary, request, ct)
                .ConfigureAwait(false);

            receipts.Add(receipt);
            if (document is not null) raw[summary.Id] = document;
        }

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Receipts = receipts,
            RefreshedMaterial = session.RefreshedMaterial(ctx.Material),
            Complete = complete,
            Via = "tickets-v2",
            Raw = raw,
        };
    }

    private async Task<(Receipt Receipt, string? Raw)> ReceiptAsync(
        IJobContext ctx, BearerSession session, LidlSettings settings, TimeZoneInfo zone,
        LidlTicketSummary summary, ResourceRequest request, CancellationToken ct)
    {
        IReadOnlyList<ReceiptItem> items = [];
        var payment = ReceiptFactory.Payment();
        var total = summary.Total;
        var storeName = summary.StoreName;
        var purchasedAt = summary.PurchasedAt;
        string? raw = null;

        // raw IS the detail document: include=raw alone must fetch it too
        if (request.WantsItems || request.WantsRaw)
        {
            using var detail = await DetailAsync(ctx, session, settings, summary.Id, ct).ConfigureAwait(false);
            var root = detail.RootElement;

            if (request.WantsRaw) raw = root.GetRawText();

            // a raw-only request changes nothing else: rewriting from the detail would give one purchase a different total and hash
            if (request.WantsItems)
            {
                // a v3 detail is "ticketType": "HTML" with no line-item collection (confirmed 2026-08-04); lines are in htmlPrintedReceipt
                var printed = JsonAccess.StrOf(root, "htmlPrintedReceipt");

                items = LidlPrintedReceipt.Items(printed, _options, total.Currency);
                payment = LidlPrintedReceipt.Payment(printed, _options);

                total = MoneyReader.Optional(root, _options.AmountUnit, total.Currency,
                    "ticket.detail.total", "totalAmount", "total") ?? total;

                storeName = StoreName(root) ?? storeName;

                // the detail's timestamp is the one to trust: it agrees with the till's card line, the list's is two hours late
                // a wall clock with no offset, so it is read in the store's country zone
                if (JsonAccess.StrOf(root, "date") is { Length: > 0 } stamped)
                {
                    purchasedAt = ReceiptTime.Parse(stamped, zone, ProviderId, "ticket.detail.date");
                }
            }
        }

        return (ReceiptFactory.Build(
            ctx.SessionId,
            summary.Id,
            LidlPlusTicketParser.Merchant(storeName),
            purchasedAt,
            total,
            payment,
            items), raw);
    }

    /// OBSERVED 2026-07-28: Country and language are required, else accounts.lidl.com redirects to /error?id=…
    /// Country is capitalised and bare ("NL"), language a lower-case full locale ("nl-NL"); "nl" is another /error redirect.
    internal string AuthorizeUrl(PkceChallenge pkce, LidlSettings settings)
    {
        ArgumentNullException.ThrowIfNull(pkce);
        ArgumentNullException.ThrowIfNull(settings);

        return UrlBuilder.WithQuery(_options.AuthorizeUrl,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["client_id"] = _options.ClientId,
                ["response_type"] = "code",
                ["redirect_uri"] = _options.RedirectUri,
                ["scope"] = _options.Scope,
                ["Country"] = settings.Country,
                ["language"] = LidlSettings.Locale(settings),
                // RFC 7636: the server refuses to exchange the code without the matching verifier
                ["code_challenge"] = pkce.Challenge,
                ["code_challenge_method"] = PkceChallenge.Method,
            });
    }

    /// the manifest's pattern admits two shapes and only the e-mail has an '@', so this cannot disagree with its validation
    internal static bool LooksLikeEmail(string username) =>
        username.Contains('@', StringComparison.Ordinal);

    /// absence is an answer, not an error: it means "stream the page from the start"
    private static string? OptionalInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");

    /// The wall is checked BEFORE the password is typed: the redactor refuses to photograph a page holding a secret field.
    /// reCAPTCHA Enterprise is not relayable (it scores the rendering browser): streaming relays the browser itself.
    private async Task<string> ReachRedirectAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher,
        string? username, string? password, string authorizeUrl, CancellationToken ct)
    {
        ctx.Progress(JobStep.Authenticating);

        if (username is null || password is null)
        {
            return await LiveRedirectAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }

        var identified = await FillUsernameAsync(page, username, ct).ConfigureAwait(false);

        // interactive only: a picture captcha is relayable through the gate below; a widget that scores the browser is not
        var walled = (await _captcha.DetectAsync(page, ct).ConfigureAwait(false)).Kind
            is CaptchaKind.Interactive;

        if (!identified || walled)
        {
            return await LiveRedirectAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }

        try
        {
            return await SignInAsync(ctx, page, watcher, username, password, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex)
            when (ex.Code is ErrorCode.BlockedByProvider or ErrorCode.ProviderChanged)
        {
            // the scoring verdict bounces to the identifier screen with a generic notice, like changed markup: both go to the person
            // reloaded first, on this path only: no red failure box is handed over; the wall path keeps the typed username
            await page.GotoAsync(authorizeUrl, ct).ConfigureAwait(false);

            return await LiveRedirectAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }
    }

    private async Task<string> LiveRedirectAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        // the page must hold no secret before it is photographed: the failure path may have typed a password
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        // the account is touched from here: a requeued login is how an account gets locked
        ctx.CredentialSubmitted();

        ctx.Progress(JobStep.AwaitingHuman);

        // the live-view answer is the empty passive one and the redirect ends the wait; linked so the ask can be ENDED,
        // which stops the shutter and releases the browser
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

                if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is { } captured)
                {
                    ctx.Progress(JobStep.Finalizing);
                    return captured;
                }

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                $"{ProviderId}: the live login ended without reaching '{_options.RedirectUri}'; " +
                "the sign-in was not completed");
        }
        finally
        {
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    /// the '@' decides the box, never the other on a miss: typing an address into the phone input spends a real attempt
    private async Task<bool> FillUsernameAsync(ILoginPage page, string username, CancellationToken ct)
    {
        var selectors = LooksLikeEmail(username) ? _options.EmailSelectors : _options.PhoneSelectors;

        return await page.FillAsync(selectors, username, _options.SelectorTimeoutMs, ct).ConfigureAwait(false);
    }

    private async Task<string> SignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher,
        string username, string password, CancellationToken ct)
    {
        ctx.Progress(JobStep.Authenticating);

        var email = LooksLikeEmail(username);
        var selectors = email ? _options.EmailSelectors : _options.PhoneSelectors;
        var what = email ? "e-mail field" : "phone field";

        // never the other box on a miss: it spends a real attempt, and a failed login is never retried here
        if (!await page.FillAsync(selectors, username, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing(what, selectors);
        }

        // Lidl may ask on two screens (identifier, Next, password): a live attempt died on "no element for the password field"
        // probed briefly: a single-page form still works and a layout change needs no release; the two-step page always misses
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            // advancing submits the identifier: latch first, or a lease lost here requeues a login that already reached Lidl
            ctx.CredentialSubmitted();

            if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
            {
                throw Missing("identifier submit", _options.SubmitSelectors);
            }

            if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("password field, on either the first or the second step", _options.PasswordSelectors);
            }
        }

        // latch before the credentials leave: a lost lease then fails the job, since a retried login locks the account
        ctx.CredentialSubmitted();

        // the password screen has its own button; the identifier step's "Volgende" would submit the wrong form
        if (!await page.ClickAsync(_options.PasswordSubmitSelectors, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("password submit", _options.PasswordSubmitSelectors);
        }

        var field = await page.FindAsync(_options.VerificationCodeSelectors, _options.SelectorTimeoutMs, ct)
            .ConfigureAwait(false);

        if (field is null)
        {
            // checked first because it is already decided: waiting on the redirect would burn the whole timeout and report wrongly
            if (await page.FindAsync(_options.BlockedNoticeSelectors, _options.ProbeMs, ct)
                    .ConfigureAwait(false) is not null)
            {
                throw ConnectorException.Blocked(
                    "lidl: the login was refused and returned to the identifier screen with a generic notice. " +
                    "The page carries reCAPTCHA Enterprise, so this is most likely a score-based verdict on an " +
                    "automated browser rather than anything about the account - the same credentials sign in by " +
                    "hand. An agent attached to a real browser profile is the route that can pass it.");
            }

            // no code box: Lidl skips the step on a trusted device (redirect on its way) or something blocks the form.
            // probing for a wall only here keeps the happy path cheap
            if (await FaceCaptchaAsync(ctx, page, watcher, ct).ConfigureAwait(false) is { } finished)
            {
                return finished;
            }
        }
        else
        {
            await SubmitCodeAsync(ctx, page, email, ct).ConfigureAwait(false);
        }

        return await AwaitRedirectAsync(page, watcher, ct).ConfigureAwait(false);
    }

    /// never solves anything: the code is on the account owner's phone or in their mailbox
    private async Task SubmitCodeAsync(IJobContext ctx, ILoginPage page, bool email, CancellationToken ct)
    {
        var delivery = await DeliveryAsync(page, email, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = MessageKeys.VerificationCode,
            Delivery = delivery,
            Length = _options.CodeLength,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.CodeChallengeSeconds),
        }, ct).ConfigureAwait(false);

        if (!await page.FillAsync(_options.VerificationCodeSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("verification code field", _options.VerificationCodeSelectors);
        }

        ctx.Progress(JobStep.Authenticating);

        if (!await page.ClickAsync(_options.VerificationSubmitSelectors, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            // some code forms submit on the last keystroke and have no button: the Enter covers them
            await page.AnswerAsync(_options.VerificationCodeSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false);
        }
    }

    /// decided per login: a fixed "sms" sent e-mail users to watch a phone while the challenge expired
    private async Task<string> DeliveryAsync(ILoginPage page, bool email, CancellationToken ct)
    {
        // the page's own word beats the inference (a phone user can get the code by mail); markers unconfirmed, so override only
        if (await page.FindAsync(_options.EmailDeliverySelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            return "email";
        }

        if (await page.FindAsync(_options.SmsDeliverySelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            return "sms";
        }

        return email ? "email" : "sms";
    }

    /// Albert Heijn's page turned out to be fronted by a widget, so the same policy applies: a picture is relayed,
    /// a widget goes to whoever is at the browser, an unattended agent fails at once.
    private async Task<string?> FaceCaptchaAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is { } finished) return finished;

        if (!outcome.Handled)
        {
            throw ConnectorException.Blocked($"{ProviderId}: a captcha stood between the login and its redirect");
        }

        return null;
    }

    private async Task<string> AwaitRedirectAsync(ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow().AddSeconds(_options.RedirectTimeoutSeconds);
        var poll = TimeSpan.FromSeconds(_options.RedirectPollSeconds);

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is { } captured) return captured;
            if (_time.GetUtcNow() >= deadline) break;
        }

        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: the login never redirected to '{_options.RedirectUri}'; last url was '{page.Url}'");
    }

    private static string AuthorizationCode(string redirectUrl)
    {
        var query = new Uri(redirectUrl).Query;
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0) continue;
            if (!pair.AsSpan(0, separator).Equals("code", StringComparison.Ordinal)) continue;

            return Uri.UnescapeDataString(pair[(separator + 1)..]);
        }

        throw ConnectorException.ProviderChanged("lidl: the callback carried no authorization code");
    }

    private Task<TokenSet> ExchangeAsync(IJobContext ctx, string code, string verifier, CancellationToken ct) =>
        PostTokenAsync(ctx, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = _options.RedirectUri,
            ["code_verifier"] = verifier,
        }, "token exchange", ct);

    private Task<TokenSet> RefreshAsync(IJobContext ctx, string refreshToken, CancellationToken ct) =>
        PostTokenAsync(ctx, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
        }, "token refresh", ct);

    private async Task<TokenSet> PostTokenAsync(
        IJobContext ctx, Dictionary<string, string> form, string what, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _options.TokenUrl)
        {
            Content = new FormUrlEncodedContent(form),
        };

        // "LidlPlusNativeClient:secret" confirmed from the reference; an empty secret is a different client to the token endpoint
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_options.ClientId}:{_options.ClientSecret}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", basic);

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        if (response.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.BadRequest)
        {
            throw ConnectorException.SessionExpired($"lidl: {what} rejected ({(int)response.StatusCode})");
        }

        ProviderHttp.EnsureSuccess(response, ProviderId, what);

        using var document = await ProviderHttp.ReadJsonAsync(response, ProviderId, what, ct).ConfigureAwait(false);
        return TokenSet.Parse(document.RootElement, ProviderId, _time);
    }

    /// THE PAGE BUDGET IS THIS CONNECTOR'S LIMIT, NOT LIDL'S HISTORY: stopping at MaxPages must not be reported complete.
    private async Task<(List<LidlTicketSummary> Rows, bool Complete)> ListAsync(
        IJobContext ctx, BearerSession session, LidlSettings settings, TimeZoneInfo zone,
        ResourceRequest request, int cap, CancellationToken ct)
    {
        var collected = new List<LidlTicketSummary>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // assumed spent until something ends the walk on its own terms: the safe default says less than it knows
        var spent = true;

        for (var page = 1; page <= _options.MaxPages; page++)
        {
            ct.ThrowIfCancellationRequested();

            var url = _options.TicketsBaseUrl.TrimEnd('/') + _options.TicketListPathTemplate
                .Replace("{country}", settings.Country, StringComparison.Ordinal)
                .Replace("{page}", page.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

            using var response = await session.SendAsync(ctx.Http,
                token => Request(HttpMethod.Get, url, token, settings),
                (refresh, token) => RefreshAsync(ctx, refresh, token), "ticket list", ct).ConfigureAwait(false);

            ProviderHttp.EnsureSuccess(response, ProviderId, "ticket list", RetailHttp.RetailBlockStatuses);

            using var document = await ProviderHttp
                .ReadJsonAsync(response, ProviderId, "ticket list", ct).ConfigureAwait(false);

            var rows = LidlPlusTicketParser.ParseList(document.RootElement, _options, zone);
            if (rows.Count == 0) { spent = false; break; }

            // a repeated page means pageNumber advances nothing upstream; carrying on repeats one request against a defended endpoint
            var fresh = rows.Where(r => seen.Add(r.Id)).ToList();
            if (fresh.Count == 0) { spent = false; break; }

            collected.AddRange(fresh.Where(r => ReceiptFactory.InWindow(r.PurchasedAt, request)));
            ctx.Found(collected.Count);

            // the list runs newest first: a page entirely older than the window means every later one is too
            if (request.Since is { } since && rows.All(r => DateOnly.FromDateTime(r.PurchasedAt.Date) < since))
            {
                spent = false;
                break;
            }

            // one page beyond the cap proves the pass partial; the caller reports truncation off the cap itself
            if (collected.Count > cap) { spent = false; break; }
        }

        // running out of pages looks like an ordinary result downstream: an incremental sync would keep an unseen gap
        if (spent)
        {
            ctx.Note(
                $"{ProviderId}: stopped after {_options.MaxPages} pages of the ticket list, which is this "
                + "connector's own limit and not the end of your history - anything older than that is not "
                + "in this pass");
        }

        return ([.. collected.OrderByDescending(r => r.PurchasedAt)], !spent);
    }

    /// CONFIRMED: store is an object with id ("NL0263") and name ("Delft"); read as a string it gave the branch code.
    private static string? StoreName(JsonElement detail)
    {
        if (JsonAccess.TryProp(detail, out var store, "store")
            && store.ValueKind == JsonValueKind.Object
            && JsonAccess.StrOf(store, "name") is { Length: > 0 } named)
        {
            return named;
        }

        return JsonAccess.StrOf(detail, "storeName", "storeCode");
    }

    private async Task<JsonDocument> DetailAsync(
        IJobContext ctx, BearerSession session, LidlSettings settings, string ticketId, CancellationToken ct)
    {
        var url = _options.TicketsBaseUrl.TrimEnd('/') + _options.TicketDetailPathTemplate
            .Replace("{country}", settings.Country, StringComparison.Ordinal)
            .Replace("{id}", Uri.EscapeDataString(ticketId), StringComparison.Ordinal);

        using var response = await session.SendAsync(ctx.Http,
            token => Request(HttpMethod.Get, url, token, settings),
            (refresh, token) => RefreshAsync(ctx, refresh, token), "ticket detail", ct).ConfigureAwait(false);

        ProviderHttp.EnsureSuccess(response, ProviderId, "ticket detail", RetailHttp.RetailBlockStatuses);

        return await ProviderHttp.ReadJsonAsync(response, ProviderId, "ticket detail", ct).ConfigureAwait(false);
    }

    /// sent because the ticket API routes on them, not to disguise anything
    private HttpRequestMessage Request(HttpMethod method, string url, string accessToken, LidlSettings settings)
    {
        var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("App-Version", _options.AppVersionHeader);
        request.Headers.TryAddWithoutValidation("Operating-System", _options.OperatingSystemHeader);
        request.Headers.TryAddWithoutValidation("App", _options.AppHeader);
        request.Headers.TryAddWithoutValidation("Accept-Language", settings.Language);
        request.Headers.TryAddWithoutValidation("Country", settings.Country);
        return request;
    }
}

internal sealed record LidlSettings(string Country, string Language)
{
    /// authorize wants a full locale ("nl-NL"); the bare language used by headers and ticket URLs is an /error redirect there
    public static string Locale(LidlSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return $"{settings.Language}-{settings.Country}";
    }

    public static LidlSettings From(IReadOnlyDictionary<string, string> config, SessionMaterial? material)
    {
        var country = Pick(config, material, "country");
        var language = Pick(config, material, "language");

        if (!LidlPlusManifest.Countries.Contains(country, StringComparer.Ordinal))
        {
            throw ConnectorException.InvalidRequest($"lidl: country '{country}' is not one of the supported values");
        }

        if (!LidlPlusManifest.Languages.Contains(language, StringComparer.Ordinal))
        {
            throw ConnectorException.InvalidRequest($"lidl: language '{language}' is not one of the supported values");
        }

        return new LidlSettings(country, language);
    }

    private static string Pick(IReadOnlyDictionary<string, string> config, SessionMaterial? material, string key)
    {
        if (config.TryGetValue(key, out var fromConfig) && !string.IsNullOrWhiteSpace(fromConfig))
        {
            return Normalize(key, fromConfig);
        }

        if (material?.Extra.TryGetValue(key, out var fromMaterial) == true && !string.IsNullOrWhiteSpace(fromMaterial))
        {
            return Normalize(key, fromMaterial);
        }

        throw ConnectorException.InvalidRequest($"lidl: config '{key}' is required");
    }

    /// Lidl is case-sensitive about both, verbatim in URLs and headers: country uppercase, language lowercase
    private static string Normalize(string key, string value) => key == "country"
        ? value.Trim().ToUpperInvariant()
        : value.Trim().ToLowerInvariant();
}
