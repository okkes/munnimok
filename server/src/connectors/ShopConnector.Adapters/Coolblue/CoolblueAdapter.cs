using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Coolblue;

/// Coolblue's standard OIDC flow must NOT be driven here: its callback has no verifier for a flow it never started,
/// so www.coolblue.nl stays anonymous. The login uses the protected page. The session is a COOKIE: no consumer order
/// API exists, the list states no money, so every receipt costs a ~600KB page load. No token is obtained or sealed.
public sealed class CoolblueAdapter : IProviderAdapter
{
    public const string ProviderId = "coolblue";
    public const string ReceiptsResource = "receipts";

    /// Statuses meaning Coolblue refuses us. 429 is here, unlike the shared default (rate_limited): CloudFront's WAF rate
    /// rule answers it without Retry-After. Never invalid_credentials: that sends the user to reset a fine password.
    internal static readonly IReadOnlySet<int> BlockStatuses = new HashSet<int> { 403, 429, 502, 504 };

    private static readonly ProviderManifest Manifest = CoolblueManifest.Build();

    private readonly CoolblueOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public CoolblueAdapter(CoolblueOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new CoolblueOptions();
        _time = time ?? TimeProvider.System;

        // policy shared with Albert Heijn and Lidl; no wall seen on this form, the gate names one in a poll instead of waiting
        // out the job budget
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

        // checked before a browser is leased: launching Chromium to find a blank field holds an agent for nothing; the seam
        // below checks again for the offline suite
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var driver = new PlaywrightLoginPage(page, Manifest);

        return await LoginAsync(ctx, driver, new CoolblueSessionWatcher(driver, _options, _time), ct)
            .ConfigureAwait(false);
    }

    /// Internal so the offline suite can drive it: the state check and credential latch are unreachable without live Chromium.
    /// Starts at the protected page (307 to /inloggen) and lets Coolblue run its own OIDC: our own authorize request left
    /// www.coolblue.nl anonymous, and its token exchange was refused 403 for a token nothing sends. No HTTP request here.
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // the protected page, not a login form: Coolblue's own 307 and callback are the only journey that ends with a session
        // on the shop's host
        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);

        // already inside: nothing is typed. A kept profile lands on the overview, and a sign-in would type into a missing form.
        // Before the consent click and the latch: nothing above has reached Coolblue with a credential, so requeue is still safe.
        if (await SessionProbe.AskAsync(ctx, (_, t) => PresenceAsync(page, t), ct)
                .ConfigureAwait(false) is SessionPresence.SignedIn)
        {
            ctx.Note(
                $"{ProviderId}: this browser was still signed in to Coolblue, so nothing was asked of you - " +
                "which is the whole reason for keeping a profile on your own machine");

            ctx.Progress(JobStep.Finalizing);

            return Sealed(await SessionAsync(ctx, ct).ConfigureAwait(false));
        }

        await SignInAsync(ctx, page, watcher, username, password, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        // only after SignInAsync proved the page needs a session: Coolblue gives Coolblue-Session to anonymous visitors too
        return Sealed(await SessionAsync(ctx, ct).ConfigureAwait(false));
    }

    /// One method for both ways in (driven sign-in, already inside): two copies could seal subtly different sessions.
    private static LoginResult Sealed(string storage) => new()
    {
        Material = new SessionMaterial { StorageState = storage },
        // named for the brand: the OIDC userinfo name needs a bearer token this login no longer obtains, and the account page
        // costs a 600KB request
        Account = new ProviderAccount { DisplayName = Manifest.Name },
        // deliberately unset: nothing states the session cookie's lifetime; the manifest carries a conservative guess
    };

    /// Navigates, unlike PresenceAsync: the answer is the address the shop leaves the browser on, and a browser that has
    /// been nowhere is on neither.
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var browser = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browser, Manifest);

        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);

        return await PresenceAsync(page, ct).ConfigureAwait(false);
    }

    /// The ADDRESS is the only witness: a signed-out request gets Coolblue-Session, cbvid and _csrfSecret (confirmed
    /// 2026-08-07), so a cookie check once sealed an anonymous session. The page gets SignedOutBounceSeconds to say NO,
    /// then CoolblueSessionWatcher.SignedIn confirms: one rule for "in".
    private Task<SessionPresence> PresenceAsync(ILoginPage page, CancellationToken ct) =>
        SessionProbe.OnPageAsync(
            page,
            url => url.Contains(_options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)
                   || url.Contains(_options.LoginPathMarker, StringComparison.OrdinalIgnoreCase),
            _ => Task.FromResult(CoolblueSessionWatcher.SignedIn(page.Url, _options)),
            TimeSpan.FromSeconds(_options.SignedOutBounceSeconds),
            TimeSpan.FromMilliseconds(_options.SessionPollMs),
            _time,
            ct);

    /// Forced by the provider: the overview is an index with no money (its one euro sign is in a translations blob), so a
    /// total exists only on the order's own 600KB+ page. The window bounds the cost, the record cap is the backstop.
    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        // before a single packet leaves: an undeclared money unit is this deployment's fault, and finding out after seventy
        // page loads wastes them
        _ = _options.TotalUnitOrThrow();

        // the cookie IS the credential and no refresh is possible during a fetch: a dead session needs a new login job
        // (session_expired)
        var cookies = CoolblueCookies.Header(ctx.Material?.StorageState, _options.CookieDomainSuffix)
                      ?? throw ConnectorException.SessionExpired(
                          $"{ProviderId}: the stored browser session carries no {_options.CookieDomainSuffix} " +
                          "cookies, so no fetch could carry a session");

        var cap = _options.RecordCap ?? Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;

        ctx.Progress(JobStep.Downloading);

        var (listings, walkWasComplete) = await WalkAsync(ctx, cookies, request, cap, ct).ConfigureAwait(false);

        var ordered = listings.OrderByDescending(l => l.PlacedAt).ToList();
        var complete = walkWasComplete;

        if (ordered.Count > cap)
        {
            ordered = [.. ordered.Take(cap)];
            complete = false;
        }

        var receipts = new List<Receipt>(ordered.Count);
        var unread = 0;

        foreach (var listing in ordered)
        {
            ct.ThrowIfCancellationRequested();

            var priced = await PricedAsync(ctx, cookies, listing, request.WantsItems, ct).ConfigureAwait(false);

            if (priced is not { } order)
            {
                // dropped, not emitted with an invented total; the pass reports partial so the caller comes back: a silent gap becomes
                // permanent
                unread++;
                complete = false;
                continue;
            }

            var documents = request.WantsInvoice
                ? await DocumentsAsync(ctx, cookies, listing, ct).ConfigureAwait(false)
                : [];

            ctx.Progress(JobStep.Normalizing);

            var receipt = ReceiptFactory.Build(
                ctx.SessionId,
                listing.Id,
                Merchant(listing.Title),
                listing.PlacedAt,
                order.Total,
                // Coolblue's details page names no payment method; fields stay null and stated so a consumer knows matching is weaker
                ReceiptFactory.Payment(),
                order.Items);

            // some orders itemise less than charged (399 of 463, reason unstated; another agrees exactly): a per-order fact, not a
            // parse failure. The derived line is deliberately not called a fee (amount known, reason not); the total stays
            // Coolblue's own, which is what a bank transaction matches.
            if (receipt.Items.Count > 0) receipt = receipt.WithUnattributedLine(CoolblueMessageKeys.Unattributed);

            receipts.Add(receipt with
            {
                // attached AFTER the factory, as bol does: the content hash must be the same with and without include=invoice, or
                // consumer dedupe breaks
                Documents = documents,
            });
        }

        if (unread > 0)
        {
            ctx.Note($"{unread} order(s) in the window could not be priced and are not in this pass; " +
                     "their details pages did not answer");
        }

        return new FetchResult
        {
            Receipts = receipts,
            Complete = complete,
            Via = request.WantsInvoice ? "orders-html+invoice-pdf" : "orders-html",
        };
    }

    /// StoreName carries the order's product headline ("Coolblue - Samsung koelkast" is recognisable, ten times "Coolblue"
    /// is not); null when the card names none.
    internal static Merchant Merchant(string? title) => new()
    {
        Id = ProviderId,
        Name = "Coolblue",
        StoreName = string.IsNullOrWhiteSpace(title) ? null : title,
    };

    /// Complete says whether the walk saw everything; getting it backwards tells a consumer it holds the whole history
    /// when it holds twenty pages.
    private async Task<(List<CoolblueListing> Listings, bool Complete)> WalkAsync(
        IJobContext ctx, string cookies, ResourceRequest request, int cap, CancellationToken ct)
    {
        var collected = new List<CoolblueListing>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        var budgetRanOut = true;

        for (var page = 1; page <= _options.MaxPages; page++)
        {
            ct.ThrowIfCancellationRequested();

            var body = await ReadPageAsync(
                ctx, cookies, OverviewUrl(page), $"orders page {page}", ct).ConfigureAwait(false);

            ctx.Progress(JobStep.Parsing);

            var listings = CoolblueHtmlOrders.ParseList(body, _options, RetailZones.Dutch);
            if (listings.Count == 0)
            {
                budgetRanOut = false;
                break;
            }

            var (fresh, older) = Tally(listings, seen, request, collected);
            ctx.Found(collected.Count);

            // a repeated page means Coolblue ignores the paging parameter; without this guard the same page is fetched twenty times
            if (fresh == 0)
            {
                budgetRanOut = false;
                break;
            }

            // newest first: a page entirely below the window means later ones are too, so a daily sync does not walk two years
            if (older == listings.Count)
            {
                budgetRanOut = false;
                break;
            }

            // one page past the cap proves the pass is partial; more would be real half-megabyte requests the caller discards
            if (collected.Count > cap)
            {
                budgetRanOut = false;
                break;
            }
        }

        return (collected, !budgetRanOut);
    }

    private static (int Fresh, int Older) Tally(
        IReadOnlyList<CoolblueListing> listings, HashSet<string> seen, ResourceRequest request,
        List<CoolblueListing> collected)
    {
        var fresh = 0;
        var older = 0;

        foreach (var listing in listings)
        {
            if (!seen.Add(listing.Id)) continue;
            fresh++;

            if (request.Since is { } since && DateOnly.FromDateTime(listing.PlacedAt.Date) < since) older++;
            if (ReceiptFactory.InWindow(listing.PlacedAt, request)) collected.Add(listing);
        }

        return (fresh, older);
    }

    /// Failures that repeat for every order (session over, a wall, the total's LABEL moved) are thrown: carrying on would
    /// spend sixty more requests and report a short history as complete. An order-specific failure becomes a note, a skipped
    /// receipt and Complete = false.
    private async Task<CoolblueOrder?> PricedAsync(
        IJobContext ctx, string cookies, CoolblueListing listing, bool wantsItems, CancellationToken ct)
    {
        var url = _options.OrderDetailsUrlTemplate.Replace(
            "{orderId}", Uri.EscapeDataString(listing.Id), StringComparison.Ordinal);

        string page;
        try
        {
            page = await ReadPageAsync(ctx, cookies, url, $"the page for order '{listing.Id}'", ct)
                .ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (ex.Code is not (ErrorCode.SessionExpired or ErrorCode.BlockedByProvider))
        {
            ctx.Note($"order '{listing.Id}': its page could not be read ({ex.Code}: {ex.Detail})");
            return null;
        }

        // proof the page is the order asked for: /bestellingen silently redirects to the account home, so Coolblue answers
        // wrong-but-plausible pages, and a wrong total puts one order's money on another's receipt
        if (!StatesOrderNumber(page, listing.Id))
        {
            ctx.Note($"order '{listing.Id}': the page that answered does not state that order number, " +
                     $"so no total was taken from it (looked for '{_options.OrderNumberLabel}')");
            return null;
        }

        return new CoolblueOrder(
            CoolblueHtmlOrders.ParseTotal(page, _options),
            // read off the same page: a second visit for the lines would double the most expensive thing here; no items asked,
            // none read (reconciles trivially)
            wantsItems
                ? [.. CoolblueHtmlOrders.ParseItems(page, _options).Select(
                    line => new ReceiptItem
                    {
                        Name = line.Name,
                        Total = line.Total,
                        Quantity = line.Quantity,
                        // never derived from total and count: wrong as soon as a line carries a bundle discount, and the page states none
                        UnitPrice = null,
                    })]
                : []);
    }

    private bool StatesOrderNumber(string page, string orderId)
    {
        var rendered = CoolblueHtmlOrders.Rendered(page);
        var at = rendered.IndexOf(_options.OrderNumberLabel, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return false;

        var from = at + _options.OrderNumberLabel.Length;
        var window = rendered[from..Math.Min(rendered.Length, from + 512)];

        return window.Contains(orderId, StringComparison.Ordinal);
    }

    private string OverviewUrl(int page) =>
        page <= 1
            ? _options.OrdersPageUrl
            : UrlBuilder.WithQuery(_options.OrdersPageUrl,
                new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    [_options.PageParam] = page.ToString(System.Globalization.CultureInfo.InvariantCulture),
                });

    /// The jar, once the browser PROVED it is signed in by standing on a page that needs a session. Here only a guard
    /// against sealing an empty bundle: anonymous visitors get a full jar too, and checking the jar instead of the URL
    /// sealed an anonymous session (2026-08-07).
    internal async Task<string> SessionAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        string? jar;
        try
        {
            jar = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            throw new ConnectorException(
                ErrorCode.ProviderChanged,
                $"{ProviderId}: the browser signed in but its session could not be read back", ex);
        }

        // same filter as the fetch, so "the login found a session" and "the fetch can send one" cannot differ
        if (CoolblueCookies.Header(jar, _options.CookieDomainSuffix) is not null) return jar!;

        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: the browser reached '{_options.SignedInUrlMarker}', which needs a session, and yet holds " +
            $"no {_options.CookieDomainSuffix} cookies to seal");
    }

    private async Task<string> SignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher,
        string username, string password, CancellationToken ct)
    {
        // Best effort: a consent wall left standing covers the form, and its
        // absence is the normal case on a fresh profile.
        _ = await page.ClickAsync(_options.ConsentSelectors, _options.ProbeMs, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("username field", _options.UsernameSelectors);
        }

        // two screens: the e-mail, then a password box revealed after a button (the first screen's one password input is a decoy).
        // Probed, not assumed: clicking "next" on a single-screen form submits the identifier alone and spends a login attempt,
        // so click only when there is no password box.
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            // advancing submits the e-mail, so the account is touched from here: latch first, or a lease lost before the next line
            // requeues a login that already reached Coolblue
            ctx.CredentialSubmitted();

            if (!await page.ClickAsync(_options.ContinueSelectors, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("continue button", _options.ContinueSelectors);
            }

            if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing(
                    "password field, on either the first or the second screen", _options.PasswordSelectors);
            }
        }

        // latch before the credentials leave the machine: after this a lost lease fails the job, as a retried login is how an
        // account gets locked
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("login submit", _options.SubmitSelectors);
        }

        return await SettleAsync(ctx, page, watcher, ct).ConfigureAwait(false);
    }

    /// "Signed in" means standing in the account area, not reaching the OIDC callback (a login that left the shop anonymous
    /// reached it, 2026-08-07). No recognised outcome is deliberately not invalid_credentials: never retried, and it sends
    /// the user to reset a fine password.
    internal async Task<string> SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        var deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
        var poll = TimeSpan.FromSeconds(_options.RedirectPollSeconds);
        var captchaSeen = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is { } captured) return captured;

            // the only path that may report invalid_credentials; nothing retries it
            if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
                is not null)
            {
                throw ConnectorException.InvalidCredentials(
                    $"{ProviderId}: the login page stated a credential error");
            }

            if (!captchaSeen && await FaceCaptchaAsync(ctx, page, watcher, ct).ConfigureAwait(false) is { } faced)
            {
                captchaSeen = true;
                if (faced.Redirect is { } finished) return finished;

                // the settle budget measures Coolblue's answer time, so it restarts once a wait on a human is over
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        throw Unsettled(page, captchaSeen);
    }

    /// A redirect on the outcome means the wall came down and the login is in; a wall the gate could hand to nobody ends
    /// the login here.
    private async Task<CaptchaOutcome?> FaceCaptchaAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null || outcome.Handled) return outcome;

        throw Unsettled(page, captchaSeen: true);
    }

    private ConnectorException Unsettled(ILoginPage page, bool captchaSeen) =>
        captchaSeen
            ? ConnectorException.Blocked(
                $"{ProviderId}: a captcha stood between the login and the account page. None has ever been observed " +
                "on this form, so this is new and worth capturing")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the login neither reached '{_options.SignedInUrlMarker}' nor stated an error; " +
                $"last url was '{page.Url}'");

    private async Task<string> ReadPageAsync(
        IJobContext ctx, string cookies, string url, string what, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        request.Headers.TryAddWithoutValidation("Cookie", cookies);
        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept-Language", _options.AcceptLanguage);
        request.Headers.TryAddWithoutValidation(
            "Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        // the body is kept on failure: an error body is the most useful thing a provider hands back
        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, BlockStatuses, ct).ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        Guard(body, what);
        return body;
    }

    /// The wall is checked first: mistaking it for a dead session starts a fresh login into the wall, spending a credential.
    private void Guard(string body, string what)
    {
        foreach (var marker in _options.BotWallMarkers)
        {
            if (!body.Contains(marker, StringComparison.OrdinalIgnoreCase)) continue;

            throw ConnectorException.Blocked(
                $"{ProviderId}: {what} answered 200 with an interstitial (matched '{marker}'). No bot management " +
                "was found anywhere on coolblue.nl when this adapter was written, so this is new and worth " +
                "telling an operator about - and it is not a credential problem");
        }

        foreach (var marker in _options.AccountPageLoginMarkers)
        {
            if (!body.Contains(marker, StringComparison.Ordinal)) continue;

            throw ConnectorException.SessionExpired(
                $"{ProviderId}: {what} answered with the sign-in form (matched '{marker}'); the stored session " +
                "is over and a fetch holds no credential, so a human has to sign in again");
        }
    }

    /// The cheapest documents here: /mijn-factuur/{orderId}/{invoiceId} sits on the list card, one request, no discovery.
    /// Failures are an absence and a note, never a throw. No ctx.Pacer ticket: ctx.Http already enters the per-provider
    /// SemaphoreSlim(1,1) gate, so a ticket around an HTTP call would DEADLOCK the job.
    private async Task<IReadOnlyList<ReceiptDocument>> DocumentsAsync(
        IJobContext ctx, string cookies, CoolblueListing listing, CancellationToken ct)
    {
        if (listing.Invoices.Count == 0) return [];

        var documents = new List<ReceiptDocument>(listing.Invoices.Count);

        foreach (var invoice in listing.Invoices.Take(_options.MaxDocumentsPerOrder))
        {
            ct.ThrowIfCancellationRequested();

            CoolblueDownload fetched;
            try
            {
                fetched = await DownloadAsync(ctx, cookies, invoice.Href, ct).ConfigureAwait(false);
            }
            catch (ConnectorException ex)
            {
                ctx.Note($"order '{listing.Id}': invoice '{invoice.InvoiceId}' could not be downloaded " +
                         $"({ex.Code}: {ex.Detail})");
                continue;
            }

            if (!IsDocument(fetched))
            {
                ctx.Note($"order '{listing.Id}': invoice '{invoice.InvoiceId}' answered {fetched.Status} " +
                         $"'{fetched.MediaType}' with {fetched.Bytes.Length} byte(s); not attached");
                continue;
            }

            documents.Add(new ReceiptDocument
            {
                Kind = ReceiptDocumentKinds.Invoice,
                MediaType = fetched.MediaType,
                // Coolblue's only per-link text is an action ("Factuur"), not the document's name: Name stays null
                Name = null,
                // the anchor's download attribute suggests exactly this id, so a saved file gets Coolblue's own filename
                Filename = $"coolblue-{listing.Id}-invoice-{invoice.InvoiceId}.pdf",
                SizeBytes = fetched.Bytes.Length,
                ContentBase64 = Convert.ToBase64String(fetched.Bytes),
            });
        }

        return documents;
    }

    /// The media type is the server's claim (read parameter-free, so a charset cannot reject a PDF); the magic number is the
    /// FILE's and catches an error page wearing a PDF type, as a session dying mid-fetch produces.
    private bool IsDocument(CoolblueDownload fetched) =>
        fetched.Status is 200
        && _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase)
        && fetched.Bytes.Length > _options.DocumentMagic.Count
        && fetched.Bytes.Take(_options.DocumentMagic.Count).SequenceEqual(_options.DocumentMagic);

    /// Bytes, never text: decoding and re-encoding a PDF corrupts it silently (a bol capture had 7000 replacement characters).
    /// No EnsureSuccess: a non-200 on a document is a note, not a failed fetch.
    private async Task<CoolblueDownload> DownloadAsync(
        IJobContext ctx, string cookies, string url, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        request.Headers.TryAddWithoutValidation("Cookie", cookies);
        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept-Language", _options.AcceptLanguage);
        request.Headers.TryAddWithoutValidation("Accept", "application/pdf,*/*");

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        var bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);

        // MediaTypeHeaderValue already split off any charset, which is why the raw header is never read
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;

        return new CoolblueDownload((int)response.StatusCode, mediaType, bytes);
    }

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"{ProviderId}: '{key}' is required");

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");

}

/// Success is a PLACE: the account area is unreachable without a session (signed-out gets 307 to /inloggen). Watching
/// the OIDC callback was wrong (reached, then the sign-in page rendered again, 2026-08-07); cookies prove nothing.
/// Wears IRedirectWaiter so the shared CaptchaGate is reused unchanged.
internal sealed class CoolblueSessionWatcher : IRedirectWaiter
{
    private readonly ILoginPage _page;
    private readonly CoolblueOptions _options;
    private readonly TimeProvider _time;

    public CoolblueSessionWatcher(ILoginPage page, CoolblueOptions options, TimeProvider time)
    {
        _page = page;
        _options = options;
        _time = time;
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        // counted, not clock-bounded: a frozen TimeProvider (every test) never reaches a clock deadline and the loop would spin
        // until the job budget ran out
        var interval = Math.Max(1, _options.SessionPollMs);
        var passes = Math.Max(1, (int)(timeout.TotalMilliseconds / interval));

        for (var pass = 0; pass < passes; pass++)
        {
            ct.ThrowIfCancellationRequested();

            if (SignedIn(_page.Url, _options)) return _page.Url;
            if (pass + 1 >= passes) break;

            await Task.Delay(TimeSpan.FromMilliseconds(interval), _time, ct).ConfigureAwait(false);
        }

        return null;
    }

    /// The login PATH clause is a guard: an unauthenticated visitor is sent to /inloggen?returnUrl=... naming the account
    /// area; live that URL is percent-encoded, hiding the marker from the first clause by accident. A relative one would not.
    internal static bool SignedIn(string? url, CoolblueOptions options)
    {
        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase);
    }
}
