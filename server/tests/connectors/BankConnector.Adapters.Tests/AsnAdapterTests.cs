using BankConnector.Adapters.Asn;
using BankConnector.Adapters.Tests.Support;
using Connector.Kit.Adapters;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Normalization;
using Xunit;

namespace BankConnector.Adapters.Tests;

/// <summary>
/// ASN's sign-in and export, driven offline.
///
/// <para>
/// Every value these assert against came from a discovery session rather than
/// from reasoning - see <see cref="AsnOptions"/>, where each is marked. The
/// adapter this replaced was written from a design document and was wrong about
/// the shape of the bank, not merely its selectors.
/// </para>
///
/// <para>
/// A real sign-in here costs an attempt against somebody's account, so what can
/// be checked offline is checked offline: the order of the form, the polarity of
/// a checkbox that means its own opposite, and what happens when a step does not
/// land.
/// </para>
/// </summary>
public sealed class AsnAdapterTests
{
    private static readonly AsnOptions Options = new();

    /// <summary>The account this statement belongs to is stated by the file.</summary>
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

    /// <summary>
    /// The label ASN actually renders on its select-all, count and all.
    /// </summary>
    /// <remarks>
    /// NOT <see cref="AsnOptions.AllAccountsLabelPrefix"/>, and that distinction
    /// is the whole reason the first live fetch died against a green suite. The
    /// fixture used to be built from the adapter's own vocabulary - it
    /// registered the string the adapter would ask for, so every click hit by
    /// construction and the tests could only confirm the adapter agreed with
    /// itself. The bank puts the number of accounts in the label, so what it
    /// renders and what the adapter knows to ask for are never the same string.
    /// </remarks>
    private const string RenderedSelectAll = "Alles selecteren (3)";

    /// <summary>
    /// The confirm, as ASN renders it - count and all.
    /// </summary>
    /// <remarks>
    /// Its neighbour on that dialog is "Selectie wissen (3)", which CLEARS the
    /// selection, and a run that guessed at the primary action pressed exactly
    /// that. Both carry the count, so both are prefix-matched, and a fixture
    /// holding the adapter's bare string instead of the bank's could not tell
    /// an exact match from a prefix one.
    /// </remarks>
    private const string RenderedConfirm = "Selectie bevestigen (3)";

    /// <summary>
    /// THE EXPORT FORM'S data-testid='button' ELEMENTS, IN DOCUMENT ORDER.
    /// </summary>
    /// <remarks>
    /// Index 2 is THE BACK CONTROL, and it is in this fixture to be left alone.
    /// Its label is the title of the page you came from: "Overzicht" on an
    /// account page, "ASN Bankrekening" on a form reached from that account,
    /// nothing at all on the root overview, and "Rekening" for this adapter,
    /// which arrives from nowhere. Two commits in a row aimed at it - once by
    /// the stem "rekening", once by that exact label and this index - and both
    /// times a live fetch left the export form for /zelf-regelen/rekeningen.
    /// <para>
    /// 0 and 1 are page chrome; 3 and 4 are the form's own unlabelled buttons,
    /// most likely the two calendar triggers for the two date boxes.
    /// </para>
    /// </remarks>
    private static readonly string[] FormButtons =
    [
        string.Empty,
        string.Empty,
        "Rekening",
        string.Empty,
        string.Empty,
    ];

    /// <summary>Which of those is the way OUT of the export form.</summary>
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

        // The account select cannot be clicked, exactly as on the bank - the
        // click has to go to the box around it.
        portal.ForceOnlySelectors.Add(Options.AccountPickerForceSelectors[0]);

        // And ONLY that box opens the dialog. A fixture where the heading is
        // simply always there cannot test a check that it appeared.
        portal.Opens[$"click:{Options.AccountPickerSelectors[0]}"] = Options.AccountModalHeading;
        portal.Opens[$"click:{Options.FormatChangeLabel}"] = Options.FormatModalHeading;

        // The CAMT radio is one of the controls this bank parks behind a
        // styled label - it is what the live fetch reported as a radio that
        // "has no index 2" on a modal holding five of them.
        portal.UnreachableControls.Add(
            $"{Options.FormatRadioSelectors[0]}#{Options.Camt053RadioIndex}");

        // ONE account, and the statement below is that one account - so a
        // fixture that says nothing about how many the bank offered is a
        // fixture in which a short export cannot be noticed.
        portal.Counts[Options.AccountCheckboxSelectors[0]] = 1;
        portal.Labels.Add(RenderedConfirm);

        // Counted from the same list the positional clicks index into, so the
        // fixture cannot disagree with itself about how many buttons exist.
        portal.Counts[Options.AccountPickerFallbackSelectors[0]] = FormButtons.Length;

        return portal;
    }

    /// <summary>
    /// Where a call sits in the order, or -1. The order is most of what can go
    /// wrong offline on this provider.
    /// </summary>
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

    // ---- the sign-in -------------------------------------------------------

    /// <summary>
    /// THE COOKIE WALL IS REFUSED BEFORE ANYTHING ELSE IS TOUCHED.
    /// </summary>
    /// <remarks>
    /// It stands in front of the whole page, and the option it clicks is
    /// "Cookies weigeren" rather than "Cookies accepteren" - a connector reading
    /// somebody's statements has no business accepting tracking on their behalf.
    /// </remarks>
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

        // AND THE BRAND BANNER GOES BEFORE THE QR IS RELAYED. It pushes the
        // code below the fold of the stream at the phone width the agent
        // emulates, so the account holder has to scroll a picture to scan it.
        var banner = Step(portal, $"click:{Options.BannerDismissSelectors[0]}");

        Assert.True(banner > refused, "the brand banner was dismissed before the cookie wall in front of it");
        Assert.True(banner < chose, "the banner was still up when the QR screen was asked for");
    }

    /// <summary>
    /// THE BANK'S OWN SCREEN IS RELAYED, because its code will not sit still.
    /// </summary>
    /// <remarks>
    /// The first version photographed the QR - found by being square, 205x205
    /// against a 158x30 logo - and relayed one picture. ASN refreshes that code
    /// every few seconds, so a still frame is a code that has already expired
    /// by the time somebody has their phone out. A live view shows what the
    /// page is showing now, which is the only thing worth scanning.
    /// </remarks>
    [Fact]
    public async Task The_page_is_relayed_live_rather_than_photographed_once()
    {
        using var ctx = Context();
        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        var asked = Assert.Single(ctx.Asked);

        Assert.Equal(ChallengeType.LiveView, asked.Type);

        // No still image goes with it. One would be a second, staler answer to
        // the same question.
        Assert.Null(asked.Image);
    }

    /// <summary>
    /// SITTING ON THE SIGN-IN PAGE IS NOT BEING SIGNED IN, even though its
    /// address contains the signed-in one.
    /// </summary>
    /// <remarks>
    /// The trap this bank sets, and it took a live failure to see. ASN signs
    /// people in at <c>/online/web/onlinebankieren/inloggen/</c> and lands them
    /// on <c>/online/web/onlinebankieren/</c> - so the marker for "you are in"
    /// is a PREFIX of the page you are on before you are.
    /// <para>
    /// A wait built on it alone matched on its very first check, the
    /// <c>/inloggen/</c> test then failed the login, and the account holder was
    /// told "that code was not accepted" before there was a code to accept.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task Waiting_for_the_signed_in_path_does_not_match_the_sign_in_page_beneath_it()
    {
        using var ctx = Context();

        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        // Exactly where a browser sits while somebody is still deciding to
        // reach for their phone.
        portal.ArrivesAt = "https://www.asnbank.nl" + Options.SignedInPathMarker + "inloggen/";

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None));

        Assert.Equal(ErrorCode.MfaFailed, refused.Code);

        // And the honest version still lands.
        using var second = Context();
        var arrived = StubAsnPortal.SignedIn(Options.AppMethodLabel);
        arrived.ArrivesAt = "https://www.asnbank.nl" + Options.SignedInPathMarker;

        await new AsnAdapter(Options).LoginAsync(second, arrived, CancellationToken.None);
    }

    /// <summary>
    /// A SIGN-IN THAT NEVER LEFT THE LOGIN PAGE IS REFUSED.
    /// </summary>
    /// <remarks>
    /// Proved by a path rather than a word. There is an "Uitloggen" button on
    /// every signed-in page which would be a better marker in every way but one:
    /// a bank serving an English-speaking customer would fail every login.
    /// </remarks>
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

    /// <summary>
    /// THE CODE IS STILL ON SCREEN WHILE THE SCAN IS WAITED FOR.
    /// </summary>
    /// <remarks>
    /// The first live attempt failed here and the symptom named it exactly:
    /// "for a very short moment I saw the QR code, then this screen". The token
    /// source the challenge was raised against was disposed when the method
    /// that raised it returned - so the relay was cancelled BEFORE the caller
    /// began waiting for the browser to move, and the account holder watched
    /// their code appear and vanish.
    /// <para>
    /// Asserting that a challenge was raised passes either way. Asserting it
    /// was cancelled passes either way. What separates them is WHEN, so this
    /// looks at the moment the wait begins.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task The_code_is_still_live_while_the_scan_is_waited_for()
    {
        using var ctx = new FakeJobContext { Browser = new StubBrowserLease(), AnswersNever = true };

        var portal = StubAsnPortal.SignedIn(Options.AppMethodLabel);

        var liveWhenWaiting = false;
        portal.OnWait = () => liveWhenWaiting = ctx.Asked.Count == 1 && ctx.ChallengesAbandoned == 0;

        // AnswersNever, or the fake resolves the challenge the instant it is
        // raised and the relay's lifetime cannot be observed at all - which is
        // how the first version of this test passed over the bug it was
        // written for.

        await new AsnAdapter(Options).LoginAsync(ctx, portal, CancellationToken.None);

        Assert.True(
            liveWhenWaiting,
            "the QR relay was already cancelled when the adapter started waiting for the scan, so the code "
            + "would have vanished off the account holder's screen before they could use it");
    }

    /// <summary>
    /// A FAILED SIGN-IN SAYS WHAT THE PAGE LOOKED LIKE.
    /// </summary>
    /// <remarks>
    /// A first live attempt produced "provider_changed" and nothing else, which
    /// names a category rather than a step - the method button, the QR, or a
    /// page that never loaded are three different repairs behind one code. This
    /// login runs on somebody's real account and cannot be repeated with more
    /// logging turned on, so the diagnosis travels with the first failure.
    /// </remarks>
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

    // ---- the export --------------------------------------------------------

    /// <summary>
    /// THE ZIP CHECKBOX IS TICKED, BECAUSE IT MEANS ITS OWN OPPOSITE.
    /// </summary>
    /// <remarks>
    /// It reads "Geen zip-bestand van maken" - do NOT make a zip - so ticking it
    /// is what produces the bare XML, and ASN zips by default. An adapter
    /// written to "tick the zip box" would fetch precisely the wrong file, and
    /// the failure would surface as a parser refusing an archive, which reads
    /// like the bank changing its export rather than like this reading a label
    /// backwards.
    /// </remarks>
    [Fact]
    public async Task The_no_zip_box_is_ticked_and_camt_is_the_third_format()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(portal.Checked[$"{Options.NoZipCheckboxSelectors[0]}#0"]);
        Assert.True(portal.Checked[$"{Options.FormatRadioSelectors[0]}#{Options.Camt053RadioIndex}"]);

        // Third, after Pdf and CSV. Asserted as the number as well as the
        // behaviour, because the index IS the observation.
        Assert.Equal(2, Options.Camt053RadioIndex);
    }

    /// <summary>
    /// The format is settled before the download is asked for.
    /// </summary>
    /// <remarks>
    /// Order matters on this form: clicking Download first exports whatever
    /// format was last saved, which on a fresh session is a PDF - and a PDF
    /// reaching a CAMT parser reads as the bank having changed its export.
    /// </remarks>
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

    /// <summary>
    /// Dates are TYPED rather than clicked out of a calendar, in the format the
    /// boxes accept.
    /// </summary>
    /// <remarks>
    /// <c>maxlength=10</c> on both, which is dd-mm-jjjj. The screen also has a
    /// month-by-month picker, and driving one of those back through years of
    /// history is the kind of loop that breaks on every redesign.
    /// </remarks>
    [Fact]
    public async Task The_window_is_typed_into_the_two_date_boxes()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.Equal("01-08-2026", portal.Filled[$"{Options.DateSelectors[0]}#0"]);
        Assert.Equal("31-08-2026", portal.Filled[$"{Options.DateSelectors[0]}#1"]);
    }

    /// <summary>
    /// The statement is parsed, and its own balances are checked.
    /// </summary>
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

    /// <summary>
    /// A STATEMENT THAT DOES NOT ADD UP IS REFUSED.
    /// </summary>
    /// <remarks>
    /// The reconciliation is the whole reason this format is worth driving a
    /// form for: the bank states an opening and a closing balance, so entries
    /// that do not move one onto the other mean something is missing. Publishing
    /// them anyway would hand somebody a statement that looks complete and is
    /// not.
    /// <para>
    /// The refusal is the PARSER's - Camt053Parser.VerifyAgainstBalances - and
    /// it arrives as ProviderChanged. This adapter briefly carried a second
    /// copy of the same arithmetic; the test is what showed the two disagreeing
    /// about the error code, and the duplicate went.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task A_statement_whose_entries_do_not_add_up_is_refused()
    {
        using var ctx = Context();
        var portal = Ready();

        // One entry short of the movement its own balances claim.
        portal.Download = Statement.Replace(
            "<Amt Ccy=\"EUR\">24.50</Amt>", "<Amt Ccy=\"EUR\">20.00</Amt>", StringComparison.Ordinal);

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
    }

    /// <summary>
    /// A download that produced nothing says which box to look at.
    /// </summary>
    /// <remarks>
    /// The likeliest cause by far is the zip: leave that checkbox alone and ASN
    /// sends an archive, which arrives here as no readable XML at all.
    /// </remarks>
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

    /// <summary>
    /// THE SELECT-ALL IS FOUND BY ITS BEGINNING, because its end is a number.
    /// </summary>
    /// <remarks>
    /// ASN renders "Alles selecteren (3)". The adapter cannot know the count
    /// before the page is open, so an exact match is a click that can never
    /// land - and that is precisely how the first live fetch died: it hunted
    /// for the whole string, spent its ten seconds not finding it, and the
    /// timeout took the export down.
    /// </remarks>
    [Fact]
    public async Task The_select_all_is_matched_by_prefix_because_the_count_is_in_the_label()
    {
        using var ctx = Context();
        var portal = Ready();

        await new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        // The rendered label carries a count the adapter never had.
        Assert.NotEqual(RenderedSelectAll, Options.AllAccountsLabelPrefix);
        Assert.Contains(portal.Calls, c => c == $"click:{Options.AllAccountsLabelPrefix}");
        Assert.DoesNotContain(portal.Calls, c => c.EndsWith(":missed", StringComparison.Ordinal));
    }

    /// <summary>
    /// The pattern that prefix match compiles to, in a dialect JavaScript reads.
    /// </summary>
    /// <remarks>
    /// This regex does not stay in .NET - Playwright serialises it to the
    /// driver, where a JavaScript engine compiles it. <c>Regex.Escape</c> writes
    /// a space as <c>\ </c>, which .NET reads as a literal space, JavaScript
    /// accepts only as a legacy identity escape, and a unicode-mode JavaScript
    /// regex refuses. Every label on this bank has a space in it, so the pattern
    /// is asserted as a STRING rather than only by what it matches here.
    /// </remarks>
    [Fact]
    public void The_prefix_pattern_is_anchored_and_carries_no_escaped_spaces()
    {
        var pattern = AsnPortal.PrefixPattern(Options.AllAccountsLabelPrefix);

        Assert.Equal("^Alles selecteren", pattern.ToString());
        Assert.DoesNotContain("\\ ", pattern.ToString(), StringComparison.Ordinal);

        Assert.Matches(pattern, RenderedSelectAll);

        // Anchored, so a label merely CONTAINING the words is not this button.
        Assert.DoesNotMatch(pattern, "Niet Alles selecteren");

        // And a label with regex punctuation in it is still matched literally.
        Assert.Equal("^Kies \\(alles\\)", AsnPortal.PrefixPattern("Kies (alles)").ToString());
    }

    /// <summary>
    /// THE SELECT-ALL IS INSIDE A MODAL, so the modal is opened first.
    /// </summary>
    /// <remarks>
    /// The screen carrying "Alles selecteren (3)" also carries a modal-close
    /// button, a search box and one checkbox per account. The screen a fresh
    /// agent lands on has none of them. So the select-all is not on the export
    /// form at all - the first live fetch hunted for it there, where it has
    /// never been.
    /// <para>
    /// And the picker is CLOSED before the dates are typed, because this form
    /// is one where order decides what a keystroke means.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// OPENING THE PICKER IS CHECKED, not assumed from having clicked.
    /// </summary>
    /// <remarks>
    /// A click that landed somewhere unintended is how every live failure on
    /// this bank has started, and the damage is always done by the NEXT step,
    /// hunting for something on a page that has moved on. The dialog announces
    /// itself with its own heading, so this is a claim that can be tested - and
    /// the fixture only reveals that heading for a click on the real control,
    /// so the check has something to fail against.
    /// </remarks>
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

    /// <summary>
    /// A picker that closes itself is not a failure, and does not read as one.
    /// </summary>
    /// <remarks>
    /// The close is the one best-effort step in this sequence. Whether ASN's
    /// dialog applies-and-dismisses or waits to be closed was never observed
    /// either way, and failing a whole fetch over a dialog that is already gone
    /// would be a bug of this connector's own making. Noted rather than thrown,
    /// so the run still says what it saw.
    /// </remarks>
    [Fact]
    public async Task A_picker_that_closed_itself_does_not_fail_the_fetch()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.AbsentSelectors.Add(Options.ModalCloseSelectors[0]);

        // Nothing confirms it and nothing closes it - a dialog that applied its
        // choice and dismissed itself looks exactly like this from out here.
        var result = await new AsnAdapter(Options with { AccountConfirmLabels = [] })
            .FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);
    }

    /// <summary>
    /// THE BACK CONTROL IS NEVER CLICKED, however much it looks like the picker.
    /// </summary>
    /// <remarks>
    /// It is the third data-testid='button' on the form, its label is the title
    /// of the page you came from, and on a fresh navigation that reads
    /// "Rekening". Two commits aimed at it - once by the stem, once by that
    /// exact label and that exact index - and both times a live fetch left the
    /// export form for the accounts overview and went hunting there.
    /// <para>
    /// Asserted over the WHOLE ladder, including the rungs that only run when
    /// earlier ones fail, because the danger is precisely that a fallback
    /// reaches for it.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task No_rung_of_the_ladder_ever_reaches_the_back_control()
    {
        using var ctx = Context();

        var portal = Ready();

        // Nothing opens the dialog, so every rung is tried.
        portal.Opens.Clear();

        await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.DoesNotContain(BackControl, Options.AccountPickerFallbackIndexes);
        Assert.DoesNotContain(FormButtons[BackControl], portal.ClickedByPosition);

        // And it is not reached by label either - that was the other attempt.
        Assert.DoesNotContain(
            portal.Calls,
            c => c == $"click:{FormButtons[BackControl]}");
    }

    /// <summary>
    /// THE SELECT IS REACHED THROUGH THE BOX AROUND IT, not by clicking it.
    /// </summary>
    /// <remarks>
    /// Playwright refused the select itself as unactionable while the shape
    /// probe listed it happily - the signature of a native control parked
    /// behind a styled wrapper. The fixture models that refusal, so an adapter
    /// that went back to clicking the select directly would fail here.
    /// </remarks>
    [Fact]
    public async Task The_picker_is_opened_through_the_box_around_the_select()
    {
        using var ctx = Context();
        var portal = Ready();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, portal, Transactions(), CancellationToken.None);

        Assert.True(result.Complete);
        Assert.Contains(portal.Calls, c => c == $"click:{Options.AccountPickerSelectors[0]}");

        // The later rungs were never needed.
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("force:", StringComparison.Ordinal));
        Assert.Empty(portal.ClickedByPosition);
        Assert.Contains(ctx.Notes, n => n.Contains("opened by the box around", StringComparison.Ordinal));
    }

    /// <summary>
    /// A LOWER RUNG IS TRIED, and only after the form has been reloaded.
    /// </summary>
    /// <remarks>
    /// A rung that opens nothing may still have MOVED the browser, which is how
    /// this went wrong twice. A second attempt made on whatever page that
    /// landed on is not a second attempt at anything.
    /// </remarks>
    [Fact]
    public async Task A_rung_that_opened_nothing_is_followed_by_a_reload_before_the_next()
    {
        using var ctx = Context();

        var portal = Ready();

        // The box is there but does nothing; the forced click on the select is
        // what works - which is the arrangement the live page might yet turn
        // out to have.
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

    /// <summary>
    /// AN ACCOUNT TYPE THIS SESSION CANNOT REACH IS REFUSED, not ignored.
    /// </summary>
    /// <remarks>
    /// This adapter never read the account filter at all. The manifest
    /// advertised it - every bank resource here does - and the account holder
    /// duly ticked "credit_card" and "loan" on a connection that has neither,
    /// and received four hundred transactions from the accounts they had not
    /// asked for, marked complete. Asking wrong and asking for everything
    /// produced the same answer.
    /// <para>
    /// The platform's rule refuses rather than returning nothing, and the
    /// distinction is the whole point: an empty result reads as "you have no
    /// credit-card transactions" when the truth is "this session cannot reach
    /// any".
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// AND THE MANIFEST OFFERS ONLY WHAT THE EXPORT CAN TELL APART.
    /// </summary>
    /// <remarks>
    /// A CAMT.053 statement names an IBAN, a currency and two balances, and
    /// says nothing about what kind of account is behind them - so every
    /// account here is Current, including the ones their owner calls savings.
    /// Offering four types was an invitation to ask an unanswerable question.
    /// </remarks>
    [Fact]
    public async Task The_manifest_offers_only_the_account_type_this_export_produces()
    {
        var transactions = AsnManifest.Build().Resources
            .Single(r => r.Id == BankResources.Transactions);

        var accounts = transactions.Params.Single(p => p.Key == "accounts");

        Assert.Equal(["current"], accounts.Values);

        // AND THE MANIFEST SAYS WHAT THE FILTER DOES NOT DO.
        //
        // One export covers every account this login can see, so the parameter
        // above decides what a caller is SHOWN and not what leaves the bank.
        // No combination of enum values can state that, and somebody narrowing
        // a fetch to one account is entitled to assume otherwise unless the
        // resource says so itself.
        Assert.Equal(AsnManifest.WholeExportKey, transactions.NotesKey);

        // And that is not a claim about the manifest alone: what comes back
        // carries the same one type.
        using var ctx = Context();

        var result = await new AsnAdapter(Options).FetchAsync(
            ctx, Ready(), new ResourceRequest { ResourceId = BankResources.Accounts }, CancellationToken.None);

        Assert.All(result.Accounts, a => Assert.Equal(AccountType.Current, a.Type));
    }

    /// <summary>
    /// AN EXPORT SHORT OF THE ACCOUNTS ON OFFER IS REFUSED.
    /// </summary>
    /// <remarks>
    /// This is the check the first working fetch went without, and it went
    /// without it for the usual reason: every step looked like it had worked.
    /// The dialog said "Alles selecteren (3)", the select-all was clicked, a
    /// file came back, it parsed, every balance in it reconciled to the cent -
    /// and ONE account was handed back as a complete answer. Nothing in that
    /// chain can notice two missing accounts, because each link only checks
    /// itself.
    /// <para>
    /// The bank's own count is the outside opinion that makes it noticeable,
    /// and it is a NUMBER: one checkbox per account, no name and no IBAN asked
    /// for.
    /// </para>
    /// </remarks>
    [Fact]
    public async Task An_export_that_missed_accounts_the_picker_offered_is_refused()
    {
        using var ctx = Context();

        var portal = Ready();

        // The bank offers three; the statement below carries one.
        portal.Counts[Options.AccountCheckboxSelectors[0]] = 3;

        var refused = await Assert.ThrowsAsync<ConnectorException>(
            () => new AsnAdapter(Options).FetchAsync(ctx, portal, Transactions(), CancellationToken.None));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("offered 3 account(s)", refused.Message, StringComparison.Ordinal);
        Assert.Contains("came back with 1", refused.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// THE DIALOG IS CONFIRMED, WHICH IS NOT THE SAME AS CLOSED.
    /// </summary>
    /// <remarks>
    /// An X dismisses a dialog; on this design system that is not agreeing with
    /// it. The first export to reach the end selected all three accounts,
    /// pressed the X, and downloaded the one account the form defaults to.
    /// </remarks>
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

        // AND THE BANK'S LABEL CARRIES A COUNT THE ADAPTER CANNOT KNOW, so the
        // match is a prefix - the same trap as the select-all beside it.
        Assert.NotEqual(RenderedConfirm, Options.AccountConfirmLabels[0]);
        Assert.StartsWith(Options.AccountConfirmLabels[0], RenderedConfirm, StringComparison.Ordinal);
    }

    /// <summary>
    /// AND IF NOTHING CONFIRMS IT, THE RUN CARRIES THE DIALOG'S SHAPE OUT.
    /// </summary>
    /// <remarks>
    /// The real confirm has never been seen: the shape probe capped its button
    /// list at twelve and the one capture of this dialog held exactly twelve,
    /// so anything after "Alles selecteren (3)" was cut off. Until a run says
    /// what is actually in there, the candidate list is guesswork - so a run
    /// where none of them lands is made to answer the question.
    /// </remarks>
    [Fact]
    public async Task A_picker_that_nothing_confirmed_reports_what_was_in_it()
    {
        using var ctx = Context();

        var portal = Ready();
        portal.Shape = "at: https://www.asnbank.nl/x | buttons: button[data-testid='button'] \"Gereed\"";

        // The candidate list is emptied rather than the label removed, because
        // "Opslaan" is ALSO the format dialog's save - the same word confirming
        // two different dialogs on one form. Taking it out of the page would
        // break a later step and prove nothing about this one.
        await new AsnAdapter(Options with { AccountConfirmLabels = [] })
            .FetchAsync(ctx, portal, Transactions(), CancellationToken.None);

        Assert.Contains(
            ctx.Notes,
            n => n.Contains("confirmed the account picker", StringComparison.Ordinal)
                 && n.Contains("Gereed", StringComparison.Ordinal));

        // AND IT GUESSES AT NOTHING. A run once pressed the dialog's last
        // button on the reasoning that a primary action sits there; on this
        // dialog that is "Selectie wissen", which CLEARS the selection. A wrong
        // button here does not merely fail to help - it undoes the step before
        // it, so the dialog is closed and the count check reports the truth.
        Assert.DoesNotContain(
            portal.Calls,
            c => c.StartsWith($"click:{Options.AccountPickerFallbackSelectors[0]}#", StringComparison.Ordinal));

        Assert.Contains(portal.Calls, c => c == $"click:{Options.ModalCloseSelectors[0]}");
    }

    /// <summary>
    /// And that guess is only safe because the count check catches it.
    /// </summary>
    /// <remarks>
    /// Pressing an unseen button might press Cancel. What makes that acceptable
    /// rather than reckless is the check at the end of the export: fewer
    /// statements than the dialog offered is refused, so a wrong guess produces
    /// the failure that was already happening rather than a short account list
    /// presented as whole.
    /// </remarks>
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

    /// <summary>
    /// A RADIO THAT REFUSES TO BE SET IS PRESSED BY ITS BOX, not given up on.
    /// </summary>
    /// <remarks>
    /// The live fetch reported "the format modal has no radio at index 2"
    /// against a modal the shape probe could see five radios in. The radio was
    /// there; Playwright would not act on it, because de Volksbank styles a
    /// label and parks the real input behind it - the same thing that hid the
    /// account select. An unreachable control and an absent one produce exactly
    /// the same miss, which is why the ladder exists.
    /// </remarks>
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

        // And the run says which way each control had to be worked, because the
        // answer differs per control on this bank.
        Assert.Contains(
            ctx.Notes,
            n => n.Contains("CAMT.053 was set by the box around it", StringComparison.Ordinal));
    }

    /// <summary>
    /// THE FORMAT DIALOG IS CHECKED TO HAVE OPENED, like the account one.
    /// </summary>
    /// <remarks>
    /// This form carries three modals and every step means something different
    /// depending on which is up - a date typed while the format modal is open
    /// goes into the format modal.
    /// </remarks>
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

    /// <summary>
    /// AND THE NO-ZIP BOX IS REQUIRED, because the file arrives wrong without it.
    /// </summary>
    /// <remarks>
    /// It was best effort, which is the wrong shape for a control that decides
    /// WHICH FILE turns up. ASN zips by default, so a miss here sends an archive
    /// where XML is expected, and that surfaces as the parser refusing the
    /// export - which reads like the bank having changed its format rather than
    /// like a box this connector failed to tick.
    /// <para>
    /// The message names the likelier cause. That box only appears once a
    /// format is chosen, so its absence is evidence about the radio.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// A SAVE THAT MISSED IS A FORMAT THAT WAS NEVER APPLIED.
    /// </summary>
    /// <remarks>
    /// Also best effort until now. A missed "Opslaan" leaves the modal's choice
    /// unapplied and downloads whatever format was last saved - on a fresh
    /// session a PDF, which reaches a CAMT parser and reads as the bank having
    /// changed its export.
    /// </remarks>
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

    /// <summary>
    /// AN EXPORT THAT CANNOT TAKE EVERY ACCOUNT REFUSES, rather than taking some.
    /// </summary>
    /// <remarks>
    /// This click used to be best-effort. A miss would have gone on to download
    /// whatever ASN happened to have ticked and return it with
    /// <c>Complete = true</c> - a partial set of somebody's accounts, published
    /// as the whole set. That is the failure nobody can see from the outside,
    /// which makes it the one worth failing loudly for.
    /// </remarks>
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

        // And nothing was downloaded, because there was nothing safe to download.
        Assert.DoesNotContain(portal.Calls, c => c.StartsWith("download:", StringComparison.Ordinal));
    }

    /// <summary>
    /// A FAILED FETCH SAYS WHAT THE PAGE LOOKED LIKE, exactly as the login does.
    /// </summary>
    /// <remarks>
    /// The login half carried this from its first live failure and the fetch
    /// half did not, so when the export broke against a real account all the
    /// caller got was "something broke on our side" - while the agent's own log
    /// held the label it had been hunting for. A fetch is no more repeatable
    /// with more logging turned on than a sign-in is.
    /// </remarks>
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

    /// <summary>
    /// Accounts come out of the same download, because there is no list to read.
    /// </summary>
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

    // ---- signing out -------------------------------------------------------

    /// <summary>
    /// ASN's signed-in page, as a logout job actually finds it.
    /// </summary>
    /// <remarks>
    /// Nowhere yet, because a logout job's browser has been nowhere; and the
    /// sign-out BEHIND A MENU, because at the phone width the agent emulates
    /// ASN's header is collapsed. Both sign-out tests below used to hold the
    /// button from the start, which is a page no account holder has ever seen -
    /// and it let a sign-out that has never once worked pass twice.
    /// <para>
    /// Behind the SECOND header control rather than the first, so a search that
    /// stops at the first thing it presses fails here. A live disconnect
    /// already proved the obvious candidate wrong once: the hamburger opens the
    /// navigation menu, which holds "Overzicht", "Zelf regelen" and "Contact"
    /// and no sign-out at all.
    /// </para>
    /// </remarks>
    private static StubAsnPortal SignOutPage()
    {
        var portal = StubAsnPortal.Blank();

        // POSITIONED BY THE ORDER THE ADAPTER TRIES, not by a fixed index, so
        // this keeps testing the ladder rather than one arrangement of ASN's
        // header: the first thing tried opens a panel over the page, and the
        // second is the one that works.
        var first = Options.SignOutMenuIndexes[0];
        var second = Options.SignOutMenuIndexes[1];

        var buttons = Enumerable.Range(0, Math.Max(first, second) + 2)
            .Select(i => $"something else {i}")
            .ToArray();

        // Named for what they DO here rather than for ASN's own controls: the
        // point is the ladder, and which of the bank's two header buttons is
        // which is AsnOptions' business, not this fixture's.
        buttons[first] = "a control that opens a panel";
        buttons[second] = "the control holding the sign-out";

        portal.ButtonsInOrder.AddRange(buttons);

        // BY THE CONTROL, not by the index it happens to sit at.
        portal.RevealsLabel["press:the control holding the sign-out"] = Options.SignOutLabel;

        // AND THE FIRST RUNG OPENS SOMETHING OVER THE TOP, which is what ASN's
        // search control actually does: a panel reading "Veel gebruikte links".
        // A positional handle then counts the PANEL's buttons, so a ladder that
        // does not go back to the page first presses the second thing inside
        // the panel.
        portal.Covers["press:a control that opens a panel"] =
            ["the search box", "a suggested link", "another suggested link"];

        return portal;
    }

    /// <summary>
    /// A SIGN-OUT IS CONFIRMED BY WHERE IT LANDS, never by having been clicked.
    /// </summary>
    /// <remarks>
    /// A logout that silently does nothing is a failure this platform has
    /// already shipped once, on ING, and spent a week finding.
    /// </remarks>
    [Fact]
    public async Task Signing_out_is_confirmed_by_the_page_it_reaches()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.ArrivesAt = "https://www.asnbank.nl/asn-app-en-asn-online-bankieren/uitgelogd.html";

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("signed out upstream", StringComparison.Ordinal));
    }

    /// <summary>
    /// THE SIGN-OUT GOES TO ASN'S PAGE BEFORE LOOKING FOR ASN'S BUTTON.
    /// </summary>
    /// <remarks>
    /// A logout job opens a browser that has been nowhere. Without a
    /// navigation the "Uitloggen" hunt runs against about:blank and finds
    /// nothing, and the run then reports "no sign-out button was on the page" -
    /// blaming the bank for a page nobody asked it for. That is exactly what a
    /// live disconnect reported, and ING's adapter has carried the fix for this
    /// since its own version of the same failure.
    /// <para>
    /// Both existing sign-out tests passed over it, because their fixture had
    /// the button before it had been anywhere.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// A DISCONNECT CARRYING NO SESSION LAUNCHES NOTHING.
    /// </summary>
    /// <remarks>
    /// Opening the page IS resuming the session - the lease is built from the
    /// job's own cookie jar - so with no jar this would start Chromium to visit
    /// a bank as a stranger, and then report the sign-in page's lack of a
    /// sign-out button as a failure.
    /// </remarks>
    [Fact]
    public async Task A_disconnect_with_no_stored_session_does_not_open_a_browser()
    {
        using var ctx = Context();

        // The lease REFUSES to hand out a page - "this test drives the page
        // through the adapter's seam and must not start a browser" - so
        // reaching the end of this call is itself the assertion that no
        // browser was launched. Asserting on the lease's Started flag would
        // not have been: it is a fixed true and records nothing.
        await new AsnAdapter(Options).LogoutAsync(ctx, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("nothing to sign out", StringComparison.Ordinal));
    }

    /// <summary>
    /// And a click that went nowhere says so, rather than claiming a sign-out.
    /// </summary>
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

    /// <summary>
    /// THE SIGN-OUT KEEPS LOOKING UNTIL THE BUTTON IS ACTUALLY THERE.
    /// </summary>
    /// <remarks>
    /// The bug a live disconnect kept reporting. The agent emulates a phone,
    /// where ASN's header is collapsed, so the sign-out is not rendered until
    /// something opens the menu holding it - and the hunt for it spent its ten
    /// seconds and then reported ASN as having no sign-out.
    /// <para>
    /// The first fix opened the hamburger, which was the obvious candidate and
    /// the wrong one: that menu holds "Overzicht", "Zelf regelen" and
    /// "Contact". So a rung is judged by whether the SIGN-OUT appeared, never
    /// by whether the press landed - the fixture reveals it from the second
    /// header control, and a search that stops at the first thing it presses
    /// fails here.
    /// </para>
    /// </remarks>
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

        // AND THE NOTE SAYS WHICH ROUTE WORKED. Three live sign-outs were spent
        // finding out which of ASN's unnamed header controls holds the button,
        // and the run that finally worked recorded nothing but "signed out
        // upstream" - so the next person to ask has to buy the answer again.
        Assert.Contains(
            ctx.Notes,
            n => n.Contains("signed out upstream", StringComparison.Ordinal)
                 && n.Contains($"header control {index}", StringComparison.Ordinal));
    }

    /// <summary>
    /// A BUTTON ALREADY ON THE PAGE IS NOT HUNTED FOR IN MENUS.
    /// </summary>
    /// <remarks>
    /// A wider viewport shows ASN's header outright, and de Volksbank serves
    /// SNS, RegioBank and BLG Wonen from these same pages - so "collapsed
    /// behind a menu" is this agent's phone emulation rather than a fact about
    /// the bank. Pressing header controls to reveal something already visible
    /// is a press on somebody's bank for nothing.
    /// </remarks>
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

    /// <summary>
    /// AND IT ASKS BEFORE IT PRESSES, or the search cannot be afforded.
    /// </summary>
    /// <remarks>
    /// A click that finds nothing spends ten seconds first. A search over three
    /// candidates that CLICKED for each would cost half a minute of nothing
    /// happening - which on a failed job is longer than the courtesy sign-out
    /// is allowed, so it would be cancelled mid-hunt and report nothing at all.
    /// <para>
    /// So each rung asks whether the button is there and presses only what that
    /// answers for. The count is the assertion: one press per candidate, not
    /// one press per candidate plus a hopeful click.
    /// </para>
    /// </remarks>
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

    /// <summary>
    /// A SESSION THAT HAS ALREADY ENDED IS NOT A MISSING BUTTON.
    /// </summary>
    /// <remarks>
    /// ASN answers a signed-in address with its sign-in page once the session
    /// is gone, and that page has no sign-out on it - correctly. Reporting that
    /// as "no 'Uitloggen' button was on the page" reads as a broken adapter,
    /// when it is the bank saying the work is already done.
    /// </remarks>
    [Fact]
    public async Task A_session_that_had_already_ended_is_not_reported_as_a_missing_button()
    {
        using var ctx = Context();

        var portal = SignOutPage();
        portal.RedirectsTo = Options.LoginUrl;

        await new AsnAdapter(Options).LogoutAsync(ctx, portal, CancellationToken.None);

        Assert.Contains(ctx.Notes, n => n.Contains("had already ended", StringComparison.Ordinal));
        Assert.DoesNotContain(ctx.Notes, n => n.Contains("left to expire", StringComparison.Ordinal));

        // And it stops there rather than pressing whatever the sign-in page
        // does have on it.
        Assert.Equal(-1, Step(portal, $"click:{Options.SignOutMenuSelectors[0]}#0"));
    }

    /// <summary>
    /// And a sign-out that could not find its button says what WAS there.
    /// </summary>
    /// <remarks>
    /// A sign-out failure cannot be reproduced: the next attempt needs a fresh
    /// code, and by then the session it was meant to end has expired on its
    /// own. So the diagnosis has to travel with the first failure, exactly as
    /// it does on the sign-in path - which is how this bug was found rather
    /// than guessed at.
    /// </remarks>
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
