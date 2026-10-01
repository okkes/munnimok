using System.Net;
using Connector.Kit.Adapters;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Coolblue;

/// <summary>
/// Coolblue: the best front door of any retailer here, and behind it the most
/// expensive order fetch.
///
/// Coolblue runs a standards-compliant OpenID Connect flow with S256 PKCE at
/// <c>accounts.coolblue.nl</c>, offering <c>offline_access</c> and a real
/// <c>refresh_token</c> grant, with no bot wall and no captcha on the form.
/// All CONFIRMED from Coolblue's own discovery document - and this adapter
/// touches none of it.
///
/// It cannot, and finding out took two live runs. Driving that flow ourselves
/// signs a human in to the identity server and leaves <c>www.coolblue.nl</c>
/// ANONYMOUS, because Coolblue's own callback page has no verifier for a flow
/// it never started. So the login goes where a shopper goes - the protected
/// page - and lets the site run its own login and hand back its own session.
///
/// That session is a COOKIE, and everything else follows from it. Coolblue
/// publishes no consumer order API: no public prior art, <c>/graphql</c> a 404,
/// <c>api.coolblue.nl</c> unresolvable, and a live capture in which not one
/// JSON response carried an order. The account is a Next.js app that
/// server-renders its orders into roughly 600KB of HTML per page, and the
/// captured request for the order list sent no Authorization header at all.
///
/// So this adapter reads markup, carries the cookie jar the browser earned, and
/// pays a page load for every single receipt - because the order list states no
/// money anywhere. See <see cref="CoolblueHtmlOrders"/> for why nothing on those
/// pages can be reached by a selector, and <see cref="CoolblueManifest"/> for
/// what all of it costs a consumer.
/// </summary>
/// <remarks>
/// No token of any kind is obtained or sealed. The authorization code is never
/// redeemed - see the remarks on the login - so there is no access token, no
/// refresh token, and nothing to rotate. A bundle from this provider holds a
/// cookie jar and nothing else.
/// </remarks>
public sealed class CoolblueAdapter : IProviderAdapter
{
    public const string ProviderId = "coolblue";
    public const string ReceiptsResource = "receipts";

    /// <summary>
    /// Statuses that mean Coolblue is refusing us rather than failing.
    ///
    /// 429 is here and it is NOT in the shared default, which maps it to
    /// rate_limited. The divergence is deliberate: Coolblue sits behind
    /// CloudFront, an AWS WAF rate-based rule answers 429 with no Retry-After
    /// to honour, and treating a bot wall as "try again shortly" is precisely
    /// how a client earns a permanent one. None of these is ever
    /// invalid_credentials - telling somebody their password is wrong when the
    /// truth is a wall sends them to reset a password that was fine and leaves
    /// the block undiagnosed.
    /// </summary>
    internal static readonly IReadOnlySet<int> BlockStatuses = new HashSet<int> { 403, 429, 502, 504 };

    private static readonly ProviderManifest Manifest = CoolblueManifest.Build();

    private readonly CoolblueOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public CoolblueAdapter(CoolblueOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new CoolblueOptions();
        _time = time ?? TimeProvider.System;

        // The policy is shared with Albert Heijn and Lidl; only the selectors
        // and the patience are Coolblue's. No wall has ever been seen on this
        // form - the gate is here so that if one appears the adapter can name
        // it in one poll instead of waiting out a whole job budget.
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

        // Everything that can fail without contacting anyone, checked before a
        // browser is leased. Launching Chromium to discover a blank field holds
        // an agent for nothing; the seam below checks again because it is the
        // entry point the offline suite drives.
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var driver = new PlaywrightLoginPage(page, Manifest);

        return await LoginAsync(ctx, driver, new CoolblueSessionWatcher(driver, _options, _time), ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// The whole login, behind the seam.
    ///
    /// Internal rather than private so the offline suite can drive it: the
    /// state check on the callback and the credential latch both decide whether
    /// a real person can connect at all, and neither is reachable without a
    /// live Chromium and a real account - which on this platform is a thing
    /// that may be spent exactly once and is never retried.
    /// </summary>
    /// <remarks>
    /// COOLBLUE RUNS ITS OWN OIDC FLOW AND THIS ADAPTER STAYS OUT OF IT, which
    /// is the correction two live runs forced on 2026-08-07.
    ///
    /// This used to open the authorize endpoint itself, with a PKCE pair and a
    /// state of its own minting, and then redeem the code at the token
    /// endpoint. Both halves were wrong, and each failed in its own way:
    /// <list type="number">
    /// <item>The token exchange was refused with 403 - an edge refusal, with
    /// none of the <c>invalid_grant</c> an OAuth error carries. It bought an
    /// ACCESS TOKEN, which this adapter sends nowhere, so it could only ever
    /// fail the job. Removed.</item>
    /// <item>Worse and quieter: driving the authorize request ourselves meant
    /// COOLBLUE'S OWN callback page had no verifier for a flow it never
    /// started. The human signed in, <c>accounts.coolblue.nl</c> was happy, and
    /// <c>www.coolblue.nl</c> stayed ANONYMOUS - so the login sealed a jar of
    /// anonymous cookies and the first fetch was handed the sign-in form.</item>
    /// </list>
    /// The login now starts where a shopper starts: at the protected page. It
    /// 307s to <c>/inloggen</c>, Coolblue runs its own flow with its own state
    /// and its own verifier, and brings the browser back signed in. Nothing
    /// here mints an OIDC parameter or redeems anything, and this method makes
    /// no HTTP request of its own at all.
    /// </remarks>
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        // The PROTECTED page, not a login form. Coolblue's own 307 takes the
        // browser to the form and its own callback brings it back - which is
        // both the journey a shopper takes and the only one that ends with a
        // session on the shop's own host.
        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);

        // ALREADY INSIDE? THEN NOTHING IS TYPED.
        //
        // The protected page above is the whole test: Coolblue answers it for
        // a browser it knows and 307s one it does not to /inloggen. So an
        // agent that keeps a profile - somebody's own machine - opens this and
        // is simply on the order overview, and a sign-in driven at that page
        // would type an e-mail into a form that is not there and report the
        // shop as changed.
        //
        // BEFORE THE CONSENT CLICK AND EVERYTHING BELOW IT, which is also
        // where the latch lives: nothing above this line has reached Coolblue
        // with a credential, so a connect that stops here is still safe for
        // the control plane to requeue.
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

        // Only now, and only because SignInAsync proved the browser is standing
        // on a page that cannot be reached without a session. Reading the jar
        // any earlier reads an anonymous one - Coolblue issues Coolblue-Session
        // to visitors who have never signed in at all.
        return Sealed(await SessionAsync(ctx, ct).ConfigureAwait(false));
    }

    /// <summary>
    /// What a connect hands back, however it got there.
    /// </summary>
    /// <remarks>
    /// One method rather than two, because there are now two ways in - a
    /// sign-in that was driven, and a browser that was already inside - and
    /// two copies of this would be two chances for a connect that asked
    /// nobody anything to seal a subtly different session from one that did.
    /// </remarks>
    private static LoginResult Sealed(string storage) => new()
    {
        // The cookie jar and nothing else. No access token, no refresh
        // token - see the remarks above.
        Material = new SessionMaterial { StorageState = storage },
        // Named for the brand rather than the person. The OIDC userinfo
        // endpoint would give us their name and needs a bearer token this
        // login deliberately no longer obtains; reading the account page for
        // it would cost a 600KB request to decorate a label.
        Account = new ProviderAccount { DisplayName = Manifest.Name },
        // Deliberately unset. What expires is Coolblue's session cookie, and
        // nothing states its lifetime - the manifest carries a conservative
        // guess, which is the honest place for a number nobody measured.
    };

    /// <summary>
    /// The kit's already-signed-in capability, answered for Coolblue.
    /// </summary>
    /// <remarks>
    /// It navigates and <see cref="PresenceAsync"/> does not, for the same
    /// reason the login navigates before it asks: the answer is entirely which
    /// address the shop leaves the browser on, and a browser that has been
    /// nowhere is on neither.
    /// </remarks>
    public async Task<SessionPresence> AlreadySignedInAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var browser = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        var page = new PlaywrightLoginPage(browser, Manifest);

        await page.GotoAsync(_options.LoginStartUrl, ct).ConfigureAwait(false);

        return await PresenceAsync(page, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether this browser is still inside the account area.
    /// </summary>
    /// <remarks>
    /// Assumes the browser has already been sent to
    /// <see cref="CoolblueOptions.LoginStartUrl"/>.
    /// <para>
    /// THE ADDRESS IS THE ONLY WITNESS, and on this shop that is a measured
    /// fact rather than a shortage of ideas. Cookie presence proves NOTHING
    /// here: a signed-out request to any Coolblue page is answered with
    /// <c>Set-Cookie: Coolblue-Session=...</c> alongside <c>cbvid</c> and
    /// <c>_csrfSecret</c> - CONFIRMED live 2026-08-07 against a plain curl
    /// carrying no credentials at all. This adapter's login once checked for
    /// exactly that, passed instantly on an anonymous session, and sealed a
    /// bundle whose first fetch was handed the sign-in form.
    /// </para>
    /// <para>
    /// So the page is given <see cref="CoolblueOptions.SignedOutBounceSeconds"/>
    /// to say NO - the 307 to <c>/inloggen</c>, or the form's own host - and
    /// only a page that never says it is confirmed by
    /// <see cref="CoolblueSessionWatcher.SignedIn"/>, which is the same rule
    /// the settle loop uses. Two rules would be two ideas of what "in" means.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// The order history, out of markup, at one page load per order.
    ///
    /// The shape is forced by the provider rather than chosen. Coolblue's
    /// overview is an INDEX: it states an order's id, its date, one product
    /// headline and its invoice links, and it states NO MONEY AT ALL - the one
    /// euro sign on a real 610KB page is inside a translations blob. So a
    /// receipt's total exists only on the order's own page, and this walks the
    /// list, then fetches one details page per order in the window.
    ///
    /// That is genuinely expensive - a details page is well over half a
    /// megabyte, and this account's seven pages hold seventy orders - so the
    /// window does the bounding and the record cap is the backstop. A daily
    /// sync asks for yesterday and costs a page load or two; a first connect
    /// pays for the history once, which is exactly the trade the account owner
    /// asked for.
    /// </summary>
    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'");
        }

        // Before a single packet leaves. A money unit that is not declared is
        // this deployment's fault rather than Coolblue's, and finding out after
        // seventy page loads would be seventy requests spent on nothing.
        _ = _options.TotalUnitOrThrow();

        // The account pages are server-rendered behind the session cookie, so
        // the cookie IS the credential. No refresh is possible during a fetch -
        // a dead session needs a new login job, which is what session_expired
        // asks the platform for.
        var cookies = CoolblueCookies.Header(ctx.Material?.StorageState, _options.CookieDomainSuffix)
                      ?? throw ConnectorException.SessionExpired(
                          $"{ProviderId}: the stored browser session carries no {_options.CookieDomainSuffix} " +
                          "cookies, so no fetch could carry a session");

        var cap = Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;

        ctx.Progress(JobStep.Downloading);

        var (listings, walkWasComplete) = await WalkAsync(ctx, cookies, request, cap, ct).ConfigureAwait(false);

        var ordered = listings.OrderByDescending(l => l.PlacedAt).ToList();
        var complete = walkWasComplete;

        if (ordered.Count > cap)
        {
            // More remains than one pass may return. Newest first, so the
            // caller has the most recent and comes back for the rest.
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
                // A real purchase we could not price. Dropped from this pass
                // rather than emitted with an invented total, and the pass
                // reports itself partial so the caller knows to come back -
                // silently returning fewer receipts is how a gap becomes
                // permanent.
                unread++;
                complete = false;
                continue;
            }

            var documents = request.WantsInvoice
                ? await DocumentsAsync(ctx, cookies, listing, ct).ConfigureAwait(false)
                : [];

            ctx.Progress(JobStep.Normalizing);

            // Through the factory, so every receipt leaves here with a
            // reconciliation verdict and a content hash on it.
            var receipt = ReceiptFactory.Build(
                ctx.SessionId,
                listing.Id,
                Merchant(listing.Title),
                listing.PlacedAt,
                order.Total,
                // Coolblue's details page states "Betalingsdetails" and then the
                // total, and names no method at all - not a card tail, not
                // iDEAL. Every field null and stated, so a consumer knows its
                // matching will be weaker rather than thinking we forgot.
                ReceiptFactory.Payment(),
                order.Items);

            // The gap between what Coolblue charged and what it itemised,
            // named rather than hidden.
            //
            // Both halves of that matter here. One captured order lists a
            // single product at 399 against a stated total of 463 and does not
            // say anywhere what the other 64 was; another lists a product at
            // 694 against a total of 694 and agrees exactly. So this is a
            // per-order fact about Coolblue's page, not a parsing failure, and
            // an adapter that offered no line items at all - which this one did
            // until an account owner asked why - threw away the eight orders
            // that add up perfectly to avoid being wrong about the ninth.
            //
            // The derived line keeps the breakdown adding up to what was
            // actually paid, and is deliberately NOT called a fee: we know the
            // amount and not the reason, and inventing a reason for money is how
            // a receipt stops being evidence. The total is untouched - it stays
            // Coolblue's own figure, which is what a bank transaction is
            // matched against.
            if (receipt.Items.Count > 0) receipt = receipt.WithUnattributedLine(CoolblueMessageKeys.Unattributed);

            receipts.Add(receipt with
            {
                // Attached AFTER the factory, deliberately, exactly as bol
                // does: the content hash covers what the receipt says about the
                // purchase, and an opt-in attachment must not change it. The
                // same order fetched with and without include=invoice has to
                // hash the same, or every consumer's dedupe breaks the first
                // time somebody asks for a PDF.
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
            // Nothing rotates: this fetch spends a cookie, and there is nothing
            // to exchange one for.
            Via = request.WantsInvoice ? "orders-html+invoice-pdf" : "orders-html",
        };
    }

    /// <summary>
    /// Coolblue as a merchant, with the order's own product headline on it.
    ///
    /// <c>StoreName</c> is the only place the list's one useful string can go,
    /// and it is worth carrying: a spending app showing "Coolblue" ten times
    /// tells the user nothing, where "Coolblue - Samsung koelkast" is
    /// recognisable. Null when the card names no product, never invented.
    /// </summary>
    internal static Merchant Merchant(string? title) => new()
    {
        Id = ProviderId,
        Name = "Coolblue",
        StoreName = string.IsNullOrWhiteSpace(title) ? null : title,
    };

    /// <summary>
    /// The overview, page by page, until the window or the history runs out.
    ///
    /// Returns the listings inside the window and whether the walk ended
    /// because it had seen everything. The difference is what the caller's
    /// <c>Complete</c> means, and getting it backwards tells a consumer it holds
    /// the whole history when it holds twenty pages of it.
    /// </summary>
    private async Task<(List<CoolblueListing> Listings, bool Complete)> WalkAsync(
        IJobContext ctx, string cookies, ResourceRequest request, int cap, CancellationToken ct)
    {
        var collected = new List<CoolblueListing>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // True while the walk is still ending because the page budget ran out
        // rather than because the history did.
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

            // A page that repeats the last one means Coolblue is not honouring
            // the paging parameter. Without this guard that presents as the
            // same page fetched twenty times against a live account.
            if (fresh == 0)
            {
                budgetRanOut = false;
                break;
            }

            // Newest first, so a page entirely below the window means every
            // later page is too. This is what keeps a daily sync from walking
            // two years of history to find yesterday.
            if (older == listings.Count)
            {
                budgetRanOut = false;
                break;
            }

            // One page past the cap is enough to know the pass is partial, and
            // more would be pages the caller is about to discard - which here
            // is not a rounding error but real half-megabyte requests.
            if (collected.Count > cap)
            {
                budgetRanOut = false;
                break;
            }
        }

        return (collected, !budgetRanOut);
    }

    /// <summary>
    /// One page's listings against the walk so far: how many were new to it,
    /// and how many of those were placed before the window opened. The ones
    /// inside the window go into <paramref name="collected"/>.
    /// </summary>
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

    /// <summary>
    /// One order's stated total, off its own page. Null when the page could not
    /// be read.
    /// </summary>
    /// <remarks>
    /// The split between what is swallowed here and what is not is the whole
    /// judgement in this method. A failure that will repeat for every remaining
    /// order - the session being over, a wall, or the total's LABEL having
    /// moved - is thrown, because carrying on would spend sixty more requests
    /// to fail sixty more times and then report a short history as a complete
    /// one. Anything specific to this order becomes a note, a skipped receipt
    /// and <c>Complete = false</c>.
    /// </remarks>
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

        // Proof that the page which came back is the order that was asked for.
        // Not paranoia: /bestellingen on this very site silently redirects to
        // the account home, so Coolblue is known to answer a wrong-but-plausible
        // page rather than a 404 - and a total read off the wrong page puts one
        // order's money on another's receipt.
        if (!StatesOrderNumber(page, listing.Id))
        {
            ctx.Note($"order '{listing.Id}': the page that answered does not state that order number, " +
                     $"so no total was taken from it (looked for '{_options.OrderNumberLabel}')");
            return null;
        }

        return new CoolblueOrder(
            CoolblueHtmlOrders.ParseTotal(page, _options),
            // Read off the same page in the same breath, because a second visit
            // for the lines would double the most expensive thing this adapter
            // does. A caller that did not ask for items gets none, and a receipt
            // with no items reconciles trivially rather than falsely - there is
            // nothing to check a total against.
            wantsItems
                ? [.. CoolblueHtmlOrders.ParseItems(page, _options).Select(
                    line => new ReceiptItem
                    {
                        Name = line.Name,
                        Total = line.Total,
                        Quantity = line.Quantity,
                        // Never derived from the total and the count. A unit
                        // price computed that way looks authoritative and is
                        // wrong the moment a line carries a bundle discount, and
                        // this page states none of its own.
                        UnitPrice = null,
                    })]
                : []);
    }

    /// <summary>
    /// Whether a details page names the order we asked for, within a label's
    /// reach of the words "Ordernummer".
    /// </summary>
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

    /// <summary>
    /// The browser's cookie jar, taken once the browser has PROVED it is signed
    /// in by standing on a page that needs a session.
    ///
    /// The check here is only that the jar can produce a Cookie header at all,
    /// and that is deliberately not the proof of anything - it is a guard
    /// against sealing an empty bundle. Coolblue answers a signed-OUT request
    /// with <c>Coolblue-Session</c>, <c>cbvid</c> and <c>_csrfSecret</c>, so a
    /// full jar is exactly what an anonymous visitor has. The proof happened
    /// earlier, when the browser arrived in the account area.
    /// <para>
    /// That distinction is not academic. Checking the jar INSTEAD of the URL is
    /// what sealed an anonymous session on 2026-08-07 and handed the first
    /// fetch a sign-in form.
    /// </para>
    /// </summary>
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

        // Read through the same filter the fetch uses, so "the login found a
        // session" and "the fetch can send one" cannot mean different things.
        if (CoolblueCookies.Header(jar, _options.CookieDomainSuffix) is not null) return jar!;

        throw ConnectorException.ProviderChanged(
            $"{ProviderId}: the browser reached '{_options.SignedInUrlMarker}', which needs a session, and yet holds " +
            $"no {_options.CookieDomainSuffix} cookies to seal");
    }

    // ---- login -------------------------------------------------------------

    /// <summary>
    /// Types the credentials into the one form that holds both and returns the
    /// callback URL.
    /// </summary>
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

        // Two screens now, and this used to say one.
        //
        // "One screen, both boxes - CONFIRMED" was written from a capture of
        // the authorize landing page, and on 2026-08-07 the account owner
        // reported entering an e-mail, pressing a button, and only then seeing
        // a password field. The captured screen agrees: its only input of type
        // password is the decoy Coolblue keeps for password managers, which
        // PasswordSelectors now excludes.
        //
        // PROBED rather than assumed, exactly as Amazon's does. A Coolblue that
        // goes back to a single screen is still handled by the first attempt,
        // and the old warning it replaces stays true - clicking a "next" on a
        // form that has no next submits the identifier alone and spends a login
        // attempt - which is why the click only happens when there is provably
        // no password box to fill.
        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.PasswordProbeMs, ct)
                .ConfigureAwait(false))
        {
            // Advancing the wizard submits the e-mail address, so the account
            // is touched from here on. Latch first: a lease lost between the
            // click and the next line would otherwise requeue a login that has
            // already reached Coolblue.
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

        // Latch before the credentials leave the machine. After this a lost
        // lease fails the job rather than requeuing it: a retried login is how
        // an account gets locked.
        ctx.CredentialSubmitted();

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.SelectorTimeoutMs, ct).ConfigureAwait(false))
        {
            throw Missing("login submit", _options.SubmitSelectors);
        }

        return await SettleAsync(ctx, page, watcher, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Waits for the login to resolve into one of four outcomes: signed in, a
    /// stated credential error, a captcha, or nothing recognisable.
    ///
    /// "Signed in" means the browser is standing in the account area, which is
    /// a place it cannot reach without a session. That is a deliberately
    /// different question from "did we arrive at the OIDC callback": the
    /// callback was reached on 2026-08-07 by a login that left the shop's own
    /// host anonymous, and this adapter believed it.
    ///
    /// The last case is deliberately not <c>invalid_credentials</c>. Guessing
    /// "wrong password" from silence sends the user to reset a password that
    /// was fine, and a credential error is never retried - so the mistake is
    /// permanent for that session too.
    /// </summary>
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

            // The page states a credential failure itself. This is the only
            // path in the adapter that may report invalid_credentials, and
            // nothing retries it - by construction rather than by discipline.
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

                // The settle budget measures how long Coolblue takes to
                // answer, so it restarts once a wait on a human is over:
                // the minutes they spent are not the provider being slow.
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        throw Unsettled(page, captchaSeen);
    }

    /// <summary>
    /// The captcha standing on the page, faced through the shared gate, or
    /// null when none stands there. A redirect on the outcome means the wall
    /// came down and the login is in; a wall the gate could hand to nobody
    /// ends the login here, with the verdict the settle budget would have
    /// reached.
    /// </summary>
    private async Task<CaptchaOutcome?> FaceCaptchaAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        var outcome = await _captcha.FaceAsync(ctx, page, watcher, wall, ct).ConfigureAwait(false);
        if (outcome.Redirect is not null || outcome.Handled) return outcome;

        throw Unsettled(page, captchaSeen: true);
    }

    /// <summary>
    /// The verdict on a login that never resolved. A captcha that was ever
    /// seen is the reason it did not; without one, nothing recognisable
    /// happened at all.
    /// </summary>
    private ConnectorException Unsettled(ILoginPage page, bool captchaSeen) =>
        captchaSeen
            ? ConnectorException.Blocked(
                $"{ProviderId}: a captcha stood between the login and the account page. None has ever been observed " +
                "on this form, so this is new and worth capturing")
            : ConnectorException.ProviderChanged(
                $"{ProviderId}: the login neither reached '{_options.SignedInUrlMarker}' nor stated an error; " +
                $"last url was '{page.Url}'");

    /// <summary>
    /// One account page, carrying the session cookie, guarded for what a 200
    /// can be other than the page asked for.
    /// </summary>
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

        // The body is kept on failure: an error body is the single most useful
        // thing a provider hands back, and discarding it turns a five-second
        // fix into an afternoon against a live account.
        await ProviderHttp.EnsureSuccessAsync(response, ProviderId, what, BlockStatuses, ct).ConfigureAwait(false);

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        Guard(body, what);
        return body;
    }

    /// <summary>
    /// The two things a 200 can be other than the page we asked for.
    ///
    /// The wall is checked first on purpose. Mistaking a wall for a dead
    /// session starts a fresh login straight into the wall - spending a
    /// credential against something that was never going to answer - which is
    /// the more expensive of the two wrong readings.
    /// </summary>
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

    // ---- invoice documents -------------------------------------------------

    /// <summary>
    /// The invoice PDFs for one order, straight off the LIST markup.
    ///
    /// The cheapest documents of any provider here, and the reason is worth
    /// recording: Amazon's invoice URL is an opaque guid reachable only through
    /// an AJAX fragment, and bol's needs a per-order details page of its own -
    /// while Coolblue puts <c>/mijn-factuur/{orderId}/{invoiceId}</c> right on
    /// the card, with a <c>download</c> attribute naming the file. So an
    /// invoice costs exactly one request and no discovery at all.
    ///
    /// Failures become an absence and a note, never a throw. A document is an
    /// extra the caller asked for; failing a fetch that has already read every
    /// order correctly, because one PDF would not come down, trades the whole
    /// answer for a footnote.
    /// </summary>
    /// <remarks>
    /// NO <c>ctx.Pacer</c> TICKET IS TAKEN HERE, deliberately. This adapter
    /// fetches over <see cref="IJobContext.Http"/>, whose handler already
    /// enters the same per-provider gate; that gate is a
    /// <c>SemaphoreSlim(1, 1)</c> released on ticket disposal, so holding a
    /// ticket around an HTTP call would not double-pace it - it would DEADLOCK
    /// the job until its budget ran out.
    /// </remarks>
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
                // Coolblue's only per-link text is an ACTION - "Factuur",
                // "Download factuur" - and not a name for the document.
                // ReceiptDocument.Name is what the provider CALLED it, so the
                // honest answer here is nothing at all.
                Name = null,
                // The provider's own suggestion, from the anchor's download
                // attribute, is exactly this id - so a user who saves it gets
                // the filename Coolblue would have given them.
                Filename = $"coolblue-{listing.Id}-invoice-{invoice.InvoiceId}.pdf",
                SizeBytes = fetched.Bytes.Length,
                ContentBase64 = Convert.ToBase64String(fetched.Bytes),
            });
        }

        return documents;
    }

    /// <summary>
    /// Whether what came back is really the document it claimed to be.
    ///
    /// Both halves earn their place. The media type is the server's claim, read
    /// through <c>ContentType.MediaType</c> so a charset parameter on a binary
    /// file cannot reject a perfectly good PDF. The magic number is the FILE's
    /// claim, and it is the half that catches a 200 that is really an error
    /// page wearing a PDF content type - which is what a session dying
    /// mid-fetch produces.
    /// </summary>
    private bool IsDocument(CoolblueDownload fetched) =>
        fetched.Status is 200
        && _options.DocumentMediaTypes.Contains(fetched.MediaType, StringComparer.OrdinalIgnoreCase)
        && fetched.Bytes.Length > _options.DocumentMagic.Count
        && fetched.Bytes.Take(_options.DocumentMagic.Count).SequenceEqual(_options.DocumentMagic);

    /// <summary>
    /// A document as bytes.
    ///
    /// <c>ReadAsByteArrayAsync</c> and never <c>ReadAsStringAsync</c>: decoding
    /// a PDF as text and re-encoding it corrupts it silently, and the resulting
    /// file still opens far enough to look plausible. The bol capture contains
    /// a live demonstration - the browser's own copy came back with seven
    /// thousand replacement characters in it.
    ///
    /// No <c>EnsureSuccess</c>. A non-200 on a document is a note and a missing
    /// attachment, not a failed fetch.
    /// </summary>
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

        // Already parameter-free: MediaTypeHeaderValue has split any charset
        // off, which is the whole reason the raw header is never read here.
        var mediaType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;

        return new CoolblueDownload((int)response.StatusCode, mediaType, bytes);
    }

    // ---- small helpers -----------------------------------------------------

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"{ProviderId}: '{key}' is required");

    private static ConnectorException Missing(string what, IReadOnlyList<string> selectors) =>
        ConnectorException.ProviderChanged(
            $"{ProviderId}: no element for the {what}; tried [{string.Join(", ", selectors)}]");

}

/// <summary>
/// "Are we in yet?", for a provider whose success is a PLACE rather than an
/// event.
///
/// Albert Heijn and Lidl Plus finish by sending the browser to a scheme
/// Chromium cannot open, so <see cref="RedirectWatcher"/> catches that one
/// navigation. Coolblue has no such moment worth catching. It has one that
/// LOOKS worth catching - the OIDC callback - and on 2026-08-07 this adapter
/// watched exactly that and was wrong: the callback was reached, the browser
/// went on to render the sign-in page again, and www.coolblue.nl had no
/// session at all.
///
/// So the signal is where the browser has ENDED UP. The account area cannot be
/// reached without a session - a signed-out visit is answered 307 to
/// <c>/inloggen</c> - which makes standing in it the proof, and the only one
/// this provider offers. Cookies are not: Coolblue issues
/// <c>Coolblue-Session</c> to visitors who have never signed in.
///
/// Wearing <see cref="IRedirectWaiter"/> is what lets the shared
/// <see cref="CaptchaGate"/> - which watches "did the provider move on while
/// the human worked?" throughout an interactive challenge - be used here
/// unchanged rather than reimplemented with a subtly different idea of success.
/// </summary>
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
        // Counted rather than clock-bounded. A caller holding a frozen
        // TimeProvider - which every test in this repo does - would otherwise
        // never reach a deadline computed from it, and the loop would spin
        // until the job's own budget ran out.
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

    /// <summary>
    /// Whether a URL is a signed-in one.
    ///
    /// The account marker is the destination and the login host is where the
    /// form lives; both are doing work on every real login. The login PATH
    /// clause is a guard rather than a fix, and it is worth being precise about
    /// why: Coolblue redirects an unauthenticated visitor to
    /// <c>/inloggen?returnUrl=...</c> carrying the page they asked for, so the
    /// URL the browser sits on while LEAST signed in names the account area in
    /// its own query string. Live, that return URL is percent-encoded
    /// (<c>%2Fmijn-coolblue-account%2F</c>), which hides the marker from the
    /// first clause by accident rather than by design. A relative return URL
    /// would not, and relying on an encoding nobody promised is how a login
    /// reports success on the sign-in page.
    /// </summary>
    internal static bool SignedIn(string? url, CoolblueOptions options)
    {
        if (string.IsNullOrEmpty(url)) return false;

        return url.Contains(options.SignedInUrlMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginHostMarker, StringComparison.OrdinalIgnoreCase)
               && !url.Contains(options.LoginPathMarker, StringComparison.OrdinalIgnoreCase);
    }
}
