using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

// asserted values come from discovery sessions, not reasoning (see AsnOptions); a real sign-in costs an attempt on
// a live account
public sealed class AsnAdapterTests
{
    private static readonly AsnOptions Options = new();

    private const string Statement = """
    <?xml version="1.0" encoding="UTF-8"?>
    <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
      <BkToCstmrStmt>
        <GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-08-17T12:00:00+02:00</CreDtTm></GrpHdr>
        <Stmt>
          <Id>S1</Id>
          <CreDtTm>2026-08-17T12:00:00+02:00</CreDtTm>
          <Acct><Id><IBAN>NL02ASNB0000018507</IBAN></Id><Ccy>EUR</Ccy></Acct>
          <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
            <Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
            <Dt><Dt>2026-08-01</Dt></Dt></Bal>
          <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
            <Amt Ccy="EUR">75.50</Amt><CdtDbtInd>CRDT</CdtDbtInd>
            <Dt><Dt>2026-08-10</Dt></Dt></Bal>
          <Ntry>
            <NtryRef>E1</NtryRef>
            <Amt Ccy="EUR">24.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
            <BookgDt><Dt>2026-08-05</Dt></BookgDt><ValDt><Dt>2026-08-05</Dt></ValDt>
            <NtryDtls><TxDtls><RmtInf><Ustrd>A shop</Ustrd></RmtInf></TxDtls></NtryDtls>
          </Ntry>
        </Stmt>
      </BkToCstmrStmt>
    </Document>
    """;

    private static FakeJobContext Context() => new() { Browser = new StubBrowserLease() };

    // the label as ASN renders it, count included: the fixture once held the adapter's own string, so every click hit
    // by construction
    private const string RenderedSelectAll = "Alles selecteren (3)";

    // "Selectie wissen (3)" beside it CLEARS the selection; both labels carry the count, so both are prefix-matched
    private const string RenderedConfirm = "Selectie bevestigen (3)";

    // data-testid='button' elements in document order; index 2 is the back control (label = previous page's title) and
    // is left alone: two attempts at it left the export form for /zelf-regelen/rekeningen. 0-1 are chrome; 3-4 likely
    // the calendar triggers
    private static readonly string[] FormButtons =
    [
        string.Empty,
        string.Empty,
        "Rekening",
        string.Empty,
        string.Empty,
    ];

    private const int BackControl = 2;

    private static StubAsnPortal Ready()
    {
        var portal = StubAsnPortal.SignedIn(
            RenderedSelectAll,
            Options.FormatChangeLabel,
            Options.FormatSaveLabel,
            Options.DownloadLabel);

        portal.Download = Statement;
        portal.ButtonsInOrder.AddRange(FormButtons);

        // the account select cannot be clicked, as on the bank: the click goes to the box around it
        portal.ForceOnlySelectors.Add(Options.AccountPickerForceSelectors[0]);

        // only that box opens the dialog, so the check that it appeared can fail
        portal.Opens[$"click:{Options.AccountPickerSelectors[0]}"] = Options.AccountModalHeading;
        portal.Opens[$"click:{Options.FormatChangeLabel}"] = Options.FormatModalHeading;

        // the CAMT radio sits behind a styled label: live reported "no index 2" on a modal holding five radios
        portal.UnreachableControls.Add(
            $"{Options.FormatRadioSelectors[0]}#{Options.Camt053RadioIndex}");

        // one account, matching the statement: without a stated count a short export cannot be noticed
        portal.Counts[Options.AccountCheckboxSelectors[0]] = 1;
        portal.Labels.Add(RenderedConfirm);

        portal.Counts[Options.AccountPickerFallbackSelectors[0]] = FormButtons.Length;

        return portal;
    }

    // where a call sits in the order, or -1; the order is most of what can go wrong offline here
    private static int Step(StubAsnPortal portal, string call)
    {
        for (var i = 0; i < portal.Calls.Count; i++)
        {
            if (string.Equals(portal.Calls[i], call, StringComparison.Ordinal)) return i;
        }

        return -1;
    }

    private static ResourceRequest Transactions() => new()
    {
        ResourceId = BankResources.Transactions,
        Since = new DateOnly(2026, 8, 1),
        Until = new DateOnly(2026, 8, 31),
    };

    // the cookie wall is refused, never accepted: a connector reading statements must not accept tracking on the
    // user's behalf
    [Fact]
    public async Task The_cookie_wall_is_refused_before_a_method_is_chosen()
    {
        using var ctx = Context();
        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        var refused = Step(portal, $"click:{Options.CookieRefuseSelectors[0]}");
        var chose = Step(portal, $"click:{Options.AppMethodLabel}");

        Assert.True(refused >= 0, "the cookie wall was never refused");
        Assert.True(refused < chose, "a sign-in method was chosen before the cookie wall was dealt with");

        // the brand banner pushes the QR below the fold of the phone-width stream, so it goes before the QR is relayed
        var banner = Step(portal, $"click:{Options.BannerDismissSelectors[0]}");

        Assert.True(banner > refused, "the brand banner was dismissed before the cookie wall in front of it");
        Assert.True(banner < chose, "the banner was still up when the QR screen was asked for");
    }

    // #562: ASN's "Browser updaten" notice stands in front of the sign-in when it judges the browser outdated; pressed
    // first, and said
    [Fact]
    public async Task The_outdated_browser_notice_is_passed_before_the_sign_in_and_said()
    {
        using var ctx = Context();
        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);
        portal.AbsentSelectors.Remove(StubAsnPortal.BrowserNotice);

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        var passed = Step(portal, $"click:{StubAsnPortal.BrowserNotice}");
        Assert.True(passed >= 0, "the notice's way on was never pressed");
        Assert.True(passed < Step(portal, $"click:{Options.CookieRefuseSelectors[0]}"), "the cookie wall was dealt with before the notice in front of it");
        Assert.True(passed < Step(portal, $"click:{Options.AppMethodLabel}"));
        Assert.Contains(ctx.Notes, n => n.Contains("outdated-browser notice", StringComparison.Ordinal));

        using var quiet = Context();
        var plain = StubAsnPortal.SignedIn(Options.AppMethodLabel);
        await new AsnAdapter(Options).LoginAsync(quiet, plain, CancellationToken.None);
        Assert.DoesNotContain(plain.Calls, c => c.StartsWith($"click:{StubAsnPortal.BrowserNotice}", StringComparison.Ordinal));
        Assert.DoesNotContain(quiet.Notes, n => n.Contains("outdated-browser notice", StringComparison.Ordinal));
    }

    // ASN refreshes its code every few seconds, so a photographed still has expired: the page is relayed live
    [Fact]
    public async Task The_page_is_relayed_live_rather_than_photographed_once()
    {
        using var ctx = Context();
        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);

        Assert.Equal(ChallengeType.LiveView, asked.Type);

        // no still image: it would be a second, staler answer to the same question
        Assert.Null(asked.Image);
    }

    // the sign-in address (/inloggen/) contains the signed-in marker: a wait on the prefix alone matched at once and
    // failed the login
    [Fact]
    public async Task Waiting_for_the_signed_in_path_does_not_match_the_sign_in_page_beneath_it()
    {
        using var ctx = Context();

        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        portal.ArrivesAt = "https://www.asnbank.nl" + Options.SignedInPathMarker + "inloggen/";

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaFailed, refused.Code);

        using var second = Context();
        var arrived = StubAsnPortal.SignedIn(Options.AppMethodLabel);
        arrived.ArrivesAt = "https://www.asnbank.nl" + Options.SignedInPathMarker;

        await new AsnAdapter(Options).LoginAsync(second, arrived, CancellationToken.None);
    }

    // proved by a path, not the "Uitloggen" word: an English-language customer would fail every login
    [Fact]
    public async Task A_scan_nobody_completed_is_refused_rather_than_reported_as_connected()
    {
        using var ctx = Context();

        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);
        portal.ArrivesAt = null;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaFailed, refused.Code);
    }

    // the token source was disposed when the raising method returned, cancelling the relay before the wait began; this
    // checks WHEN
    [Fact]
    public async Task The_code_is_still_live_while_the_scan_is_waited_for()
    {
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(), AnswersNever = true };

        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        var liveWhenWaiting = false;
        portal.OnWait = () => liveWhenWaiting = ctx.Asked.Count == 1 && ctx.ChallengesAbandoned == 0;

        // AnswersNever: otherwise the fake resolves the challenge at once and the relay's lifetime cannot be observed

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        Assert.True(
            liveWhenWaiting,
            "the QR relay was already cancelled when the adapter started waiting for the scan, so the code "
            + "would have vanished off the account holder's screen before they could use it");
    }

    // a login on a real account cannot be repeated with more logging: the page's shape travels with the first failure
    [Fact]
    public async Task A_failed_sign_in_carries_the_shape_of_the_page_that_failed()
    {
        using var ctx = Context();

        var portal = StubAsnPortal.SignedIn();
        portal.Shape = "at: https://www.asnbank.nl/x | buttons: button.ap-button \"Digipas\"";

        await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("when that failed, the page was", StringComparison.Ordinal)
                 && n.Contains("button.ap-button", StringComparison.Ordinal));
    }

    // the box reads "Geen zip-bestand van maken" (do NOT zip): ticking it gives the bare XML, ASN zips by default
    [Fact]
    public async Task The_no_zip_box_is_ticked_and_camt_is_the_third_format()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(portal.Checked[$"{Options.NoZipCheckboxSelectors[0]}#0"]);
        Assert.True(portal.Checked[$"{Options.FormatRadioSelectors[0]}#{Options.Camt053RadioIndex}"]);

        // third after Pdf and CSV; the index is the observation
        Assert.Equal(2, Options.Camt053RadioIndex);
    }

    // clicking Download first exports the last saved format, a PDF on a fresh session
    [Fact]
    public async Task The_format_is_chosen_before_the_file_is_asked_for()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        var saved = Step(portal, $"click:{Options.FormatSaveLabel}");
        var asked = Step(portal, $"download:{Options.DownloadLabel}");

        Assert.True(saved >= 0 && asked > saved, "the download was asked for before the format was saved");
    }

    // typed (maxlength=10, dd-mm-jjjj): driving the month picker back through years breaks on every redesign
    [Fact]
    public async Task The_window_is_typed_into_the_two_date_boxes()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.Equal("01-08-2026", portal.Filled[$"{Options.DateSelectors[0]}#0"]);
        Assert.Equal("31-08-2026", portal.Filled[$"{Options.DateSelectors[0]}#1"]);
    }

    [Fact]
    public async Task A_statement_that_reconciles_comes_back_as_transactions()
    {
        using var ctx = Context();

        var result = await new AsnAdapter(Options)
            .FetchAsync(ctx, Ready(), Transactions(), CancellationToken.None);

        var row = Assert.Single(result.Transactions);

        Assert.Equal(-2_450, row.Amount.Value);
        Assert.Equal(new DateOnly(2026, 8, 5), row.BookedAt);
        Assert.True(result.Complete);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("the entries add up", StringComparison.Ordinal));
    }

    // the reconciliation is why CAMT is worth driving; the refusal is the parser's (ProviderChanged), not a second
    // copy here
    [Fact]
    public async Task A_statement_whose_entries_do_not_add_up_is_refused()
    {
        using var ctx = Context();
        var portal = Ready();

        portal.Download = Statement.Replace(
            "<Amt Ccy=\"EUR\">24.50</Amt>", "<Amt Ccy=\"EUR\">20.00</Amt>", StringComparison.Ordinal);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
    }

    // likeliest cause is the zip checkbox: left alone, ASN sends an archive, seen here as no readable XML
    [Fact]
    public async Task A_download_that_produced_nothing_names_the_zip_box()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Download = null;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains(Options.NoZipLabel, refused.Message, StringComparison.Ordinal);
    }

    // the select-all label ends in the account count, unknown before the page opens: an exact match never lands
    [Fact]
    public async Task The_select_all_is_matched_by_prefix_because_the_count_is_in_the_label()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.NotEqual(RenderedSelectAll, Options.AllAccountsLabelPrefix);
        Assert.Contains(portal.Calls, c => c == $"click:{Options.AllAccountsLabelPrefix}");
        Assert.DoesNotContain(portal.Calls, c => c.EndsWith(":missed", StringComparison.Ordinal));
    }

    // the regex is serialised to Playwright's JS engine: Regex.Escape's "\ " for a space is refused in unicode mode,
    // so assert the string
    [Fact]
    public void The_prefix_pattern_is_anchored_and_carries_no_escaped_spaces()
    {
        var pattern = AsnPortal.PrefixPattern(Options.AllAccountsLabelPrefix);

        Assert.Equal("^Alles selecteren", pattern.ToString());
        Assert.DoesNotContain("\\ ", pattern.ToString(), StringComparison.Ordinal);

        Assert.Matches(pattern, RenderedSelectAll);

        Assert.DoesNotMatch(pattern, "Niet Alles selecteren");

        Assert.Equal("^Kies \\(alles\\)", AsnPortal.PrefixPattern("Kies (alles)").ToString());
    }

    // the select-all is inside a modal, not on the export form; the picker closes before the dates are typed (order
    // decides a keystroke)
    [Fact]
    public async Task The_account_picker_is_opened_before_the_select_all_and_closed_before_the_dates()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        var opened = Step(portal, $"click:{Options.AccountPickerSelectors[0]}");
        var counted = Step(portal, $"count:{Options.AccountCheckboxSelectors[0]}");
        var took = Step(portal, $"click:{Options.AllAccountsLabelPrefix}");
        var confirmed = Step(portal, $"click:{Options.AccountConfirmLabels[0]}");
        var typed = Step(portal, "fill:0");

        Assert.True(opened >= 0, "the account picker was never opened");
        Assert.True(counted > opened, "the accounts were counted before the dialog holding them was open");
        Assert.True(took > opened, "the select-all was looked for before the picker that holds it was opened");
        Assert.True(confirmed > took, "the picker was confirmed before every account had been taken");
        Assert.True(typed > confirmed, "a date was typed while the account picker was still over the form");
    }

    // a misdirected click is how every live failure here started; the dialog's heading makes the opening checkable
    [Fact]
    public async Task Nothing_that_opened_a_dialog_means_nothing_is_chosen_and_nothing_is_downloaded()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Opens.Clear();

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains(Options.AccountModalHeading, refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    // closing is the one best-effort step: whether ASN's dialog dismisses itself was never observed; noted, not thrown
    [Fact]
    public async Task A_picker_that_closed_itself_does_not_fail_the_fetch()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.AbsentSelectors.Add(Options.ModalCloseSelectors[0]);

        var result = await new AsnAdapter(Options with { AccountConfirmLabels = [] })
            .FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);
    }

    // the back control (3rd button, "Rekening" on a fresh navigation) is never clicked: two attempts at it left the
    // export form asserted over the whole ladder, since a fallback rung reaching for it is the danger
    [Fact]
    public async Task No_rung_of_the_ladder_ever_reaches_the_back_control()
    {
        using var ctx = Context();

        var portal = Ready();

        portal.Opens.Clear();

        await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.DoesNotContain(BackControl, Options.AccountPickerFallbackIndexes);
        Assert.DoesNotContain(FormButtons[BackControl], portal.ClickedByPosition);

        Assert.DoesNotContain(
            portal.Calls,
            c => c == $"click:{FormButtons[BackControl]}");
    }

    // Playwright refuses the select as unactionable while the probe lists it: a native control behind a styled wrapper
    [Fact]
    public async Task The_picker_is_opened_through_the_box_around_the_select()
    {
        using var ctx = Context();
        var portal = Ready();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);
        Assert.Contains(portal.Calls, c => c == $"click:{Options.AccountPickerSelectors[0]}");

        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("force:", StringComparison.Ordinal));
        Assert.Empty(portal.ClickedByPosition);
        Assert.Contains(ctx.Notes, n => n.Contains("opened by the box around", StringComparison.Ordinal));
    }

    // a rung that opens nothing may still have moved the browser: the form is reloaded before the next rung
    [Fact]
    public async Task A_rung_that_opened_nothing_is_followed_by_a_reload_before_the_next()
    {
        using var ctx = Context();

        var portal = Ready();

        portal.Opens.Remove($"click:{Options.AccountPickerSelectors[0]}");
        portal.Opens[$"force:{Options.AccountPickerForceSelectors[0]}"] = Options.AccountModalHeading;

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);

        var first = Step(portal, $"click:{Options.AccountPickerSelectors[0]}");
        var forced = Step(portal, $"force:{Options.AccountPickerForceSelectors[0]}");
        var reloaded = portal.Calls
            .Select((call, i) => (call, i))
            .Where(t => t.call.StartsWith("goto:", StringComparison.Ordinal) && t.i > first)
            .Select(t => t.i)
            .DefaultIfEmpty(-1)
            .Min();

        Assert.True(first >= 0, "the first rung was never tried");
        Assert.True(reloaded > first, "the form was not reloaded after the rung that opened nothing");
        Assert.True(forced > reloaded, "the next rung was tried before the form was reloaded");
        Assert.Contains(ctx.Notes, n => n.Contains("forced", StringComparison.Ordinal));
    }

    // the account filter was never read: ticking credit_card and loan returned 400 transactions marked complete
    // refuse, not return nothing: empty would read as "no credit-card transactions" when the session cannot reach any
    [Fact]
    public async Task An_account_type_this_export_cannot_reach_is_refused()
    {
        using var ctx = Context();

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(
                ctx,
                Ready(),
                new ResourceRequest
                {
                    ResourceId = BankResources.Transactions,
                    Selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                    {
                        ["accounts"] = ["credit_card"],
                    },
                },
                CancellationToken.None));

        Assert.Equal(ErrorCode.UnsupportedResource, refused.Code);
        Assert.Contains("not reachable", refused.Message, StringComparison.Ordinal);
    }

    // a CAMT.053 statement does not say what kind of account it is, so every account here is Current
    [Fact]
    public async Task The_manifest_offers_only_the_account_type_this_export_produces()
    {
        var transactions = AsnManifest.Build().Resources
            .Single(r => r.Id == BankResources.Transactions);

        var accounts = transactions.Params.Single(p => p.Key == "accounts");

        Assert.Equal(["current"], accounts.Values);

        // one export covers every account the login sees: the filter decides what is SHOWN, not what leaves the bank; the
        // notes say so
        Assert.Equal(AsnManifest.WholeExportKey, transactions.NotesKey);

        using var ctx = Context();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, Ready(), new ResourceRequest { ResourceId = BankResources.Accounts }, CancellationToken.None);

        Assert.All(result.Accounts, a => Assert.Equal(AccountType.Current, a.Type));
    }

    // each link of the chain checks only itself: one account came back as complete; the bank's own count (one checkbox
    // per account) is the outside check
    [Fact]
    public async Task An_export_that_missed_accounts_the_picker_offered_is_refused()
    {
        using var ctx = Context();

        var portal = Ready();

        portal.Counts[Options.AccountCheckboxSelectors[0]] = 3;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("offered 3 account(s)", refused.Message, StringComparison.Ordinal);
        Assert.Contains("came back with 1", refused.Message, StringComparison.Ordinal);
    }

    // the X dismisses, which on this design system is not agreeing: an export that pressed it downloaded only the
    // default account
    [Fact]
    public async Task The_account_picker_is_confirmed_rather_than_dismissed()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        var took = Step(portal, $"click:{Options.AllAccountsLabelPrefix}");
        var confirmed = Step(portal, $"click:{Options.AccountConfirmLabels[0]}");

        Assert.True(confirmed > took, "the picker was never confirmed after every account was taken");
        Assert.DoesNotContain(portal.Calls, c => c == $"click:{Options.ModalCloseSelectors[0]}");
        Assert.Contains(ctx.Notes, n => n.Contains("was confirmed with", StringComparison.Ordinal));

        // the confirm label carries a count too, so it is prefix-matched
        Assert.NotEqual(RenderedConfirm, Options.AccountConfirmLabels[0]);
        Assert.Equal(RenderedConfirm, Options.AccountConfirmLabels[0] + " (3)");
    }

    // the real confirm was never seen (the probe capped buttons at twelve): a run where no candidate lands reports the
    // dialog's shape
    [Fact]
    public async Task A_picker_that_nothing_confirmed_reports_what_was_in_it()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Shape = "at: https://www.asnbank.nl/x | buttons: button[data-testid='button'] \"Gereed\"";

        // the candidate list is emptied, not the label removed: "Opslaan" also saves the format dialog
        await new AsnAdapter(Options with { AccountConfirmLabels = [] })
            .FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("confirmed the account picker", StringComparison.Ordinal)
                 && n.Contains("Gereed", StringComparison.Ordinal));

        // no guessing: a guessed last button was "Selectie wissen", which clears the selection; the count check then
        // reports the truth
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith($"click:{Options.AccountPickerFallbackSelectors[0]}#", StringComparison.Ordinal));

        Assert.Contains(portal.Calls, c => c == $"click:{Options.ModalCloseSelectors[0]}");
    }

    // a guessed button may be Cancel; the end-of-export count check keeps that from publishing a short list as whole
    [Fact]
    public async Task A_guessed_confirm_that_was_really_a_cancel_still_cannot_publish_a_short_list()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Counts[Options.AccountCheckboxSelectors[0]] = 3;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options with { AccountConfirmLabels = [] })
                .FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("offered 3 account(s)", refused.Message, StringComparison.Ordinal);
    }

    // live reported "no radio at index 2" on a modal showing five: Playwright will not act on a radio parked behind a
    // styled label
    [Fact]
    public async Task A_radio_that_cannot_be_set_directly_is_still_chosen()
    {
        using var ctx = Context();
        var portal = Ready();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);
        Assert.True(portal.Checked[$"{Options.FormatRadioSelectors[0]}#{Options.Camt053RadioIndex}"]);

        Assert.Contains(
            portal.Calls,
            c => c == $"check:{Options.Camt053RadioIndex}:by the box around it");

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("CAMT.053 was set by the box around it", StringComparison.Ordinal));
    }

    // the form carries three modals; a date typed while the format modal is open goes into it
    [Fact]
    public async Task A_format_button_that_opened_no_dialog_refuses_before_a_format_is_picked()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Opens.Remove($"click:{Options.FormatChangeLabel}");

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains(Options.FormatModalHeading, refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    // the no-zip box decides which file arrives, so a miss refuses; the message blames the radio, since the box
    // appears only after a format is chosen
    [Fact]
    public async Task A_no_zip_box_that_cannot_be_ticked_refuses_and_blames_the_radio()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.AbsentSelectors.Add(Options.NoZipCheckboxSelectors[0]);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains(Options.NoZipLabel, refused.Message, StringComparison.Ordinal);
        Assert.Contains("may not be CAMT.053", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    // a missed "Opslaan" leaves the format unapplied: the last saved one, a PDF on a fresh session, would be
    // downloaded
    [Fact]
    public async Task A_format_that_was_never_saved_refuses_rather_than_downloading()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Labels.Remove(Options.FormatSaveLabel);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("never applied", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    // a miss would download whatever ASN had ticked and return it Complete: a partial set published as the whole
    [Fact]
    public async Task An_export_that_cannot_take_every_account_refuses_rather_than_reading_some()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Labels.Remove(RenderedSelectAll);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("unknown subset", refused.Message, StringComparison.Ordinal);

        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    // a failed fetch carries the page's shape like the login does: it cannot be repeated with more logging
    [Fact]
    public async Task A_failed_fetch_carries_the_shape_of_the_page_that_failed()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Labels.Remove(RenderedSelectAll);
        portal.Shape = "at: https://www.asnbank.nl/x | buttons: button.ap-button, inputs: 2 text";

        await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("when that failed, the page was", StringComparison.Ordinal)
                 && n.Contains("button.ap-button", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_accounts_a_session_can_see_are_the_statements_it_gets()
    {
        using var ctx = Context();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, Ready(), new ResourceRequest { ResourceId = BankResources.Accounts }, CancellationToken.None);

        var account = Assert.Single(result.Accounts);

        Assert.Equal("NL02ASNB0000018507", account.Iban);
        Assert.Equal("EUR", account.Currency);
    }

    // a logout job's browser has been nowhere, and ASN's header is collapsed at the emulated phone width: sign-out
    // sits behind the SECOND header control the hamburger holds only Overzicht, Zelf regelen and Contact
    private static StubAsnPortal SignOutPage()
    {
        var portal = StubAsnPortal.Blank();

        // positioned by the order the adapter tries, not a fixed index: the first thing tried opens a panel, the second
        // works
        var first = Options.SignOutMenuIndexes[0];
        var second = Options.SignOutMenuIndexes[1];

        var buttons = Enumerable.Range(0, Math.Max(first, second) + 2)
            .Select(i => $"something else {i}")
            .ToArray();

        buttons[first] = "a control that opens a panel";
        buttons[second] = "the control holding the sign-out";

        portal.ButtonsInOrder.AddRange(buttons);

        portal.RevealsLabel["press:the control holding the sign-out"] = Options.SignOutLabel;

        // the first rung opens a panel over the page ("Veel gebruikte links"), so positional handles count the panel's
        // buttons unless the ladder goes back first
        portal.Covers["press:a control that opens a panel"] =
            ["the search box", "a suggested link", "another suggested link"];

        return portal;
    }

    // a logout that silently does nothing shipped once on ING and took a week to find
    [Fact]
    public async Task Signing_out_is_confirmed_by_the_page_it_reaches()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("signed out upstream", StringComparison.Ordinal));
    }

    // a logout job's browser starts at about:blank: without a navigation the hunt finds nothing and blames the bank
    [Fact]
    public async Task The_sign_out_opens_a_signed_in_page_before_hunting_for_the_button()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        var went = Step(portal, $"goto:https://www.asnbank.nl{Options.SignedInPathMarker}");
        var clicked = Step(portal, $"click:{Options.SignOutLabel}");

        Assert.True(went >= 0, "the sign-out never navigated, so it hunted the button on a blank page");
        Assert.True(clicked > went, "the button was looked for before the page holding it was opened");

        Assert.Contains(ctx.Notes, n => n.Contains("signed out upstream", StringComparison.Ordinal));
    }

    // opening the page IS resuming the session (lease built from the job's cookie jar): with no jar it would visit the
    // bank as a stranger
    [Fact]
    public async Task A_disconnect_with_no_stored_session_does_not_open_a_browser()
    {
        using var ctx = Context();

        // the lease refuses to hand out a page, so reaching the end is the assertion that no browser launched (Started is
        // a fixed true)
        await new AsnAdapter(Options).LogoutAsync(ctx, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("nothing to sign out", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_sign_out_that_never_landed_does_not_claim_to_have_worked()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = null;

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.DoesNotContain(ctx.Notes, n => n.Contains("signed out upstream", StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, n => n.Contains("may still be alive", StringComparison.Ordinal));
    }

    // the phone emulation collapses ASN's header, so the sign-out appears only once a menu opens; a rung is judged by
    // the sign-out appearing, not the press landing
    [Fact]
    public async Task The_sign_out_keeps_opening_menus_until_the_button_appears()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        var index = Options.SignOutMenuIndexes[1];

        var opened = Step(portal, $"click:{Options.SignOutMenuSelectors[0]}#{index}");
        var clicked = Step(portal, $"click:{Options.SignOutLabel}");

        Assert.True(opened >= 0, "the control holding the sign-out was never pressed");
        Assert.True(clicked > opened, "the button was looked for before the menu holding it was opened");

        // the note names the route that worked: three live sign-outs were spent finding which header control holds the
        // button
        Assert.Contains(
            ctx.Notes,
            n => n.Contains("signed out upstream", StringComparison.Ordinal)
                 && n.Contains($"header control {index}", StringComparison.Ordinal));
    }

    // a wider viewport shows the header outright (de Volksbank serves SNS, RegioBank and BLG Wonen from these pages):
    // no pressing menus for a visible button
    [Fact]
    public async Task A_sign_out_already_on_the_page_is_pressed_without_opening_anything()
    {
        using var ctx = Context();

        var portal = StubAsnPortal.Blank(Options.SignOutLabel);
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("signed out upstream", StringComparison.Ordinal));

        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith($"click:{Options.SignOutMenuSelectors[0]}#", StringComparison.Ordinal));
    }

    // a click that finds nothing spends ten seconds; clicking per candidate would outlast the courtesy sign-out's
    // allowance, so each rung asks first
    [Fact]
    public async Task The_search_asks_whether_the_button_is_there_rather_than_clicking_at_it()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        var asked = portal.Calls.Count(c => c.StartsWith($"label?:{Options.SignOutLabel}", StringComparison.Ordinal));
        var pressed = portal.Calls.Count(c => c.StartsWith($"click:{Options.SignOutLabel}", StringComparison.Ordinal));

        Assert.True(asked > 0, "the search never asked whether the button was there; it clicked and waited");
        Assert.Equal(1, pressed);
    }

    // ASN answers a signed-in address with its sign-in page once the session is gone: that is done, not a missing
    // button
    [Fact]
    public async Task A_session_that_had_already_ended_is_not_reported_as_a_missing_button()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.RedirectsTo = Options.LoginUrl;

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("had already ended", StringComparison.Ordinal));
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("left to expire", StringComparison.Ordinal));

        Assert.Equal(-1, Step(portal, $"click:{Options.SignOutMenuSelectors[0]}#0"));
    }

    // a sign-out failure cannot be reproduced (the next attempt needs a fresh code): the diagnosis travels with the
    // first failure
    [Fact]
    public async Task A_sign_out_that_cannot_find_its_button_reports_the_page()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.RevealsLabel.Clear();
        portal.Shape = "at: https://www.asnbank.nl/online/web/onlinebankieren/ | buttons: none";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("left to expire", StringComparison.Ordinal));
        Assert.Contains(ctx.Notes, n => n.Contains(portal.Shape, StringComparison.Ordinal));
    }
}
