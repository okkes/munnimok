using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using Microsoft.Playwright;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.AlbertHeijn;

/// Albert Heijn, T2: a browser drives the OAuth login once; the refresh token serves every fetch after it over HTTP.
/// The pasted-redirect flow (no console on a phone) survives only as the last resort.
public sealed class AlbertHeijnAdapter : IProviderAdapter
{
    public const string ProviderId = "ah";
    public const string ReceiptsResource = "receipts";

    /// <summary>Undeclared on purpose - see <see cref="ObtainCodeAsync"/>.</summary>
    private const string RedirectInput = "redirect_url";

    private const int PageProbeMs = 500;

    private readonly ProviderManifest Manifest;

    private readonly AlbertHeijnOptions _options;
    private readonly TimeProvider _time;
    private readonly CaptchaGate _captcha;

    public AlbertHeijnAdapter(AlbertHeijnOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new AlbertHeijnOptions();
        _time = time ?? TimeProvider.System;

        // built from the options so the declared flow cannot drift from the login actually performed
        Manifest = AlbertHeijnManifest.Build(_options.LiveLogin);

        // naming hCaptcha's two frames opts this provider into the relay: a claim about the markup is the provider's to make
        _captcha = new CaptchaGate(new CaptchaSpec
        {
            ProviderId = ProviderId,
            Interactive = _options.InteractiveCaptchaSelectors,
            Grid = _options.CaptchaGridSelectors,
            Checkbox = _options.CaptchaCheckboxSelectors,
            Image = _options.ImageCaptchaSelectors,
            Input = _options.CaptchaInputSelectors,
            ProbeMs = PageProbeMs,
            ImageSeconds = _options.ChallengeSeconds,
            InteractiveSeconds = _options.InteractiveCaptchaSeconds,
            RelayRounds = _options.CaptchaRelayRounds,
            PollSeconds = _options.RedirectPollSeconds,
        }, _time);
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var code = await ObtainCodeAsync(ctx, ct).ConfigureAwait(false);
        var tokens = await ExchangeAsync(ctx, code, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Finalizing);

        return new LoginResult
        {
            Material = new SessionMaterial
            {
                AccessToken = tokens.AccessToken,
                RefreshToken = tokens.RefreshToken,
                AccessTokenExpiresAt = tokens.ExpiresAt,
            },
            // no external id: nothing in the login response identifies the member
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            // ExpiresAt unset on purpose: the access token's expiry is not the connection's, the refresh token outlives it
        };
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        if (!string.Equals(request.ResourceId, ReceiptsResource, StringComparison.Ordinal))
        {
            throw ConnectorException.Unsupported($"ah: no resource '{request.ResourceId}'");
        }

        var session = new BearerSession(ctx.Material, ProviderId, _time);
        ctx.Progress(JobStep.Downloading);

        var cap = _options.RecordCap ?? Manifest.Resource(ReceiptsResource)!.MaxRecordsPerFetch;
        var (summaries, complete) = await ListAsync(ctx, session, request, cap, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Parsing);

        var receipts = new List<Receipt>(summaries.Count);

        // only populated when asked: AH's detail response is the document to have when a field is renamed
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var summary in summaries)
        {
            ct.ThrowIfCancellationRequested();

            IReadOnlyList<ReceiptItem> items = [];
            var payment = ReceiptFactory.Payment();
            string? detailRaw = null;

            if (request.WantsItems)
            {
                // the detail call is the expensive one and the likeliest to trip protection: only when items were asked for
                using var detail = await DetailAsync(ctx, session, summary.Id, ct).ConfigureAwait(false);

                items = AlbertHeijnReceiptParser.ParseItems(detail.RootElement, _options);
                payment = AlbertHeijnReceiptParser.ParsePayment(detail.RootElement, _options);

                if (request.WantsRaw) detailRaw = detail.RootElement.GetRawText();
            }

            // without items there is no detail call: the list row is the raw, since nothing reads as "provider sent nothing"
            if (request.WantsRaw && (detailRaw ?? summary.Raw) is { } document)
            {
                raw[summary.Id] = document;
            }

            receipts.Add(ReceiptFactory.Build(
                ctx.SessionId,
                summary.Id,
                // the confirmed operations select no store: null, not a guess
                AlbertHeijnReceiptParser.Merchant(null),
                summary.PurchasedAt,
                summary.Total,
                payment,
                items));
        }

        ctx.Progress(JobStep.Normalizing);

        return new FetchResult
        {
            Receipts = receipts,
            RefreshedMaterial = session.RefreshedMaterial(ctx.Material),
            Complete = complete,
            Via = "graphql",
            Raw = raw,
        };
    }

    internal static string? ExtractCode(string? candidate) => Support.RedirectCode.Extract(candidate);

    /// only the client id is substituted; the redirect URI goes in verbatim, as the reference sends it
    internal string AuthorizeUrl() => _options.AuthorizeUrlTemplate
        .Replace("{client_id}", Uri.EscapeDataString(_options.ClientId), StringComparison.Ordinal)
        .Replace("{redirect_uri}", _options.RedirectUri, StringComparison.Ordinal);

    // nothing is typed: the human signs in on AH's page, so no credential reaches the platform
    // CredentialSubmitted is deliberately not latched: no password is submitted here, latching would fail jobs for nothing
    private async Task<string> LiveCodeAsync(IJobContext ctx, CancellationToken ct)
    {
        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        // attached before navigating: the redirect arrives the instant the last step passes, and a later watcher misses it
        using var watcher = new RedirectWatcher(page, _options.RedirectUri, _time);

        return await LiveCodeAsync(ctx, new PlaywrightLoginPage(page, Manifest), watcher, ct)
            .ConfigureAwait(false);
    }

    internal async Task<string> LiveCodeAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(watcher);

        await page.GotoAsync(AuthorizeUrl(), ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // linked so the ask can be ENDED, not abandoned: an abandoned live view keeps the shutter and agent busy and an agent
        // runs one job at a time, so every later job wedges behind it
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
                    ctx.Progress(JobStep.Authenticating);

                    return ExtractCode(captured)
                           ?? throw ConnectorException.ProviderChanged(
                               "ah: the callback carried no authorization code");
                }

                if (asked.IsCompleted) break;
            }

            throw ConnectorException.Blocked(
                "ah: the live login ended without reaching the callback; the sign-in was not completed");
        }
        finally
        {
            // cancelled in finally, not only on success: when the window runs out someone is still looking at the picture.
            // the ask's exception is observed because an unobserved one is a crash report for a deliberate close
            await view.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => _ = t.Exception, TaskScheduler.Default);
        }
    }

    private async Task<string> ObtainCodeAsync(IJobContext ctx, CancellationToken ct)
    {
        // escape hatch, not a manifest field (a third box on a two-box form): the control plane refuses it as undeclared,
        // so only a host driving the adapter directly uses it
        if (ctx.Inputs.TryGetValue(RedirectInput, out var supplied) && ExtractCode(supplied) is { } handed)
        {
            ctx.Progress(JobStep.Authenticating);
            ctx.CredentialSubmitted();          // an OAuth code is single-use
            return handed;
        }

        if (_options.LiveLogin) return await LiveCodeAsync(ctx, ct).ConfigureAwait(false);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);
        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);
        await page.GotoAsync(AuthorizeUrl()).ConfigureAwait(false);
        await DismissConsentAsync(page, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);
        await PageOps.FillAsync(page, _options.UsernameSelectors, username, ProviderId, "e-mail field",
            _options.SelectorTimeoutMs, ct).ConfigureAwait(false);
        await PageOps.FillAsync(page, _options.PasswordSelectors, password, ProviderId, "password field",
            _options.SelectorTimeoutMs, ct).ConfigureAwait(false);

        // before the click: the redirect often lands while the click is awaited
        using var watcher = new RedirectWatcher(page, _options.RedirectUri, _time);

        // latch before the credentials leave: after this a lost lease fails the job, a retried login is how an account gets locked
        ctx.CredentialSubmitted();
        await PageOps.ClickAsync(page, _options.SubmitSelectors, ProviderId, "login submit",
            _options.SelectorTimeoutMs, ct).ConfigureAwait(false);

        // the same page instance: the login state and the widget live in it, another page is a different browsing context
        var redirect = await SettleAsync(
            ctx, new PlaywrightLoginPage(page, Manifest), watcher, new MouseTapSurface(page), ct)
            .ConfigureAwait(false);

        // the URL is never quoted back: it carries a live credential
        return ExtractCode(redirect)
               ?? throw ConnectorException.ProviderChanged("ah: the callback carried no authorization code");
    }

    /// silence is deliberately not invalid_credentials: that guess is permanent, as credential errors are never retried
    internal Task<string> SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, CancellationToken ct) =>
        SettleAsync(ctx, page, watcher, taps: null, ct);

    /// <param name="taps">null: no relay possible; hCaptcha falls back to the person at the keyboard, or a refusal</param>
    internal async Task<string> SettleAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, ITapSurface? taps, CancellationToken ct)
    {
        var deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
        var poll = TimeSpan.FromSeconds(_options.RedirectPollSeconds);
        var captchaSeen = false;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            if (await watcher.WaitAsync(poll, ct).ConfigureAwait(false) is { } captured) return captured;

            await ThrowIfCredentialErrorStatedAsync(page, ct).ConfigureAwait(false);

            if (!captchaSeen
                && await MeetWallAsync(ctx, page, watcher, taps, ct).ConfigureAwait(false) is { } outcome)
            {
                captchaSeen = true;

                if (outcome.Redirect is { } finished) return finished;
                if (!outcome.Handled) break;

                // the settle budget restarts after a human wait: their minutes are not AH being slow
                deadline = _time.GetUtcNow().AddSeconds(_options.LoginSettleSeconds);
                continue;
            }

            if (_time.GetUtcNow() >= deadline) break;
        }

        return await AskTheHumanAsync(ctx, captchaSeen, page.Url, ct).ConfigureAwait(false);
    }

    /// the only path that may report invalid_credentials
    private async Task ThrowIfCredentialErrorStatedAsync(ILoginPage page, CancellationToken ct)
    {
        var stated = await page.FindAsync(_options.LoginErrorSelectors, PageProbeMs, ct).ConfigureAwait(false);
        if (stated is not null)
        {
            throw ConnectorException.InvalidCredentials("ah: the login page stated a credential error");
        }
    }

    private async Task<CaptchaOutcome?> MeetWallAsync(
        IJobContext ctx, ILoginPage page, IRedirectWaiter watcher, ITapSurface? taps, CancellationToken ct)
    {
        var wall = await _captcha.DetectAsync(page, ct).ConfigureAwait(false);
        if (wall.Kind is CaptchaKind.None) return null;

        return await _captcha.FaceAsync(ctx, page, watcher, wall, taps, ct).ConfigureAwait(false);
    }

    /// last resort: the human's own IP and browser are the likeliest to get past what stopped the agent
    private async Task<string> AskTheHumanAsync(
        IJobContext ctx, bool captchaSeen, string lastUrl, CancellationToken ct)
    {
        if (!_options.RedirectFallbackEnabled) throw Stuck(captchaSeen, lastUrl);

        ctx.Progress(JobStep.AwaitingHuman);

        var answer = await ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.Redirect,
            PromptKey = MessageKeys.PasteRedirect,
            Url = AuthorizeUrl(),
            ReturnPattern = _options.RedirectUri + "*",
            ExpiresAt = _time.GetUtcNow().AddSeconds(_options.RedirectChallengeSeconds),
        }, ct).ConfigureAwait(false);

        return answer.Value.Length > 0 && ExtractCode(answer.Value) is { } code
            ? code
            : throw Stuck(captchaSeen, lastUrl);
    }

    private static ConnectorException Stuck(bool captchaSeen, string lastUrl) => captchaSeen
        ? ConnectorException.Blocked("ah: a captcha stood between the login and its redirect")
        : ConnectorException.ProviderChanged(
            $"ah: the login neither redirected nor stated an error; last url was '{lastUrl}'");

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidRequest($"ah: '{key}' is required");

    private async Task DismissConsentAsync(IPage page, CancellationToken ct)
    {
        // best effort: a consent wall left standing covers the form
        var accept = await PageOps.FindAsync(page, _options.ConsentSelectors, 2_000, ct).ConfigureAwait(false);
        if (accept is not null) await accept.ClickAsync().ConfigureAwait(false);
    }

    private Task<TokenSet> ExchangeAsync(IJobContext ctx, string code, CancellationToken ct) =>
        PostTokenAsync(ctx, _options.TokenPath,
            new JsonObject
            {
                ["clientId"] = _options.ClientId,
                ["code"] = code,
            },
            "token exchange", ct);

    private Task<TokenSet> RefreshAsync(IJobContext ctx, string refreshToken, CancellationToken ct) =>
        PostTokenAsync(ctx, _options.RefreshPath,
            new JsonObject
            {
                ["clientId"] = _options.ClientId,
                ["refreshToken"] = refreshToken,
            },
            "token refresh", ct);

    private async Task<TokenSet> PostTokenAsync(
        IJobContext ctx, string path, JsonObject body, string what, CancellationToken ct)
    {
        using var request = Request(_options.ApiBaseUrl.TrimEnd('/') + path, accessToken: null, body.ToJsonString());

        using var response = await ProviderHttp.SendAsync(ctx.Http, request, ProviderId, ct).ConfigureAwait(false);

        // a rejected code or dead refresh token is the session ending, not a wrong password
        if (response.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.BadRequest)
        {
            throw ConnectorException.SessionExpired($"ah: {what} rejected ({(int)response.StatusCode})");
        }

        ProviderHttp.EnsureSuccess(response, ProviderId, what);

        using var document = await ProviderHttp.ReadJsonAsync(response, ProviderId, what, ct).ConfigureAwait(false);
        return TokenSet.Parse(document.RootElement, ProviderId, _time);
    }

    private async Task<(List<AhReceiptSummary> Rows, bool Complete)> ListAsync(
        IJobContext ctx, BearerSession session, ResourceRequest request, int cap, CancellationToken ct)
    {
        var pageSize = Math.Clamp(_options.PageSize, 1, cap);
        var collected = new List<AhReceiptSummary>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var complete = true;
        var offset = 0;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            using var document = await GraphQlAsync(ctx, session, _options.ListQuery, new JsonObject
            {
                ["offset"] = offset,
                ["limit"] = pageSize,
            }, "receipt list", ct).ConfigureAwait(false);

            var rows = AlbertHeijnReceiptParser.ParseList(document.RootElement, _options, request.WantsRaw);
            var more = CollectPage(rows, request, seen, collected, pageSize, cap);
            ctx.Found(collected.Count);
            if (!more) break;

            offset += pageSize;
        }

        var ordered = collected.OrderByDescending(r => r.PurchasedAt).ToList();

        if (ordered.Count > cap)
        {
            // more remains than one pass may return: partial, the caller returns for the rest under a fresh cursor
            ordered = [.. ordered.Take(cap)];
            complete = false;
        }

        return (ordered, complete);
    }

    private static bool CollectPage(
        IReadOnlyList<AhReceiptSummary> rows, ResourceRequest request, HashSet<string> seen,
        List<AhReceiptSummary> collected, int pageSize, int cap)
    {
        if (rows.Count == 0) return false;

        var fresh = 0;
        var older = 0;

        foreach (var row in rows)
        {
            if (!seen.Add(row.Id)) continue;
            fresh++;

            if (request.Since is { } since && DateOnly.FromDateTime(row.PurchasedAt.Date) < since) older++;
            if (ReceiptFactory.InWindow(row.PurchasedAt, request)) collected.Add(row);
        }

        // a repeated page means the offset advances nothing upstream: stop rather than repeat a request against a defended endpoint
        if (fresh == 0) return false;

        // newest first: a page wholly older than the window means every later page is too
        if (older == rows.Count) return false;

        // a short page ends the history; sound only because the parser refuses an unkeyable row instead of skipping it,
        // so the count is what AH sent
        if (rows.Count < pageSize) return false;

        // one page past the cap proves the pass is partial
        return collected.Count <= cap;
    }

    private Task<JsonDocument> DetailAsync(
        IJobContext ctx, BearerSession session, string receiptId, CancellationToken ct) =>
        GraphQlAsync(ctx, session, _options.DetailQuery, new JsonObject { ["id"] = receiptId }, "receipt detail", ct);

    private async Task<JsonDocument> GraphQlAsync(
        IJobContext ctx, BearerSession session, string query, JsonObject variables, string what, CancellationToken ct)
    {
        var url = _options.ApiBaseUrl.TrimEnd('/') + _options.GraphQlPath;

        // confirmed: query and variables, no operationName; serialised once because the factory reruns on refresh
        var body = new JsonObject { ["query"] = query, ["variables"] = variables }.ToJsonString();

        using var response = await session.SendAsync(ctx.Http,
            token => Request(url, token, body),
            (refresh, token) => RefreshAsync(ctx, refresh, token), what, ct).ConfigureAwait(false);

        // 403, 502 and 504 are bot protection, never a wrong password; the body is kept because a GraphQL 400 names the field
        await ProviderHttp.EnsureSuccessAsync(
            response, ProviderId, what, RetailHttp.RetailBlockStatuses, ct).ConfigureAwait(false);

        var document = await ProviderHttp.ReadJsonAsync(response, ProviderId, what, ct).ConfigureAwait(false);

        try
        {
            // GraphQL reports a failure in the body with a 200: read the errors array before trusting the data
            AlbertHeijnReceiptParser.ThrowOnErrors(document.RootElement);
        }
        catch
        {
            document.Dispose();
            throw;
        }

        return document;
    }

    /// the header block appie-go sets on every api.ah.nl call: the API needs it to route and answer;
    /// omitting it was one reason a real login failed
    private HttpRequestMessage Request(string url, string? accessToken, string jsonBody)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json"),
        };

        request.Headers.TryAddWithoutValidation("User-Agent", _options.UserAgent);
        // the same literal as the client id in the reference; one option so the two cannot drift
        request.Headers.TryAddWithoutValidation("x-client-name", _options.ClientId);
        request.Headers.TryAddWithoutValidation("x-client-version", _options.ClientVersion);
        request.Headers.TryAddWithoutValidation("x-application", _options.Application);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        if (accessToken is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        }

        return request;
    }
}
