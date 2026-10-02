using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// <summary>
/// MediaMarkt: the provider this project wrote off, and the cheapest fetch it
/// has.
///
/// The July research said "do not build", on two blockers that were both real:
/// a Cloudflare interactive challenge on the API, and a persisted-query
/// manifest forbidding a query of our own. Re-checked from a browser on
/// 2026-08-11, both are walls against the wrong kind of client. The challenge
/// answers a non-browser - the same endpoint returned 403 to a plain POST and
/// 200 to twenty-two calls from a real Chromium minutes later - and the query
/// manifest forbids OUR documents, not MediaMarkt's own.
///
/// So this adapter never writes a query and never learns a hash. It puts a
/// signed-in browser on the orders page, lets MediaMarkt's javascript ask its
/// own question, and reads the answer. Paging is that same request with one
/// parameter changed. See <see cref="IMediaMarktPortal"/>.
/// </summary>
/// <remarks>
/// A bundle from this provider holds a cookie jar and nothing else. No token of
/// any kind is issued: every authenticated request in the capture carried no
/// authorization header, which was checked across all of them rather than
/// assumed.
/// </remarks>
public sealed class MediaMarktAdapter : IProviderAdapter
{
    public const string ProviderId = "mediamarkt-nl";
    public const string ReceiptsResource = "receipts";

    private static readonly ProviderManifest Manifest = MediaMarktManifest.Build();

    private readonly MediaMarktOptions _options;
    private readonly TimeProvider _time;

    public MediaMarktAdapter(MediaMarktOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new MediaMarktOptions();
        _time = time ?? TimeProvider.System;
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // Everything that can fail without contacting anybody, before a browser
        // is leased. Launching Chromium to discover a blank field holds an agent
        // for nothing.
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await LoginAsync(
                ctx,
                new PlaywrightLoginPage(page, Manifest),
                new PageMediaMarktPortal(page, _options),
                ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// The login, behind the seam so the offline suite can drive it.
    /// </summary>
    /// <remarks>
    /// THE SESSION IS CONFIRMED BY ASKING FOR ORDERS, not by reading a URL.
    /// <para>
    /// Landing back on <c>/nl/myaccount/orders</c> proves nothing: it is a
    /// client-routed SPA, so the address bar says "orders" while the app is
    /// still deciding whether to send the visitor to a login form. Coolblue
    /// sealed a jar of anonymous cookies that way, and DUO reported a finished
    /// login eighty milliseconds after opening, having asked the human nothing.
    /// </para>
    /// The check here is the strongest available and costs nothing extra: it
    /// waits for the SAME call the fetch will make and requires it to answer.
    /// A signed-out browser never fires it.
    /// </remarks>
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IMediaMarktPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(portal);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // The PROTECTED page. MediaMarkt's own redirect takes the browser to
        // the form carrying `redirectURL`, and its own callback brings it back -
        // which is both the journey a shopper takes and the only one that ends
        // with the app holding a session.
        await page.GotoAsync(_options.OrdersPageUrl, ct).ConfigureAwait(false);

        await ConsentAsync(ctx, page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("the e-mail box", _options.UsernameSelectors);
        }

        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("the password box", _options.PasswordSelectors);
        }

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            throw Missing("the sign-in button", _options.SubmitSelectors);
        }

        ctx.Progress(JobStep.Finalizing);

        // AND NOW WAIT, WITHOUT TOUCHING ANYTHING.
        //
        // The form carries redirectURL=/nl/myaccount/orders, so MediaMarkt's own
        // app lands on the orders page and fires the query by itself. The first
        // live run navigated here instead - and a navigation on top of a sign-in
        // still in flight cancels it, which produced a browser sitting on the
        // login form and an adapter blaming the password.
        var observed = await portal
            .WatchAsync(_options.OrdersOperation, _options.OrdersCallTimeoutMs, ct)
            .ConfigureAwait(false);

        if (observed is not { } call)
        {
            // What the page IS showing, quoted. MediaMarkt renders its own
            // message into the form, so this distinguishes a refused password
            // from a second factor from a changed form - none of which the
            // first version of this message could tell apart.
            var showing = await portal.DescribeAsync(ct).ConfigureAwait(false);

            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the app never asked for orders after the sign-in, so nobody is signed in. " +
                $"The browser is {showing}");
        }

        // A refusal here is not a bad password - the form accepted it. Left to
        // say what it is: an expired-looking session, or Cloudflare.
        _ = MediaMarktCalls.Body(call, _options, _options.OrdersOperation, ctx.Note);

        return new LoginResult
        {
            // The cookie jar and nothing else.
            Material = new SessionMaterial { StorageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false) },
            // Named for the brand rather than the person. The payload does carry
            // the account holder's name, and using it would mean keeping a name
            // this connector has no need for.
            Account = new ProviderAccount { DisplayName = Manifest.Name },
        };
    }

    /// <summary>
    /// The cookie wall, answered with the narrowest option and never with
    /// "Alles accepteren".
    /// </summary>
    /// <remarks>
    /// Best effort by design: the layer only appears on a profile that has not
    /// answered it, so a miss usually means it was not there. What must NOT
    /// happen is the broad answer - a connector signing in on somebody's behalf
    /// has no business opting them into marketing tracking, and the account
    /// holder confirmed the orders page works with the necessary categories
    /// only.
    /// </remarks>
    private async Task ConsentAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        if (!await page.ClickAsync(_options.ConsentNecessarySelectors, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            return;
        }

        if (await page.ClickAsync(_options.ConsentSaveSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            ctx.Note($"{ProviderId}: answered the cookie layer with the necessary categories only");
        }
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await FetchAsync(ctx, request, new PageMediaMarktPortal(page, _options), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The order history: one observed call, then as many pages as the window
    /// needs.
    /// </summary>
    /// <remarks>
    /// The first page is not requested - it is WATCHED. Navigating to the orders
    /// page makes MediaMarkt's own client fire <c>GetCombinedOrdersV3</c> with
    /// its own current persisted hash, and that request is both the first page
    /// of data and the template every later page is built from.
    /// <para>
    /// Which means a fetch cannot ask for page two without having seen page one,
    /// and that is fine: page one is the page a caller almost always wants, and
    /// the alternative is keeping a hash that MediaMarkt rotates on every
    /// front-end deploy.
    /// </para>
    /// </remarks>
    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx, ResourceRequest request, IMediaMarktPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(portal);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        ctx.Progress(JobStep.Downloading);

        var first = await portal
            .ObserveAsync(_options.OrdersPageUrl, _options.OrdersOperation, _options.OrdersCallTimeoutMs, ct)
            .ConfigureAwait(false);

        if (first is not { } opening)
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: the orders page never asked for orders, which is what it does when nobody " +
                "is signed in. The stored session is over.");
        }

        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;
        var (orders, complete) = await WalkAsync(ctx, request, portal, opening, cap, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Normalizing);

        var receipts = new List<Receipt>();
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var order in orders
                     .Where(order => ReceiptFactory.InWindow(order.PurchasedAt, request))
                     .OrderByDescending(order => order.PurchasedAt))
        {
            if (receipts.Count >= cap)
            {
                complete = false;
                break;
            }

            receipts.Add(ReceiptFactory.Build(
                ctx.SessionId,
                order.Id,
                Merchant(),
                order.PurchasedAt,
                order.Total,
                order.Payment,
                request.WantsItems ? order.Items : []));

            if (order.Raw is { } payload) raw[order.Id] = payload;
        }

        if (request.WantsInvoice)
        {
            receipts = await WithInvoicesAsync(ctx, portal, receipts, ct).ConfigureAwait(false);
        }

        var unreconciled = receipts.Count(receipt => !receipt.Reconciled);

        if (unreconciled > 0)
        {
            // Emitted anyway, flagged, and said out loud. A receipt whose lines
            // disagree with its total is still a real purchase, and the four
            // money identities this reader is built on held across every order
            // in the capture - so one that fails is news.
            ctx.Note(
                $"{ProviderId}: {unreconciled} receipt(s) have line items that do not sum to the stated " +
                "total; they are returned with reconciled=false rather than dropped");
        }

        return new FetchResult
        {
            Receipts = receipts,
            Complete = complete,
            Raw = raw,
            Via = request.WantsInvoice ? _options.OrdersOperation + "+invoice-pdf" : _options.OrdersOperation,
        };
    }

    /// <summary>
    /// The invoice for each receipt, newest first, up to the ceiling. One page
    /// per order, so it costs what it costs; a missing one is noted and the
    /// receipt stays - a document is an extra the caller asked for, never a
    /// reason to lose the purchase (user request 2026-10-02: MediaMarkt was
    /// expected to carry its invoices).
    /// </summary>
    private async Task<List<Receipt>> WithInvoicesAsync(
        IJobContext ctx, IMediaMarktPortal portal, List<Receipt> receipts, CancellationToken ct)
    {
        var withDocuments = new List<Receipt>(receipts.Count);
        var opened = 0;

        foreach (var receipt in receipts)
        {
            ct.ThrowIfCancellationRequested();

            if (opened >= _options.MaxDocumentOrdersPerFetch)
            {
                withDocuments.Add(receipt);
                continue;
            }

            opened++;
            var document = await InvoiceAsync(ctx, portal, receipt.ExternalId, ct).ConfigureAwait(false);
            withDocuments.Add(document is null ? receipt : receipt with { Documents = [document] });

            await Task.Delay(TimeSpan.FromMilliseconds(_options.PageGapMs), _time, ct).ConfigureAwait(false);
        }

        if (receipts.Count > _options.MaxDocumentOrdersPerFetch)
        {
            ctx.Note(
                $"{ProviderId}: {receipts.Count - _options.MaxDocumentOrdersPerFetch} order(s) past the " +
                $"{_options.MaxDocumentOrdersPerFetch}-order invoice ceiling came back without one; the next " +
                "sync asks for theirs");
        }

        return withDocuments;
    }

    /// <summary>One order's invoice as a document, or null with the reason noted.</summary>
    private async Task<ReceiptDocument?> InvoiceAsync(
        IJobContext ctx, IMediaMarktPortal portal, string orderId, CancellationToken ct)
    {
        MediaMarktDocument? fetched;
        try
        {
            fetched = await portal.InvoiceAsync(orderId, ctx.Note, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (ex.Code is not ErrorCode.SessionExpired)
        {
            // A dead session is the one failure worth propagating: every
            // remaining order would fail the same way.
            ctx.Note($"order '{orderId}': the invoice could not be fetched ({ex.Code}: {ex.Detail})");
            return null;
        }

        if (fetched is null) return null;

        // What it says it is, not what it is called: a sign-in page answered
        // to a document link is text/html, and attaching it would hand
        // somebody a download that opens to nothing.
        var wanted = _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase);
        if (fetched.Status is not 200 || !wanted || fetched.Bytes.Length == 0)
        {
            ctx.Note(
                $"order '{orderId}': the invoice answered {fetched.Status} '{fetched.MediaType}' with " +
                $"{fetched.Bytes.Length} byte(s); not attached");
            return null;
        }

        return new ReceiptDocument
        {
            Kind = ReceiptDocumentKinds.Invoice,
            MediaType = fetched.MediaType,
            Name = "Factuur",
            Filename = string.IsNullOrWhiteSpace(fetched.Filename) ? $"mediamarkt-{orderId}.pdf" : fetched.Filename,
            SizeBytes = fetched.Bytes.Length,
            ContentBase64 = Convert.ToBase64String(fetched.Bytes),
        };
    }

    /// <summary>
    /// The observed first page, then as many more as the window needs. Not
    /// complete when the walk stopped short of the history's end.
    /// </summary>
    private async Task<(List<MediaMarktOrder> Orders, bool Complete)> WalkAsync(
        IJobContext ctx, ResourceRequest request, IMediaMarktPortal portal, MediaMarktCall opening, int cap,
        CancellationToken ct)
    {
        var orders = new List<MediaMarktOrder>();
        var page = 0;
        var call = opening;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var body = MediaMarktCalls.Body(
                call, _options, $"{_options.OrdersOperation} page {page + 1}", ctx.Note);

            using var document = JsonDocument.Parse(body);
            var read = MediaMarktOrders.Read(document, _options, request.WantsRaw);

            orders.AddRange(read);
            ctx.Found(orders.Count);
            page++;

            // A SHORT PAGE IS THE END, and it is the only end MediaMarkt states.
            // The payload carries no total count anywhere - confirmed across
            // every captured response - so a walk either stops on a page that
            // came back smaller than it asked for, or it never stops.
            //
            // MEASURED ON WHAT MEDIAMARKT SENT, not on what could be read.
            // Read() drops an order it cannot make a receipt of, so counting
            // its output made one odd order look like the end of history: the
            // walk stopped there and reported itself complete, cutting the rest
            // of somebody's purchases off with nothing to say so.
            if (MediaMarktOrders.Stated(document, _options) < _options.PageSize) break;

            // The oldest order on this page is already before the window, so
            // every page after it is too. Checked here rather than after the
            // whole walk, because a ten-year-old account is twenty pages a
            // caller asked nothing about.
            if (read.Count > 0 && read.All(order => Older(order, request))) break;

            if (page >= _options.MaxPages || orders.Count >= cap)
            {
                ctx.Note(
                    $"{ProviderId}: stopped after {page} page(s) with {orders.Count} order(s); " +
                    "there may be more, so this pass is partial");
                return (orders, false);
            }

            await Task.Delay(TimeSpan.FromMilliseconds(_options.PageGapMs), _time, ct).ConfigureAwait(false);

            var next = MediaMarktCalls.AtOffset(opening.Url, _options.PageSize, page * _options.PageSize, _options);

            call = await portal
                .ReadAsync(next, opening.Headers ?? new Dictionary<string, string>(StringComparer.Ordinal), ct)
                .ConfigureAwait(false);
        }

        return (orders, true);
    }

    /// <summary>
    /// MediaMarkt as a merchant.
    /// </summary>
    /// <remarks>
    /// No <c>StoreName</c>, deliberately. A collected order names an
    /// <c>outletId</c> - a number - and never the shop it belongs to; turning
    /// "901" into a store name would mean inventing one, and showing the number
    /// itself would put a MediaMarkt internal id in front of a user as if it
    /// meant something.
    /// </remarks>
    internal static Merchant Merchant() => new() { Id = ProviderId, Name = "MediaMarkt" };

    /// <summary>Is this order older than the window the caller asked for?</summary>
    private static bool Older(MediaMarktOrder order, ResourceRequest request) =>
        request.Since is { } since && DateOnly.FromDateTime(order.PurchasedAt.Date) < since;

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidCredentials($"{ProviderId}: '{key}' is required");

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: could not find {what} on the sign-in form. Tried: {string.Join(", ", selectors)}");
}
