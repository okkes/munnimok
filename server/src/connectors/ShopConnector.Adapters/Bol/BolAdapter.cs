using System.Net;
using System.Net.Http.Headers;
using Microsoft.Playwright;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

// consumer route = browser login + cookie jar; api.bol.com is a SELLER API (client_credentials, a merchant's
// orders, not the user's) and is never touched here
public sealed class BolAdapter : IProviderAdapter
{
    public const string ProviderId = "bol";
    public const string ReceiptsResource = "receipts";

    /// <summary>The header the stored jar goes out in; a learned header never takes its place.</summary>
    private const string CookieHeader = "Cookie";

    private static readonly ProviderManifest Manifest = BolManifest.Build();

    private readonly BolOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public BolAdapter(BolOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new BolOptions();
        _time = time ?? TimeProvider.System;

        // policy shared with Albert Heijn and Lidl Plus; only the selectors and the patience are bol's
        _captcha = new CaptchaGate(new CaptchaSpec
        {
            ProviderId = ProviderId,
            Interactive = _options.InteractiveCaptchaSelectors,
            Image = _options.ImageCaptchaSelectors,
            Input = _options.CaptchaInputSelectors,
            ProbeMs = _options.ProbeMs,
            ImageSeconds = _options.ChallengeSeconds,
            InteractiveSeconds = _options.InteractiveCaptchaSeconds,
            PollSeconds = _options.PollSeconds,
        }, _time);
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // validated before a browser is leased: launching Chromium to find a blank field holds an agent for nothing
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var browserPage = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browserPage, Manifest);

        // listened for from before the first navigation so an early request is not missed; the request is kept with the hash:
        // bol refused a fetch rebuilt around a learned hash (2026-10-07 prod), so the fetch replays the page's own body and headers
        var learned = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        IRequest? fired = null;
        void OnRequest(object? _, IRequest request)
        {
            if (!string.Equals(request.Method, "POST", StringComparison.OrdinalIgnoreCase)) return;
            if (!request.Url.Contains(_options.GraphQlUrl, StringComparison.OrdinalIgnoreCase)) return;
            if (!BolPersistedQuery.TryReadHash(request.PostData, _options.OrdersOperationName, out var hash)) return;

            fired ??= request;
            learned.TrySetResult(hash);
        }

        browserPage.Request += OnRequest;
        try
        {
            var result = await LoginAsync(ctx, page, new BolSessionWatcher(ctx, page, _options, _time), ct)
                .ConfigureAwait(false);

            return await SealAsync(ctx, page, result, learned.Task, token => ReplayAsync(fired, token), ct)
                .ConfigureAwait(false);
        }
        finally
        {
            browserPage.Request -= OnRequest;
        }
    }

    internal async Task<LoginResult> SealAsync(
        IJobContext ctx, ILoginPage page, LoginResult result, Task<string> learned,
        Func<CancellationToken, Task<BolPageRequest?>> capture, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(capture);

        var hash = await new BolHashProbe(_options).LearnAsync(ctx, page, learned, ct).ConfigureAwait(false);

        // the jar was sealed before the probe visited the overview, so cookies bol set there never reached a fetch (2026-10-07 prod)
        result = await ResealJarAsync(ctx, result, ct).ConfigureAwait(false);
        if (hash is null) return result;

        var request = await capture(ct).ConfigureAwait(false);
        ctx.Note(LearnedNote(hash, request));

        var material = BolPersistedQuery.WithHash(result.Material, hash);
        return result with { Material = BolPersistedQuery.WithRequest(material, request) };
    }

    // a fresh read without cookies for the orders host (a lease answers empty once its browser is gone) must not replace
    // the checked jar, and a failed read must not fail a sign-in that succeeded
    private async Task<LoginResult> ResealJarAsync(IJobContext ctx, LoginResult result, CancellationToken ct)
    {
        try
        {
            var fresh = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

            if (BolCookies.For(fresh, _options.OrdersHost).Count > 0)
            {
                return result with { Material = result.Material with { StorageState = fresh } };
            }

            ctx.Note($"{ProviderId}: the session read after the probe carries no cookies for '{_options.OrdersHost}'; " +
                     "the jar sealed at sign-in stands");
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException or InvalidOperationException or ConnectorException)
        {
            ctx.Note($"{ProviderId}: the session could not be read again after the probe ({ex.GetType().Name}); " +
                     "the jar sealed at sign-in stands");
        }

        return result;
    }

    private static string LearnedNote(string hash, BolPageRequest? request)
    {
        var learned = request is null
            ? "the page's own request could not be read, so a fetch rebuilds it"
            : $"the page's own request body and {request.Headers.Count} header(s) " +
              $"[{string.Join(", ", request.Headers.Keys.OrderBy(name => name, StringComparer.Ordinal))}] were learned with it";

        return $"{ProviderId}: the orders operation's persisted-query hash ({BolPersistedQuery.Prefix(hash)}) was learned " +
               $"from the page and sealed into the session; {learned}";
    }

    // AllHeadersAsync, not Headers: the sync view withholds security-related headers; bounded because a request the page
    // moved on from may never answer
    private async Task<BolPageRequest?> ReplayAsync(IRequest? fired, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (fired?.PostData is not { Length: > 0 } body) return null;

        IEnumerable<KeyValuePair<string, string>> headers = fired.Headers;
        try
        {
            var all = fired.AllHeadersAsync();
            if (await Task.WhenAny(all, Task.Delay(_options.HashProbeMs, ct)).ConfigureAwait(false) == all)
            {
                headers = await all.ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is PlaywrightException or TimeoutException)
        {
            // The provisional view stands; it carries what the page set itself.
        }

        return new BolPageRequest(body, BolPersistedQuery.CarryHeaders(headers));
    }

    // internal so the offline suite can drive it; a live login on this provider is spent once and never retried
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        try
        {
            return await SignInAsync(ctx, page, signedIn, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            throw PageRefusal(ex);
        }
    }

    private async Task<LoginResult> SignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // the protected page, not the login form: bol's own 302 chain to the form and back is the cleanest signal we are in
        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);
        await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            // the redirect chain did not end at a form: go straight to the form's address, one of the few confirmed things about bol
            await page.GotoAsync(_options.LoginFormUrl, ct).ConfigureAwait(false);
            await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

            if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("e-mail field, on either the account page's redirect or the login form itself",
                    _options.UsernameSelectors);
            }
        }

        // a classic single-screen Spring form: a miss is a real shape change, not a two-step wizard like Lidl's
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("password field", _options.PasswordSelectors);
        }

        // latch before the credentials leave: after this a lost lease fails the job instead of requeuing it, because a retried
        // login locks accounts and bol may already have sent a code
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("login submit", _options.SubmitSelectors);
        }

        await SettleAsync(ctx, page, signedIn, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        // orders need cookies scoped to www.bol.com, but JSESSIONID is set on login.bol.com: a login that left nothing usable failed
        if (BolCookies.For(storageState, _options.OrdersHost).Count == 0)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the login left no cookies scoped to '{_options.OrdersHost}', so no fetch could " +
                "carry a session; bol's session cookie may have moved host or been renamed " +
                $"(looking for any of [{string.Join(", ", _options.SessionCookieNames)}])");
        }

        return new LoginResult
        {
            Material = new SessionMaterial { StorageState = storageState },
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            // stated from this login so the consumer's countdown starts with the session; the TTL is a guess (BolManifest)
            ExpiresAt = _time.GetUtcNow().AddSeconds(BolManifest.SessionTtlSeconds),
        };
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        // no credential exists during a fetch: a dead cookie needs a new login job, which session_expired asks for
        var cookies = BolCookies.Header(ctx.Material?.StorageState, _options.OrdersHost)
                      ?? throw ConnectorException.SessionExpired(
                          $"{ProviderId}: the stored browser session carries no cookies for " +
                          $"'{_options.OrdersHost}'");

        // bol double-submits its CSRF token: the cookie value must be echoed in a header, else "403 XSRF failed"
        var xsrf = BolCookies.Value(ctx.Material?.StorageState, _options.OrdersHost, _options.XsrfCookieName);

        var shape = BolShapes.For(_options.OrdersShape);
        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;

        // the hash learned at sign-in beats the configured one (bol moves it with every front-end release), and the page's own
        // request rides with it: bol refused a request rebuilt around a hash its page had just sent (2026-10-07 prod)
        var learned = Learned(ctx.Material);
        var options = learned.Options;
        if (learned.Any) ctx.Note(FetchNote(learned));

        ctx.Progress(JobStep.Downloading);

        List<BolOrder> collected;
        bool walkWasComplete;
        try
        {
            (collected, walkWasComplete) = await WalkAsync(ctx, new BolCall(shape, options, cookies, xsrf), request, cap, ct)
                .ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (learned.Hash is null && IsRefusedOperation(ex))
        {
            // configured hash refused and none learned: ask for a new sign-in (it learns the current hash) instead of provider_changed.
            // a refused LEARNED hash is a change bol made since sign-in and stays provider_changed
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: bol refused the configured orders operation and this session learned no hash of its own; " +
                $"a new sign-in learns the one bol's page sends today ({ex.Detail})");
        }

        var ordered = collected.OrderByDescending(o => o.PlacedAt).ToList();
        var complete = walkWasComplete;

        if (ordered.Count > cap)
        {
            ordered = [.. ordered.Take(cap)];
            complete = false;
        }

        return await NormalizeAsync(ctx, request, shape, cookies, ordered, complete, ct).ConfigureAwait(false);
    }

    private static bool IsRefusedOperation(ConnectorException ex) =>
        ex.Code == ErrorCode.ProviderChanged && (ex.Detail ?? string.Empty).Contains(BolGraphQlShape.RefusedMarker, StringComparison.Ordinal);

    // a page step Playwright gave up on is bol's page misbehaving: provider_unavailable (retry), not internal, which paged
    // as unhandled exceptions (prod, GlitchTip #24-#28, #33-#34); a missing selector stays provider_changed
    private static ConnectorException PageRefusal(Exception ex) =>
        new(ErrorCode.ProviderUnavailable,
            $"{ProviderId}: the sign-in's page step did not complete ({ex.GetType().Name}: {FirstLine(ex.Message)}); " +
            "bol's page was slow or something covered it, and a retry may land",
            ex);

    private static string FirstLine(string message)
    {
        var end = message.IndexOfAny(['\r', '\n']);
        return (end < 0 ? message : message[..end]).Trim();
    }

    private sealed record BolCall(IBolOrdersShape Shape, BolOptions Options, string Cookies, string? Xsrf);

    private sealed record BolLearned(BolOptions Options, string? Hash, BolPageRequest? PageRequest)
    {
        public bool Any => Hash is not null || PageRequest is not null;
    }

    private BolLearned Learned(SessionMaterial? material)
    {
        var hash = BolPersistedQuery.Learned(material);
        var replay = BolPersistedQuery.LearnedRequest(material);

        var options = hash is null ? _options : _options with { OrdersPersistedQueryHash = hash };
        if (replay is not null)
        {
            options = options with { OrdersRequestTemplate = replay.Body, OrdersRequestHeaders = replay.Headers };
        }

        return new BolLearned(options, hash, replay);
    }

    private static string FetchNote(BolLearned learned)
    {
        var body = learned.PageRequest is null
            ? "rebuilding the request around it"
            : "replaying the page's own request body with its headers";

        return $"{ProviderId}: fetching with the persisted-query hash the sign-in learned ({BolPersistedQuery.Prefix(learned.Hash)}), {body}";
    }

    private async Task<(List<BolOrder> Orders, bool Complete)> WalkAsync(
        IJobContext ctx, BolCall call, ResourceRequest request, int cap, CancellationToken ct)
    {
        var shape = call.Shape;
        var zone = RetailZones.Dutch;
        var collected = new List<BolOrder>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // true while the walk ends on the page budget rather than the history: backwards, a consumer is told it has it all
        var budgetRanOut = true;

        for (var page = 1; page <= _options.MaxPages; page++)
        {
            ct.ThrowIfCancellationRequested();

            var body = await ReadPageAsync(ctx, call.Shape, call.Options, call.Cookies, call.Xsrf, page, ct).ConfigureAwait(false);

            ctx.Progress(JobStep.Parsing);

            // the call's options, not the adapter's: a refusal names the hash and body actually in use (the learned ones)
            var orders = shape.Parse(body, call.Options, zone, request.WantsRaw, ctx.Note);
            if (orders.Count == 0)
            {
                budgetRanOut = false;
                break;
            }

            var (fresh, older) = Tally(orders, seen, request, collected);
            ctx.Found(collected.Count);

            // a page repeating the previous one means the pagination parameter (a guess) is wrong; stops the same page fetched 20 times
            if (fresh == 0)
            {
                budgetRanOut = false;
                break;
            }

            // newest first: a page entirely below the window means every later page is too
            if (older == orders.Count)
            {
                budgetRanOut = false;
                break;
            }

            // one page past the cap proves the pass is partial; more is work the caller discards
            if (collected.Count > cap)
            {
                budgetRanOut = false;
                break;
            }
        }

        return (collected, !budgetRanOut);
    }

    private static (int Fresh, int Older) Tally(
        IReadOnlyList<BolOrder> orders, HashSet<string> seen, ResourceRequest request, List<BolOrder> collected)
    {
        var fresh = 0;
        var older = 0;

        foreach (var order in orders)
        {
            if (!seen.Add(order.Id)) continue;
            fresh++;

            if (request.Since is { } since && DateOnly.FromDateTime(order.PlacedAt.Date) < since) older++;
            if (ReceiptFactory.InWindow(order.PlacedAt, request)) collected.Add(order);
        }

        return (fresh, older);
    }

    private async Task<FetchResult> NormalizeAsync(
        IJobContext ctx, ResourceRequest request, IBolOrdersShape shape, string cookies,
        List<BolOrder> ordered, bool complete, CancellationToken ct)
    {
        ctx.Progress(JobStep.Normalizing);

        var receipts = new List<Receipt>(ordered.Count);

        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        // document orders are bounded: each costs a details page of over half a MB plus a download per invoice; orders past
        // the ceiling still become receipts without documents, and the run says so
        var documentBudget = request.WantsInvoice ? _options.MaxDocumentOrdersPerFetch : 0;
        var documentsSkipped = 0;

        foreach (var order in ordered)
        {
            if (order.Raw is { } document) raw[order.Id] = document;

            IReadOnlyList<ReceiptDocument> documents = [];
            if (request.WantsInvoice)
            {
                if (documentBudget > 0)
                {
                    documentBudget--;
                    documents = await DocumentsAsync(ctx, cookies, order, ct).ConfigureAwait(false);
                }
                else
                {
                    documentsSkipped++;
                }
            }

            receipts.Add(ToReceipt(ctx, request, shape, order) with
            {
                Documents = documents,
            });
        }

        if (documentsSkipped > 0)
        {
            ctx.Note($"{documentsSkipped} order(s) past the {_options.MaxDocumentOrdersPerFetch}-order document " +
                     "ceiling came back with no invoice; ask for a narrower window to get theirs");
        }

        return new FetchResult
        {
            Receipts = receipts,
            Complete = complete,
            Via = request.WantsInvoice ? shape.Name + "+invoice-pdf" : shape.Name,
            Raw = raw,
        };
    }

    private static Receipt ToReceipt(
        IJobContext ctx, ResourceRequest request, IBolOrdersShape shape, BolOrder order) =>
        ReceiptFactory.Build(
            ctx.SessionId,
            order.Id,
            Merchant(order.SellerName),
            order.PlacedAt,
            // the payload states no order total: this is our own sum, flagged derived so the reconciliation flag keeps meaning
            // "a stated total was checked and agreed" on every provider
            new ReceiptTotal(order.Total, shape.TotalIsDerived),
            order.Payment,
            // no items asked: a receipt with none reconciles trivially, there is nothing to check a total against
            request.WantsItems ? order.Items : []);

    internal static Merchant Merchant(string? sellerName) => new()
    {
        Id = ProviderId,
        Name = "bol.com",
        // null when the page names nobody (bol ships many orders itself), never a guess
        StoreName = sellerName,
    };

    private async Task<string> ReadPageAsync(
        IJobContext ctx, IBolOrdersShape shape, BolOptions options, string cookies, string? xsrf, int page, CancellationToken ct)
    {
        var url = shape.Url(options, page);
        var what = $"orders page {page} ({shape.Name} shape)";

        var payload = shape.Body(options, page);

        using var request = new HttpRequestMessage(payload is null ? HttpMethod.Get : HttpMethod.Post, url);

        if (payload is not null)
        {
            request.Content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
        }

        request.Headers.TryAddWithoutValidation(CookieHeader, cookies);
        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept", shape.Accept);
        request.Headers.TryAddWithoutValidation("Accept-Language", _options.AcceptLanguage);

        foreach (var (name, value) in shape.Headers(options))
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        // only on a write: bol checks the double-submitted token on the API POST, not on a page GET
        if (payload is not null)
        {
            // without it the POST earns "403 XSRF failed", which would read as bol blocking us; asking for a login sets the cookie
            if (string.IsNullOrEmpty(xsrf))
            {
                throw ConnectorException.SessionExpired(
                    $"{ProviderId}: the stored session carries no '{_options.XsrfCookieName}' cookie, and bol " +
                    $"refuses the orders API without it echoed in '{_options.XsrfHeader}'. A fresh login sets it.");
            }

            request.Headers.TryAddWithoutValidation(_options.XsrfHeader, xsrf);
        }

        // best effort: an unparseable start URL should lose a header, not the fetch
        if (Uri.TryCreate(_options.LoginStartUrl, UriKind.Absolute, out var referrer))
        {
            request.Headers.Referrer = referrer;
        }

        // the page's own headers over the defaults, for the operation's POST only; jar, referer and CSRF echo stay the fetch's
        // own because the token has to match the cookie beside it (2026-10-07 prod)
        if (payload is not null) Replay(request, options);

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        await RefuseStaleTokenAsync(response, ct).ConfigureAwait(false);

        // 401 is the session being over; BlockStatuses are bol refusing and never a wrong password; the body is kept
        // on failure because a block page usually names its vendor
        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, _options.BlockStatuses, ct)
            .ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        Guard(body, what);
        return body;
    }

    // replaced, not added: TryAddWithoutValidation appends a second value (two User-Agents); a content header belongs to the
    // body and the request's own collection refuses it
    private static void Replay(HttpRequestMessage request, BolOptions options)
    {
        foreach (var (name, value) in options.OrdersRequestHeaders)
        {
            if (!BolPersistedQuery.MayCarry(name) || IsFetchOwn(name, options)) continue;
            if (Put(request.Headers, name, value)) continue;

            if (request.Content is { } content) Put(content.Headers, name, value);
        }
    }

    private static bool IsFetchOwn(string name, BolOptions options) =>
        string.Equals(name, CookieHeader, StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, "Referer", StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, options.XsrfHeader, StringComparison.OrdinalIgnoreCase);

    // TryGetValues answers quietly where Remove and Contains throw for a content header asked of the request's collection
    private static bool Put(HttpHeaders headers, string name, string value)
    {
        if (headers.TryGetValues(name, out _)) headers.Remove(name);
        return headers.TryAddWithoutValidation(name, value);
    }

    // bol answers a bad CSRF token with 403 "XSRF failed", and 403 is otherwise how it blocks: read as a block it marks the
    // provider degraded instead of asking for the login that fixes it
    private async Task RefuseStaleTokenAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.StatusCode != HttpStatusCode.Forbidden) return;

        // buffered because the caller reads this same body again to quote it in its error
        await response.Content.LoadIntoBufferAsync(ct).ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!body.Contains(_options.XsrfFailureMarker, StringComparison.OrdinalIgnoreCase)) return;

        throw ConnectorException.SessionExpired(
            $"{ProviderId}: bol refused the orders API with '{_options.XsrfFailureMarker}', so the stored " +
            "CSRF token no longer matches the session. A new login mints both together.");
    }

    // the bot wall is checked first: mistaking a wall for a dead session starts a login straight into it, spending a credential

    // the overview has no invoice reference: ids come off the details page; failures are a note, never a throw
    // NO ctx.Pacer ticket: ctx.Http's handler already enters the per-provider SemaphoreSlim(1, 1) gate, so a ticket
    // around an HTTP call would DEADLOCK the job (Amazon takes tickets because its calls are browser navigations)
    private async Task<IReadOnlyList<ReceiptDocument>> DocumentsAsync(
        IJobContext ctx, string cookies, BolOrder order, CancellationToken ct)
    {
        var detailsUrl = _options.OrderDetailsUrlTemplate.Replace(
            "{reference}", Uri.EscapeDataString(order.Id), StringComparison.Ordinal);

        string page;
        try
        {
            page = await ReadDocumentPageAsync(
                ctx, cookies, detailsUrl, $"the details page for order '{order.Id}'", ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (ex.Code is not ErrorCode.SessionExpired)
        {
            // a dead session is the one failure to propagate: every remaining order would fail the same way
            ctx.Note($"order '{order.Id}': the details page could not be read ({ex.Code}: {ex.Detail})");
            return [];
        }

        var links = BolDocuments.Parse(page, _options);
        if (links.Count == 0)
        {
            ctx.Note($"order '{order.Id}': no invoice on its details page " +
                     $"({page.Length} chars, pattern '{_options.InvoiceIdPattern}')");
            return [];
        }

        var documents = new List<ReceiptDocument>(links.Count);

        foreach (var invoiceId in links.Take(_options.MaxDocumentsPerOrder).Select(link => link.InvoiceId))
        {
            ct.ThrowIfCancellationRequested();

            var pdfUrl = _options.InvoicePdfUrlTemplate.Replace(
                "{invoiceId}", Uri.EscapeDataString(invoiceId), StringComparison.Ordinal);

            BolDownload fetched;
            try
            {
                fetched = await DownloadAsync(ctx, cookies, pdfUrl, ct).ConfigureAwait(false);
            }
            catch (ConnectorException ex)
            {
                ctx.Note($"order '{order.Id}': invoice '{invoiceId}' could not be downloaded " +
                         $"({ex.Code}: {ex.Detail})");
                continue;
            }

            if (!IsDocument(fetched))
            {
                ctx.Note($"order '{order.Id}': invoice '{invoiceId}' answered {fetched.Status} " +
                         $"'{fetched.MediaType}' with {fetched.Bytes.Length} byte(s); not attached");
                continue;
            }

            documents.Add(new ReceiptDocument
            {
                Kind = ReceiptDocumentKinds.Invoice,
                MediaType = fetched.MediaType,
                // bol's only per-link text is an ACTION ("Bekijk factuur"), not what the provider called the document: Name stays null
                Name = null,
                Filename = $"bol-{order.Id}-invoice-{invoiceId}.pdf",
                SizeBytes = fetched.Bytes.Length,
                ContentBase64 = Convert.ToBase64String(fetched.Bytes),
            });
        }

        ctx.Note($"order '{order.Id}': attached {documents.Count} of {links.Count} invoice document(s)");
        return documents;
    }

    // the media type is read through ContentType.MediaType because bol sends "application/pdf;charset=UTF-8"; the magic
    // number catches a 200 error page wearing a PDF content type, which a session dying mid-fetch produces
    private bool IsDocument(BolDownload fetched) =>
        fetched.Status is 200
        && _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase)
        && fetched.Bytes.Length > _options.DocumentMagic.Count
        && fetched.Bytes.Take(_options.DocumentMagic.Count).SequenceEqual(_options.DocumentMagic);

    // not ReadPageAsync: its shape-driven guard is the trap, see GuardAccountPage
    private async Task<string> ReadDocumentPageAsync(
        IJobContext ctx, string cookies, string url, string what, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        request.Headers.TryAddWithoutValidation(CookieHeader, cookies);
        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        request.Headers.TryAddWithoutValidation("Accept-Language", _options.AcceptLanguage);

        if (Uri.TryCreate(_options.LoginStartUrl, UriKind.Absolute, out var referrer))
        {
            request.Headers.Referrer = referrer;
        }

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, _options.BlockStatuses, ct)
            .ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        GuardAccountPage(body, what);
        return body;
    }

    // bytes, never text: decoding a PDF as text and re-encoding it corrupts it silently; no EnsureSuccessAsync because a
    // non-200 on a document is a note and a missing attachment, not a failed fetch
    private async Task<BolDownload> DownloadAsync(
        IJobContext ctx, string cookies, string url, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);

        request.Headers.TryAddWithoutValidation(CookieHeader, cookies);
        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "application/pdf,*/*");
        request.Headers.TryAddWithoutValidation("Accept-Language", _options.AcceptLanguage);

        if (Uri.TryCreate(_options.LoginStartUrl, UriKind.Absolute, out var referrer))
        {
            request.Headers.Referrer = referrer;
        }

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        var bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);

        var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;

        return new BolDownload((int)response.StatusCode, mediaType, bytes);
    }

    private void Guard(string body, string what) =>
        GuardWith(body, what, _options.LoginPageMarkers);

    // account pages carry login.bol.com/wsp once (inside "passwordForgottenUrl") while working, so the ordinary
    // LoginPageMarkers would raise session_expired every time; the bot-wall half is unchanged
    private void GuardAccountPage(string body, string what) =>
        GuardWith(body, what, _options.AccountPageLoginMarkers);

    private void GuardWith(string body, string what, IReadOnlyList<string> loginMarkers)
    {
        foreach (var marker in _options.BotWallMarkers)
        {
            if (!body.Contains(marker, StringComparison.OrdinalIgnoreCase)) continue;

            throw ConnectorException.Blocked(
                $"{ProviderId}: {what} answered 200 with a bot-protection interstitial (matched '{marker}'). " +
                "bol ran no such vendor when this adapter was written, so this is a change worth telling " +
                "an operator about - and it is not a credential problem");
        }

        foreach (var marker in loginMarkers)
        {
            if (!body.Contains(marker, StringComparison.Ordinal)) continue;

            throw ConnectorException.SessionExpired(
                $"{ProviderId}: {what} answered with the login form (matched '{marker}'); the stored session " +
                "is over and bol offers consumers no refresh grant, so a human has to sign in again");
        }
    }

    // no recognisable outcome is provider_changed, never invalid_credentials: guessing "wrong password" from silence sends
    // users to reset a fine password, and a credential error is never retried
    private async Task SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
        var poll = TimeSpan.FromSeconds(_options.PollSeconds);
        var captchaSeen = false;
        var codeAnswered = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            // first: a device bol already trusts goes straight through and the probes below would hit a page that moved on
            if (await signedIn.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return;

            await RefuseStatedAsync(page, ct).ConfigureAwait(false);

            if (!codeAnswered &&
                await page.FindAsync(_options.VerificationCodeSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
                    is not null)
            {
                await RelayCodeAsync(ctx, page, ct).ConfigureAwait(false);
                codeAnswered = true;

                // the budget measures bol's answer time: the minutes a human spent finding a code are not the provider being slow
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (!captchaSeen && await FaceCaptchaAsync(ctx, page, signedIn, ct).ConfigureAwait(false) is { } faced)
            {
                captchaSeen = true;
                if (faced.Redirect is not null) return;

                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        throw await UnsettledAsync(page, captchaSeen, ct).ConfigureAwait(false);
    }

    private async Task RefuseStatedAsync(ILoginPage page, CancellationToken ct)
    {
        // a generic notice is not a credential verdict: Lidl's login answers an automated browser with one, and reading it as a
        // bad password was a real bug
        if (await page.FindAsync(_options.BlockedNoticeSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            await page.ClearSecretsAsync(ct).ConfigureAwait(false);

            throw ConnectorException.Blocked(
                $"{ProviderId}: the login was refused with a notice that names no cause. The page carries a " +
                "reCAPTCHA site key, so the likeliest reading is a risk-based verdict on an automated " +
                "browser rather than anything about the account - an agent on a real residential line is " +
                "the route that passes it");
        }

        // the one path that may report invalid_credentials, only because the page said so itself
        if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            await page.ClearSecretsAsync(ct).ConfigureAwait(false);
            throw ConnectorException.InvalidCredentials($"{ProviderId}: the login page stated a credential error");
        }
    }

    private async Task<CaptchaOutcome?> FaceCaptchaAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        var outcome = await _captcha.FaceAsync(ctx, page, signedIn, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null || outcome.Handled) return outcome;

        throw await UnsettledAsync(page, captchaSeen: true, ct).ConfigureAwait(false);
    }

    private async Task<ConnectorException> UnsettledAsync(ILoginPage page, bool captchaSeen, CancellationToken ct)
    {
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        return captchaSeen
            ? ConnectorException.Blocked($"{ProviderId}: a captcha stood between the login and the account page")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the login neither completed nor stated anything recognisable within " +
                $"{_options.LoginSettleSeconds}s; last url was '{page.Url}'");
    }

    private async Task RelayCodeAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        var delivery = await DeliveryAsync(page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = BolMessageKeys.VerificationCode,
            Delivery = delivery,
            // null unless a live run has seen the screen: a wrong length makes the consumer reject a valid code before it is tried
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
            // some code forms submit on the last keystroke and have no button: Enter
            await page.AnswerAsync(_options.VerificationCodeSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false);
        }
    }

    // the page's own word beats the e-mail default: telling someone to watch a phone that never rings expires the challenge
    private async Task<string> DeliveryAsync(ILoginPage page, CancellationToken ct)
    {
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

        return "email";
    }

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"{ProviderId}: '{key}' is required");

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");
}

// the sign-in's listener can stay silent (bol lands elsewhere, or renders the first page on the server), so the probe
// opens the overview and presses "Toon meer", which fires the operation (2026-10-05)
internal sealed class BolHashProbe
{
    private readonly BolOptions _options;

    public BolHashProbe(BolOptions options) => _options = options;

    public async Task<string?> LearnAsync(IJobContext ctx, ILoginPage page, Task<string> learned, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(learned);

        if (await ArrivedAsync(learned, ct).ConfigureAwait(false)) return learned.Result;

        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);
        if (await ArrivedAsync(learned, ct).ConfigureAwait(false))
        {
            ctx.Note($"{BolAdapter.ProviderId}: the orders overview fired the operation once opened");
            return learned.Result;
        }

        // the cookie wall over the overview swallowed the "Toon meer" press (2026-10-06 prod): out of the way first
        await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

        // a first page rendered on the server fires nothing until the next one is asked for
        if (await PressLoadMoreAsync(ctx, page, ct).ConfigureAwait(false)
            && await ArrivedAsync(learned, ct).ConfigureAwait(false))
        {
            ctx.Note($"{BolAdapter.ProviderId}: 'Toon meer' made the overview fire the operation");
            return learned.Result;
        }

        ctx.Note($"{BolAdapter.ProviderId}: the orders page fired no persisted operation within {_options.HashProbeMs} ms, " +
                 "not even after opening the overview and pressing 'Toon meer'; the configured hash stands");
        return null;
    }

    private async Task<bool> ArrivedAsync(Task<string> learned, CancellationToken ct) =>
        await Task.WhenAny(learned, Task.Delay(_options.HashProbeMs, ct)).ConfigureAwait(false) == learned;

    // one more try after the walls are taken down again; the probe is an optimisation, never the login's verdict
    private const int LoadMoreAttempts = 2;

    // own click budget: three sign-ins died as `internal` on Playwright's 500 ms click budget when bol's second wall took
    // the pointer (2026-10-06/07 prod); false when the button is absent or still refuses
    private async Task<bool> PressLoadMoreAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        for (var attempt = 1; attempt <= LoadMoreAttempts; attempt++)
        {
            try
            {
                return await page.ClickAsync(_options.LoadMoreSelectors, _options.LoadMoreMs, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
            {
                var next = attempt < LoadMoreAttempts;
                ctx.Note($"{BolAdapter.ProviderId}: 'Toon meer' did not take the press ({ex.GetType().Name}, attempt {attempt} of {LoadMoreAttempts}); " +
                         (next ? "the walls are taken down again before the next one" : "the configured hash stands"));
                if (next) await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);
            }
        }

        return false;
    }
}

// success here is the cookie jar, not a redirect (AH and Lidl end on a scheme Chromium cannot open); wearing
// IRedirectWaiter lets the shared CaptchaGate be reused unchanged
internal sealed class BolSessionWatcher : IRedirectWaiter
{
    private readonly IJobContext _ctx;
    private readonly ILoginPage _page;
    private readonly BolOptions _options;
    private readonly TimeProvider _time;

    public BolSessionWatcher(IJobContext ctx, ILoginPage page, BolOptions options, TimeProvider time)
    {
        _ctx = ctx;
        _page = page;
        _options = options;
        _time = time;
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        // counted, not clock-bounded: a frozen TimeProvider (every test) would never reach a deadline and the loop would spin
        var interval = Math.Max(1, _options.SessionPollMs);
        var passes = Math.Max(1, (int)(timeout.TotalMilliseconds / interval));

        for (var pass = 0; pass < passes; pass++)
        {
            ct.ThrowIfCancellationRequested();

            if (await SignedInAsync(ct).ConfigureAwait(false)) return _page.Url;
            if (pass + 1 >= passes) break;

            await Task.Delay(TimeSpan.FromMilliseconds(interval), _time, ct).ConfigureAwait(false);
        }

        return null;
    }

    private async Task<bool> SignedInAsync(CancellationToken ct)
    {
        if (_page.Url.Contains(_options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)) return false;

        var storageState = await _ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);
        return BolCookies.HasSession(storageState, _options);
    }
}
