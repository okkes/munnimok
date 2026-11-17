using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Jumbo;

// T3: a browser drives an Auth0 login; the cookie it leaves serves plain HTTP GraphQL for about a day
// order amounts are decimal-string euros, declared per field, never inferred (declared minor once made totals a hundredth)
public sealed class JumboAdapter : IProviderAdapter
{
    public const string ProviderId = "jumbo";
    public const string ReceiptsResource = "receipts";

    // built from the options so the manifest's flow and the login this adapter performs cannot drift apart
    private readonly ProviderManifest Manifest;

    private readonly JumboOptions _options;
    private readonly IJumboGraphQlClient _graphql;
    private readonly IJumboReceiptLayoutParser _layout;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public JumboAdapter(
        JumboOptions? options = null, IJumboGraphQlClient? graphql = null, TimeProvider? time = null)
        : this(options, graphql, time, layout: null)
    {
    }

    internal JumboAdapter(
        JumboOptions? options,
        IJumboGraphQlClient? graphql,
        TimeProvider? time,
        IJumboReceiptLayoutParser? layout)
    {
        _options = options ?? new JumboOptions();
        _graphql = graphql ?? new HttpJumboGraphQlClient(_options);
        _layout = layout ?? new JumboPrintLayoutParser();
        _time = time ?? TimeProvider.System;

        Manifest = JumboManifest.Build();

        // policy shared with Albert Heijn and Lidl Plus; Auth0 ships hCaptcha, reCAPTCHA and Turnstile
        // and activates one on risk score: a widget is the likely wall
        _captcha = new CaptchaGate(new CaptchaSpec
        {
            ProviderId = ProviderId,
            Interactive = _options.InteractiveCaptchaSelectors,
            Image = _options.ImageCaptchaSelectors,
            Input = _options.CaptchaInputSelectors,
            ProbeMs = _options.ProbeMs,
            ImageSeconds = _options.ChallengeSeconds,
            InteractiveSeconds = _options.InteractiveCaptchaSeconds,
            PollSeconds = _options.SettlePollSeconds,
        }, _time);
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var login = new PlaywrightLoginPage(page, Manifest);
        var watcher = new JumboReturnWatcher(login, _options, _time);

        return await LoginAsync(ctx, login, watcher, ct).ConfigureAwait(false);
    }

    // credentials are OPTIONAL: a Turnstile token is minted in the rendering browser and cannot be relayed or solved
    // so on a walled day the half-filled page is streamed to the account owner, who carries on
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        // minted once at connect: a device that changes identity every run looks like what it is
        var deviceId = ctx.Material?.DeviceId ?? Guid.NewGuid().ToString();

        var username = OptionalInput(ctx, "username");
        var password = OptionalInput(ctx, "password");

        bool filled;
        try
        {
            // 302s to /api/auth/login and on to Auth0; the old /inloggen is a 404
            await page.GotoAsync(_options.LoginUrl, ct).ConfigureAwait(false);
            await DismissConsentAsync(page, ct).ConfigureAwait(false);

            // username first: not secret, so it may sit in the box while the page is photographed
            ctx.Progress(JobStep.Authenticating);

            var identified = username is not null
                             && await page.FillAsync(
                                    _options.UsernameSelectors, username, _options.SelectorTimeoutMs, ct)
                                .ConfigureAwait(false);

            // wall check before the password is typed or anything clicked: a walled day spends no attempt
            // interactive only: a picture captcha is relayable by the gate below, a widget (Turnstile) is not
            var walled = (await _captcha.DetectAsync(page, ct).ConfigureAwait(false)).Kind
                is CaptchaKind.Interactive;

            filled = identified
                     && !walled
                     && password is not null
                     && await FillPasswordAsync(ctx, page, password, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            // a page that would not settle (slow Auth0, moved consent layer) is not munni's fault: the run is handed over
            ctx.Note(
                $"jumbo: the typed sign-in did not complete ({ex.GetType().Name}: {ex.Message}); " +
                "the page is being handed over instead");
            filled = false;
        }

        if (!filled)
        {
            return await LiveLoginAsync(ctx, page, watcher, deviceId, ct).ConfigureAwait(false);
        }

        // latch before the credentials leave: a lost lease must fail the job, not requeue it, since a retried login locks an account
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("login submit", _options.SubmitSelectors);
        }

        try
        {
            await SettleAsync(ctx, page, watcher, ct).ConfigureAwait(false);
        }
        catch (ConnectorException ex) when (ex.Code is ErrorCode.BlockedByProvider or ErrorCode.ProviderChanged)
        {
            // a late wall, a one-time code or something unseen is answerable by the owner: hand over rather than fail
            // invalid_credentials must not come through here: it reaches the consumer so a stored credential is dropped
            return await LiveLoginAsync(ctx, page, watcher, deviceId, ct).ConfigureAwait(false);
        }

        ctx.Progress(JobStep.Finalizing);
        return await HarvestAsync(ctx, deviceId, ct).ConfigureAwait(false);
    }

    // false when the box never appeared: not a failure, the human on a streamed view can see what this could not
    private async Task<bool> FillPasswordAsync(
        IJobContext ctx, ILoginPage page, string password, CancellationToken ct)
    {
        // Auth0 may split the credentials over two screens; short probe, since on a single page it always misses
        if (await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            return true;
        }

        // advancing submits the identifier: latch first, or a lease lost after the click requeues a login that reached Jumbo
        ctx.CredentialSubmitted();

        return await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false)
               && await page.FillAsync(_options.PasswordSelectors, password, _options.SelectorTimeoutMs, ct)
                   .ConfigureAwait(false);
    }

    private static string? OptionalInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    // types nothing: Turnstile (auth0_v2) mints its token in the human's browser, so the browser goes to the human
    // no credential is posted or held (the validator refuses manifest fields)
    // CredentialSubmitted is NOT latched: the attempts are the human's own
    internal async Task<LoginResult> LiveLoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, string deviceId, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        // no navigation: the caller's page may carry the typed username
        // secrets cleared first: the redactor refuses to photograph a page with a filled secret field
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // raised on its own: a live view's answer is empty, the session appearing is what ends it; linked so the ask can be ended
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
                    return await HarvestAsync(ctx, deviceId, ct).ConfigureAwait(false);
                }

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                "jumbo: the live login ended without reaching a session; the sign-in was not completed");
        }
        finally
        {
            // cancelling stops the shutter, releases the browser and lets the job finish
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    // the cookies are the credential: a login that left none did not happen, whatever the URL
    private async Task<LoginResult> HarvestAsync(IJobContext ctx, string deviceId, CancellationToken ct)
    {
        var storageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false);

        if (JumboCookies.Extract(storageState, _options.CookieDomainSuffix).Count == 0)
        {
            throw ConnectorException.ProviderChanged("jumbo: login left no jumbo.com cookies behind");
        }

        return new LoginResult
        {
            Material = new SessionMaterial { StorageState = storageState, DeviceId = deviceId },
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            ExpiresAt = _time.GetUtcNow().AddSeconds(JumboManifest.SessionTtlSeconds),
        };
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"jumbo: no resource '{request.ResourceId}'");
        }

        // optional: the working client sends no device header, so refusing would send users back through a login
        // for a header the API may never read
        var deviceId = ctx.Material?.DeviceId;

        ctx.Progress(JobStep.Downloading);

        var zone = RetailZones.Dutch;
        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;

        var walk = await WalkAsync(ctx, deviceId, request, zone, cap, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Parsing);

        var receipts = new List<Receipt>(walk.Orders.Count + walk.StoreReceipts.Count);
        var complete = walk.Complete;
        var emitted = new HashSet<string>(StringComparer.Ordinal);

        // Keyed by the external id its receipt carries, which is how a consumer
        // pairs the two back up.
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var order in walk.Orders)
        {
            ct.ThrowIfCancellationRequested();

            var (receipt, document) = await OnlineReceiptAsync(ctx, deviceId, order, request, ct)
                .ConfigureAwait(false);

            receipts.Add(receipt);
            if (document is not null) raw[receipt.ExternalId] = document;

            emitted.Add(order.OrderId);
        }

        foreach (var summary in walk.StoreReceipts)
        {
            ct.ThrowIfCancellationRequested();

            // A till record of an online order carries that order's id in its
            // transaction id. Emitting both would count one shop twice.
            if (_options.DeduplicateOnlineStoreReceipts &&
                string.Equals(summary.Source, _options.OnlineReceiptSource, StringComparison.OrdinalIgnoreCase) &&
                summary.OrderId is { } orderId && emitted.Contains(orderId))
            {
                continue;
            }

            var (receipt, document) = await StoreReceiptAsync(ctx, deviceId, summary, request.WantsRaw, ct)
                .ConfigureAwait(false);

            if (receipt is null)
            {
                // only with SkipUnreadableStoreReceipts: the pass is partial and says so
                complete = false;
                continue;
            }

            receipts.Add(receipt);
            if (document is not null) raw[receipt.ExternalId] = document;
        }

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Receipts = [.. receipts.OrderByDescending(r => r.PurchasedAt)],
            Complete = complete,
            // nothing rotates: Jumbo's backend exchanges the Auth0 tokens into the cookie, the browser holds no refresh token
            Via = "graphql",
            Raw = raw,
        };
    }

    private enum SettleStep
    {
        Nothing,

        SignedIn,

        CodeAnswered,

        /// <summary>A wall stood and was carried to the human; the page is still worth watching.</summary>
        WallRelayed,

        WallStanding,
    }

    // the last case is provider_changed, not invalid_credentials: guessing "wrong password" from silence
    // sends users to reset a good password, and credential errors are never retried
    internal async Task SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
        var captchaSeen = false;
        var mfaAnswered = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var step = await SettleOnceAsync(ctx, page, watcher, mfaAnswered, captchaSeen, ct)
                .ConfigureAwait(false);

            if (step is SettleStep.SignedIn) return;

            if (step is SettleStep.WallStanding)
            {
                captchaSeen = true;
                break;
            }

            // the settle budget measures Jumbo's answer time: it restarts after a wait on a human
            if (step is SettleStep.CodeAnswered)
            {
                mfaAnswered = true;
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (step is SettleStep.WallRelayed)
            {
                captchaSeen = true;
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        throw captchaSeen
            ? ConnectorException.Blocked("jumbo: a captcha stood between the login and the session")
            : ConnectorException.ProviderChanged(
                $"jumbo: the login neither produced a session nor stated an error within " +
                $"{_options.LoginSettleSeconds}s; last url was '{page.Url}'");
    }

    private async Task<SettleStep> SettleOnceAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, bool mfaAnswered, bool captchaSeen,
        CancellationToken ct)
    {
        var poll = TimeSpan.FromSeconds(_options.SettlePollSeconds);

        if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is not null) return SettleStep.SignedIn;

        // the only path that may report invalid_credentials; nothing retries it
        if (await page.FindAsync(_options.LoginErrorSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            throw ConnectorException.InvalidCredentials("jumbo: the login page stated a credential error");
        }

        if (!mfaAnswered &&
            await page.FindAsync(_options.MfaCodeSelectors, _options.ProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            await AnswerCodeAsync(ctx, page, ct).ConfigureAwait(false);
            return SettleStep.CodeAnswered;
        }

        if (captchaSeen) return SettleStep.Nothing;

        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return SettleStep.Nothing;

        // the gate relays a picture and refuses an interactive widget when nobody is at the browser; it never solves one
        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null) return SettleStep.SignedIn;

        return outcome.Handled ? SettleStep.WallRelayed : SettleStep.WallStanding;
    }

    // never solves: the code is on the owner's phone or in their mailbox
    private async Task AnswerCodeAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        // delivery unset: Auth0 sends the code as the account is configured, and naming a phone that never rings strands the user
        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.MfaCode,
            PromptKey = MessageKeys.VerificationCode,
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.ChallengeSeconds),
        }, ct).ConfigureAwait(false);

        if (!await page.AnswerAsync(_options.MfaCodeSelectors, answer.Value, _options.SelectorTimeoutMs, ct)
                .ConfigureAwait(false))
        {
            throw Missing("verification code field", _options.MfaCodeSelectors);
        }

        ctx.Progress(JobStep.Authenticating);
    }

    private async Task DismissConsentAsync(ILoginPage page, CancellationToken ct)
    {
        // best effort: a missing consent wall is the normal case on a fresh profile
        await page.ClickAsync(_options.ConsentSelectors, 2_000, ct).ConfigureAwait(false);
    }

    private sealed record Walk
    {
        public required List<JumboOrderSummary> Orders { get; init; }

        public required List<JumboStoreReceiptSummary> StoreReceipts { get; init; }

        public required bool Complete { get; init; }
    }

    // online orders page by offset/limit inside ordersInput, receipts by a top-level zero-based page
    // separate cursors: each side stops on its own
    private async Task<Walk> WalkAsync(
        IJobContext ctx, string? deviceId, ResourceRequest request, TimeZoneInfo zone, int cap, CancellationToken ct)
    {
        var orders = new List<JumboOrderSummary>();
        var receipts = new List<JumboStoreReceiptSummary>();
        var seenOrders = new HashSet<string>(StringComparer.Ordinal);
        var seenReceipts = new HashSet<string>(StringComparer.Ordinal);

        var ordersOffset = 0;
        var receiptsPage = 0;
        var ordersDone = false;
        var receiptsDone = false;
        var complete = true;

        for (var pass = 0; pass < _options.MaxPages && !(ordersDone && receiptsDone); pass++)
        {
            ct.ThrowIfCancellationRequested();

            using var document = await ExecuteAsync(ctx, deviceId, new JumboGraphQlRequest
            {
                OperationName = _options.ListOperationName,
                Query = _options.ListDocument,
                Variables = ListVariables(ordersOffset, receiptsPage),
            }, ct).ConfigureAwait(false);

            var root = document.RootElement;

            if (!ordersDone)
            {
                ordersDone = CollectOrdersPage(root, request, zone, cap, orders, seenOrders);
                ordersOffset += _options.OrdersPageSize;
            }

            if (!receiptsDone)
            {
                receiptsDone = CollectReceiptsPage(root, request, zone, cap, receipts, seenReceipts);
                receiptsPage++;
            }

            ctx.Found(orders.Count + receipts.Count);
        }

        // out of passes with a side still going: there is more upstream, and the caller must be told
        if (!ordersDone || !receiptsDone) complete = false;

        var selectedOrders = orders.OrderByDescending(o => o.PurchasedAt).ToList();
        if (selectedOrders.Count > cap)
        {
            selectedOrders = [.. selectedOrders.Take(cap)];
            complete = false;
        }

        // an in-store receipt states its total only in its detail: one extra round trip each, budgeted newest-first
        // the oldest fall off and the pass reports itself partial rather than hammering a defended endpoint
        var room = Math.Max(0, Math.Min(cap - selectedOrders.Count, _options.StoreReceiptDetailBudget));
        var selectedReceipts = receipts.OrderByDescending(r => r.PurchasedAt).ToList();
        if (selectedReceipts.Count > room)
        {
            selectedReceipts = [.. selectedReceipts.Take(room)];
            complete = false;
        }

        return new Walk
        {
            Orders = selectedOrders,
            StoreReceipts = selectedReceipts,
            Complete = complete,
        };
    }

    private bool CollectOrdersPage(
        JsonElement root, ResourceRequest request, TimeZoneInfo zone, int cap,
        List<JumboOrderSummary> orders, HashSet<string> seen)
    {
        var rows = JumboOrders.Rows(root, _options);
        var fresh = 0;
        var older = 0;

        foreach (var row in rows)
        {
            var summary = JumboOrders.ParseSummary(row, _options, zone, request.WantsRaw);
            if (summary is null) continue;              // unkeyable rows cannot be deduped
            if (!seen.Add(summary.OrderId)) continue;

            fresh++;
            if (request.Since is { } since && DateOnly.FromDateTime(summary.PurchasedAt.Date) < since) older++;
            if (ReceiptFactory.InWindow(summary.PurchasedAt, request)) orders.Add(summary);
        }

        var stated = JumboOrders.TotalCount(root, _options);

        return rows.Count == 0
               // an offset that advances nothing: carrying on repeats the request against a defended endpoint
               || fresh == 0
               // newest first: a page entirely below the window means every later page is too
               || older == rows.Count
               || rows.Count < _options.OrdersPageSize
               || (stated is { } total && seen.Count >= total)
               || orders.Count > cap;
    }

    private bool CollectReceiptsPage(
        JsonElement root, ResourceRequest request, TimeZoneInfo zone, int cap,
        List<JumboStoreReceiptSummary> receipts, HashSet<string> seen)
    {
        var rows = JumboStoreReceipts.Rows(root, _options);
        var fresh = 0;
        var older = 0;

        foreach (var row in rows)
        {
            var summary = JumboStoreReceipts.ParseSummary(row, _options, zone);
            if (summary is null) continue;
            if (!seen.Add(summary.TransactionId)) continue;

            fresh++;
            if (request.Since is { } since && DateOnly.FromDateTime(summary.PurchasedAt.Date) < since) older++;
            if (ReceiptFactory.InWindow(summary.PurchasedAt, request)) receipts.Add(summary);
        }

        // receiptOverview states totalResults: the walk ends on a number, not a heuristic
        var stated = JumboStoreReceipts.TotalResults(root, _options);

        return rows.Count == 0
               || fresh == 0
               || older == rows.Count
               || rows.Count < _options.ReceiptsPageSize
               || (stated is { } total && seen.Count >= total)
               || receipts.Count > cap;
    }

    private async Task<(Receipt Receipt, string? Raw)> OnlineReceiptAsync(
        IJobContext ctx, string? deviceId, JumboOrderSummary order, ResourceRequest request, CancellationToken ct)
    {
        var detail = new JumboOrderDetail();

        // the list row stands in until a detail call: raw without items would otherwise hand back nothing
        var raw = order.Raw;

        if (request.WantsItems)
        {
            // the detail is the expensive call and most likely to trip protection: only when items are asked
            // the total still comes from the list, so the two are a real reconciliation pair
            using var document = await ExecuteAsync(ctx, deviceId, new JumboGraphQlRequest
            {
                OperationName = _options.OrderDetailOperationName,
                Query = _options.OrderDetailDocument,
                Variables = OrderDetailVariables(order.OrderId),
            }, ct).ConfigureAwait(false);

            detail = JumboOrders.ParseDetail(
                document.RootElement, _options, order.Total.Currency, order.OrderId);

            // the detail document is the richer raw
            if (request.WantsRaw) raw = document.RootElement.GetRawText();
        }

        return (ReceiptFactory.Build(
            ctx.SessionId,
            OrderExternalId(order.OrderId),
            JumboReceipts.Merchant(order.StoreName),
            order.PurchasedAt,
            order.Total,
            detail.Payment,
            detail.Items), raw);
    }

    private async Task<(Receipt? Receipt, string? Raw)> StoreReceiptAsync(
        IJobContext ctx, string? deviceId, JumboStoreReceiptSummary summary, bool keepRaw, CancellationToken ct)
    {
        // always fetched: the list states no total, so nothing else says anything about the purchase
        using var document = await ExecuteAsync(ctx, deviceId, new JumboGraphQlRequest
        {
            OperationName = _options.DigitalReceiptOperationName,
            Query = _options.DigitalReceiptDocument,
            Variables = new JsonObject { ["transactionId"] = summary.TransactionId },
        }, ct).ConfigureAwait(false);

        var storeName = JumboStoreReceipts.StoreName(document.RootElement, _options) ?? summary.StoreName;
        var layout = JumboStoreReceipts.Layout(document.RootElement, _options, summary.TransactionId);

        if (layout is null)
        {
            return (Unreadable(summary.TransactionId,
                $"its receiptImage is not a '{_options.DigitalReceiptJsonType}' layout, and nothing else in " +
                "Jumbo's API states an in-store total"), null);
        }

        var contents = _layout.Parse(layout, _options, _options.Currency);

        if (contents.Total is not { } total)
        {
            return (Unreadable(summary.TransactionId,
                $"its printed layout yielded no total ({contents.Shortfall ?? "no reason given"})"), null);
        }

        var receipt = ReceiptFactory.Build(
            ctx.SessionId,
            ReceiptExternalId(summary.TransactionId),
            JumboReceipts.Merchant(storeName),
            summary.PurchasedAt,
            total,
            ReceiptFactory.Payment(contents.PaymentMethod),
            contents.Items);

        var raw = keepRaw ? document.RootElement.GetRawText() : null;

        // a half-read layout must not claim to reconcile: an empty item list reconciles trivially
        // the content hash covers facts, not the verdict, so overriding it keeps the hash correct
        return (contents.Shortfall is null ? receipt : receipt with { Reconciled = false }, raw);
    }

    private Receipt? Unreadable(string transactionId, string why)
    {
        if (_options.SkipUnreadableStoreReceipts) return null;

        throw ConnectorException.ProviderChanged(
            $"jumbo: in-store receipt '{transactionId}' cannot be stated because {why}");
    }

    private async Task<JsonDocument> ExecuteAsync(
        IJobContext ctx, string? deviceId, JumboGraphQlRequest request, CancellationToken ct)
    {
        var document = await _graphql.ExecuteAsync(ctx, request, deviceId, ct).ConfigureAwait(false);

        try
        {
            // GraphQL reports failures in the body with a 200: errors are read before the data is trusted
            JumboGraphQlErrors.Throw(document.RootElement);
        }
        catch
        {
            document.Dispose();
            throw;
        }

        return document;
    }

    // offset/limit live inside ordersInput while page/pageSize are top level: two paginations over two systems
    internal JsonObject ListVariables(int offset, int page) => new()
    {
        ["ordersInput"] = new JsonObject
        {
            ["offset"] = offset,
            ["limit"] = _options.OrdersPageSize,
            ["direction"] = _options.OrdersDirection,
            ["sortBy"] = _options.OrdersSortBy,
            ["statusCategory"] = _options.OrdersStatusCategory,
        },
        ["page"] = page,
        ["pageSize"] = _options.ReceiptsPageSize,
    };

    // $orderId is Float!, so it goes as a number: the string Jumbo handed us is a schema validation error
    internal static JsonObject OrderDetailVariables(string orderId)
    {
        if (!double.TryParse(orderId, NumberStyles.Float, CultureInfo.InvariantCulture, out var numeric))
        {
            throw ConnectorException.ProviderChanged(
                $"jumbo: order id '{orderId}' is not a number, but OrderPagesOrder declares $orderId as Float!");
        }

        return new JsonObject { ["orderId"] = numeric };
    }

    // prefixed: the two halves of Jumbo mint their own ids, which could collide in the dedupe set
    internal static string OrderExternalId(string orderId) => $"order-{orderId}";

    internal static string ReceiptExternalId(string transactionId) => $"receipt-{transactionId}";

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");
}

// "signed in" is on jumbo.com and off every login marker: Jumbo's backend exchanges the Auth0 code at
// /api/auth/callback, so the browser sees only a cookie and a redirect
internal sealed class JumboReturnWatcher : IRedirectWaiter
{
    private const int PollMilliseconds = 250;

    private readonly ILoginPage _page;
    private readonly JumboOptions _options;
    private readonly TimeProvider _time;

    public JumboReturnWatcher(ILoginPage page, JumboOptions options, TimeProvider time)
    {
        _page = page;
        _options = options;
        _time = time;
    }

    // both halves needed: about:blank and error pages are on neither; auth.jumbo.com ends in the shop's domain but is the login
    internal static bool IsSignedIn(string? url, JumboOptions options)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!url.Contains(options.CookieDomainSuffix, StringComparison.OrdinalIgnoreCase)) return false;

        return !options.LoginUrlMarkers.Any(m => url.Contains(m, StringComparison.OrdinalIgnoreCase));
    }

    public async Task<string?> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow() + timeout;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var url = _page.Url;
            if (IsSignedIn(url, _options)) return url;
            if (_time.GetUtcNow() >= deadline) return null;

            await Task.Delay(TimeSpan.FromMilliseconds(PollMilliseconds), _time, ct).ConfigureAwait(false);
        }
    }
}

// a factory so adding Jumbo to the shared registry is a single line
public static class JumboRegistration
{
    public static IProviderAdapter Create(JumboOptions? options = null, TimeProvider? time = null) =>
        new JumboAdapter(options, graphql: null, time);
}
