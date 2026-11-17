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

/// ASN: one export form yields one CAMT.053 document with a statement per account, so accounts and transactions
/// are one download. ASN serves CAMT.053 to private customers (ING reserves it for businesses).
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

    internal async Task<LoginResult> LoginAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        try
        {
            return await SignInAsync(ctx, portal, ct).ConfigureAwait(false);
        }
        catch (ConnectorException)
        {
            // on failure the page's shape travels with the error: a live login on a real account cannot be repeated with more logging
            ctx.Note($"{ProviderId}: when that failed, the page was - {await portal.DescribeAsync(ct).ConfigureAwait(false)}");

            throw;
        }
    }

    private async Task<LoginResult> SignInAsync(IJobContext ctx, IAsnPortal portal, CancellationToken ct)
    {
        await portal.GotoAsync(_options.LoginUrl, ct).ConfigureAwait(false);
        await PastBrowserNoticeAsync(portal, _options, ctx.Note, ct).ConfigureAwait(false);

        // refuse cookies, not accept; best effort: the banner appears on the second render, and a miss must not fail the sign-in
        await portal.ClickAsync(_options.CookieRefuseSelectors, ct).ConfigureAwait(false);

        // dismiss the brand banner so the QR is not below the fold; best effort, a promo banner must not fail a sign-in
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

    /// ASN's "Browser updaten" notice (shown to a browser it judges outdated) is passed and noted: the agent's browser
    /// wants renewing (#562).
    internal static async Task<bool> PastBrowserNoticeAsync(IAsnPortal portal, AsnOptions options, Action<string>? note, CancellationToken ct)
    {
        if (!await portal.HasAsync(options.BrowserNoticeContinueSelectors, TimeSpan.FromMilliseconds(options.BrowserNoticeProbeMs), ct).ConfigureAwait(false))
        {
            return false;
        }

        if (!await portal.ClickAsync(options.BrowserNoticeContinueSelectors, ct).ConfigureAwait(false)) return false;

        note?.Invoke($"{ProviderId}: ASN showed its outdated-browser notice and was asked to go on to online banking; "
                     + "this agent's browser wants renewing");
        return true;
    }

    // live view, not a still: the QR rotates every few seconds. The relay must outlive the challenge call: the scan
    // ends by ASN moving the browser on, and disposing the source early cancelled the relay before that wait began
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
            // proven by a path, not a word: "Uitloggen" would fail every login for an English-speaking customer
            // both markers in one wait: the signed-in path is a prefix of the sign-in path, so it alone matched at once
            return await portal.WaitForPathAsync(
                    _options.SignedInPathMarker,
                    _options.SignInPathMarker,
                    TimeSpan.FromSeconds(_options.HumanSeconds),
                    ct)
                .ConfigureAwait(false);
        }
        finally
        {
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
            // same page diagnosis as the login: a fetch on a real account cannot be repeated with more logging either
            ctx.Note($"{ProviderId}: when that failed, the page was - {await portal.DescribeAsync(ct).ConfigureAwait(false)}");

            throw;
        }
    }

    private async Task<FetchResult> ReadAsync(
        IJobContext ctx, IAsnPortal portal, ResourceRequest request, CancellationToken ct)
    {
        var window = BankWindow.Resolve(request, Manifest, DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime));
        var statements = await ExportAsync(ctx, portal, window, ct).ConfigureAwait(false);

        var reachable = statements.Select(s => s.Account).ToList();

        // the caller's account filter: BankAccountFilter refuses an unreachable type, since an empty result reads "no transactions"
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

        // no reconciliation here: Camt053Parser.VerifyAgainstBalances already checks each statement (ProviderChanged on mismatch)
        ctx.Note(
            $"{ProviderId}: read {rows.Count} transaction(s) from {statements.Count} statement(s). Every one "
            + "of them was checked against the opening and closing balance the bank states on it, and the "
            + "entries add up");

        return new FetchResult { Transactions = rows, Complete = true, Via = "camt053" };
    }

    /// Every step is checked: a silently ignored click would yield a valid export of the wrong thing.
    private async Task<IReadOnlyList<Camt053Statement>> ExportAsync(
        IJobContext ctx, IAsnPortal portal, FetchWindow window, CancellationToken ct)
    {
        ctx.Progress(JobStep.Downloading);

        await portal.GotoAsync(Absolute(_options.ExportPath), ct).ConfigureAwait(false);
        // the notice goes on to online banking, not back to the page asked for
        if (await PastBrowserNoticeAsync(portal, _options, ctx.Note, ct).ConfigureAwait(false))
        {
            await portal.GotoAsync(Absolute(_options.ExportPath), ct).ConfigureAwait(false);
        }

        var offered = await ChooseAccountsAsync(ctx, portal, ct).ConfigureAwait(false);

        // dates are typed (dd-MM-yyyy, maxlength 10), not picked: the calendar would be clicked back through years
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

        ctx.Found(statements.Sum(statement => statement.Transactions.Count));

        // the count check catches a skipped confirm: each link only checks itself, and one account once came back as complete
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

    /// The select-all lives in a modal behind the account button; close it before touching anything else, since a date
    /// typed while a modal is open goes into it.
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

        // the bank's own account count (a checkbox per account) is the only way to tell whether the export covered everything
        var offered = await portal.CountAsync(_options.AccountCheckboxSelectors, ct).ConfigureAwait(false);

        // every account: one export covers them, and per-account downloads would be watched by the bank
        if (!await portal.ClickLabelAsync(_options.AllAccountsLabelPrefix, LabelMatch.Prefix, ct)
            .ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the account picker opened but has no '{_options.AllAccountsLabelPrefix}' "
                + "button to take every account with, so this export would have covered an unknown subset "
                + "of them");
        }

        // applied, not merely closed: an X dismissal discards the choice and the form keeps its single default account
        foreach (var label in _options.AccountConfirmLabels)
        {
            // by prefix: this button carries the count too ("Selectie bevestigen (3)")
            if (!await portal.ClickLabelAsync(label, LabelMatch.Prefix, ct).ConfigureAwait(false)) continue;

            ctx.Note($"{ProviderId}: the account picker was confirmed with '{label}'");

            return offered;
        }

        // note what the dialog held: the confirm label has never been observed
        ctx.Note(
            $"{ProviderId}: none of [{string.Join(", ", _options.AccountConfirmLabels)}] confirmed the "
            + $"account picker - with it open the page was: "
            + await portal.DescribeAsync(ct).ConfigureAwait(false));

        // no guess at a replacement: the last button[data-testid='button'] is "Selectie wissen" (clear all) and undoes the
        // selection; close the dialog and let the count check refuse
        await portal.ClickAsync(_options.ModalCloseSelectors, ct).ConfigureAwait(false);

        return offered;
    }

    /// A ladder of ways to open the account dialog, each judged by the "Kies een rekening" heading, reloading between:
    /// a click that opens nothing may have moved the browser. The back control at index 2 must never become a rung.
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
            // a fresh form: the rung before may have moved the browser
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

    /// "Geen zip-bestand van maken" means do not zip: it is TICKED to get bare XML, and ASN zips by default.
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

        // the tick is required: a miss delivers an archive, which reads like the bank changing its export
        var zip = await portal.SetCheckedNthAsync(
            _options.NoZipCheckboxSelectors, 0, _options.TickNoZipForXml, ct).ConfigureAwait(false);

        if (zip is null)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the '{_options.NoZipLabel}' box could not be ticked. It appears once a "
                + $"format is chosen, so index {_options.Camt053RadioIndex} may not be CAMT.053 at all");
        }

        ctx.Note($"{ProviderId}: CAMT.053 was set {format}, and the no-zip box {zip}");

        if (!await portal.ClickLabelAsync(_options.FormatSaveLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the format modal has no '{_options.FormatSaveLabel}', so the format chosen "
                + "in it was never applied to the download");
        }
    }

    /// Confirmed by the signed-out page (/uitgelogd.html): a logout that silently does nothing has shipped before.
    public async Task LogoutAsync(IJobContext ctx, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(ctx);

        // nothing stored, nothing to sign out of: the page resumes via the job's cookie jar, so without one it visits as a stranger
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

        // go to the overview first: a logout job's browser starts on about:blank, so the "Uitloggen" hunt would blame the bank
        // (ING's adapter has the same fix)
        await portal.GotoAsync(Absolute(_options.SignedInPathMarker), ct).ConfigureAwait(false);

        // an ended session is not a missing button: ASN answers the overview with its sign-in page, which has no sign-out
        if (portal.Url.Contains(_options.SignInPathMarker, StringComparison.OrdinalIgnoreCase))
        {
            ctx.Note(
                $"{ProviderId}: the stored session had already ended - ASN answered its overview with the "
                + "sign-in page, so there was nothing left to sign out of");

            return;
        }

        // the sign-out is behind a menu (the agent emulates a phone, where menus are shut); the hamburger holds only
        // Overzicht, Zelf regelen, Contact, so the user menu is the other control
        var opened = await OpenSignOutMenuAsync(portal, ct).ConfigureAwait(false);

        if (!await portal.ClickLabelAsync(_options.SignOutLabel, LabelMatch.Exact, ct).ConfigureAwait(false))
        {
            ctx.Note(
                $"{ProviderId}: no '{_options.SignOutLabel}' button was on {portal.Url} "
                + (opened ?? "and none of its header controls revealed one")
                + ", so the session is left to expire");

            // re-open the header: a sign-out failure cannot be reproduced, and the search panel left open would be described instead
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
            // note which route revealed the button: only failures used to carry it
            ctx.Note(
                $"{ProviderId}: signed out upstream, "
                + (opened ?? "though nothing was seen to reveal the button first"));

            return;
        }

        ctx.Note(
            $"{ProviderId}: the sign-out was clicked but the signed-out page never arrived, so the session "
            + "may still be alive until ASN expires it");
    }

    /// Asks rather than clicks: a click that finds nothing spends ten seconds, enough to cancel the courtesy sign-out.
    /// Each rung is judged by the SIGN-OUT appearing, never by the press landing.
    private async Task<string?> OpenSignOutMenuAsync(IAsnPortal portal, CancellationToken ct)
    {
        var budget = TimeSpan.FromSeconds(2);

        if (await portal.HasLabelAsync(_options.SignOutLabel, budget, ct).ConfigureAwait(false))
        {
            return "on the page as it stood";
        }

        // the user menu by its name ("Profiel menu openen"): unlike a position, it survives ASN reordering its header
        if (await portal.ClickAsync(_options.UserMenuSelectors, ct).ConfigureAwait(false)
            && await portal.HasLabelAsync(_options.SignOutLabel, budget, ct).ConfigureAwait(false))
        {
            return "from the profile menu";
        }

        var tried = 0;

        foreach (var index in _options.SignOutMenuIndexes)
        {
            ct.ThrowIfCancellationRequested();

            // a fresh header: the rung before may have opened ASN's search panel, and the next index would land inside it
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
