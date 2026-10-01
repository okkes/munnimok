using System.Globalization;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Normalization;
using Connector.Kit.Security;
using BankConnector.Adapters.Parsing;

namespace BankConnector.Adapters.Asn;

/// <summary>
/// ASN Bank, written from a discovery session rather than from a guess.
///
/// <para>
/// An earlier adapter of this name was deleted. It was reasoned from a design
/// document - a digipas serial typed into a form, a challenge number read back -
/// and two live sessions showed a different bank entirely. Everything below
/// comes from <see cref="AsnOptions"/>, where each value is marked OBSERVED or
/// not.
/// </para>
///
/// <para>
/// <b>Why this bank is worth the trouble.</b> ASN serves CAMT.053 to private
/// customers, which ING reserves for businesses. So the hard half of a bank
/// adapter - turning a statement into transactions somebody can trust - is
/// <see cref="Camt053Parser"/>, already written and already proven against a
/// real 390-entry export whose balances reconciled to the cent. What is left is
/// driving a form, and this file is that.
/// </para>
///
/// <para>
/// <b>The export is the whole fetch.</b> There is no per-account API to walk and
/// no cursor to follow: one form takes the accounts, the dates and the format,
/// and produces one document holding a statement per account. That is why
/// <see cref="AccountsAsync"/> and the transaction read are the same download -
/// asking twice would mean two exports of the same data.
/// </para>
/// </summary>
internal sealed class AsnAdapter(AsnOptions? options = null, TimeProvider? time = null) : IProviderAdapter
{
    public const string ProviderId = AsnManifest.ProviderId;

    private readonly AsnOptions _options = options ?? new AsnOptions();
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public ProviderManifest Manifest { get; } = AsnManifest.Build();

    public ProviderManifest Describe() => Manifest;

    public async Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        ctx.Progress(JobStep.OpeningProvider);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await LoginAsync(ctx, new AsnPortal(page), ct).ConfigureAwait(false);
    }

    /// <summary>The sign-in, behind the seam so the offline suite can drive it.</summary>
    internal async Task<LoginResult> LoginAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        try
        {
            return await SignInAsync(ctx, portal, ct).ConfigureAwait(false);
        }
        catch (ConnectorException)
        {
            // WHAT THE PAGE LOOKED LIKE WHEN IT WENT WRONG, carried out with
            // the failure rather than left on the agent.
            //
            // A first live attempt against this bank produced nothing but
            // "provider_changed", which names a category and not a step: the
            // method button, the QR, or a page that never loaded at all are
            // three different repairs and one error code. A login here runs on
            // somebody's real account and cannot simply be repeated with more
            // logging turned on, so the diagnosis has to travel with the first
            // failure.
            ctx.Note($"{ProviderId}: when that failed, the page was - {await portal.DescribeAsync(ct).ConfigureAwait(false)}");

            throw;
        }
    }

    private async Task<LoginResult> SignInAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        await portal.GotoAsync(_options.LoginUrl, ct).ConfigureAwait(false);

        // REFUSED, NOT ACCEPTED, and it stands in front of everything. Best
        // effort: it appears on the second render rather than the first, and a
        // session that never saw it is not a session that failed.
        await portal.ClickAsync(_options.CookieRefuseSelectors, ct).ConfigureAwait(false);

        // AND THE BRAND BANNER, so the QR is not pushed below the fold of the
        // stream the account holder has to scan. Best effort by design: a
        // sign-in that failed because a promotional banner would not close
        // would be a defect invented for a convenience.
        await portal.ClickAsync(_options.BannerDismissSelectors, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Authenticating);

        if (!await portal.ClickLabelAsync(_options.AppMethodLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the sign-in page offers no '{_options.AppMethodLabel}' method");
        }

        if (!await ScanAsync(ctx, portal, ct).ConfigureAwait(false))
        {
            throw new ConnectorException(
                ErrorCode.MfaFailed,
                $"{ProviderId}: the browser never reached a signed-in page, so the scan was refused or "
                + "nobody completed it");
        }

        ctx.Progress(JobStep.Finalizing);

        return new LoginResult
        {
            Material = new SessionMaterial
            {
                StorageState = await ctx.Browser.StorageStateAsync(ct).ConfigureAwait(false),
            },
        };
    }

    /// <summary>
    /// Relays ASN's own screen while the human scans, and waits for the bank to
    /// move the browser on.
    /// </summary>
    /// <remarks>
    /// A LIVE VIEW RATHER THAN A PHOTOGRAPH, because the code rotates.
    ///
    /// The first version found the QR by being square - 205x205 against a
    /// 158x30 logo - cropped it and relayed one picture. That works for a code
    /// that sits still, and ASN's does not: it refreshes every few seconds, so
    /// a still frame is a code that has already expired by the time somebody
    /// has their phone out. What they scan has to be what the page is showing
    /// NOW, which is what the live view is for - the same relay DUO uses for
    /// DigiD's QR, for the same reason.
    ///
    /// <para>
    /// THE RELAY OUTLIVES THE CALL THAT RAISES IT, which the first version got
    /// wrong. The challenge is raised and not awaited - nobody types anything
    /// back, the scan finishes by ASN moving the browser on - so the wait for
    /// that has to happen inside the relay's lifetime. It did not: the token
    /// source was disposed when the method returned, cancelling the relay
    /// before the caller began waiting, and the account holder watched their
    /// code appear and vanish.
    /// </para>
    /// </remarks>
    /// <returns>Whether the browser reached a signed-in page.</returns>
    private async Task<bool> ScanAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Progress(JobStep.AwaitingHuman);

        using var relay = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var asked = ctx.AskAsync(
            new Challenge
            {
                Type = ChallengeType.LiveView,
                PromptKey = AsnManifest.QrKey,
                ExpiresAt = _time.GetUtcNow().AddSeconds(_options.HumanSeconds),
            },
            relay.Token);

        try
        {
            // THE SIGN-IN PROVES ITSELF BY LEAVING, which is a path rather than
            // a word. There is an "Uitloggen" button on every signed-in page
            // and it would be a better marker in every way except the one that
            // matters: a bank serving an English-speaking customer would fail
            // every login.
            //
            // BOTH HALVES IN ONE WAIT, because one path is a prefix of the
            // other. ASN signs people in under /online/web/onlinebankieren/ AND
            // lands them there - the sign-in page is /inloggen/ beneath it - so
            // waiting for the signed-in marker alone matched on the very first
            // check, and the /inloggen/ test then failed the login instantly.
            // The account holder got "that code was not accepted" before there
            // was a code to accept.
            return await portal.WaitForPathAsync(
                    _options.SignedInPathMarker,
                    _options.SignInPathMarker,
                    TimeSpan.FromSeconds(_options.HumanSeconds),
                    ct)
                .ConfigureAwait(false);
        }
        finally
        {
            // Taken down once the page has answered. Observed rather than
            // awaited: it was cancelled on purpose, and the cancellation it
            // throws is not news.
            await relay.CancelAsync().ConfigureAwait(false);
            _ = asked.ContinueWith(static t => t.Exception, TaskScheduler.Default);
        }
    }

    public async Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        ArgumentNullException.ThrowIfNull(request);

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        return await FetchAsync(ctx, new AsnPortal(page), request, ct).ConfigureAwait(false);
    }

    internal async Task<FetchResult> FetchAsync(
        IJobContext ctx, IAsnPortal portal, ResourceRequest request, CancellationToken ct)
    {
        try
        {
            return await ReadAsync(ctx, portal, request, ct).ConfigureAwait(false);
        }
        catch (ConnectorException)
        {
            // THE SAME DIAGNOSIS THE LOGIN CARRIES, which this half went
            // without and paid for. A first live fetch died on a button that
            // was not there, and all the caller was told is "something broke on
            // our side" - while the agent's own log held the label it had been
            // hunting for. A fetch runs on a real account behind a real
            // sign-in; it is no more repeatable-with-more-logging than the
            // login is, so it gets the same treatment.
            ctx.Note($"{ProviderId}: when that failed, the page was - {await portal.DescribeAsync(ct).ConfigureAwait(false)}");

            throw;
        }
    }

    private async Task<FetchResult> ReadAsync(
        IJobContext ctx, IAsnPortal portal, ResourceRequest request, CancellationToken ct)
    {
        var window = BankWindow.Resolve(request, Manifest, DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime));
        var statements = await ExportAsync(ctx, portal, window, ct).ConfigureAwait(false);

        // FROM THE STATEMENT ITSELF. There is no account list to read: the
        // export names the account it belongs to, so the accounts a session can
        // see are the statements it gets back.
        var reachable = statements.Select(s => s.Account).ToList();

        // THE CALLER'S ACCOUNT FILTER, WHICH THIS ADAPTER USED TO IGNORE
        // ENTIRELY.
        //
        // The manifest advertises the parameter - every bank resource here
        // does - and nothing in this file had ever read it. So a caller who
        // ticked "credit_card" and "loan", account types ASN does not have,
        // received four hundred transactions from the accounts they had not
        // asked for and a green "complete" beside them. Asking wrong and asking
        // for everything produced the same answer.
        //
        // BankAccountFilter is the platform's rule and it refuses rather than
        // returning nothing: an empty result reads as "you have no savings
        // transactions" when the truth is "this session cannot reach any".
        var selected = BankAccountFilter.Select(reachable, request);

        if (string.Equals(request.ResourceId, BankResources.Accounts, StringComparison.Ordinal))
        {
            return new FetchResult
            {
                Accounts = [.. selected],
                Complete = true,
                Via = "camt053",
            };
        }

        var wanted = selected.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);

        var rows = statements
            .SelectMany(s => s.Transactions)
            .Where(t => wanted.Contains(t.AccountId))
            .Where(t => window.Contains(t.BookedAt))
            .ToList();

        // NO RECONCILIATION LOOP HERE, and its absence is the point.
        //
        // This file grew one, and it was duplicating Camt053Parser's own
        // VerifyAgainstBalances - which has done the same arithmetic since
        // before this adapter existed, does it per statement as part of
        // parsing, and reports a mismatch as ProviderChanged. A second copy in
        // the caller is a second thing to keep correct and a second answer to
        // reconcile when the two disagree.
        //
        // So the guarantee below is real and it is the parser's: a statement
        // that reached this line balanced.
        ctx.Note(
            $"{ProviderId}: read {rows.Count} transaction(s) from {statements.Count} statement(s). Every one "
            + "of them was checked against the opening and closing balance the bank states on it, and the "
            + "entries add up");

        return new FetchResult { Transactions = rows, Complete = true, Via = "camt053" };
    }

    /// <summary>
    /// Drives the download form once and parses what comes back.
    /// </summary>
    /// <remarks>
    /// The form is filled in the order the page presents it: accounts, dates,
    /// then format. Every step is checked rather than assumed - a bank's form
    /// that silently ignored a click would otherwise produce a perfectly valid
    /// export of the wrong thing, which is the failure nobody can see.
    /// </remarks>
    private async Task<IReadOnlyList<Camt053Statement>> ExportAsync(
        IJobContext ctx, IAsnPortal portal, FetchWindow window, CancellationToken ct)
    {
        ctx.Progress(JobStep.Downloading);

        await portal.GotoAsync(Absolute(_options.ExportPath), ct).ConfigureAwait(false);

        var offered = await ChooseAccountsAsync(ctx, portal, ct).ConfigureAwait(false);

        // TYPED, NOT PICKED. The two boxes take dd-mm-jjjj - maxlength=10 on
        // both - and the alternative is a month-by-month calendar that would
        // have to be clicked backwards through years of history.
        var from = window.From.ToString("dd-MM-yyyy", CultureInfo.InvariantCulture);
        var until = window.To.ToString("dd-MM-yyyy", CultureInfo.InvariantCulture);

        if (!await portal.FillNthAsync(_options.DateSelectors, 0, from, ct).ConfigureAwait(false)
            || !await portal.FillNthAsync(_options.DateSelectors, 1, until, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the download form has no pair of date fields this connector recognises");
        }

        await ChooseFormatAsync(ctx, portal, ct).ConfigureAwait(false);

        ctx.Progress(JobStep.Parsing);

        var xml = await portal.DownloadTextAsync(
            _options.DownloadLabel, TimeSpan.FromSeconds(_options.DownloadSeconds), ct).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(xml))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the download produced no file. If the export is arriving zipped, the "
                + $"'{_options.NoZipLabel}' box was not ticked");
        }

        var statements = Camt053Parser.Parse(xml, new Camt053Options
        {
            SessionId = ctx.SessionId,
            ProviderId = ProviderId,
            AccountType = AccountType.Current,
        });

        // AS MANY STATEMENTS AS THERE WERE ACCOUNTS, or this is not the export
        // that was asked for.
        //
        // This is the check the first working fetch went without, and it went
        // without it for the usual reason: everything it did looked like it had
        // worked. It selected all three accounts, closed the dialog, downloaded
        // a file that parsed cleanly, reconciled every balance in it to the
        // cent, and handed back ONE account as a complete answer. Nothing in
        // that chain is capable of noticing two missing accounts, because each
        // link only checks itself.
        if (offered > 0 && statements.Count < offered)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the account picker offered {offered} account(s) and the export came back "
                + $"with {statements.Count}. Taking every account is what the '"
                + $"{_options.AllAccountsLabelPrefix}' button is for, so the dialog was most likely closed "
                + "rather than confirmed, and its choice discarded");
        }

        return statements;
    }

    /// <summary>
    /// Opens the account picker, takes every account, and closes it again.
    /// </summary>
    /// <remarks>
    /// A MODAL, WHICH IS THE WHOLE POINT. The select-all is not on the export
    /// form: it lives in a dialog behind the account button, alongside a search
    /// box and one checkbox per account. The first live fetch looked for it on
    /// the form, where it has never been, and spent its budget not finding it.
    /// <para>
    /// Closed before anything else is touched, because this form is one where
    /// order decides what a keystroke means - the same trap the format modal
    /// carries, where a date typed while it is open goes into the modal.
    /// </para>
    /// </remarks>
    /// <returns>How many accounts the dialog offered, or 0 if it would not say.</returns>
    private async Task<int> ChooseAccountsAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        if (!await OpenPickerAsync(ctx, portal, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: nothing on the download form opened a '{_options.AccountModalHeading}' "
                + $"dialog - tried [{string.Join(", ", _options.AccountPickerSelectors)}], then "
                + $"[{string.Join(", ", _options.AccountPickerForceSelectors)}] forced, then "
                + $"[{string.Join(", ", _options.AccountPickerFallbackSelectors)}] at "
                + $"{string.Join(" and ", _options.AccountPickerFallbackIndexes)}");
        }

        // THE BANK'S OWN COUNT OF THE ACCOUNTS, taken while its dialog is open
        // and taken as a NUMBER: one checkbox per account, no name and no IBAN
        // asked for. It is the only thing that turns "did this export cover
        // everything" into a question with an answer, and the first export to
        // reach the end needed exactly that question asking - it returned one
        // account out of three and looked complete.
        var offered = await portal.CountAsync(_options.AccountCheckboxSelectors, ct).ConfigureAwait(false);

        // EVERY account, because one export covers them all and asking per
        // account would mean one download each against a bank that is watching
        // how often somebody exports.
        if (!await portal.ClickLabelAsync(_options.AllAccountsLabelPrefix, LabelMatch.Prefix, ct)
            .ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the account picker opened but has no '{_options.AllAccountsLabelPrefix}' "
                + "button to take every account with, so this export would have covered an unknown subset "
                + "of them");
        }

        // APPLIED, NOT MERELY CLOSED, and the difference cost a whole export.
        // The first fetch that reached the end came back with one account while
        // the dialog it had just used said "Alles selecteren (3)". Everything
        // before this was confirmed working, which leaves the dismissal: an X
        // closes a dialog, and on this design system that is not the same as
        // agreeing with it, so the form kept the single account it defaults to.
        foreach (var label in _options.AccountConfirmLabels)
        {
            // BY PREFIX, because this button carries the count too:
            // "Selectie bevestigen (3)".
            if (!await portal.ClickLabelAsync(label, LabelMatch.Prefix, ct).ConfigureAwait(false)) continue;

            ctx.Note($"{ProviderId}: the account picker was confirmed with '{label}'");

            return offered;
        }

        // WHAT THE DIALOG ACTUALLY HELD, because the confirm has never been
        // seen. The first run to get this far reported "NOT SHOWN: 2 more
        // buttons" - the probe's cap was hiding exactly the two that matter,
        // and this note is what said so.
        ctx.Note(
            $"{ProviderId}: none of [{string.Join(", ", _options.AccountConfirmLabels)}] confirmed the "
            + $"account picker - with it open the page was: "
            + await portal.DescribeAsync(ct).ConfigureAwait(false));

        // AND NO GUESS AT A REPLACEMENT. One run pressed the dialog's last
        // button on the reasoning that a primary action sits there. The dialog
        // ends "Alles selecteren", "Selectie wissen", "Selectie bevestigen" -
        // take all, CLEAR ALL, confirm - and the last
        // button[data-testid='button'] is the middle one. It threw the
        // selection away, and the capture afterwards read "(0)" where it had
        // read "(3)".
        //
        // A wrong button on this dialog does not merely fail to help; it undoes
        // the step before it. So the dialog is closed and the export refuses on
        // the count, which is the honest outcome when the confirm is not there.
        await portal.ClickAsync(_options.ModalCloseSelectors, ct).ConfigureAwait(false);

        return offered;
    }

    /// <summary>
    /// Opens the account dialog, trying each way this form might offer, and
    /// says which one worked.
    /// </summary>
    /// <remarks>
    /// A LADDER RATHER THAN A GUESS, because three separate readings of the
    /// same captures each produced a confident answer and two of them were
    /// wrong. The rungs are ordered by how well the evidence supports them: the
    /// box around the account select first, the select itself forced second,
    /// and the form's two unlabelled buttons last.
    /// <para>
    /// WHAT MAKES THIS SAFE IS NOT THE ORDER, IT IS THE CHECK. No rung is
    /// believed on the strength of having been clicked - each is judged by
    /// whether ASN's own "Kies een rekening" heading appeared, and the form is
    /// reloaded before the next one, because a click that opens nothing may
    /// still have MOVED the browser. That is exactly how an earlier version
    /// left the export page and went looking for a select-all on the accounts
    /// overview.
    /// </para>
    /// <para>
    /// The back control at index 2 is not a rung and must never become one. It
    /// is the single most attractive-looking thing on this form - its label is
    /// the name of the page you came from, which on a fresh navigation reads
    /// "Rekening" - and it has already cost two commits.
    /// </para>
    /// <para>
    /// The note is not decoration. Which rung worked is the thing worth knowing
    /// after this run: a fetch against somebody's real bank is not an
    /// experiment that can be repeated with more logging turned on.
    /// </para>
    /// </remarks>
    private async Task<bool> OpenPickerAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        var rungs = new List<(string What, Func<Task<bool>> Try)>
        {
            ("the box around the account select", () => portal.ClickAsync(_options.AccountPickerSelectors, ct)),
            ("the account select itself, forced", () => portal.ClickForceAsync(_options.AccountPickerForceSelectors, ct)),
        };

        rungs.AddRange(_options.AccountPickerFallbackIndexes.Select(index =>
            ($"the unlabelled form button at {index}",
             new Func<Task<bool>>(() =>
                 portal.ClickNthAsync(_options.AccountPickerFallbackSelectors, index, ct)))));

        for (var i = 0; i < rungs.Count; i++)
        {
            // A fresh form, because the rung before may have moved the browser
            // rather than opened anything.
            if (i > 0) await portal.GotoAsync(Absolute(_options.ExportPath), ct).ConfigureAwait(false);

            if (!await rungs[i].Try().ConfigureAwait(false)) continue;
            if (!await OpenedAsync(portal, ct).ConfigureAwait(false)) continue;

            ctx.Note($"{ProviderId}: the account picker opened by {rungs[i].What}");

            return true;
        }

        return false;
    }

    private Task<bool> OpenedAsync(IAsnPortal portal, CancellationToken ct) =>
        portal.HasHeadingAsync(_options.AccountModalHeading, TimeSpan.FromSeconds(10), ct);

    /// <summary>
    /// Opens the format modal, picks CAMT.053, asks for it unzipped, saves.
    /// </summary>
    /// <remarks>
    /// THE CHECKBOX MEANS ITS OWN OPPOSITE. It reads "Geen zip-bestand van
    /// maken" - do NOT make a zip - so it is TICKED to get the bare XML, and
    /// ASN zips by default. An adapter written to "tick the zip box" would
    /// fetch precisely the wrong file, and the failure would arrive as a parser
    /// refusing an archive, which reads like the bank changing its export.
    /// </remarks>
    private async Task ChooseFormatAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        if (!await portal.ClickLabelAsync(_options.FormatChangeLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the download form has no '{_options.FormatChangeLabel}' for the file format");
        }

        if (!await portal.HasHeadingAsync(
                _options.FormatModalHeading, TimeSpan.FromSeconds(10), ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: '{_options.FormatChangeLabel}' was clicked but no "
                + $"'{_options.FormatModalHeading}' dialog opened, so the format was never offered");
        }

        var format = await portal.SetCheckedNthAsync(
            _options.FormatRadioSelectors, _options.Camt053RadioIndex, true, ct).ConfigureAwait(false);

        if (format is null)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the CAMT.053 radio at index {_options.Camt053RadioIndex} could not be "
                + "chosen - not by setting it, not by forcing it, and not by clicking the box around it");
        }

        // TICKED, AND THE TICK IS REQUIRED. It reads "Geen zip-bestand van
        // maken" - do NOT make a zip - so this is what produces the bare XML,
        // and ASN zips by default. Left to best effort, a miss here means an
        // archive arriving where XML is expected, which surfaces as the parser
        // refusing the export and reads like the bank having changed it.
        var zip = await portal.SetCheckedNthAsync(
            _options.NoZipCheckboxSelectors, 0, _options.TickNoZipForXml, ct).ConfigureAwait(false);

        if (zip is null)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the '{_options.NoZipLabel}' box could not be ticked. It appears once a "
                + $"format is chosen, so index {_options.Camt053RadioIndex} may not be CAMT.053 at all");
        }

        // WHICH RUNG WORKED, because this bank keeps hiding its real controls
        // behind styled ones and the answer differs per control.
        ctx.Note($"{ProviderId}: CAMT.053 was set {format}, and the no-zip box {zip}");

        if (!await portal.ClickLabelAsync(_options.FormatSaveLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the format modal has no '{_options.FormatSaveLabel}', so the format chosen "
                + "in it was never applied to the download");
        }
    }

    /// <summary>
    /// Signs out, and confirms it by where the browser lands.
    /// </summary>
    /// <remarks>
    /// Confirmed rather than assumed, because a logout that silently does
    /// nothing is a failure this platform has already shipped once. The
    /// signed-out page is <c>/uitgelogd.html</c>, observed in a real run.
    /// <para>
    /// Worth doing even though ASN expires an idle session itself - it does so
    /// on its own schedule, and a bank that sees a string of sessions never
    /// signed out of draws conclusions about the account.
    /// </para>
    /// </remarks>
    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // NOTHING STORED MEANS NOTHING TO SIGN OUT OF. Opening the page IS
        // resuming the session - the lease is built with the job's own cookie
        // jar - so with no jar this would launch Chromium to visit a bank as a
        // stranger, and then report the sign-in page's lack of a sign-out
        // button as a failure.
        if (string.IsNullOrWhiteSpace(ctx.Material?.StorageState))
        {
            ctx.Note($"{ProviderId}: this disconnect carried no stored session, so there was nothing to sign out");
            return;
        }

        var page = await ctx.Browser.PageAsync(ct).ConfigureAwait(false);

        await LogoutAsync(ctx, new AsnPortal(page), ct).ConfigureAwait(false);
    }

    internal async Task LogoutAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        ctx.Progress(JobStep.LoggingOut);

        // ASN'S BUTTON IS ON ASN'S PAGE, and this went without it.
        //
        // A logout job opens a browser that has never been anywhere, so the
        // "Uitloggen" hunt ran against about:blank and found nothing - which
        // was then reported as "no sign-out button was on the page", blaming
        // the bank for a page nobody had asked it for. ING's adapter carries
        // this exact fix and this one was written without it.
        //
        // The signed-in overview, because that is where the button lives and
        // navigating there with the stored jar is what proves the session is
        // still worth ending.
        await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);

        // A SESSION THAT HAS ALREADY ENDED IS NOT A MISSING BUTTON.
        //
        // ASN answers the overview with its sign-in page once the session is
        // gone, and that page has no sign-out on it - correctly. Without this
        // the run reports "no 'Uitloggen' button was on the page", which reads
        // as a broken adapter and is in fact the bank saying the work is
        // already done.
        if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            ctx.Note(
                $"{ProviderId}: the stored session had already ended - ASN answered its overview with the "
                + "sign-in page, so there was nothing left to sign out of");

            return;
        }

        // THE SIGN-OUT IS BEHIND A MENU, and the agent emulates a phone, where
        // a menu is shut until something opens it.
        //
        // NOT the hamburger, which is what the first attempt at this reasoned
        // its way to. A live disconnect opened that one and described what it
        // held - "Overzicht", "Zelf regelen", "Contact" - so the navigation
        // menu is now walked and ruled out. The user menu is a different
        // control, and AsnOptions says which two it can be.
        var opened = await OpenSignOutMenuAsync(portal, ct).ConfigureAwait(false);

        if (!await portal.ClickLabelAsync(_options.SignOutLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            ctx.Note(
                $"{ProviderId}: no '{_options.SignOutLabel}' button was on {portal.Url} "
                + (opened ?? "and none of its header controls revealed one")
                + ", so the session is left to expire");

            // THE HEADER AS IT STANDS, not as the last rung left it.
            //
            // A sign-out failure cannot be reproduced - the next attempt needs
            // a fresh code, and by then the session it was meant to end has
            // expired on its own - so this is the one chance to see the page.
            // The first version described whatever the search panel had opened
            // over the top of it, which is a picture of the last thing that
            // went wrong rather than of the controls being searched.
            await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);

            ctx.Note(
                $"{ProviderId}: with nothing opened, its header was - "
                + await portal.DescribeAsync(ct).ConfigureAwait(false));

            return;
        }

        if (await portal.WaitForPathAsync(
                _options.SignedOutPathMarker, without: null, TimeSpan.FromSeconds(10), ct)
            .ConfigureAwait(false))
        {
            // AND HOW IT WAS REACHED, which the run that finally worked could
            // not say. Only the failure carried the route, so a sign-out that
            // succeeded reported "signed out upstream" and nothing about which
            // of ASN's unnamed header controls had held the button - leaving
            // the one fact three live attempts had been spent buying to be
            // inferred from the shape of the run before it.
            ctx.Note(
                $"{ProviderId}: signed out upstream, "
                + (opened ?? "though nothing was seen to reveal the button first"));

            return;
        }

        ctx.Note(
            $"{ProviderId}: the sign-out was clicked but the signed-out page never arrived, so the session "
            + "may still be alive until ASN expires it");
    }

    /// <summary>
    /// Gets ASN to render its sign-out, and says what it took.
    /// </summary>
    /// <remarks>
    /// ASKED RATHER THAN CLICKED AT, which is what makes a search over menus
    /// affordable. A click that finds nothing spends ten seconds first, so
    /// trying three candidates by clicking would cost half a minute of nothing
    /// - long enough for the courtesy sign-out on a failed job to be cancelled
    /// mid-hunt and report nothing at all. Asking whether the button is there
    /// costs a second.
    /// <para>
    /// Every rung is judged by whether the SIGN-OUT appeared, never by whether
    /// the press landed. A press that opens the wrong panel is still a press
    /// that worked, and this adapter has already once mistaken one for the
    /// other - the back control whose label reads like the thing it wanted.
    /// </para>
    /// </remarks>
    /// <returns>How it was opened, or null if nothing revealed it.</returns>
    private async Task<string?> OpenSignOutMenuAsync(IAsnPortal portal, CancellationToken ct)
    {
        var budget = TimeSpan.FromSeconds(2);

        // Already showing, which is what a desktop viewport does and what a
        // session that never collapsed its header would do.
        if (await portal.HasLabelAsync(_options.SignOutLabel, budget, ct).ConfigureAwait(false))
        {
            return "on the page as it stood";
        }

        // THE MENU BY ITS NAME, which is now a thing that can be asked for.
        //
        // A mapping run finally described these controls - "Zoeken" and
        // "Profiel menu openen" - because the page probe learned to read an
        // aria-label off a button with no text. Three live sign-outs went into
        // discovering "the second one" positionally; this is that answer said
        // properly, and unlike a position it survives ASN reordering its own
        // header.
        if (await portal.ClickAsync(_options.UserMenuSelectors, ct).ConfigureAwait(false)
            && await portal.HasLabelAsync(_options.SignOutLabel, budget, ct).ConfigureAwait(false))
        {
            return "from the profile menu";
        }

        var tried = 0;

        foreach (var index in _options.SignOutMenuIndexes)
        {
            ct.ThrowIfCancellationRequested();

            // A FRESH HEADER, because the rung before may have opened a panel
            // over the top of the one this is counting.
            //
            // The account picker's ladder has carried this line since its own
            // version of the same failure, and this was written without it: the
            // first press opened ASN's search - "Veel gebruikte links", a search
            // box and three buttons - and the second press then landed on
            // whatever was second INSIDE THAT PANEL. So an enumeration over the
            // header's two controls pressed one of them and something else
            // entirely.
            if (tried++ > 0)
            {
                await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);
            }

            if (!await portal.ClickNthAsync(_options.SignOutMenuSelectors, index, ct).ConfigureAwait(false))
            {
                continue;
            }

            if (await portal.HasLabelAsync(_options.SignOutLabel, budget, ct).ConfigureAwait(false))
            {
                return $"after opening header control {index}";
            }
        }

        return null;
    }

    private string Absolute(string path) =>
        new Uri(new Uri(_options.LoginUrl), path).ToString();
}
