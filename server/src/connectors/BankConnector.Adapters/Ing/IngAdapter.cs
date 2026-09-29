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

/// <summary>
/// ING, read the way ING's own app reads itself.
///
/// The adapter never constructs a transactions URL, because it cannot: the
/// agreement id in <c>/v1/agreements/{id}/transactions</c> is encrypted per
/// session and was a different string on each of the two captures of the same
/// account. So the overview page is asked to load, ING's javascript asks its
/// own question with its own current id, and this listens - then walks ING's
/// own cursor links for the rest. See <see cref="IIngPortal"/>.
/// </summary>
/// <remarks>
/// A bundle from this provider holds a cookie jar and nothing else, and it does
/// not hold it for long: ING wants a second factor on every sign-in and its
/// session cannot be renewed without one, so this adapter signs OUT when it is
/// finished rather than leaving one alive. The account holder asked for that
/// explicitly - ING's fraud detection notices an account that signs in
/// repeatedly and never signs out, and the consequences of that land on them.
/// </remarks>
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

        // Everything that can fail without contacting anybody, before a browser
        // is leased. Launching Chromium to discover a blank field holds an agent
        // for nothing - and at a bank it also spends one of a limited number of
        // sign-in attempts to learn the same thing.
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

    /// <summary>
    /// The login, behind the seam so the offline suite can drive it.
    /// </summary>
    /// <remarks>
    /// THE SESSION IS CONFIRMED BY ASKING FOR TRANSACTIONS, not by reading a
    /// URL. mijn.ing.nl is a client-routed app, so the address bar says
    /// <c>/banking</c> while the app is still deciding whether to send the
    /// visitor back to a sign-in - Coolblue sealed a jar of anonymous cookies
    /// that way, and DUO reported a finished login eighty milliseconds after
    /// opening, having asked the human nothing.
    /// </remarks>
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

        // From here a retry could count against the account. Said before the
        // waiting starts, because what makes it true is that the form was
        // submitted, not that anything came back.
        ctx.CredentialSubmitted();

        // The password is out of the DOM before anything is photographed. The
        // redactor refuses to capture while a secret-declared field holds
        // content, and the challenge below is exactly when a capture happens.
        await page.ClearSecretsAsync(ct).ConfigureAwait(false);

        ctx.Progress(JobStep.AwaitingHuman);

        // THE CARD IS RAISED AND NOT AWAITED, and that is the whole point.
        //
        // ING pushes a notification to the account holder's phone and its own
        // page polls until they tap it. The approval therefore has a witness
        // that is not the human: ING's app takes itself to the overview and
        // fetches transactions the moment it lands. Waiting for somebody to
        // come back to a browser tab and confirm what their bank already told
        // us would be asking them to do the machine's job.
        //
        // So the challenge exists to SAY what to do - the consumer renders it
        // from the prompt key - while the watch below is what actually decides.
        // Pressing the button still works and simply arrives first; ignoring it
        // costs nothing. Six adapters here already race a challenge this way;
        // DUO's live view is the closest relative.
        using var ask = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(new Challenge
        {
            Type = ChallengeType.AppApproval,
            PromptKey = IngManifest.AppApprovalKey,
            // Longer than the wait below, deliberately. An unanswered challenge
            // parks the job until the run completes, and a challenge that
            // expires first gets the whole finished login swept away. See
            // IngOptions.ChallengeTtlMs.
            ExpiresAt = _time.GetUtcNow().AddMilliseconds(_options.ChallengeTtlMs),
        }, ask.Token);

        IReadOnlyList<IngCall> observed;

        try
        {
            // WATCH FIRST, NAVIGATE SECOND.
            //
            // ING's app takes itself to the overview once the approval lands and
            // fires the transactions call by itself, so on the ordinary path
            // there is nothing to do but listen. MediaMarkt's first live run
            // navigated at this exact moment instead, cancelled a sign-in that
            // was still in flight, and reported the password as refused - so the
            // navigation here is the FALLBACK, for a session that finished
            // somewhere unexpected.
            //
            // The APPROVAL budget, not the API one: this wait now spans a person
            // finding their phone, which forty-five seconds does not.
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
            // Cancelled rather than abandoned: the platform releases the job's
            // budget park on this unwind, and dropping the task instead would
            // stop the run's working clock for the rest of the login.
            await ask.CancelAsync().ConfigureAwait(false);

            // And observed, so the cancellation does not surface later as an
            // unobserved task exception. The two hosts disagree about what that
            // exception IS - the agent lets a raw OperationCanceledException
            // escape, the inline runner turns it into mfa_timeout - so this
            // swallows whatever arrives rather than naming one.
            _ = asked.ContinueWith(static settled => _ = settled.Exception, TaskScheduler.Default);
        }

        ctx.Progress(JobStep.Finalizing);

        if (observed.Count == 0)
        {
            throw ConnectorException.InvalidCredentials(
                $"{ProviderId}: the overview never asked for transactions after the sign-in, so nobody is " +
                $"signed in. The browser is {await Showing(portal, ct).ConfigureAwait(false)}");
        }

        // A refusal here is not a bad password - the form accepted it, and the
        // approval landed. Left to say what it actually is.
        _ = IngCalls.Body(observed[0], "the overview's transactions call", ctx.Note);

        var accounts = (await AccountsAsync(ctx, portal, Today(), ct).ConfigureAwait(false)).Found;

        return new LoginResult
        {
            // The cookie jar and nothing else.
            Material = new SessionMaterial
            {
                StorageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false),
            },
            // Named for the bank rather than the person. The payloads do carry
            // the account holder's name, and using it would mean keeping a name
            // this connector has no need for.
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
            // The real expiry rather than the manifest's, which happens to be
            // the same number - stated here so that a future change to one does
            // not silently promise something the other does not deliver.
            ExpiresAt = _time.GetUtcNow().AddSeconds(Manifest.Auth.Session.TtlSeconds),
        };
    }

    /// <summary>
    /// Gets to the password form, from whichever sign-in screen ING opened on.
    /// </summary>
    /// <remarks>
    /// ING picks its own first screen - "Inloggen via je app" on a phone
    /// viewport, "Log in met een QR-code" on a desktop one - and the password
    /// form is one click away behind a button naming it. The check is for the
    /// FORM rather than for the screen: if the password box is already there,
    /// nothing is clicked, which is what keeps a wrong guess about the button's
    /// wording from breaking a login that did not need it.
    /// </remarks>
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

        // The overview, for the transactions ING's own app fetches on arrival.
        // The account lists come from a second page below, for the same reason:
        // ING serves its own client and refuses ours.
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

    /// <summary>
    /// An account list, and whether it is ALL of them.
    /// </summary>
    /// <remarks>
    /// THE FLAG TRAVELS WITH THE LIST, because this adapter has two routes to
    /// one and they do not reach the same accounts. The agreement list is every
    /// agreement ING holds; the statement screen produces the current accounts
    /// and asks for savings and cards only when a human switches its picker, so
    /// merely visiting it reaches less - a live run reported an account holder's
    /// own savings account as unreachable for exactly that reason.
    /// <para>
    /// That was already understood and already SAID, in a note and in this
    /// file's own remarks. What went with it was <c>complete: true</c> and
    /// <c>via: "overview"</c>, unconditionally, on both routes - so the one
    /// field a consumer is told to code against announced a partial list as the
    /// whole of somebody's accounts, and the prose explaining otherwise was
    /// somewhere no program will ever read.
    /// </para>
    /// </remarks>
    private sealed record IngAccountList(IReadOnlyList<IngAccount> Found, bool Everything, string Via);

    /// <summary>
    /// How far one walk goes: the window it has to cover, and the most rows it
    /// may bring back.
    /// </summary>
    /// <remarks>
    /// For the whole page, <see cref="Cap"/> is the page's budget; for one
    /// account's walk it is that account's share of it - see
    /// <see cref="TransactionsAsync"/>.
    /// </remarks>
    private readonly record struct WalkLimits(FetchWindow Window, int Cap);

    /// <summary>The window a transactions request covers, and the page's row cap.</summary>
    private WalkLimits Limits(ResourceRequest request, DateOnly today) =>
        new(
            BankWindow.Resolve(request, Manifest, today),
            _options.RecordCap
            ?? Manifest.Resource(BankResources.Transactions)?.MaxRecordsPerFetch
            ?? 200);

    /// <summary>
    /// The transaction history: the observed call per account, then ING's own
    /// cursor links until the window is covered.
    /// </summary>
    /// <remarks>
    /// TWO ROUTES TO THE SAME ENDPOINT, and the difference matters.
    /// <list type="bullet">
    /// <item>ING's overview fetches transactions per CURRENT account by itself.
    /// Those calls are observed, and the first page is one this connector never
    /// had to ask for - which is the most reliable page there is.</item>
    /// <item>Every other account - savings, cards, loans - is fetched from the
    /// <c>transactions</c> link its own agreement states. That link was sitting
    /// in the agreement list for several releases while this adapter told
    /// callers their savings history "is offered as a download only", because
    /// the overview making no call for it was mistaken for ING not serving
    /// it.</item>
    /// </list>
    /// <para>
    /// After that, both are the same cursor walk.
    /// </para>
    /// </remarks>
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

        // WHO WILL BE WALKED, DECIDED BEFORE ANYTHING IS.
        //
        // The cap is a budget for the whole page, and a budget cannot be shared
        // out by a loop that does not know how many accounts are still coming.
        // It used to be handed to every account whole, and the emitted page is
        // then trimmed to the first `cap` rows oldest-first - so on the DEFAULT
        // fetch, which selects everything, one current account with more
        // history than the cap filled it and savings, card and loan each
        // emitted NOTHING. They were still listed, with balances, and their
        // transactions were still fetched and then thrown away: about forty
        // paced page requests spent on rows nobody would see, and an empty
        // history that reads exactly like an account nothing has happened on.
        var plan = new List<(IngAccount Account, IngCall? Opening)>();

        PlanObserved(ctx, observed, accounts, selected, served, plan, ct);
        var complete = PlanOwnFeeds(ctx, accounts, selected, served, plan);

        for (var i = 0; i < plan.Count; i++)
        {
            ct.ThrowIfCancellationRequested();

            var (account, opening) = plan[i];

            // What is LEFT, divided by the accounts still to come including
            // this one. An account that needs less passes the remainder on: a
            // savings account with twelve rows leaves the rest to the current
            // account rather than costing it a share of the page.
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

            // TRIMMED HERE RATHER THAN AT THE END, because the emission's own
            // trim keeps a contiguous prefix - which across accounts means the
            // first one and none of the rest. ING serves newest first, so this
            // keeps each account's most recent rows.
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
        }

        // NOTHING AT ALL IS AN ERROR, and a partial pass is not.
        //
        // An empty list marked incomplete is too easy for a consumer to read as
        // "you have no transactions", which is the failure this adapter has
        // spent its whole life avoiding. Where SOME account was read, the gap is
        // carried by complete=false and a note naming what was missed; where
        // none was, the request itself did not work and says so out loud. The
        // notes travel either way.
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

        // OLDEST FIRST, PER ACCOUNT, because that is what the balance chain is
        // defined on - and the chain is the only check that catches an inverted
        // sign or a dropped row, both of which produce entirely believable
        // output. ING states newest first, so this reverses each account's rows
        // rather than sorting them: sorting would repair an out-of-order page
        // instead of failing on it.
        var ordered = new List<Transaction>();

        foreach (var account in selected.Where(a => served.Contains(a.Id)))
        {
            var forAccount = rows.Where(t => string.Equals(t.AccountId, account.Id, StringComparison.Ordinal));
            ordered.AddRange(forAccount.Reverse());
        }

        var (trimmed, within) = BankEmission.Page(ordered, cap);

        ctx.Progress(JobStep.Finalizing);

        // AND THE ACCOUNT LIST'S OWN COMPLETENESS, which nothing here could
        // otherwise see. `complete` above is computed over the accounts that
        // REACHED this method: an account the degraded list never found
        // cannot lower it, so a customer with four accounts and a statement-
        // screen read would be handed three accounts' history marked whole.
        return BankEmission.Verified(
            ProviderId,
            selected,
            trimmed,
            complete && within && read.Everything,
            via: "v1/agreements/transactions");
    }

    /// <summary>
    /// The first half of the plan: the accounts ING's own overview already
    /// fetched a page for, each walked from that page.
    /// </summary>
    private static void PlanObserved(
        IJobContext ctx,
        IReadOnlyList<IngCall> observed,
        IReadOnlyList<IngAccount> accounts,
        IReadOnlyList<Account> selected,
        HashSet<string> served,
        List<(IngAccount Account, IngCall? Opening)> plan,
        CancellationToken ct)
    {
        // How many observed pages have had to be attributed by inference rather
        // than by what they state. A second one is a contradiction - see
        // Attribute.
        var unnamed = 0;

        foreach (var call in observed)
        {
            ct.ThrowIfCancellationRequested();

            using var opening = JsonDocument.Parse(IngCalls.Body(call, "a page of transactions", ctx.Note));

            if (Attribute(ctx, opening, accounts, ref unnamed) is not { } account) continue;

            if (!IsSelected(selected, account)) continue;

            // ONE WALK PER ACCOUNT, however many calls ING's client made for
            // it. The latch keys on the request url, so a page fetched twice
            // with different query - a retry, a widget asking for its own
            // slice - arrives as two entries naming the same account, and
            // walking both would emit every row of it twice.
            if (!served.Add(account.Record.Id)) continue;

            plan.Add((account, call));
        }
    }

    /// <summary>
    /// The second half of the plan: every other selected account, by the link
    /// its own agreement states.
    /// </summary>
    /// <returns>
    /// False when a selected account states no link, because a caller asked
    /// for its history and is getting none.
    /// </returns>
    private static bool PlanOwnFeeds(
        IJobContext ctx,
        IReadOnlyList<IngAccount> accounts,
        IReadOnlyList<Account> selected,
        HashSet<string> served,
        List<(IngAccount Account, IngCall? Opening)> plan)
    {
        var complete = true;

        // EVERY OTHER SELECTED ACCOUNT, BY ITS OWN LINK.
        //
        // ING's overview fetches transactions per current account and for
        // nothing else, so anything else selected would have come back empty -
        // and did, for several releases, reported as "ING offers that history
        // as a download only". It does not: every agreement states the address
        // of its own feed, and the walk below is the same one.
        foreach (var account in accounts)
        {
            if (served.Contains(account.Record.Id)) continue;
            if (!IsSelected(selected, account)) continue;

            if (account.TransactionsPath is null)
            {
                // Incomplete, not empty. A caller asked for this account's
                // history and is getting none; saying "complete" about that
                // would be telling them there is nothing there.
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

    /// <summary>Did the caller ask for this account?</summary>
    private static bool IsSelected(IReadOnlyList<Account> selected, IngAccount account) =>
        selected.Any(a => string.Equals(a.Id, account.Record.Id, StringComparison.Ordinal));

    /// <summary>
    /// One account's history from the call ING'S OWN CLIENT made for it.
    /// </summary>
    /// <remarks>
    /// The body is re-parsed rather than carried from the planning pass. A
    /// JsonDocument held across an await for every observed account is a
    /// lifetime to get wrong, and re-parsing one page of forty rows costs
    /// less than the paced request that fetched it.
    /// <para>
    /// A body that will not parse costs this account and no other, matching
    /// the own-feed route beside it. It used to fail the whole fetch and throw
    /// away every account already walked - and as <c>internal</c>, which reads
    /// to a caller as our bug rather than as ING having sent something odd.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// One account's history from the feed ITS OWN AGREEMENT names, for the
    /// accounts the overview fetches nothing for.
    /// </summary>
    /// <remarks>
    /// Savings, cards and loans. ING's overview asks for transactions per
    /// current account and stops there, so for years of releases this connector
    /// told a caller their savings history "is offered as a download only" -
    /// while the agreement list it was already reading carried the address of
    /// the feed.
    /// <para>
    /// The headers are an OBSERVED TRANSACTIONS CALL's, not the agreement
    /// list's: this is a request to the same endpoint family ING's own client
    /// just used, and the closest thing to it that was accepted is the best
    /// template there is. With no observed call to borrow from, the agreement
    /// list's own headers are the fallback.
    /// </para>
    /// <para>
    /// NEVER FATAL, and null rather than empty on a miss: an account whose feed
    /// is refused must not take the accounts that worked down with it, and
    /// "read nothing" has to stay distinguishable from "read, and there was
    /// nothing" - one is a gap and the other is an answer.
    /// </para>
    /// </remarks>
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
                // THE SHAPE, because a feed this reader cannot make sense of is
                // one nobody here has seen. The current account's transactions
                // were read from a capture; a card's and a loan's have only
                // ever been reached through the link on their agreements, and
                // ING is under no obligation to spell a card payment the way it
                // spells a bank transfer. This is how every other shape in this
                // adapter was learned - keys and lengths, never a value.
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

    /// <summary>
    /// The headers a composed request borrows: an observed transactions
    /// call's, or the agreement list's when no transactions call was seen.
    /// See <see cref="OwnFeedAsync"/> for why that order.
    /// </summary>
    private IReadOnlyDictionary<string, string>? BorrowedHeaders(IIngPortal portal, IReadOnlyList<IngCall> observed)
    {
        if (observed.Count > 0) return observed[0].Headers;

        return portal.Seen(_options.AgreementsPath) is [var agreements, ..] ? agreements.Headers : null;
    }

    /// <summary>
    /// One account's pages, from the observed call to ING's last cursor.
    /// </summary>
    /// <remarks>
    /// THE FIRST PAGE IS OBSERVED AND EVERY LATER ONE IS ASKED FOR, and those
    /// are not equally reliable. ING's own client makes the first; this
    /// connector composes the rest, replaying the headers that client sent - and
    /// ING's edge has been seen to refuse a composed request outright on a live
    /// session. So a refused page stops the walk and reports the pass as
    /// partial, rather than throwing away a good page of transactions over the
    /// page behind it.
    /// </remarks>
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

                var page = IngTransactions.Read(document, ctx.SessionId, account.Id);
                Absorb(ctx, walk, page, limits.Window);

                // The oldest row on this page is already before the window, so
                // every page after it is too. Checked before the cursor is
                // followed rather than after the whole walk, because an account
                // with ten years on it is fifty pages a caller asked nothing
                // about.
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

    /// <summary>
    /// What one account's cursor walk has gathered so far.
    /// </summary>
    /// <remarks>
    /// The tallies in one place rather than a row of locals, so each step of
    /// the walk - absorbing a page, deciding whether to go on, asking for the
    /// next page, reporting - can be read on its own.
    /// </remarks>
    private sealed class Walk
    {
        /// <summary>The rows inside the window, in ING's order: newest first.</summary>
        public List<Transaction> Rows { get; } = [];

        public int Pages { get; set; }

        /// <summary>How many unsettled reservations the pages carried and this walk left out.</summary>
        public int Reservations { get; set; }

        public bool Complete { get; set; } = true;

        /// <summary>ING's own codes on the rows this reader could not classify, distinct, in page order.</summary>
        public List<string> Unclassified { get; } = [];

        /// <summary>The tail of every derived row's detail link, in page order across the whole walk.</summary>
        public List<string> Details { get; } = [];
    }

    /// <summary>
    /// Folds one page into the walk: the rows inside the window, and
    /// everything the report at the end is built from.
    /// </summary>
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

        // ACROSS THE WHOLE WALK, and kept in page order, because the two
        // things that give a position away only show up that way: the
        // same tail arriving twice, and a run that restarts when the
        // next page begins.
        walk.Details.AddRange(page.DetailIds);
    }

    /// <summary>
    /// Has the walk spent its pages or its rows? Said out loud when it has,
    /// with where it stopped.
    /// </summary>
    private bool Exhausted(IJobContext ctx, Walk walk, Account account, WalkLimits limits)
    {
        if (walk.Pages < _options.MaxPages && walk.Rows.Count < limits.Cap) return false;

        walk.Complete = false;

        // WHERE IT STOPPED, not just that it did. ING serves newest
        // first, so the oldest row read is the boundary - and the
        // caller continues by asking again with `until` set to it,
        // which is a parameter this resource already takes. A note
        // that says only "partial" leaves them to binary-search
        // their own history.
        var oldest = walk.Rows.Count > 0 ? walk.Rows[^1].BookedAt : limits.Window.From;

        ctx.Note(
            $"{ProviderId}: stopped after {walk.Pages} page(s) with {walk.Rows.Count} transaction(s) for " +
            $"{account.ExternalId}, at {oldest:yyyy-MM-dd}. There is more before that date: ask " +
            $"again with until={oldest:yyyy-MM-dd} to continue from here");

        return true;
    }

    /// <summary>
    /// The next page's body, asked for with the headers of the call it
    /// continues - or null when ING refused the request this connector
    /// composed, which ends the walk as partial rather than as failed.
    /// </summary>
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

            // THE HEADERS OF THE CALL THIS CONTINUES, not of whatever
            // ING's client asked for most recently. A cursor page is
            // the same request one step further on, and the live run
            // that went out with two headers on it was refused by ING's
            // webserver.
            var call = await portal.ReadAsync(next, opening.Headers, ct).ConfigureAwait(false);

            try
            {
                return IngCalls.Body(call, $"page {walk.Pages + 1} of transactions", ctx.Note);
            }
            catch (ConnectorException ex)
            {
                // A COMPOSED REQUEST REFUSED, not a dead session. ING's
                // own client served page one on this very session
                // moments ago; what failed is the page this connector
                // built, and ING's edge is known to answer one of those
                // with a 401 while the session is perfectly alive.
                // Reporting that as session_expired would send somebody
                // to re-authenticate over a page they already have.
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

    /// <summary>
    /// What the walk can say about how far to trust its own rows, once the
    /// last page is in.
    /// </summary>
    private static void Report(IJobContext ctx, Walk walk, Account account)
    {
        var rows = walk.Rows;

        if (walk.Reservations > 0)
        {
            // Said out loud rather than dropped quietly. A reservation is a card
            // authorisation that has not settled: ING states no running balance
            // for it and is free to change its amount when it books, so
            // publishing it as a booked transaction would be publishing a figure
            // that changes itself later.
            ctx.Note(
                $"{ProviderId}: skipped {walk.Reservations} unsettled reservation(s) on {account.ExternalId}; " +
                "they are not booked yet and will arrive with their final amounts");
        }

        // COUNTED ON WHAT SURVIVES THE WINDOW, not on what was read.
        // The two differ on every page that straddles the edge of the
        // window, and counting the wrong one produced "10 of 3
        // transaction(s) carry a derived id" on a live run.
        var derived = rows.Count(IngTransactions.IsDerived);
        var chained = rows.Exists(t => t.ResultingBalance is not null);

        // BOTH OF THESE ARE ABOUT HOW FAR TO TRUST WHAT CAME BACK, and neither
        // is visible in the rows themselves.
        //
        // A derived id is stable across a language change by construction -
        // nothing translatable goes into it - but it is still ours rather than
        // ING's, and a consumer deduplicating on it deserves to know which.
        if (derived > 0)
        {
            ctx.Note(
                $"{ProviderId}: {derived} of {rows.Count} transaction(s) on {account.ExternalId} carry an id " +
                "this connector derived, because ING states none for them. They are prefixed 'ing-d-' and are " +
                "built only from parts ING does not translate");

            // WHAT WOULD REPLACE THEM, MEASURED RATHER THAN USED. Every one of
            // those rows links to its own detail page, and that link ends in
            // something id-shaped. Whether it IS an id cannot be told from one
            // payload - see IngTransactions.DescribeDetails - and adopting a
            // position by mistake would hand the consumer this account's entire
            // history again on every single sync.
            ctx.Note($"{ProviderId}: {IngTransactions.DescribeDetails(walk.Details)}");
        }

        // And the running balance is what catches an inverted sign or a dropped
        // row - both of which produce entirely believable output. A feed that
        // states none is not wrong, but it is unchecked, and saying so is the
        // difference between "verified" and "nothing objected".
        if (rows.Count > 0 && !chained)
        {
            ctx.Note(
                $"{ProviderId}: ING states no running balance on {account.ExternalId}, so the usual check that " +
                "the amounts add up could not be run for it. The rows are as ING sent them; nothing confirms " +
                "none is missing");
        }

        // ING'S OWN CODES FOR THE ROWS THIS CONNECTOR COULD NOT CLASSIFY.
        //
        // A research instrument, and the same one that classified a credit
        // card: iconId turned out to be a code rather than translated text, and
        // that was only knowable by looking at the values.
        //
        // THE COUNT AND THE CODES ARE ABOUT DIFFERENT SETS, and saying so is
        // the whole repair. The count is of rows the caller RECEIVED; the codes
        // come off every row this reader saw, window or not. A live run put the
        // difference on screen - "0 of 0 transaction(s) on V28681505 could not
        // be classified. ING's own codes on them were: IIPS, SAV-rente, ..." -
        // which is the same nonsense as the "10 of 3" this file already fixed
        // once, in a sentence that then listed seven codes belonging to rows
        // nobody was given.
        if (walk.Unclassified.Count > 0)
        {
            var other = rows.Count(t => t.Kind == TransactionKind.Other);

            // THE TWO SCOPES, NAMED. Saying they differ was the previous
            // repair and it did not land: "1 of 1 transaction(s) in the
            // requested window could not be classified, and these are ING's own
            // codes on the rows this connector could not classify: IIPS,
            // SAV-rente, SWNP, SAV-opname, SDSCO, SAV-inleg, SD" reads as seven
            // codes on one row, which is impossible - a row has one code.
            //
            // The clause has to say WHICH rows the codes came from, not merely
            // that a distinction exists.
            var counted = rows.Count == 0
                ? "no transaction fell inside the requested window"
                : $"{other} of the {rows.Count} transaction(s) you received could not be classified";

            // AND WHAT THE LIST LEFT OUT. Twenty-four codes was a silent cut in
            // the one sentence whose entire purpose is to be reasoned from.
            var shown = walk.Unclassified.Take(24).ToList();
            var cut = walk.Unclassified.Count - shown.Count;

            ctx.Note(
                $"{ProviderId}: on {account.ExternalId}, {counted}. Separately, across EVERY row read for this "
                + $"account - the window's and the pages either side of it - ING's own codes on the ones this "
                + $"connector could not classify were: {string.Join(", ", shown)}"
                + (cut > 0 ? $", and {cut} more" : string.Empty));
        }
    }

    /// <summary>
    /// Which account a page of transactions belongs to.
    /// </summary>
    /// <remarks>
    /// By ING's product-agreement UUID, which it repeats inside the action links
    /// of the transactions themselves and which is the <c>uuid</c> that
    /// <c>/accounts/current</c> states. The agreement id in the request URL
    /// cannot be used - it is encrypted per session, and was a different string
    /// on each of the two captures of this same account.
    /// <para>
    /// The one-account fallback is deliberate and narrow: with a single current
    /// account there is nothing to confuse it with, and refusing there would
    /// mean losing every transaction over a link ING is free to stop emitting.
    /// With more than one, a guess would file somebody's transactions under the
    /// wrong account, which reconciles perfectly and is invisible.
    /// </para>
    /// <para>
    /// <b>ONCE, AND THE SECOND TIME IS A REFUSAL.</b> "Nothing to confuse it
    /// with" rests on a fact about ING rather than about this code - its
    /// overview fetches transactions for current accounts and for nothing else
    /// - and that premise was documented here and checked nowhere. If the
    /// overview ever fetches a savings feed that states no agreement, its rows
    /// land on the one current account, AND the savings account is walked again
    /// by its own link: the same history filed twice, once under the wrong
    /// name, reconciling perfectly under both.
    /// </para>
    /// <para>
    /// A second unnamed page is what that looks like from here, because one
    /// account cannot be the subject of two. It is refused, and said out loud.
    /// </para>
    /// <para>
    /// <b>The FIRST is still attributed, and that is a compromise rather than a
    /// result.</b> Refusing both would be safer if the current account could be
    /// read another way, and it cannot: ING states a transactions link on the
    /// savings, card and loan agreements and NOT on the current one - the
    /// overview fetching it is the only route there is, which a test asserting
    /// otherwise is what established. So refusing everything would trade an
    /// invisible mistake for the certain loss of the account most people are
    /// asking about. If the first unnamed page is the one that belongs
    /// elsewhere it is still misfiled; what is no longer possible is for that
    /// to happen without anybody being told.
    /// </para>
    /// </remarks>
    /// <param name="unnamed">
    /// How many pages this pass has already attributed by inference rather than
    /// by what they state.
    /// </param>
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

    /// <summary>
    /// Every account, WATCHED rather than asked for.
    /// </summary>
    /// <remarks>
    /// Nothing here is fetched. This used to ask for the account lists - plain
    /// GETs to endpoints whose addresses do not move and were read straight off a
    /// capture - and ING answered <c>401 Authorization Required</c> from its
    /// webserver, on a session its own javascript had used successfully seconds
    /// earlier to serve a page of transactions. Knowing an endpoint's address
    /// turns out to be a long way from being allowed to call it.
    /// <para>
    /// <c>/global/agreements</c> is what the overview renders its own list from,
    /// and landing on the overview is already what this adapter does for the
    /// transactions feed - so by the time anything gets here the answer is
    /// usually latched and this costs a dictionary lookup.
    /// </para>
    /// <para>
    /// THE STATEMENT SCREEN IS THE FALLBACK, and it is kept rather than deleted
    /// because the agreement reader was written from a schema while those three
    /// were written from a capture. If ING moves the shape underneath it, this
    /// degrades to the current accounts it has always been able to read instead
    /// of failing the fetch.
    /// </para>
    /// </remarks>
    private async Task<IngAccountList> AccountsAsync(
        IJobContext ctx, IIngPortal portal, DateOnly today, CancellationToken ct)
    {
        ctx.Progress(JobStep.SelectingAccounts);

        // Already latched by the navigation made for the transactions, on the
        // ordinary path. The short wait is for the run where it has not landed
        // yet - the overview fires both calls on mount and their order is ING's
        // business, not something to depend on.
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

        // NOT EVERYTHING, and now said in the one place a program can read.
        // This route asks for savings and cards only when somebody switches
        // the picker on that screen, so visiting it reaches the current
        // accounts and whatever else ING happened to have fetched already.
        return new IngAccountList(
            await StatementScreenAsync(ctx, portal, today, ct).ConfigureAwait(false),
            Everything: false,
            Via: "statement-screen");
    }

    /// <summary>
    /// The agreement list, read - or said to be unreadable, in a way that says
    /// how to fix it.
    /// </summary>
    /// <remarks>
    /// A refusal is NOT caught here. <see cref="IngCalls"/> turns a 401 into
    /// <c>session_expired</c>, and quietly falling back to another screen on one
    /// would trade a clear "sign in again" for a fetch that reports half of
    /// somebody's accounts. Only a payload this connector cannot make sense of
    /// falls through - and then <see cref="IngSchema"/> states its structure,
    /// never its values, so the next version can be written from evidence.
    /// </remarks>
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

            // ONE NOTE, AND IT ALWAYS CARRIES THE SHAPE. Whichever way the read
            // came up short, what the next version needs is the structure of
            // what ING actually sent - keys, nesting and string lengths, never a
            // value. The alternative is another live sign-in on somebody's real
            // account to find out.
            ctx.Note(
                $"{ProviderId}: the statement screen was used to list accounts instead of " +
                $"{_options.AgreementsPath}, because {why}. The shape of what ING sent is: " +
                IngSchema.Describe(document.RootElement));
        }

        return null;
    }

    /// <summary>
    /// Fills in the balance for an account whose list entry states none, from
    /// the resource ING's OWN LINK points at.
    /// </summary>
    /// <remarks>
    /// A CREDIT CARD HAS NO BALANCE IN ANY LIST, and three live runs established
    /// that rather than one guess. <c>/credit-cards/cards</c> states the card,
    /// its status, its statement dates and its export formats, and nothing in it
    /// is an amount. The agreement list carries a <c>balance</c> for every other
    /// type and omits the object entirely for a card. And the whole set of
    /// endpoints the overview touched had nothing card-shaped in it - because
    /// ING's overview shows no card balance either. The figure is on the card's
    /// own screen.
    /// <para>
    /// Which the agreement's <c>self</c> link addresses:
    /// <c>/nl/agreements/{id}/carddetails</c>. FOLLOWED RATHER THAN COMPOSED,
    /// and that distinction is the whole reason this connector works - ING's
    /// edge answered a composed request with 401 on a live session its own
    /// javascript was using. A link the payload states is the same kind of
    /// thing as the cursor the page walk already follows, carried out with the
    /// same headers.
    /// </para>
    /// <para>
    /// NEVER FATAL. The account is already listed; this only adds a figure to
    /// it. A refusal here is the composed-request failure mode again rather
    /// than a dead session - ING served the agreement list on this very session
    /// moments ago - so it is noted and the account keeps its blank, which
    /// beats a zero that would read as a settled card.
    /// </para>
    /// </remarks>
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
                // Out of leads, so the session's whole endpoint list comes back:
                // paths only, and no segment that says whose account.
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
                // REBUILT rather than patched, because the content hash is
                // computed from the record's own fields and a balance dropped
                // into a copy would leave it stating the hash of an account
                // without one.
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

    /// <summary>
    /// The older route: one endpoint per account type, off the statement screen.
    /// </summary>
    /// <remarks>
    /// Current accounts are REQUIRED and savings and cards are BEST EFFORT,
    /// which is not laziness: every ING customer has a current account and the
    /// session was just proved by reading one's transactions, so silence there
    /// is a real breakage. Nobody has established whether ING calls the savings
    /// endpoint at all for a customer who has no savings account, and failing
    /// their whole fetch to find out would be a defect introduced on purpose.
    /// <para>
    /// It reaches less than the agreement list does, and that is not a bug in
    /// it: ING asks for savings and cards only when somebody switches the picker
    /// on that screen, so merely visiting it produces the current accounts and
    /// nothing else. A live run found exactly that, by reporting an account
    /// holder's own savings account as unreachable.
    /// </para>
    /// </remarks>
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

        // Already latched by the same navigation, or genuinely not made.
        Optional(ctx, portal, _options.SavingsAccountsPath, "the savings accounts", savings =>
            accounts.AddRange(IngAccounts.ReadSavings(savings, ctx.SessionId, today)));

        Optional(ctx, portal, _options.CreditCardsPath, "the credit cards", cards =>
            accounts.AddRange(IngAccounts.ReadCreditCards(cards, ctx.SessionId, Currency(accounts))));

        return accounts;
    }

    /// <summary>
    /// An account list ING may or may not have asked for, read if it did.
    /// </summary>
    /// <remarks>
    /// Absence is an ANSWER here rather than a failure, and it is said out loud
    /// either way: "we could not read your savings accounts" and "you have no
    /// savings accounts" are the same empty list to a caller, and the note is
    /// the only thing that tells them apart.
    /// </remarks>
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

    /// <summary>
    /// The currency to give a credit card, which states none of its own.
    /// </summary>
    /// <remarks>
    /// Borrowed from the accounts already read rather than hard-coded, so a
    /// customer whose ING accounts are not in euros does not get a card labelled
    /// EUR. Falls back to EUR only when there is nothing at all to borrow from,
    /// which cannot happen while a current account is required above.
    /// </remarks>
    private static string Currency(List<IngAccount> accounts) =>
        accounts.Count > 0 ? accounts[0].Record.Currency : "EUR";

    /// <summary>
    /// Signs out upstream, which for ING is a real request rather than a
    /// courtesy.
    /// </summary>
    /// <remarks>
    /// BY PRESSING ING'S OWN BUTTON. That is what makes its
    /// <c>POST /api/sessions/logout</c> happen; navigating to the goodbye page
    /// instead shows the goodbye page and leaves the session alive, which is the
    /// failure mode worth naming because it looks exactly like success.
    /// <para>
    /// Best effort, and never fatal: a user disconnecting must always succeed
    /// locally. What it must not do is claim to have signed out when it did not,
    /// so a miss is said out loud.
    /// </para>
    /// <para>
    /// THIS USED TO DO NOTHING AT ALL, silently, and the way it read is worth
    /// keeping as a warning. A disconnect arrives as a standalone
    /// <c>JobKind.Logout</c> with its own fresh context, so no browser has been
    /// started - and the first line of the method was a
    /// <c>if (!ctx.Browser.Started) return;</c> copied from an adapter that
    /// declares <c>LogoutSupport.None</c>. Every disconnect therefore reported
    /// success, sent nothing upstream, and did not even say so, while this
    /// provider's manifest promised <c>Session</c> and the account holder had
    /// asked for it by name.
    /// </para>
    /// </remarks>
    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.LoggingOut);

        // A BROWSER IS STARTED ON PURPOSE HERE. The lease is built with the
        // job's stored cookie jar, so opening a page IS resuming the session -
        // which is the only way to press a button on it. With no jar there is
        // nothing to sign out of and launching Chromium would be pure cost.
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
            // ING'S BUTTON IS ON ING'S PAGE. A logout job opens a browser that
            // has never been anywhere, so without this the selectors hunt
            // about:blank and find nothing - which the old code then reported
            // as "could not find the button", blaming ING for a page it had
            // never asked for.
            await page.GotoAsync(_options.OverviewUrl, ct).ConfigureAwait(false);

            if (!await page.ClickAsync(_options.LogoutSelectors, _options.StepProbeMs, ct).ConfigureAwait(false))
            {
                ctx.Note(
                    $"{ProviderId}: could not find ING's sign-out button, so the upstream session was left to " +
                    $"expire on its own ({Manifest.Auth.Session.TtlSeconds}s). The browser is " +
                    $"{page.Url}. Tried: {string.Join(", ", _options.LogoutSelectors)}");

                return;
            }

            // CHECKED, NOT ASSUMED. A click that lands on something else is
            // still a click, and this method's whole reason for existing is
            // that "signed out" must not be said unless it happened. ING's own
            // sign-out call is the evidence - the same shape of proof the login
            // uses, where a transactions call rather than a url is what says
            // somebody is in.
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

    /// <summary>
    /// A step that did not work, said as one of the two things it can be.
    /// </summary>
    /// <remarks>
    /// PRESENT-BUT-UNUSABLE IS NOT MISSING, and ING has already served exactly
    /// that: it ships a phone layout and a desktop layout in one document and
    /// hides one with CSS, so a selector matches an element nobody can press.
    /// Playwright finds it, waits for it to become actionable, and gives up -
    /// which arrives here as the same false a genuinely absent element does.
    /// <para>
    /// Reported as "could not find", the two send an engineer to opposite
    /// repairs: one is a selector that matches nothing and the other is a
    /// selector that matches too much. The first live sign-in against this bank
    /// was the second kind, and was read as the first.
    /// </para>
    /// </remarks>
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
