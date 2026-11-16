using System.Text.Json;
using Connector.Kit.Adapters;
using Connector.Kit.Browsing;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;

namespace BankConnector.Adapters.Ing;

// never builds a transactions URL (its agreement id is encrypted per session): the overview loads, ING's own client
// asks, this listens, then walks ING's cursor links. Signs OUT when finished: ING wants a second factor on every
// sign-in, and its fraud detection flags accounts that sign in and never out
public sealed class IngAdapter : IProviderAdapter
{
    public const string ProviderId = "ing-nl";

    private static readonly ProviderManifest Manifest = IngManifest.Build();

    private readonly IngOptions _options;
    private readonly TimeProvider _time;

    public IngAdapter(IngOptions? options = null, TimeProvider? time = null)
    {
        _options = options ?? new IngOptions();
        _time = time ?? TimeProvider.System;
    }

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // fail on blank input before a browser is leased: it would idle an agent and spend one of a limited number of
        // sign-in attempts
        _ = RequiredInput(ctx, "username");
        _ = RequiredInput(ctx, "password");

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await LoginAsync(
                ctx,
                new PlaywrightLoginPage(page, Manifest),
                new PageIngPortal(page, _options),
                ct)
            .ConfigureAwait(false);
    }

    /// the session is confirmed by a transactions call, not a URL: mijn.ing.nl is client-routed, so /banking can still
    /// bounce to sign-in (Coolblue sealed anonymous cookies; DUO reported a login 80 ms in)
    internal async Task<LoginResult> LoginAsync(
        IJobContext ctx, ILoginPage page, IIngPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(portal);

        var username = RequiredInput(ctx, "username");
        var password = RequiredInput(ctx, "password");

        await page.GotoAsync(_options.LoginUrl, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        await OpenPasswordFormAsync(ctx, page, ct).ConfigureAwait(false);

        if (!await page.FillAsync(_options.UsernameSelectors, username, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            throw await UnusableAsync(page, portal, "the username box", _options.UsernameSelectors, ct).ConfigureAwait(false);
        }

        if (!await page.FillAsync(_options.PasswordSelectors, password, _options.StepProbeMs, ct)
                .ConfigureAwait(false))
        {
            throw await UnusableAsync(page, portal, "the password box", _options.PasswordSelectors, ct).ConfigureAwait(false);
        }

        if (!await page.ClickAsync(_options.SubmitSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            throw await UnusableAsync(page, portal, "the sign-in button", _options.SubmitSelectors, ct).ConfigureAwait(false);
        }

        // from here a retry could count against the account
        ctx.CredentialSubmitted();

        // the redactor refuses to capture while a secret field holds content, and the challenge is when a capture happens
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // the card is raised, not awaited: ING pushes to the phone and its own page advances on approval, so the watch below
        // decides; the challenge only says what to do (pressing it still works and arrives first)
        using var ask = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.AppApproval,
            PromptKey = IngManifest.AppApprovalKey,
            // longer than the wait below: an unanswered challenge parks the job, and one expiring first gets the finished login
            // swept away (IngOptions.ChallengeTtlMs)
            ExpiresAt = _time.GetUtcNow().AddMilliseconds(_options.ChallengeTtlMs),
        }, ask.Token);

        IReadOnlyList<IngCall> observed;

        try
        {
            // watch first, navigate second: navigating while a sign-in was in flight cancelled it and reported the password refused
            // (MediaMarkt); navigation is only the fallback. The approval budget applies: a person has to find their phone
            observed = await portal
                .WatchAsync(_options.TransactionsPathSuffix, _options.AppApprovalTimeoutMs, ct)
                .ConfigureAwait(false);

            if (observed.Count == 0)
            {
                observed = await portal
                    .ObserveAsync(
                        _options.OverviewUrl, _options.TransactionsPathSuffix, _options.ApiCallTimeoutMs, ct)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            // cancelled, not abandoned: the platform releases the job's budget park on this unwind
            await ask.CancelAsync().ConfigureAwait(false);

            // observed so the cancel is no unobserved task exception; agent and inline runner surface it differently,
            // so any is swallowed
            _ = asked.ContinueWith(static settled => _ = settled.Exception, TaskScheduler.Default);
        }

        ctx.Progress(JobStep.Finalizing);

        if (observed.Count == 0)
        {
            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the overview never asked for transactions after the sign-in, so nobody is " +
                $"signed in. The browser is {await Showing(portal, ct).ConfigureAwait(false)}");
        }

        // a refusal here is not a bad password: the form accepted it and the approval landed
        _ = IngCalls.Body(observed[0], "the overview's transactions call", ctx.Note);

        var accounts = (await AccountsAsync(ctx, portal, Today(), ct).ConfigureAwait(false)).Found;

        return new LoginResult
        {
            Material = new SessionMaterial
            {
                StorageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false),
            },
            // named for the bank: the payloads carry the holder's name, which is not kept
            Account = new ProviderAccount { DisplayName = Manifest.Name },
            Reachable =
            [
                .. accounts.Select(a => new ReachableAccount
                {
                    ExternalId = a.Record.ExternalId,
                    Type = AccountTypes.Wire(a.Record.Type),
                    DisplayName = a.Record.DisplayName,
                }),
            ],
            // the real expiry, stated so a change to the manifest's equal number cannot promise something else
            ExpiresAt = _time.GetUtcNow().AddSeconds(Manifest.Auth.Session.TtlSeconds),
        };
    }

    /// the password form is one click behind ING's app/QR sign-in screen; checks for the FORM first, so a wrong guess at
    /// the button wording cannot break a login that did not need it
    private async Task OpenPasswordFormAsync(IJobContext ctx, ILoginPage page, CancellationToken ct)
    {
        if (await page.FindAsync(_options.PasswordSelectors, _options.StepProbeMs, ct).ConfigureAwait(false)
            is not null)
        {
            return;
        }

        if (await page.ClickAsync(_options.PasswordFormSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
        {
            ctx.Note($"{ProviderId}: opened the username-and-password form from ING's app sign-in screen");
        }
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await FetchAsync(ctx, request, new PageIngPortal(page, _options), ct).ConfigureAwait(false);
    }

    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx, ResourceRequest request, IIngPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(portal);

        ctx.Progress(JobStep.Downloading);

        // the overview, for the transactions ING's own app fetches on arrival; the account lists come from a second page
        // because ING serves its own client and refuses ours
        var observed = await portal
            .ObserveAsync(_options.OverviewUrl, _options.TransactionsPathSuffix, _options.ApiCallTimeoutMs, ct)
            .ConfigureAwait(false);

        if (observed.Count == 0 && !await portal.AwaitApiAsync(_options.ApiCallTimeoutMs, ct).ConfigureAwait(false))
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: the overview made no call to ING's API, which is what it does when nobody is " +
                $"signed in. The browser is {await Showing(portal, ct).ConfigureAwait(false)}");
        }

        ctx.Progress(JobStep.Parsing);

        var today = Today();
        var read = await AccountsAsync(ctx, portal, today, ct).ConfigureAwait(false);
        var accounts = read.Found;
        var selected = BankAccountFilter.Select([.. accounts.Select(a => a.Record)], request);

        return request.ResourceId switch
        {
            BankResources.Accounts => Accounts(ctx, selected, read),
            BankResources.Transactions =>
                await TransactionsAsync(ctx, portal, read, selected, observed, Limits(request, today), ct)
                    .ConfigureAwait(false),
            _ => throw ConnectorException.Unsupported($"{ProviderId}: no resource '{request.ResourceId}'"),
        };
    }

    private static FetchResult Accounts(IJobContext ctx, IReadOnlyList<Account> selected, IngAccountList read)
    {
        ctx.Progress(JobStep.Normalizing);

        return BankEmission.Verified(ProviderId, selected, [], complete: read.Everything, via: read.Via);
    }

    /// the flag travels with the list: the agreement list is every account, the statement screen only the current ones
    /// unless a human switches its picker, so Everything/Via must tell consumers when the list is partial
    private sealed record IngAccountList(IReadOnlyList<IngAccount> Found, bool Everything, string Via);

    /// Cap: the page's budget for the whole page, one account's share of it for a single walk
    private readonly record struct WalkLimits(FetchWindow Window, int Cap);

    private WalkLimits Limits(ResourceRequest request, DateOnly today) =>
        new(
            BankWindow.Resolve(request, Manifest, today),
            _options.RecordCap
            ?? Manifest.Resource(BankResources.Transactions)?.MaxRecordsPerFetch
            ?? 200);

    /// two routes: current accounts' first page is observed (the overview fetches those); savings, cards and loans use
    /// the transactions link on their agreement (the overview makes no call for them, once mistaken for ING not serving them)
    private async Task<FetchResult> TransactionsAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngAccountList read,
        IReadOnlyList<Account> selected,
        IReadOnlyList<IngCall> observed,
        WalkLimits limits,
        CancellationToken ct)
    {
        var accounts = read.Found;
        var cap = limits.Cap;

        var rows = new List<Transaction>();
        var served = new HashSet<string>(StringComparer.Ordinal);

        // who is walked is decided before anything is: the cap is a page-wide budget, and handing it whole to each account let
        // one current account fill it so the others emitted nothing after being fetched
        var plan = new List<(IngAccount Account, IngCall? Opening)>();

        PlanObserved(ctx, observed, accounts, selected, served, plan, ct);
        var complete = PlanOwnFeeds(ctx, accounts, selected, served, plan);

        for (var i = 0; i < plan.Count; i++)
        {
            ct.ThrowIfCancellationRequested();

            var (account, opening) = plan[i];

            // what is left divided by the accounts still to come: an account needing less passes the rest on
            var budget = Math.Max(1, (cap - rows.Count) / (plan.Count - i));
            var share = limits with { Cap = budget };

            var walked = opening is { } call
                ? await ObservedAsync(ctx, portal, call, account.Record, share, ct).ConfigureAwait(false)
                : await OwnFeedAsync(ctx, portal, account, account.TransactionsPath!, observed, share, ct)
                    .ConfigureAwait(false);

            complete &= walked.Complete;

            if (walked.Rows is null)
            {
                served.Remove(account.Record.Id);
                continue;
            }

            // trimmed here, not at the end: the emission trim keeps a contiguous prefix, i.e. the first account only; ING serves
            // newest first, so each account keeps its most recent rows
            if (walked.Rows.Count > budget)
            {
                rows.AddRange(walked.Rows.Take(budget));
                complete = false;

                ctx.Note(
                    $"{ProviderId}: {AccountTypes.Wire(account.Record.Type)} account " +
                    $"{account.Record.ExternalId} has more history than its share of this page " +
                    $"({budget} of {cap} rows); ask for that account on its own to get more of it");
            }
            else
            {
                rows.AddRange(walked.Rows);
            }

            ctx.Found(rows.Count);
        }

        // nothing read at all is an error, a partial pass is complete=false plus a note: an empty incomplete list
        // reads as "no transactions"
        if (served.Count == 0)
        {
            var reachable = accounts
                .Where(a => a.TransactionsPath is not null)
                .Select(a => a.Record.ExternalId)
                .ToList();

            throw ConnectorException.Unsupported(
                $"{ProviderId}: none of the selected accounts could be read for transactions. " +
                (reachable.Count > 0
                    ? $"ING states a transactions link for: {string.Join(',', reachable)}"
                    : "ING stated a transactions link for none of the accounts this session lists"));
        }

        ctx.Progress(JobStep.Normalizing);

        // oldest first per account, reversed not sorted: the balance chain is defined on it, and sorting would repair an
        // out-of-order page instead of failing on it (ING states newest first)
        var ordered = new List<Transaction>();

        foreach (var account in selected.Where(a => served.Contains(a.Id)))
        {
            var forAccount = rows.Where(t => string.Equals(t.AccountId, account.Id, StringComparison.Ordinal));
            ordered.AddRange(forAccount.Reverse());
        }

        var (trimmed, within) = BankEmission.Page(ordered, cap);

        ctx.Progress(JobStep.Finalizing);

        // plus the account list's own completeness: `complete` covers only accounts that reached here, so one the degraded
        // list never found could not lower it
        return BankEmission.Verified(
            ProviderId,
            selected,
            trimmed,
            complete && within && read.Everything,
            via: "v1/agreements/transactions");
    }

    private static void PlanObserved(
        IJobContext ctx,
        IReadOnlyList<IngCall> observed,
        IReadOnlyList<IngAccount> accounts,
        IReadOnlyList<Account> selected,
        HashSet<string> served,
        List<(IngAccount Account, IngCall? Opening)> plan,
        CancellationToken ct)
    {
        // observed pages attributed by inference, not by what they state; a second is a contradiction (see Attribute)
        var unnamed = 0;

        foreach (var call in observed)
        {
            ct.ThrowIfCancellationRequested();

            using var opening = JsonDocument.Parse(IngCalls.Body(call, "a page of transactions", ctx.Note));

            if (Attribute(ctx, opening, accounts, ref unnamed) is not { } account) continue;

            if (!IsSelected(selected, account)) continue;

            // one walk per account: the latch keys on request url, so a retried or sliced page names the same account twice and
            // walking both would emit its rows twice
            if (!served.Add(account.Record.Id)) continue;

            plan.Add((account, call));
        }
    }

    /// false when a selected account states no link: a caller asked for its history and gets none
    private static bool PlanOwnFeeds(
        IJobContext ctx,
        IReadOnlyList<IngAccount> accounts,
        IReadOnlyList<Account> selected,
        HashSet<string> served,
        List<(IngAccount Account, IngCall? Opening)> plan)
    {
        var complete = true;

        // the overview fetches transactions for current accounts only, but every agreement states the address of its own feed
        foreach (var account in accounts)
        {
            if (served.Contains(account.Record.Id)) continue;
            if (!IsSelected(selected, account)) continue;

            if (account.TransactionsPath is null)
            {
                // incomplete, not empty: saying complete would tell the caller there is nothing there
                complete = false;
                ctx.Note(
                    $"{ProviderId}: ING states no transactions link for {AccountTypes.Wire(account.Record.Type)} " +
                    $"account {account.Record.ExternalId}, so no history could be read for it");

                continue;
            }

            served.Add(account.Record.Id);
            plan.Add((account, null));
        }

        return complete;
    }

    private static bool IsSelected(IReadOnlyList<Account> selected, IngAccount account) =>
        selected.Any(a => string.Equals(a.Id, account.Record.Id, StringComparison.Ordinal));

    /// the body is re-parsed, not carried across awaits (a JsonDocument lifetime trap); a body that will not parse costs
    /// only this account, not the whole fetch
    private async Task<(IReadOnlyList<Transaction>? Rows, bool Complete)> ObservedAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngCall call,
        Account account,
        WalkLimits limits,
        CancellationToken ct)
    {
        try
        {
            using var opening = JsonDocument.Parse(IngCalls.Body(call, "a page of transactions", ctx.Note));

            return await WalkAsync(ctx, portal, call, opening, account, limits, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ConnectorException or JsonException)
        {
            ctx.Note(
                $"{ProviderId}: the page of transactions ING served for {account.ExternalId} could not be read " +
                $"({ex.Message}), so that account is reported with no history rather than with none found");

            return (null, false);
        }
    }

    /// savings, cards and loans, which the overview fetches nothing for; headers are borrowed from an observed transactions
    /// call, else the agreement list's. Never fatal and null (not empty) on a miss: a refused feed must not sink the other
    /// accounts, and "read nothing" differs from "nothing there"
    private async Task<(IReadOnlyList<Transaction>? Rows, bool Complete)> OwnFeedAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngAccount account,
        string path,
        IReadOnlyList<IngCall> observed,
        WalkLimits limits,
        CancellationToken ct)
    {
        var what = $"the {AccountTypes.Wire(account.Record.Type)} account's own transactions";
        var headers = BorrowedHeaders(portal, observed);

        IngCall call;

        using (await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(_options.PageGapMs), _time, ct).ConfigureAwait(false);
            call = await portal.ReadAsync(path, headers, ct).ConfigureAwait(false);
        }

        try
        {
            using var opening = JsonDocument.Parse(IngCalls.Body(call, what, ctx.Note));

            try
            {
                return await WalkAsync(
                        ctx, portal, call with { Headers = headers }, opening, account.Record, limits, ct)
                    .ConfigureAwait(false);
            }
            catch (ConnectorException ex) when (ex.Code is ErrorCode.ProviderChanged)
            {
                // the shape is noted: card and loan feeds were only ever reached through the agreement link, so nobody has seen how ING
                // spells their rows (keys and lengths, never values)
                ctx.Note(
                    $"{ProviderId}: {what} ({PageIngPortal.Endpoint(path)}) answered, but this reader could not " +
                    $"make transactions of it ({ex.Message}), so {account.Record.ExternalId} is reported with " +
                    $"no history. Its shape is: {IngSchema.Describe(opening.RootElement, maxChars: 3_000)}");

                return (null, false);
            }
        }
        catch (Exception ex) when (ex is ConnectorException or JsonException)
        {
            ctx.Note(
                $"{ProviderId}: {what} ({PageIngPortal.Endpoint(path)}) could not be read ({ex.Message}), so " +
                $"{account.Record.ExternalId} is reported with no history rather than with none found");

            return (null, false);
        }
    }

    private IReadOnlyDictionary<string, string>? BorrowedHeaders(IIngPortal portal, IReadOnlyList<IngCall> observed)
    {
        if (observed.Count > 0) return observed[0].Headers;

        return portal.Seen(_options.AgreementsPath) is [var agreements, ..] ? agreements.Headers : null;
    }

    /// the first page is ING's own client's, later ones are composed here with its headers and ING's edge has refused
    /// composed requests, so a refusal ends the walk as partial instead of discarding the good page
    private async Task<(IReadOnlyList<Transaction> Rows, bool Complete)> WalkAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngCall opening,
        JsonDocument document,
        Account account,
        WalkLimits limits,
        CancellationToken ct)
    {
        var walk = new Walk();
        var owned = false;

        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();

                var page = IngTransactions.Read(document, ctx.SessionId, account.Id, account.ExternalId);
                Absorb(ctx, walk, page, limits.Window);

                // the oldest row is already before the window, so every later page is: checked before following the cursor, as a
                // ten-year account is fifty pages nobody asked about
                if (page.Transactions.Count > 0 && page.Transactions[^1].BookedAt < limits.Window.From) break;

                if (page.NextPath is not { } next) break;

                if (Exhausted(ctx, walk, account, limits)) break;

                var body = await NextPageAsync(ctx, portal, opening, next, account, walk, ct).ConfigureAwait(false);

                if (body is null) break;

                if (owned) document.Dispose();

                document = JsonDocument.Parse(body);
                owned = true;
            }
        }
        finally
        {
            if (owned) document.Dispose();
        }

        Report(ctx, walk, account);

        return (walk.Rows, walk.Complete);
    }

    private sealed class Walk
    {
        /// <summary>The rows inside the window, in ING's order: newest first.</summary>
        public List<Transaction> Rows { get; } = [];

        public int Pages { get; set; }

        public int Reservations { get; set; }

        public bool Complete { get; set; } = true;

        public List<string> Unclassified { get; } = [];

        public List<string> Details { get; } = [];
    }

    private static void Absorb(IJobContext ctx, Walk walk, IngTransactionPage page, FetchWindow window)
    {
        walk.Pages++;
        walk.Reservations += page.Reservations;

        foreach (var message in page.Messages)
        {
            ctx.Note($"{ProviderId}: ING said '{message}' about a page of transactions");
        }

        walk.Rows.AddRange(page.Transactions.Where(t => window.Contains(t.BookedAt)));

        walk.Unclassified.AddRange(page.Unclassified.Except(walk.Unclassified, StringComparer.Ordinal));

        // across the whole walk, in page order: a position shows only as the same tail twice or a run restarting on the next page
        walk.Details.AddRange(page.DetailIds);
    }

    private bool Exhausted(IJobContext ctx, Walk walk, Account account, WalkLimits limits)
    {
        if (walk.Pages < _options.MaxPages && walk.Rows.Count < limits.Cap) return false;

        walk.Complete = false;

        // says where it stopped: newest first, so the oldest row read is the boundary and the caller continues with until=<it>
        var oldest = walk.Rows.Count > 0 ? walk.Rows[^1].BookedAt : limits.Window.From;

        ctx.Note(
            $"{ProviderId}: stopped after {walk.Pages} page(s) with {walk.Rows.Count} transaction(s) for " +
            $"{account.ExternalId}, at {oldest:yyyy-MM-dd}. There is more before that date: ask " +
            $"again with until={oldest:yyyy-MM-dd} to continue from here");

        return true;
    }

    /// null when ING refused the composed request: the walk ends as partial, not failed
    private async Task<string?> NextPageAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngCall opening,
        string next,
        Account account,
        Walk walk,
        CancellationToken ct)
    {
        using (await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false))
        {
            await Task.Delay(TimeSpan.FromMilliseconds(_options.PageGapMs), _time, ct).ConfigureAwait(false);

            // the headers of the call this continues, not of ING's most recent call: a live run that went out with two
            // headers was refused
            var call = await portal.ReadAsync(next, opening.Headers, ct).ConfigureAwait(false);

            try
            {
                return IngCalls.Body(call, $"page {walk.Pages + 1} of transactions", ctx.Note);
            }
            catch (ConnectorException ex)
            {
                // a refused composed request is not a dead session: ING's edge answers one with 401 on a live session, and
                // session_expired would send somebody to re-authenticate
                walk.Complete = false;
                ctx.Note(
                    $"{ProviderId}: page {walk.Pages + 1} for {account.ExternalId} was refused " +
                    $"({ex.Code}), so this pass stops at {walk.Rows.Count} transaction(s) and is " +
                    $"partial. The headers repeated from ING's own call were: " +
                    $"[{string.Join(", ", (opening.Headers?.Keys ?? []).Order(StringComparer.Ordinal))}]");

                return null;
            }
        }
    }

    private static void Report(IJobContext ctx, Walk walk, Account account)
    {
        var rows = walk.Rows;

        if (walk.Reservations > 0)
        {
            // reservations are skipped: no running balance, and ING may change the amount when it books
            ctx.Note(
                $"{ProviderId}: skipped {walk.Reservations} unsettled reservation(s) on {account.ExternalId}; " +
                "they are not booked yet and will arrive with their final amounts");
        }

        // counted on rows inside the window, not rows read: a straddling page once produced "10 of 3 derived"
        var derived = rows.Count(IngTransactions.IsDerived);
        var chained = rows.Exists(t => t.ResultingBalance is not null);

        // a derived id is ours rather than ING's; a consumer deduplicating on it should know
        if (derived > 0)
        {
            ctx.Note(
                $"{ProviderId}: {derived} of {rows.Count} transaction(s) on {account.ExternalId} carry an id " +
                "this connector derived, because ING states none for them. They are prefixed 'ing-d-' and are " +
                "built only from parts ING does not translate");

            // detail-link tails are measured, not adopted: whether one is an id cannot be told from one payload (see
            // IngTransactions.DescribeDetails), and a wrong position would re-deliver the whole history every sync
            ctx.Note($"{ProviderId}: {IngTransactions.DescribeDetails(walk.Details)}");
        }

        // a feed with no running balance is unchecked: the chain is what catches an inverted sign or a dropped row
        if (rows.Count > 0 && !chained)
        {
            ctx.Note(
                $"{ProviderId}: ING states no running balance on {account.ExternalId}, so the usual check that " +
                "the amounts add up could not be run for it. The rows are as ING sent them; nothing confirms " +
                "none is missing");
        }

        // the count covers rows received, the codes every row read (window or not): a live run printed "0 of 0 ... codes: IIPS, ..."
        if (walk.Unclassified.Count > 0)
        {
            var other = rows.Count(t => t.Kind == TransactionKind.Other);

            // the clause must say WHICH rows the codes came from: "seven codes on one row" is impossible
            var counted = rows.Count == 0
                ? "no transaction fell inside the requested window"
                : $"{other} of the {rows.Count} transaction(s) you received could not be classified";

            // the list cuts at 24 and says how many more: a silent cut defeats the sentence's purpose
            var shown = walk.Unclassified.Take(24).ToList();
            var cut = walk.Unclassified.Count - shown.Count;

            ctx.Note(
                $"{ProviderId}: on {account.ExternalId}, {counted}. Separately, across EVERY row read for this "
                + $"account - the window's and the pages either side of it - ING's own codes on the ones this "
                + $"connector could not classify were: {string.Join(", ", shown)}"
                + (cut > 0 ? $", and {cut} more" : string.Empty));
        }
    }

    /// by ING's agreement UUID in the transactions' action links (the id in the URL is encrypted per session). One current
    /// account takes ONE unnamed page; a second is refused, as the overview should fetch current accounts only and the same
    /// history could be filed twice. The first is still attributed: ING states no transactions link on the current account
    private static IngAccount? Attribute(
        IJobContext ctx, JsonDocument page, IReadOnlyList<IngAccount> accounts, ref int unnamed)
    {
        var current = accounts.Where(a => a.Record.Type == AccountType.Current).ToList();

        if (IngTransactions.AgreementId(page) is { } stated)
        {
            foreach (var account in accounts)
            {
                if (string.Equals(account.AgreementId, stated, StringComparison.OrdinalIgnoreCase))
                {
                    return account;
                }
            }

            ctx.Note($"{ProviderId}: a page of transactions names an account this session does not list");
            return null;
        }

        if (current.Count == 1 && ++unnamed == 1) return current[0];

        ctx.Note(
            current.Count == 1
                ? $"{ProviderId}: {unnamed} pages of transactions state no account, and one current account "
                  + "cannot be the subject of them all - so this one was left out. ING's overview is only "
                  + "supposed to fetch current accounts, so the history you were given may be filed under "
                  + "the wrong account"
                : $"{ProviderId}: a page of transactions states no account, and there are {current.Count} "
                  + "current accounts to choose between, so it was left out rather than guessed at");

        return null;
    }

    /// nothing is fetched: composed GETs to the list endpoints got 401 from ING's webserver on a live session;
    /// /global/agreements is watched, the overview renders from it. The statement screen is the fallback: the agreement
    /// reader was written from a schema, those three from a capture
    private async Task<IngAccountList> AccountsAsync(
        IJobContext ctx, IIngPortal portal, DateOnly today, CancellationToken ct)
    {
        ctx.Progress(JobStep.SelectingAccounts);

        // usually latched by the transactions navigation already; the short wait covers the overview firing both calls
        // in an order that is ING's business
        var seen = portal.Seen(_options.AgreementsPath);

        if (seen.Count == 0)
        {
            seen = await portal.WatchAsync(_options.AgreementsPath, _options.StepProbeMs, ct).ConfigureAwait(false);
        }

        if (seen.Count == 0)
        {
            ctx.Note(
                $"{ProviderId}: ING made no call to {_options.AgreementsPath}, so the accounts were read from " +
                "the statement screen instead and may not include every type");
        }
        else if (Listed(ctx, seen[0], today) is { Count: > 0 } accounts)
        {
            return new IngAccountList(
                await DetailedAsync(ctx, portal, accounts, seen[0], today, ct).ConfigureAwait(false),
                Everything: true,
                Via: "v1/agreements");
        }

        // NOT everything: the statement screen asks for savings and cards only when the picker is switched
        return new IngAccountList(
            await StatementScreenAsync(ctx, portal, today, ct).ConfigureAwait(false),
            Everything: false,
            Via: "statement-screen");
    }

    /// a refusal is NOT caught: IngCalls maps 401 to session_expired, and falling back would report half the accounts;
    /// only an unreadable payload falls through, with its shape (never values) noted
    private IReadOnlyList<IngAccount>? Listed(IJobContext ctx, IngCall call, DateOnly today)
    {
        JsonDocument document;

        try
        {
            document = JsonDocument.Parse(IngCalls.Body(call, "the agreement list", ctx.Note));
        }
        catch (JsonException ex)
        {
            ctx.Note(
                $"{ProviderId}: {_options.AgreementsPath} was not readable JSON ({ex.Message}), so the " +
                "statement screen was used to list accounts instead");

            return null;
        }

        using (document)
        {
            string why;

            try
            {
                var accounts = IngAccounts.ReadAgreements(document, ctx.SessionId, today, ctx.Note);

                if (accounts.Count > 0) return accounts;

                why = "it named no account this connector reads";
            }
            catch (ConnectorException ex) when (ex.Code is ErrorCode.ProviderChanged)
            {
                why = ex.Message;
            }

            // the note always carries the shape (keys, nesting, lengths, never values): the alternative is another live sign-in
            // on somebody's real account
            ctx.Note(
                $"{ProviderId}: the statement screen was used to list accounts instead of " +
                $"{_options.AgreementsPath}, because {why}. The shape of what ING sent is: " +
                IngSchema.Describe(document.RootElement));
        }

        return null;
    }

    /// a card has no balance in any list (three live runs): read from the agreement's self link, followed not composed
    /// (ING's edge 401s composed requests on a live session). Never fatal: a refusal keeps the blank, which beats a zero
    /// that reads as a settled card
    private static async Task<IReadOnlyList<IngAccount>> DetailedAsync(
        IJobContext ctx,
        IIngPortal portal,
        IReadOnlyList<IngAccount> accounts,
        IngCall opening,
        DateOnly today,
        CancellationToken ct)
    {
        var filled = new List<IngAccount>(accounts.Count);

        foreach (var account in accounts)
        {
            if (account.Record.Balance is not null)
            {
                filled.Add(account);
                continue;
            }

            if (account.SelfPath is not { } path)
            {
                // out of leads: the session's endpoint list is noted (paths only, no segment that says whose account)
                ctx.Note(
                    $"{ProviderId}: ING states no balance for {AccountTypes.Wire(account.Record.Type)} account " +
                    $"{account.Record.ExternalId}, and offers no link to the account's own resource either, so " +
                    $"it is listed without one. The endpoints this session touched were " +
                    $"[{string.Join(", ", portal.Endpoints())}]");

                filled.Add(account);
                continue;
            }

            filled.Add(await DetailedAsync(ctx, portal, account, path, opening, today, ct).ConfigureAwait(false));
        }

        return filled;
    }

    private static async Task<IngAccount> DetailedAsync(
        IJobContext ctx,
        IIngPortal portal,
        IngAccount account,
        string path,
        IngCall opening,
        DateOnly today,
        CancellationToken ct)
    {
        var what = $"the {AccountTypes.Wire(account.Record.Type)} account's own details";

        IngCall call;

        using (await ctx.Pacer.EnterAsync(ct).ConfigureAwait(false))
        {
            call = await portal.ReadAsync(path, opening.Headers, ct).ConfigureAwait(false);
        }

        try
        {
            using var document = JsonDocument.Parse(IngCalls.Body(call, what, ctx.Note));

            if (IngAccounts.ReadDetailsBalance(document, account.Record.Currency, today) is { } balance)
            {
                // rebuilt, not patched: the content hash is computed from the record's fields
                return account with
                {
                    Record = BankRecords.NewAccount(ctx.SessionId, new AccountDraft
                    {
                        ExternalId = account.Record.ExternalId,
                        Type = account.Record.Type,
                        DisplayName = account.Record.DisplayName,
                        Currency = account.Record.Currency,
                        Iban = account.Record.Iban,
                        MaskedNumber = account.Record.MaskedNumber,
                        Balance = balance,
                    }),
                };
            }

            ctx.Note(
                $"{ProviderId}: {what} ({PageIngPortal.Endpoint(path)}) answered, and nothing in it is a " +
                $"balance spelled the way ING spells one everywhere else, so the account is listed without " +
                $"one. Its shape is: {IngSchema.Describe(document.RootElement, maxChars: 3_000)}");
        }
        catch (Exception ex) when (ex is ConnectorException or JsonException)
        {
            ctx.Note(
                $"{ProviderId}: {what} ({PageIngPortal.Endpoint(path)}) could not be read ({ex.Message}), so " +
                "it is listed without a balance");
        }

        return account;
    }

    /// current accounts REQUIRED, savings and cards BEST EFFORT: nobody has established whether ING calls the savings
    /// endpoint for a customer without savings; this route reaches the current accounts only, as ING asks for savings
    /// and cards when the picker is switched
    private async Task<IReadOnlyList<IngAccount>> StatementScreenAsync(
        IJobContext ctx, IIngPortal portal, DateOnly today, CancellationToken ct)
    {
        var current = await portal
            .ObserveAsync(_options.DownloadPageUrl, _options.CurrentAccountsPath, _options.ApiCallTimeoutMs, ct)
            .ConfigureAwait(false);

        if (current.Count == 0)
        {
            throw ConnectorException.SessionExpired(
                $"{ProviderId}: ING's own client never asked for the account list after landing on the " +
                $"statement screen, which is what it does when nobody is signed in. The browser is " +
                $"{await Showing(portal, ct).ConfigureAwait(false)}");
        }

        var accounts = new List<IngAccount>();

        using (var document = JsonDocument.Parse(IngCalls.Body(current[0], "the current accounts", ctx.Note)))
        {
            accounts.AddRange(IngAccounts.ReadCurrent(document, ctx.SessionId, today));
        }

        Optional(ctx, portal, _options.SavingsAccountsPath, "the savings accounts", savings =>
            accounts.AddRange(IngAccounts.ReadSavings(savings, ctx.SessionId, today)));

        Optional(ctx, portal, _options.CreditCardsPath, "the credit cards", cards =>
            accounts.AddRange(IngAccounts.ReadCreditCards(cards, ctx.SessionId, Currency(accounts))));

        return accounts;
    }

    /// absence is an answer, said out loud: "could not read" and "you have none" are the same empty list otherwise
    private static void Optional(
        IJobContext ctx, IIngPortal portal, string pathMarker, string what, Action<JsonDocument> read)
    {
        var seen = portal.Seen(pathMarker);

        if (seen.Count == 0)
        {
            ctx.Note($"{ProviderId}: ING made no call for {what}, so none are reported");
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(IngCalls.Body(seen[0], what, ctx.Note));
            read(document);
        }
        catch (ConnectorException ex) when (ex.Code is ErrorCode.ProviderChanged)
        {
            ctx.Note($"{ProviderId}: {what} could not be read ({ex.Message}); continuing without them");
        }
        catch (JsonException ex)
        {
            ctx.Note($"{ProviderId}: {what} was not readable JSON ({ex.Message}); continuing without them");
        }
    }

    /// borrowed from accounts already read, so a customer whose accounts are not in euros gets no EUR card
    private static string Currency(List<IngAccount> accounts) =>
        accounts.Count > 0 ? accounts[0].Record.Currency : "EUR";

    /// press ING's own button: that fires POST /api/sessions/logout, while navigating to the goodbye page leaves the session
    /// alive and looks like success. Best effort, never fatal, a miss is said out loud. A disconnect is a standalone Logout
    /// job with no browser, and an early `Browser.Started` return once made every disconnect report success sending nothing
    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.LoggingOut);

        // a browser is started on purpose: the lease carries the stored cookie jar, so opening a page resumes the session;
        // with no jar there is nothing to sign out of
        if (string.IsNullOrWhiteSpace(ctx.Material?.StorageState))
        {
            ctx.Note($"{ProviderId}: this disconnect carried no stored session, so there was nothing to sign out");
            return;
        }

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        await LogoutAsync(ctx, new PlaywrightLoginPage(page, Manifest), new PageIngPortal(page, _options), ct)
            .ConfigureAwait(false);
    }

    internal async Task LogoutAsync(IJobContext ctx, ILoginPage page, IIngPortal portal, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(portal);

        try
        {
            // ING's button is on ING's page: a fresh logout browser sits on about:blank and the selectors would find nothing
            await page.GotoAsync(_options.OverviewUrl, ct).ConfigureAwait(false);

            if (!await page.ClickAsync(_options.LogoutSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
            {
                ctx.Note(
                    $"{ProviderId}: could not find ING's sign-out button, so the upstream session was left to " +
                    $"expire on its own ({Manifest.Auth.Session.TtlSeconds}s). The browser is " +
                    $"{page.Url}. Tried: {string.Join(", ", _options.LogoutSelectors)}");

                return;
            }

            // checked, not assumed: ING's own sign-out call is the evidence, as a transactions call is for login
            var called = await portal
                .WatchAsync(_options.LogoutCallPathMarker, _options.StepProbeMs, ct)
                .ConfigureAwait(false);

            if (called.Count > 0
                || page.Url.Contains(_options.LoggedOutPathMarker, StringComparison.OrdinalIgnoreCase))
            {
                ctx.Note($"{ProviderId}: signed out upstream");
                return;
            }

            ctx.Note(
                $"{ProviderId}: ING's sign-out button was pressed, but neither its own sign-out call nor its " +
                $"signed-out page ({_options.LoggedOutPathMarker}) followed - the browser is at {page.Url}. The " +
                $"session may still be alive and will expire on its own ({Manifest.Auth.Session.TtlSeconds}s)");
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            ctx.Note($"{ProviderId}: the sign-out click did not land ({ex.Message}); the session will expire");
        }
    }

    private DateOnly Today() => DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime);

    private static async Task<string> Showing(IIngPortal portal, CancellationToken ct)
    {
        try
        {
            return await portal.DescribeAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (PageOps.IsSelectorMiss(ex))
        {
            return $"unreadable ({ex.Message})";
        }
    }

    private static string RequiredInput(IJobContext ctx, string key) =>
        ctx.Inputs.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw ConnectorException.InvalidCredentials($"{ProviderId}: '{key}' is required");

    /// present-but-unusable is not missing: ING ships phone and desktop layouts in one document and hides one with CSS, so
    /// a selector can match an element nobody can press; "matches nothing" and "matches too much" need opposite repairs
    private async Task<ConnectorException> UnusableAsync(
        ILoginPage page, IIngPortal portal, string what, IReadOnlyList<string> selectors, CancellationToken ct)
    {
        var showing = await Showing(portal, ct).ConfigureAwait(false);

        var found = await page.FindAsync(selectors, _options.StepProbeMs, ct).ConfigureAwait(false) is not null;

        return ConnectorException.ProviderChanged(
            found
                ? $"{ProviderId}: {what} IS on the sign-in form and could not be used - one of "
                  + $"[{string.Join(", ", selectors)}] matched it and it never became usable, which is a "
                  + $"selector matching something nobody can press rather than a missing control. The browser "
                  + $"is {showing}"
                : $"{ProviderId}: could not find {what} on the sign-in form. Tried: "
                  + $"{string.Join(", ", selectors)}. The browser is {showing}");
    }
}
