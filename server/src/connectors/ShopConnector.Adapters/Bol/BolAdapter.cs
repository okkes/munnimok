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

/// <summary>
/// bol.com - the largest marketplace in the Netherlands, and the one this
/// project was most likely to build wrong.
///
/// <b>api.bol.com is not this.</b> bol's documented, well-clienced, pleasant
/// REST API is a SELLER API. It authenticates with <c>client_credentials</c>,
/// a grant that carries no user context at all, so <c>GET /retailer/orders</c>
/// answers "which orders were placed with this merchant" - a different
/// person's data, returned confidently, in the right shape. Every bol-related
/// library on GitHub is a client for it, including one whose README says it
/// "gets the orders from your bol.com account" and whose source is
/// <c>client_credentials</c> against the retailer host. Nothing in this file
/// touches api.bol.com, and nothing ever should.
///
/// The consumer route is a browser login and a cookie: <c>login.bol.com/wsp/login</c>
/// posts <c>j_username</c> and <c>j_password</c> - Spring Security's own field
/// names - and sets <c>JSESSIONID</c>. That makes this T2: a browser signs in
/// once, and every fetch afterwards is plain HTTP carrying the cookie jar.
///
/// One thing about the fetch is genuinely unknown and cannot be settled
/// without an account: whether the order list is server-rendered HTML or a
/// shell around a JSON endpoint. Both are implemented behind
/// <see cref="IBolOrdersShape"/>, an option chooses, HTML is the default
/// because the page is known to exist, and every failure names the shape it
/// tried so the first live run diagnoses itself.
/// </summary>
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

        // The policy is shared with Albert Heijn and Lidl Plus; only the
        // selectors and the patience are bol's. A widget goes to whoever is
        // sitting at the browser, a picture is relayed, and an unattended
        // agent says so at once instead of waiting out its budget.
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

        // Everything that can fail without contacting anyone, checked before
        // a browser is leased: launching Chromium to discover a blank field
        // holds an agent for nothing.
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var browserPage = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browserPage, Manifest);

        // The hash bol pins its orders operation to, read off the request
        // bol's own page makes once the sign-in lands on the orders overview
        // (see BolPersistedQuery). Listened for from before the first
        // navigation, so a page that fires early is not missed. The request
        // itself is kept beside the hash: on 2026-10-07 (prod) bol refused
        // the fetch rebuilt around a learned hash, so the fetch now replays
        // the page's own body and headers, read off it once the probe is done.
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

    /// <summary>
    /// What the sign-in seals beyond the jar: the hash bol's own page said
    /// (the probe makes it say it), the page's request around that hash, and
    /// the jar read AGAIN once the probe is done.
    ///
    /// Internal so the offline suite can drive it with a stub page and a
    /// stub lease; the Playwright listener above it is the one part a test
    /// cannot reach. <paramref name="capture"/> reads the page's request
    /// once the hash is known, and answers null when it cannot be read.
    /// </summary>
    internal async Task<LoginResult> SealAsync(
        IJobContext ctx, ILoginPage page, LoginResult result, Task<string> learned,
        Func<CancellationToken, Task<BolPageRequest?>> capture, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(capture);

        // The page the sign-in landed on, then the overview itself, then
        // the overview with "Toon meer" pressed: three chances for bol's
        // own page to say the hash. A page that never says it costs the
        // waits and nothing else - the option's hash still stands.
        var hash = await new BolHashProbe(_options).LearnAsync(ctx, page, learned, ct).ConfigureAwait(false);

        // 2026-10-07 (prod): the jar had been sealed BEFORE the probe opened
        // the overview and pressed "Toon meer", so whatever bol set on those
        // visits never reached a fetch. Read again now that they are done.
        result = await ResealJarAsync(ctx, result, ct).ConfigureAwait(false);
        if (hash is null) return result;

        var request = await capture(ct).ConfigureAwait(false);
        ctx.Note(LearnedNote(hash, request));

        var material = BolPersistedQuery.WithHash(result.Material, hash);
        return result with { Material = BolPersistedQuery.WithRequest(material, request) };
    }

    /// <summary>
    /// The result with the jar as it is NOW, or as it was when the browser
    /// has nothing better. A fresh read carrying no cookie for the orders
    /// host (a lease answers an empty state once its browser is gone) must
    /// not trade a jar the login checked for an empty one, and a read that
    /// fails must not take a sign-in that succeeded down with it.
    /// </summary>
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

    /// <summary>The sign-in's note: the hash's prefix, and WHICH headers were learned - their names, never a value.</summary>
    private static string LearnedNote(string hash, BolPageRequest? request)
    {
        var learned = request is null
            ? "the page's own request could not be read, so a fetch rebuilds it"
            : $"the page's own request body and {request.Headers.Count} header(s) " +
              $"[{string.Join(", ", request.Headers.Keys.OrderBy(name => name, StringComparer.Ordinal))}] were learned with it";

        return $"{ProviderId}: the orders operation's persisted-query hash ({BolPersistedQuery.Prefix(hash)}) was learned " +
               $"from the page and sealed into the session; {learned}";
    }

    /// <summary>
    /// The request the listener kept, read for the replay: its body as the
    /// page posted it and the headers it went out with. AllHeadersAsync
    /// rather than Headers - the synchronous view is documented to withhold
    /// security-related headers, and ING's portal met that live - but
    /// bounded, because a request the page has moved on from may never
    /// answer it, and then the provisional view is what there is.
    /// </summary>
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

    /// <summary>
    /// The whole login, behind the seam.
    ///
    /// Internal rather than private so the offline suite can drive it. Every
    /// branch below decides how a human is treated - whether they are asked
    /// for a code, told to pass a widget, told their password is wrong, or
    /// told nothing at all - and on a provider nobody here has an account
    /// for, a live attempt is a thing that can be spent exactly once and is
    /// never retried.
    /// </summary>
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

    /// <summary>The sign-in itself: every page step, through to the sealed jar.</summary>
    private async Task<LoginResult> SignInAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // Deliberately the protected page, not the login form: bol's own 302
        // chain takes us to the form and brings us back, which is the flow a
        // shopper takes and the cleanest signal that we are in.
        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);
        await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            // The redirect chain did not end at a form. The form's own address
            // is one of the few things about bol that IS confirmed, so going
            // straight at it costs one navigation and is worth far more than
            // failing on a 302 that changed shape.
            await page.GotoAsync(_options.LoginFormUrl, ct).ConfigureAwait(false);
            await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

            if (!await page.FillAsync(_options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                    .ConfigureAwait(false))
            {
                throw Missing("e-mail field, on either the account page's redirect or the login form itself",
                    _options.UsernameSelectors);
            }
        }

        // bol's is a classic single-screen Spring form: both names are on the
        // one page. A miss here is therefore a real shape change and not the
        // two-step wizard Lidl turned out to have - so it is reported rather
        // than worked around, with nothing typed anywhere and no attempt spent.
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("password field", _options.PasswordSelectors);
        }

        // Latch before the credentials leave the machine. After this a lost
        // lease fails the job rather than requeuing it: a retried login is how
        // an account gets locked, and bol may already have sent a code.
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("login submit", _options.SubmitSelectors);
        }

        await SettleAsync(ctx, page, signedIn, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        // Checked here rather than left for the first fetch to discover. The
        // orders request needs cookies scoped to www.bol.com specifically -
        // bol sets JSESSIONID on login.bol.com, and a browser would not carry
        // that across hosts unless the cookie asked it to. A login that
        // "succeeded" and left nothing usable is a login that failed.
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
            // Stated from this login rather than left to the manifest, so the
            // consumer's countdown starts when the session did. The number is
            // a conservative guess - see BolManifest.SessionTtlSeconds.
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

        // No credential is available during a fetch, so a dead cookie cannot
        // be renewed here - it needs a new login job, which is exactly what
        // session_expired asks the platform for.
        var cookies = BolCookies.Header(ctx.Material?.StorageState, _options.OrdersHost)
                      ?? throw ConnectorException.SessionExpired(
                          $"{ProviderId}: the stored browser session carries no cookies for " +
                          $"'{_options.OrdersHost}'");

        // bol double-submits its CSRF token: the cookie above carries it and
        // the request has to echo it in a header. Missing, the API answers
        // "403 XSRF failed" - so its absence is worth carrying explicitly
        // rather than discovering per request.
        var xsrf = BolCookies.Value(ctx.Material?.StorageState, _options.OrdersHost, _options.XsrfCookieName);

        var shape = BolShapes.For(_options.OrdersShape);
        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;

        // The hash the sign-in learned from bol's own page beats the
        // configured one: bol moves it with every front-end release, and the
        // one its page sent that day is the one it knows. Since 2026-10-07
        // (prod) the page's own request rides with it - bol refused the
        // request rebuilt around a hash its page had sent moments before.
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
            // The CONFIGURED hash was refused and this session never learned
            // bol's current one: a fresh sign-in learns it from bol's own page
            // (BolHashProbe), so the person is asked to sign in again rather
            // than told munni needs an update (user ss 2026-10-06: "The party
            // changed its site" on every bol sync). A LEARNED hash that is
            // refused is a change bol made since the sign-in and stays
            // provider_changed.
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: bol refused the configured orders operation and this session learned no hash of its own; " +
                $"a new sign-in learns the one bol's page sends today ({ex.Detail})");
        }

        var ordered = collected.OrderByDescending(o => o.PlacedAt).ToList();
        var complete = walkWasComplete;

        if (ordered.Count > cap)
        {
            // More remains than one pass may return. The caller gets a partial
            // pass and comes back for the rest.
            ordered = [.. ordered.Take(cap)];
            complete = false;
        }

        return await NormalizeAsync(ctx, request, shape, cookies, ordered, complete, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The overview, page by page, until the window or the history runs out.
    ///
    /// Returns the orders inside the window and whether the walk ended
    /// because it had seen everything rather than because its page budget
    /// ran out.
    /// </summary>
    /// <summary>The GraphQL shape's refusal of the operation (a hash bol no longer knows reports itself there).</summary>
    private static bool IsRefusedOperation(ConnectorException ex) =>
        ex.Code == ErrorCode.ProviderChanged && (ex.Detail ?? string.Empty).Contains(BolGraphQlShape.RefusedMarker, StringComparison.Ordinal);

    /// <summary>
    /// A page step Playwright gave up on - a click the wall took the pointer
    /// from, a navigation that never settled - is bol's page misbehaving,
    /// not munni's code: <c>provider_unavailable</c>, which asks for a retry
    /// and pages nobody. Until 2026-10-09 it escaped as <c>internal</c> with
    /// an unhandled-exception event per sign-in (prod, GlitchTip #24-#28,
    /// #33-#34). A selector that is not there at all stays
    /// <c>provider_changed</c> (see <see cref="Missing"/>); the first line of
    /// Playwright's message is kept for the operator, its call log is not.
    /// </summary>
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

    /// <summary>What one orders request needs beyond its page number: the shape, the options it reads (the learned hash and request included), the jar and the token.</summary>
    private sealed record BolCall(IBolOrdersShape Shape, BolOptions Options, string Cookies, string? Xsrf);

    /// <summary>
    /// What a session learned at sign-in, laid over the configured options:
    /// the page's hash, and since 2026-10-07 (prod) the page's own request.
    /// </summary>
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

    /// <summary>The fetch's note: which hash it sends, and whether the body is the page's own or the rebuilt shape.</summary>
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

        // True while the walk is still ending because the page budget ran out
        // rather than because the history did. The difference is what the
        // caller's `Complete` means, and getting it backwards tells a consumer
        // it has the whole history when it has twenty pages of it.
        var budgetRanOut = true;

        for (var page = 1; page <= _options.MaxPages; page++)
        {
            ct.ThrowIfCancellationRequested();

            var body = await ReadPageAsync(ctx, call.Shape, call.Options, call.Cookies, call.Xsrf, page, ct).ConfigureAwait(false);

            ctx.Progress(JobStep.Parsing);

            // The call's options rather than the adapter's: a refusal names
            // the hash and the body actually in use, which are the learned
            // ones when the session has them (2026-10-07, prod).
            var orders = shape.Parse(body, call.Options, zone, request.WantsRaw, ctx.Note);
            if (orders.Count == 0)
            {
                budgetRanOut = false;
                break;
            }

            var (fresh, older) = Tally(orders, seen, request, collected);
            ctx.Found(collected.Count);

            // A page that repeats the previous one means the pagination
            // parameter is not the one bol takes - which is entirely possible,
            // because its name is a guess. Without this guard that presents as
            // the same page fetched twenty times against a live account.
            if (fresh == 0)
            {
                budgetRanOut = false;
                break;
            }

            // Newest first, so a page entirely below the window means every
            // later page is too. Stopping here is what keeps two years of
            // history from being walked on every sync.
            if (older == orders.Count)
            {
                budgetRanOut = false;
                break;
            }

            // One page past the cap is enough to know the pass is partial;
            // more would be work the caller is about to discard.
            if (collected.Count > cap)
            {
                budgetRanOut = false;
                break;
            }
        }

        return (collected, !budgetRanOut);
    }

    /// <summary>
    /// One page's orders against the walk so far: how many were new to it,
    /// and how many of those were placed before the window opened. The ones
    /// inside the window go into <paramref name="collected"/>.
    /// </summary>
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

    /// <summary>
    /// One pass's orders as receipts, with their documents where the caller
    /// asked for them and the document ceiling allows.
    /// </summary>
    private async Task<FetchResult> NormalizeAsync(
        IJobContext ctx, ResourceRequest request, IBolOrdersShape shape, string cookies,
        List<BolOrder> ordered, bool complete, CancellationToken ct)
    {
        ctx.Progress(JobStep.Normalizing);

        var receipts = new List<Receipt>(ordered.Count);

        // Keyed by the same external id the receipts carry, which is how a
        // consumer pairs the two back up.
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        // Orders given the document treatment, bounded. Each one costs a
        // details page of well over half a megabyte plus a download per
        // invoice, against a record cap of two hundred - so without a ceiling
        // one include=invoice call is two hundred page loads and several
        // hundred downloads. Orders past it still become receipts; they carry
        // no documents, and the run says so rather than truncating in silence.
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
            // Nothing rotates: bol issues no token, so the stored bundle stays
            // exactly as it is until it expires.
            Via = request.WantsInvoice ? shape.Name + "+invoice-pdf" : shape.Name,
            Raw = raw,
        };
    }

    /// <summary>
    /// One order through the factory, so it leaves with a reconciliation
    /// verdict and a content hash on it.
    /// </summary>
    private static Receipt ToReceipt(
        IJobContext ctx, ResourceRequest request, IBolOrdersShape shape, BolOrder order) =>
        ReceiptFactory.Build(
            ctx.SessionId,
            order.Id,
            Merchant(order.SellerName),
            order.PlacedAt,
            // The GraphQL payload states no order total anywhere, so this
            // one is our own sum of its lines. Saying so is what stops the
            // reconciliation flag meaning two different things on two
            // providers: everywhere else it means a stated total was
            // checked and agreed, and here there was never a stated total
            // to check.
            new ReceiptTotal(order.Total, shape.TotalIsDerived),
            order.Payment,
            // A caller that did not ask for items gets none, and a receipt
            // with no items reconciles trivially rather than falsely: there
            // is nothing to check a total against.
            request.WantsItems ? order.Items : []);

    internal static Merchant Merchant(string? sellerName) => new()
    {
        Id = ProviderId,
        Name = "bol.com",
        // bol is a marketplace: most orders are fulfilled by a third-party
        // seller, and which one is genuinely useful to the person reading
        // their spending back. Null when the page names nobody - bol ships a
        // large share of its own orders - never a guess.
        StoreName = sellerName,
    };

    // ---- transport -----------------------------------------------------------

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

        // What this shape needs beyond the above - for the API shape, the
        // operation named in a header, without which bol's edge refuses the
        // request before GraphQL ever sees it.
        foreach (var (name, value) in shape.Headers(options))
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        // Only on a write. bol checks the double-submitted token on the API
        // POST and not on a page GET, and a browser does the same.
        if (payload is not null)
        {
            // Sending the POST without it earns "403 XSRF failed", which this
            // adapter would report as bol blocking us - a dead end for anyone
            // reading it. A login sets the cookie, so asking for one both names
            // the problem and fixes it.
            if (string.IsNullOrEmpty(xsrf))
            {
                throw ConnectorException.SessionExpired(
                    $"{ProviderId}: the stored session carries no '{_options.XsrfCookieName}' cookie, and bol " +
                    $"refuses the orders API without it echoed in '{_options.XsrfHeader}'. A fresh login sets it.");
            }

            request.Headers.TryAddWithoutValidation(_options.XsrfHeader, xsrf);
        }

        // The account page is reached from the account page, which is what a
        // browser would say. Best effort: an operator who edits the start URL
        // into something unparseable should lose a header, not the fetch.
        if (Uri.TryCreate(_options.LoginStartUrl, UriKind.Absolute, out var referrer))
        {
            request.Headers.Referrer = referrer;
        }

        // 2026-10-07 (prod): the page's own headers over the defaults above,
        // for a session that learned them. They are the headers of the
        // operation's POST, so a page shape's GET never wears them. The jar,
        // the referer and the CSRF echo stay the fetch's own: the token has
        // to match the cookie beside it, and both come off the stored session.
        if (payload is not null) Replay(request, options);

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        await RefuseStaleTokenAsync(response, ct).ConfigureAwait(false);

        // 401 is the session being over, which is a new login job. Everything
        // in BlockStatuses is bol refusing us rather than failing - and none
        // of it is ever a wrong password: telling a user to reset a password
        // that was fine leaves the real block undiagnosed. The body is kept on
        // failure because a block page usually names its own vendor.
        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, _options.BlockStatuses, ct)
            .ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        Guard(body, what);
        return body;
    }

    /// <summary>
    /// The page's own headers laid over the fetch's. Replaced rather than
    /// added: TryAddWithoutValidation appends a second value, and two
    /// User-Agents is a request no browser sends. A content header (the
    /// page's content-type) belongs to the body, and the request's own
    /// collection refuses it rather than holding it.
    /// </summary>
    private static void Replay(HttpRequestMessage request, BolOptions options)
    {
        foreach (var (name, value) in options.OrdersRequestHeaders)
        {
            if (!BolPersistedQuery.MayCarry(name) || IsFetchOwn(name, options)) continue;
            if (Put(request.Headers, name, value)) continue;

            if (request.Content is { } content) Put(content.Headers, name, value);
        }
    }

    /// <summary>The headers the fetch reads off the stored session itself; a learned one never overrides them.</summary>
    private static bool IsFetchOwn(string name, BolOptions options) =>
        string.Equals(name, CookieHeader, StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, "Referer", StringComparison.OrdinalIgnoreCase)
        || string.Equals(name, options.XsrfHeader, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// One header, replaced. False when this collection may not hold the
    /// name at all - TryGetValues answers that quietly, where Remove and
    /// Contains throw on a content header asked of the request's own.
    /// </summary>
    private static bool Put(HttpHeaders headers, string name, string value)
    {
        if (headers.TryGetValues(name, out _)) headers.Remove(name);
        return headers.TryAddWithoutValidation(name, value);
    }

    /// <summary>
    /// The 403 that is a dead session wearing a refusal's clothes.
    ///
    /// bol answers a bad or missing CSRF token with 403 and the words
    /// "XSRF failed", and 403 is otherwise how bol blocks a client. Read as a
    /// block it marks the provider degraded and tells the user to wait; read
    /// correctly it asks for the login that actually fixes it.
    /// </summary>
    private async Task RefuseStaleTokenAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.StatusCode != HttpStatusCode.Forbidden) return;

        // The response is streamed, so it is buffered first: the caller reads
        // this same body again to quote it in whatever error it raises.
        await response.Content.LoadIntoBufferAsync(ct).ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!body.Contains(_options.XsrfFailureMarker, StringComparison.OrdinalIgnoreCase)) return;

        throw ConnectorException.SessionExpired(
            $"{ProviderId}: bol refused the orders API with '{_options.XsrfFailureMarker}', so the stored " +
            "CSRF token no longer matches the session. A new login mints both together.");
    }

    /// <summary>
    /// The two things a 200 can be other than the page we asked for.
    ///
    /// The wall is checked first on purpose. Mistaking a wall for a dead
    /// session starts a fresh login straight into the wall - spending a
    /// credential against something that was never going to answer - which is
    /// the more expensive of the two wrong readings.
    /// </summary>
    // ---- invoice documents -------------------------------------------------

    /// <summary>
    /// The invoice PDFs bol holds for one order.
    ///
    /// Two requests minimum, and the first is not optional: the orders overview
    /// carries no invoice reference anywhere - not one <c>facturen</c> link -
    /// so the ids can only be read off the per-order details page.
    ///
    /// Failures here become an absence and a note, never a throw. A document is
    /// an extra the caller asked for; failing a fetch that has already read
    /// every order correctly, because one PDF would not come down, trades the
    /// whole answer for a footnote. An order with no invoice at all is normal -
    /// nothing has shipped yet - and not a fault of any kind.
    /// </summary>
    /// <remarks>
    /// NO <c>ctx.Pacer</c> TICKET IS TAKEN IN HERE, and that is deliberate
    /// rather than an oversight. This adapter fetches over
    /// <see cref="IJobContext.Http"/>, whose handler already enters the very
    /// same per-provider gate; the gate is a <c>SemaphoreSlim(1, 1)</c>
    /// released on ticket disposal, so holding a ticket around an HTTP call
    /// would not double-pace it, it would DEADLOCK the job until its budget ran
    /// out. Amazon's adapter takes tickets because its equivalent calls are
    /// browser navigations, which that handler cannot see.
    /// </remarks>
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
            // A dead session is the one failure worth propagating: every
            // remaining order would fail the same way, and the user has to sign
            // in again either way.
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
                // bol's only per-link text is an ACTION - "Bekijk factuur",
                // "Bekijk betaaloverzicht" - and not a name for the document.
                // ReceiptDocument.Name is what the provider CALLED it, so the
                // honest answer here is nothing at all.
                Name = null,
                Filename = $"bol-{order.Id}-invoice-{invoiceId}.pdf",
                SizeBytes = fetched.Bytes.Length,
                ContentBase64 = Convert.ToBase64String(fetched.Bytes),
            });
        }

        ctx.Note($"order '{order.Id}': attached {documents.Count} of {links.Count} invoice document(s)");
        return documents;
    }

    /// <summary>
    /// Whether what came back is really the document it claimed to be.
    ///
    /// Both halves earn their place. The media type is bol's claim, and it
    /// arrives as <c>application/pdf;charset=UTF-8</c> - a charset on a binary
    /// file - so it is read through <c>ContentType.MediaType</c>, which has
    /// already dropped the parameter. Comparing the raw header would reject
    /// every bol invoice there is.
    ///
    /// The magic number is the FILE's claim, and it is the half that catches a
    /// 200 that is really an error page wearing a PDF content type - which is
    /// exactly what a session dying mid-fetch produces.
    /// </summary>
    private bool IsDocument(BolDownload fetched) =>
        fetched.Status is 200
        && _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase)
        && fetched.Bytes.Length > _options.DocumentMagic.Count
        && fetched.Bytes.Take(_options.DocumentMagic.Count).SequenceEqual(_options.DocumentMagic);

    /// <summary>
    /// An account page, guarded for what an account page can actually say.
    ///
    /// Deliberately not <c>ReadPageAsync</c>: that one is shape-driven, and its
    /// guard is the trap - see <see cref="GuardAccountPage"/>.
    /// </summary>
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

    /// <summary>
    /// A document as bytes.
    ///
    /// <c>ReadAsByteArrayAsync</c> and never <c>ReadAsStringAsync</c>: decoding
    /// a PDF as text and re-encoding it corrupts it silently, and the resulting
    /// file still opens far enough to look plausible. The capture this was
    /// built from contains a live demonstration - the browser's own copy came
    /// back with seven thousand replacement characters in it.
    ///
    /// No <c>EnsureSuccessAsync</c>. A non-200 on a document is a note and a
    /// missing attachment, not a failed fetch.
    /// </summary>
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

        // Already parameter-free: MediaTypeHeaderValue has split the charset
        // off. This is the whole reason the raw header is never read here.
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;

        return new BolDownload((int)response.StatusCode, mediaType, bytes);
    }

    private void Guard(string body, string what) =>
        GuardWith(body, what, _options.LoginPageMarkers);

    /// <summary>
    /// The same judgement for a page that legitimately MENTIONS the login host.
    ///
    /// <see cref="BolOptions.LoginPageMarkers"/> includes
    /// <c>login.bol.com/wsp</c>, and bol's account pages each carry that string
    /// once - inside <c>"passwordForgottenUrl"</c>, on a page that is working
    /// perfectly. Guarding an order-details fetch with the ordinary list would
    /// therefore raise <c>session_expired</c> every single time and send a
    /// human off to sign in again for nothing.
    ///
    /// The bot-wall half is unchanged, because that half has no such problem.
    /// </summary>
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

    // ---- login ---------------------------------------------------------------

    /// <summary>
    /// Waits for the login to resolve into one of five outcomes: signed in, a
    /// one-time code to relay, a captcha, a stated credential error, or
    /// nothing recognisable.
    ///
    /// The last case is deliberately <c>provider_changed</c> and never
    /// <c>invalid_credentials</c>. Guessing "wrong password" from silence
    /// sends a user to reset a password that was fine, and a credential error
    /// is never retried - so the mistake is permanent for that session too.
    /// </summary>
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

            // First, because a device bol already trusts goes straight
            // through and everything below would be a probe against a page
            // that has already moved on.
            if (await signedIn.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return;

            await RefuseStatedAsync(page, ct).ConfigureAwait(false);

            if (!codeAnswered &&
                await page.FindAsync(_options.VerificationCodeSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
                    is not null)
            {
                await RelayCodeAsync(ctx, page, ct).ConfigureAwait(false);
                codeAnswered = true;

                // The budget measures how long bol takes to answer, so it
                // restarts once a wait on a human is over: the minutes they
                // spent finding a code are not the provider being slow, and
                // charging them to it fails a login that is about to work.
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

    /// <summary>
    /// The two verdicts the login page can state for itself, each ending the
    /// login with the secrets cleared off the page: a notice that names no
    /// cause, and a credential error.
    /// </summary>
    private async Task RefuseStatedAsync(ILoginPage page, CancellationToken ct)
    {
        // A generic notice is not a credential verdict. Lidl's login
        // answers an automated browser with exactly such a notice and
        // reading it as a bad password was a real bug, so anything
        // non-specific belongs here and reports what it is.
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

        // The one path that may report invalid_credentials, and only
        // because the page said so itself.
        if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            await page.ClearSecretsAsync(ct).ConfigureAwait(false);
            throw ConnectorException.InvalidCredentials($"{ProviderId}: the login page stated a credential error");
        }
    }

    /// <summary>
    /// The captcha standing on the page, faced through the shared gate, or
    /// null when none stands there. A redirect on the outcome means the wall
    /// came down and the login is in; a wall the gate could hand to nobody
    /// ends the login here, with the verdict the settle budget would have
    /// reached.
    /// </summary>
    private async Task<CaptchaOutcome?> FaceCaptchaAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter signedIn, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        var outcome = await _captcha.FaceAsync(ctx, page, signedIn, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null || outcome.Handled) return outcome;

        throw await UnsettledAsync(page, captchaSeen: true, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The verdict on a login that never resolved, with the secrets cleared
    /// off the page first. A captcha that was ever seen is the reason it did
    /// not; without one, nothing recognisable happened at all.
    /// </summary>
    private async Task<ConnectorException> UnsettledAsync(ILoginPage page, bool captchaSeen, CancellationToken ct)
    {
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        return captchaSeen
            ? ConnectorException.Blocked($"{ProviderId}: a captcha stood between the login and the account page")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the login neither completed nor stated anything recognisable within " +
                $"{_options.LoginSettleSeconds}s; last url was '{page.Url}'");
    }

    /// <summary>
    /// Relays the one-time code bol is assumed to send on a new device. Never
    /// solves anything: the code is in the account owner's mailbox or on their
    /// phone, and only they can read it.
    /// </summary>
    private async Task RelayCodeAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        var delivery = await DeliveryAsync(page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = BolMessageKeys.VerificationCode,
            Delivery = delivery,
            // Null unless a live run has actually seen the screen: a wrong
            // length makes the consumer reject a valid code before it is ever
            // tried, and the user waits for another one.
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
            // Some code forms submit on the last keystroke and have no button
            // at all, which is what the Enter carries.
            await page.AnswerAsync(_options.VerificationCodeSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Which way the code was sent, for the prompt the human reads.
    ///
    /// bol's credential is an e-mail address, so a mailbox is the default -
    /// but the page's own word beats the inference whenever it gives one,
    /// because telling somebody to watch a phone that will never ring is the
    /// failure they cannot recover from: the challenge expires while they wait.
    /// </summary>
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

        // What the user typed is the best evidence left: bol signs people in
        // with an address, so a mailbox is where it can reach them.
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

/// <summary>
/// Makes bol's own page say the orders operation's hash.
///
/// The sign-in listens for the operation from before its first navigation
/// (see <see cref="BolPersistedQuery"/>); this is what happens when the page
/// the sign-in landed on stays silent. 2026-10-05 (user ss): it did - bol
/// lands a sign-in somewhere the overview is not, or renders the first page
/// on the server - so the probe opens the overview itself and, failing that,
/// presses "Toon meer", which fetches the next page through the very
/// operation the adapter needs. Behind <see cref="ILoginPage"/> so every
/// step is drivable offline.
/// </summary>
internal sealed class BolHashProbe
{
    private readonly BolOptions _options;

    public BolHashProbe(BolOptions options) => _options = options;

    /// <summary>The hash, or null when the page never said it; every step is noted on the job.</summary>
    public async Task<string?> LearnAsync(IJobContext ctx, ILoginPage page, Task<string> learned, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(learned);

        if (await ArrivedAsync(learned, ct).ConfigureAwait(false)) return learned.Result;

        // The landing page said nothing: the overview is where the operation
        // lives, so the browser goes there explicitly.
        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);
        if (await ArrivedAsync(learned, ct).ConfigureAwait(false))
        {
            ctx.Note($"{BolAdapter.ProviderId}: the orders overview fired the operation once opened");
            return learned.Result;
        }

        // 2026-10-06 (prod): the cookie wall over the overview swallowed the
        // "Toon meer" press - out of the way first
        await BolConsent.DismissAsync(ctx, page, _options, ct).ConfigureAwait(false);

        // A first page rendered on the server fires nothing until the next
        // one is asked for.
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

    /// <summary>Once more after the walls are taken down again; the probe is an optimisation and never the login's verdict.</summary>
    private const int LoadMoreAttempts = 2;

    /// <summary>
    /// "Toon meer", pressed with a budget of its own (2026-10-06/07, prod:
    /// three sign-ins died as `internal` on Playwright's 500 ms click budget -
    /// the button was found, scrolled to, and bol's second wall took the
    /// pointer) and once more after the walls are down again. False when the
    /// button is absent or still will not take the press, which is noted;
    /// the configured hash then stands.
    /// </summary>
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

/// <summary>
/// "Are we in yet?", for a provider whose success is a cookie rather than a
/// redirect.
///
/// Albert Heijn and Lidl Plus finish by sending the browser to a scheme
/// Chromium cannot open, so <see cref="RedirectWatcher"/> catches that one
/// event. bol has no such moment: it just stops being the login page and
/// starts being the account page. The signal is therefore the cookie jar,
/// and wearing <see cref="IRedirectWaiter"/> is what lets the shared
/// <see cref="CaptchaGate"/> - which watches "did the provider move on while
/// the human worked?" throughout an interactive challenge - be used here
/// unchanged rather than reimplemented with a subtly different idea of
/// success.
/// </summary>
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
        // Counted rather than clock-bounded. A caller holding a frozen
        // TimeProvider - which every test in this repo does - would otherwise
        // never reach a deadline computed from it, and the loop would spin
        // until the job's own budget ran out.
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
        // Still on the login host means nothing has happened yet, and it costs
        // no round trip to know that.
        if (_page.Url.Contains(_options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)) return false;

        var storageState = await _ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);
        return BolCookies.HasSession(storageState, _options);
    }
}
