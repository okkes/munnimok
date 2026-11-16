using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.MediaMarkt;

/// Rechecked 2026-08-11: the Cloudflare challenge and the persisted-query manifest are walls against non-browsers
/// (plain POST 403, real Chromium 200; the manifest forbids OUR documents). So no query or hash of ours: a signed-in
/// browser on the orders page lets MediaMarkt's JS ask and we read the answer. A bundle is a cookie jar only.
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

        // fail on blank inputs before leasing a browser: launching Chromium to find a blank field holds an agent for nothing
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

    /// the session is confirmed by asking for orders, not by URL: orders is a client-routed SPA (Coolblue sealed anonymous
    /// cookies, DUO "finished" in 80ms); waiting for the SAME call the fetch makes is free,
    /// and a signed-out browser never fires it
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IMediaMarktPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(portal);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // the PROTECTED page: MediaMarkt's own redirect to the form and back is the only way to end with a session in the app
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

        // wait without touching anything: the form's redirectURL lands the app on orders and it fires the query itself;
        // a navigation on top of a sign-in in flight cancels it (browser stuck on the form, password blamed)
        var observed = await portal
            .WatchAsync(_options.OrdersOperation, _options.OrdersCallTimeoutMs, ct)
            .ConfigureAwait(false);

        if (observed is not { } call)
        {
            // quote what the page shows: it tells a refused password from a second factor or a changed form
            var showing = await portal.DescribeAsync(ct).ConfigureAwait(false);

            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the app never asked for orders after the sign-in, so nobody is signed in. " +
                $"The browser is {showing}");
        }

        // a refusal here is not a bad password (the form accepted it): Body reports an expired-looking session or Cloudflare
        _ = MediaMarktCalls.Body(call, _options, _options.OrdersOperation, ctx.Note);

        return new LoginResult
        {
            Material = new SessionMaterial { StorageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false) },
            // named for the brand: the payload's holder name is not needed, so it is not kept
            Account = new ProviderAccount { DisplayName = Manifest.Name },
        };
    }

    /// the narrowest consent option, never "Alles accepteren": no opting the user into marketing tracking;
    /// the orders page works with necessary only. Best effort: a miss usually means no layer was shown
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

    /// the first page is WATCHED, not requested: the page's own GetCombinedOrdersV3 call carries its current persisted hash
    /// and is the template for later pages; MediaMarkt rotates that hash on every front-end deploy
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
            // emitted flagged and said aloud: a receipt whose lines miss its total is still a real purchase
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

    /// a document is an extra: a missing invoice is noted and the receipt stays; one page per order
    private async Task<List<Receipt>> WithInvoicesAsync(
        IJobContext ctx, IMediaMarktPortal portal, List<Receipt> receipts, CancellationToken ct)
    {
        var withDocuments = new List<Receipt>(receipts.Count);
        var opened = 0;
        var notOffered = 0;

        foreach (var receipt in receipts)
        {
            ct.ThrowIfCancellationRequested();

            if (opened >= _options.MaxDocumentOrdersPerFetch)
            {
                withDocuments.Add(receipt);
                continue;
            }

            opened++;
            var (document, offered) = await InvoiceAsync(ctx, portal, receipt.ExternalId, ct).ConfigureAwait(false);
            if (!offered) notOffered++;
            withDocuments.Add(document is null ? receipt : receipt with { Documents = [document] });

            await Task.Delay(TimeSpan.FromMilliseconds(_options.PageGapMs), _time, ct).ConfigureAwait(false);
        }

        if (notOffered > 0)
        {
            // said once, and as what it is (#430): no change on MediaMarkt's side to chase
            ctx.Note($"{ProviderId}: {notOffered} order(s) offer no invoice; MediaMarkt offers one on its recent orders only");
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

    private async Task<(ReceiptDocument? Document, bool Offered)> InvoiceAsync(
        IJobContext ctx, IMediaMarktPortal portal, string orderId, CancellationToken ct)
    {
        MediaMarktDocument? fetched;
        try
        {
            fetched = await portal.InvoiceAsync(orderId, ctx.Note, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (ex.Code is not ErrorCode.SessionExpired)
        {
            // a dead session is the one failure to propagate: every remaining order would fail the same way
            ctx.Note($"order '{orderId}': the invoice could not be fetched ({ex.Code}: {ex.Detail})");
            return (null, true);
        }

        if (ReferenceEquals(fetched, MediaMarktDocument.NotOffered)) return (null, false);
        return (Document(ctx, orderId, fetched), true);
    }

    private ReceiptDocument? Document(IJobContext ctx, string orderId, MediaMarktDocument? fetched)
    {
        if (fetched is null) return null;

        // judge by the declared media type, not the name: a sign-in page answered to a document link is text/html
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

            // a short page is the only end MediaMarkt states: the payload has no total count
            // measured on what MediaMarkt SENT, not on what Read() kept: Read drops unreadable orders,
            // so one odd order ended the walk reported complete
            if (MediaMarktOrders.Stated(document, _options) < _options.PageSize) break;

            // the oldest order is before the window, so every later page is too: spares a ten-year account twenty pages
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

    /// no StoreName: an order names only an outletId number, and a name would be invented or an internal id shown
    internal static Merchant Merchant() => new() { Id = ProviderId, Name = "MediaMarkt" };

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
