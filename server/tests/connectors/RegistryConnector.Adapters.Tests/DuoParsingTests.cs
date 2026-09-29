using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

/// <summary>
/// What DUO says you owe, read off recorded payloads.
///
/// The fixtures are the real shapes from a live authenticated session on
/// 2026-08-10, with the amounts changed. What is NOT changed is the notation -
/// including the zeros, which DUO writes as <c>0E-8</c> because its API is a
/// Java BigDecimal on the wire. Seven of the eight components are zero for
/// almost everybody, so a reader that could not take that notation would fail
/// on nearly every account rather than on an unlucky one.
/// </summary>
public sealed class DuoParsingTests
{
    private static readonly DuoOptions Options = new();

    /// <summary>
    /// A day inside the second rate window of the fixture, and the day the
    /// capture was taken. Fixed, because "the rate in force today" is a
    /// function of the day and a test that read the clock would pass until
    /// 1 January 2030 and then fail.
    /// </summary>
    private static readonly DateOnly Today = new(2026, 8, 10);

    private const string Session = "ses_duo_fixture";

    private static string Amounts => Fixture.Read("duo/mijn-schulden.json");

    private static string Positions => Fixture.Read("duo/schulden.json");

    private static string Holiday => Fixture.Read("duo/resterend-aantal-maanden-aflosvrij.json");

    private static StudentDebt Read(
        string? amounts = null, string? positions = null, string? holiday = null, DateOnly? today = null) =>
        DuoDebtReader.Read(
            amounts ?? Amounts,
            positions ?? Positions,
            holiday ?? Holiday,
            today ?? Today,
            Options,
            Session);

    [Fact]
    public void The_amounts_are_euros_and_the_components_are_named()
    {
        var debt = Read();

        // 12345.67 + 89.10, in minor units. Asserted by value rather than by
        // recomputing the sum here, which would only prove the test can
        // multiply.
        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Equal("EUR", debt.Total.Currency);

        Assert.Collection(
            debt.Components,
            loan =>
            {
                Assert.Equal(StudentDebtKind.Loan, loan.Kind);
                Assert.Equal("schuldbedragLening", loan.SourceField);
                Assert.Equal(1_234_567, loan.Amount.Value);
            },
            ov =>
            {
                Assert.Equal(StudentDebtKind.PublicTransport, ov.Kind);
                Assert.Equal("schuldbedragOVSchuld", ov.SourceField);
                Assert.Equal(8_910, ov.Amount.Value);
            });
    }

    /// <summary>
    /// The notation that would have broken this on almost every account.
    ///
    /// DUO writes zero as <c>0E-8</c>. That is a legal JSON number and reads
    /// as a decimal, but it does NOT parse under the style
    /// <see cref="MoneyParser"/> uses for strings - which deliberately refuses
    /// exponents - so a reader that took the raw text and handed it to the
    /// money parser would throw on seven of the eight fields.
    /// </summary>
    [Fact]
    public void A_zero_in_scientific_notation_is_read_as_zero()
    {
        const string Json = """
        {"schuldbedragLening":100.00000000,"schuldbedragOVSchuld":0E-8,"schuldbedragPrestatiebeurs":0E-8}
        """;

        var debt = Read(amounts: Json);

        Assert.Equal(10_000, debt.Total.Value);
        Assert.Equal(StudentDebtKind.Loan, Assert.Single(debt.Components).Kind);

        // And the route not taken, asserted so the reason the reader works the
        // way it does cannot be quietly removed by somebody tidying it up.
        Assert.Throws<ConnectorException>(() => MoneyParser.ToMinor("0E-8", MoneyUnit.MajorDecimal));
    }

    [Fact]
    public void The_zero_components_are_dropped_from_the_breakdown_but_not_from_the_total()
    {
        var debt = Read();

        // DUO publishes all eight fields for everybody. Keeping the six zeros
        // would bury the two lines that say something.
        Assert.Equal(2, debt.Components.Count);
        Assert.DoesNotContain(debt.Components, c => c.Amount.Value == 0);

        // Dropping them changed nothing about what is owed.
        Assert.Equal(debt.Components.Sum(c => c.Amount.Value), debt.Total.Value);
    }

    /// <summary>
    /// DUO states the components and no total anywhere. The figure its own
    /// portal prints is summed in the browser out of the customer dossier, so
    /// ours is a sum too - and a consumer has to be told that rather than
    /// shown a number that looks like DUO's own.
    /// </summary>
    [Fact]
    public void The_total_is_ours_and_the_record_says_so()
    {
        Assert.True(Read().TotalIsDerived);
    }

    [Fact]
    public void A_component_duo_adds_later_still_reaches_the_user()
    {
        const string Json = """
        {"schuldbedragLening":50.00000000,"schuldbedragIetsNieuws":25.00000000}
        """;

        var debt = Read(amounts: Json);

        var unknown = Assert.Single(debt.Components, c => c.Kind == StudentDebtKind.Other);

        // Named, and counted. A component silently dropped from the total is a
        // figure somebody compares against a letter from DUO and cannot
        // reconcile.
        Assert.Equal("schuldbedragIetsNieuws", unknown.SourceField);
        Assert.Equal(2_500, unknown.Amount.Value);
        Assert.Equal(7_500, debt.Total.Value);
    }

    /// <summary>
    /// A DEBT THAT STOPPED BEING A NUMBER IS A HOLE IN THE TOTAL.
    /// </summary>
    /// <remarks>
    /// The reader skipped anything that was not a JSON number, without a word.
    /// The remaining seven fields still summed, the ledger check compares that
    /// sum against a total built from the same fields, and what came back was a
    /// complete-looking statement of somebody's debt that was short by a whole
    /// component - the kind of figure that gets compared against a letter from
    /// DUO and cannot be reconciled.
    /// <para>
    /// A serialiser change is all it would take: <c>"25.00"</c> instead of
    /// <c>25.00000000</c> is still valid JSON and still the right amount.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_debt_amount_that_is_no_longer_a_number_fails_rather_than_going_missing()
    {
        var refused = Assert.Throws<ConnectorException>(() => Read(amounts:
            """{"schuldbedragLening":50.00000000,"schuldbedragOVSchuld":"25.00"}"""));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("schuldbedragOVSchuld", refused.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// And anything else DUO adds is REPORTED rather than passed over.
    /// </summary>
    /// <remarks>
    /// Told apart by DUO's own vocabulary: every amount in that object is
    /// <c>schuldbedrag*</c>, so one that is not a number is a missing debt and
    /// fails the fetch, while a field named anything else is metadata this
    /// connector does not read - worth saying once, not worth refusing an
    /// account over.
    /// </remarks>
    [Fact]
    public void A_field_that_is_not_an_amount_at_all_is_named_rather_than_passed_over()
    {
        var notes = new List<string>();

        var debt = DuoDebtReader.Read(
            """{"schuldbedragLening":50.00000000,"peildatum":"2026-08-10"}""",
            Positions,
            Holiday,
            Today,
            Options,
            Session,
            note: notes.Add);

        Assert.Equal(5_000, debt.Total.Value);
        Assert.Contains(notes, n => n.Contains("peildatum", StringComparison.Ordinal));
    }

    /// <summary>
    /// AND IT SAYS NOTHING ON A REAL ACCOUNT, which is what makes it readable.
    /// </summary>
    /// <remarks>
    /// A note on every fetch is a note nobody reads, and this one exists to be
    /// noticed exactly once - the day DUO's payload grows a field. The live
    /// capture is eight numbers and nothing else, so it stays silent.
    /// </remarks>
    [Fact]
    public void The_real_payload_produces_no_note_at_all()
    {
        var notes = new List<string>();

        DuoDebtReader.Read(Amounts, Positions, Holiday, Today, Options, Session, note: notes.Add);

        Assert.Empty(notes);
    }

    // ---- where the debt is, and what it costs -------------------------------

    [Fact]
    public void The_phase_is_the_mapped_value_and_duos_own_word_beside_it()
    {
        var debt = Read();

        Assert.Equal(StudentDebtPhase.Repaying, debt.Phase);
        Assert.Equal("TERUGBETAALPERIODE", debt.PhaseLabel);
    }

    [Fact]
    public void A_status_this_connector_does_not_know_still_reaches_the_user()
    {
        const string Json = """[{"statusSchuld":"IETS_NIEUWS","rentepercentagePeriodes":[]}]""";

        var debt = Read(positions: Json);

        Assert.Equal(StudentDebtPhase.Unknown, debt.Phase);
        Assert.Equal("IETS_NIEUWS", debt.PhaseLabel);
    }

    /// <summary>
    /// DUO's own rule, from its <c>mijn-schulden-opbouw-mapper</c>: the period
    /// whose window contains the day.
    /// </summary>
    [Theory]
    [InlineData(2026, 8, 10, "2.57")]
    [InlineData(2024, 6, 1, "0.00")]
    [InlineData(2025, 1, 1, "2.57")]
    [InlineData(2024, 12, 31, "0.00")]
    public void The_rate_reported_is_the_one_in_force_that_day(int year, int month, int day, string expected)
    {
        var debt = Read(today: new DateOnly(year, month, day));

        Assert.Equal(decimal.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), debt.InterestRate);
        Assert.Equal("SF35", debt.InterestRegime);
    }

    [Fact]
    public void A_day_outside_every_window_states_no_rate_but_keeps_the_windows()
    {
        var debt = Read(today: new DateOnly(2031, 1, 1));

        Assert.Null(debt.InterestRate);
        Assert.Null(debt.InterestRegime);

        // Nothing is lost by refusing to name a current rate: both windows are
        // still carried, so a consumer can say what the rate WAS and what it
        // is due to become.
        Assert.Equal(2, debt.InterestPeriods.Count);
    }

    [Fact]
    public void Every_rate_window_is_carried_whole()
    {
        var debt = Read();

        Assert.Collection(
            debt.InterestPeriods,
            past =>
            {
                Assert.Equal("SF35", past.Regime);
                Assert.Equal(new DateOnly(2020, 1, 1), past.StartsOn);
                Assert.Equal(new DateOnly(2024, 12, 31), past.EndsOn);
                Assert.Equal(0.00m, past.Rate);
            },
            now =>
            {
                Assert.Equal(new DateOnly(2025, 1, 1), now.StartsOn);
                Assert.Equal(new DateOnly(2029, 12, 31), now.EndsOn);
                Assert.Equal(2.57m, now.Rate);
            });
    }

    /// <summary>
    /// Somebody repaying a loan while drawing lifelong-learning credit is in
    /// two phases at once, at two different rates. DUO's amounts carry no key
    /// back to the position they belong to, so there is nothing to break the
    /// tie with - and picking the first would put a confident single word on a
    /// position this connector cannot resolve.
    /// </summary>
    [Fact]
    public void Two_positions_that_disagree_produce_no_single_phase_or_rate()
    {
        var debt = Read(positions: Fixture.Read("duo/schulden-two-positions.json"));

        Assert.Equal(StudentDebtPhase.Mixed, debt.Phase);
        Assert.Equal("TERUGBETAALPERIODE, OPBOUW_LLLK", debt.PhaseLabel);

        Assert.Null(debt.InterestRate);
        Assert.Null(debt.InterestRegime);

        // And both rates survive, so the answer is "there are two" rather than
        // "there is none".
        Assert.Equal([2.57m, 1.78m], debt.InterestPeriods.Select(p => p.Rate));
        Assert.Equal(["SF35", "LLLK"], debt.InterestPeriods.Select(p => p.Regime));
    }

    [Fact]
    public void Two_positions_that_agree_are_still_one_answer()
    {
        const string Json = """
        [{"statusSchuld":"TERUGBETAALPERIODE","rentepercentagePeriodes":[
            {"vorderingsregime":"SF35","startdatum":"2025-01-01","einddatum":"2029-12-31","rentepercentage":2.57}]},
         {"statusSchuld":"TERUGBETAALPERIODE","rentepercentagePeriodes":[
            {"vorderingsregime":"SF35","startdatum":"2025-01-01","einddatum":"2029-12-31","rentepercentage":2.57}]}]
        """;

        var debt = Read(positions: Json);

        Assert.Equal(StudentDebtPhase.Repaying, debt.Phase);
        Assert.Equal(2.57m, debt.InterestRate);
    }

    [Fact]
    public void The_payment_holiday_is_read_as_a_count_of_months()
    {
        Assert.Equal(60, Read().PaymentHolidayMonthsRemaining);
    }

    /// <summary>
    /// Enrichment is allowed to be missing. Every fetch here costs a human a
    /// DigiD sign-in, so losing a balance over an interest rate would be an
    /// expensive way to say less.
    /// </summary>
    [Fact]
    public void Missing_extras_cost_the_extras_and_never_the_balance()
    {
        // Straight to the reader, because the helper above reads a null as
        // "use the fixture" - which is exactly the absence being tested here.
        var debt = DuoDebtReader.Read(Amounts, null, null, Today, Options, Session);

        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Equal(2, debt.Components.Count);

        Assert.Equal(StudentDebtPhase.Unknown, debt.Phase);
        Assert.Null(debt.PhaseLabel);
        Assert.Null(debt.InterestRate);
        Assert.Empty(debt.InterestPeriods);
        Assert.Null(debt.PaymentHolidayMonthsRemaining);
    }

    // ---- refusals -----------------------------------------------------------

    [Fact]
    public void A_payload_with_no_amounts_at_all_is_a_changed_provider()
    {
        var error = Assert.Throws<ConnectorException>(() => Read(amounts: "{}"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public void An_answer_that_is_not_json_is_a_changed_provider()
    {
        var error = Assert.Throws<ConnectorException>(() => Read(amounts: "<html><body>Inloggen</body></html>"));

        Assert.Equal(ErrorCode.ProviderChanged, error.Code);
    }

    [Fact]
    public void An_empty_answer_is_a_changed_provider()
    {
        Assert.Equal(
            ErrorCode.ProviderChanged,
            Assert.Throws<ConnectorException>(() => Read(amounts: "  ")).Code);
    }

    // ---- identity -----------------------------------------------------------

    /// <summary>
    /// A singleton standing position, so the external id is a constant: every
    /// sync updates the same row rather than adding one. With
    /// <c>(session_id, external_id)</c> uniqueness that is what makes a retry
    /// free.
    /// </summary>
    [Fact]
    public void The_record_is_the_same_row_on_every_sync()
    {
        Assert.Equal(DuoAdapter.DebtResource, Read().ExternalId);
        Assert.Equal(Read().Id, Read().Id);

        Assert.StartsWith("sdt_", Read().Id, StringComparison.Ordinal);
    }

    [Fact]
    public void The_content_hash_moves_with_the_breakdown_and_not_only_the_total()
    {
        // Same total, different debts. An ov-schuld appearing as a loan shrinks
        // by the same amount is somebody's travel product having gone
        // unstopped, and a hash keyed on the total alone would call that no
        // change at all.
        var loan = Read(amounts: """{"schuldbedragLening":100.00000000,"schuldbedragOVSchuld":0E-8}""");
        var split = Read(amounts: """{"schuldbedragLening":40.00000000,"schuldbedragOVSchuld":60.00000000}""");

        Assert.Equal(loan.Total.Value, split.Total.Value);
        Assert.NotEqual(loan.ContentHash, split.ContentHash);

        Assert.StartsWith("sha256:", loan.ContentHash, StringComparison.Ordinal);
    }

    [Fact]
    public void An_unchanged_position_hashes_the_same_twice()
    {
        Assert.Equal(Read().ContentHash, Read().ContentHash);
    }

    // ---- what DUO has stated, and when ---------------------------------------

    private static string History => Fixture.Read("duo/schuldhistorie.json");

    private static StudentDebt WithHistory(string? history = null, string? grondslag = null) =>
        DuoDebtReader.Read(
            Amounts, Positions, Holiday, Today, Options, Session,
            history ?? History,
            grondslag ?? Fixture.Read("duo/grondslaggegevens.json"));

    /// <summary>
    /// THE CORRECTION, and the test that used to assert the opposite.
    ///
    /// This record shipped with NO as-of date and a long argument for why it
    /// could never have one: the date lived only inside DUO's 2.5 MB customer
    /// dossier, so a minimal-custody connector could not reach it. The evidence
    /// was two live captures in which no narrow endpoint carried it.
    ///
    /// Both captures recorded only the pages the account holder happened to
    /// open, and nobody had opened "Mijn schuldhistorie". "Every narrow
    /// endpoint was checked" was true of the endpoints that had been SEEN and
    /// was written as though it were true of the endpoints that EXIST. A third
    /// capture, aimed at the pages nobody had visited, found it in 5.6 KB with
    /// no BSN, no parents and no income anywhere in it.
    /// </summary>
    [Fact]
    public void The_as_of_date_is_the_one_duo_calculated_interest_to()
    {
        Assert.Equal(new DateOnly(2026, 8, 1), WithHistory().AsOf);
    }

    /// <summary>
    /// And it comes off the CURRENT balance, not the first entry that happens
    /// to carry a date. A year-end balance is dated by its year and a phase by
    /// its start, so taking whichever came first would stamp today's figure
    /// with somebody else's moment.
    /// </summary>
    [Fact]
    public void The_as_of_date_is_never_taken_from_a_historical_entry()
    {
        const string Json = """
        {"saldoStudieschulds":[
          {"@type":"SaldoStartAflosfase","beginDatumAflosfase":"2022-01-01","saldoInclusiefRente":25000.00},
          {"@type":"SaldoActueel","renteBerekendTot":"2026-08-01","saldoInclusiefRente":12434.77}]}
        """;

        Assert.Equal(new DateOnly(2026, 8, 1), WithHistory(history: Json).AsOf);
    }

    /// <summary>
    /// A NUMBER DUO SENDS AS NULL COSTS THAT FIELD, NEVER THE WHOLE RECORD.
    /// </summary>
    /// <remarks>
    /// <c>TryGetInt32</c> THROWS on an element that is not a number rather than
    /// returning false - the <c>Try</c> is only about the conversion, never
    /// about the kind - and an <see cref="InvalidOperationException"/> is not a
    /// <see cref="JsonException"/>, so it went straight past every catch on the
    /// way out and arrived as <c>internal</c>.
    /// <para>
    /// The shape is not hypothetical: DUO's own recorded fixtures carry
    /// explicit nulls on number-typed fields, <c>gevraagdTermijnbedrag</c> and
    /// <c>berekendTermijnbedrag</c> among them. What it cost was the entire
    /// debt - including the balance that had already arrived - over one
    /// enrichment field, and a fresh DigiD sign-in to try again.
    /// </para>
    /// </remarks>
    [Fact]
    public void A_number_duo_sends_as_null_costs_that_field_and_nothing_else()
    {
        const string Json = """
        {"saldoStudieschulds":[
          {"@type":"SaldoEindeKalenderjaar","jaar":null,"saldoInclusiefRente":25000.00},
          {"@type":"SaldoActueel","renteBerekendTot":"2026-08-01","saldoInclusiefRente":12434.77}]}
        """;

        var debt = WithHistory(history: Json);

        // The record survives, dated off the current balance as always.
        Assert.Equal(new DateOnly(2026, 8, 1), debt.AsOf);

        // And the entry is still there, simply without the year DUO declined
        // to state - which is what every other unreadable field here does.
        var yearEnd = Assert.Single(debt.History, b => b.Kind == StudentDebtBalanceKind.YearEnd);

        Assert.Null(yearEnd.Year);
        Assert.Equal(2_500_000, yearEnd.Amount.Value);
    }

    /// <summary>
    /// AND A WHOLE ENTRY DUO SENDS AS NULL COSTS THAT ENTRY.
    /// </summary>
    /// <remarks>
    /// The sibling of the case above and the one it did not cover: the field
    /// reads were guarded, and the walk over the list itself was not. Every
    /// accessor in this reader took the entry as its first argument, so a
    /// <c>null</c> in the array threw on whichever one ran first.
    /// <para>
    /// It survived the audit that found the other four because the guard it was
    /// missing sat one level up from the guards being hunted. What forbids it
    /// now is a rule rather than a fix -
    /// <c>Connector.Kit.Tests.Normalization.JsonReadRuleTests</c>.
    /// </para>
    /// </remarks>
    [Fact]
    public void An_entry_duo_sends_as_null_costs_that_entry_and_nothing_else()
    {
        const string Json = """
        {"saldoStudieschulds":[
          null,
          "not an entry",
          {"@type":"SaldoActueel","renteBerekendTot":"2026-08-01","saldoInclusiefRente":12434.77}]}
        """;

        var debt = WithHistory(history: Json);

        Assert.Equal(new DateOnly(2026, 8, 1), debt.AsOf);

        var current = Assert.Single(debt.History);

        Assert.Equal(StudentDebtBalanceKind.Current, current.Kind);
        Assert.Equal(1_243_477, current.Amount.Value);
    }

    [Fact]
    public void Without_the_history_endpoint_the_record_states_no_date()
    {
        // Which is what every build before this one did, on every account.
        // Null still means exactly what the missing field meant: nothing here
        // is dated, so do not show it as current.
        var debt = DuoDebtReader.Read(Amounts, Positions, Holiday, Today, Options, Session);

        Assert.Null(debt.AsOf);
        Assert.Empty(debt.History);
    }

    [Fact]
    public void Every_balance_duo_states_is_carried_with_its_moment()
    {
        var history = WithHistory().History;

        Assert.Equal(7, history.Count);

        var now = Assert.Single(history, h => h.Kind == StudentDebtBalanceKind.Current);
        Assert.Equal("SaldoActueel", now.KindLabel);
        Assert.Equal(1_243_477, now.Amount.Value);
        Assert.Equal(2_500, now.InterestPortion!.Value.Value);
        Assert.Equal(2.57m, now.Rate);

        // The figure the account holder wanted to ESTIMATE by reading a ledger
        // backwards. DUO states it outright.
        var start = Assert.Single(history, h => h.Kind == StudentDebtBalanceKind.RepaymentStart);
        Assert.Equal(2_500_000, start.Amount.Value);
        Assert.Equal(new DateOnly(2022, 1, 1), start.On);

        Assert.Equal(3, history.Count(h => h.Kind == StudentDebtBalanceKind.YearEnd));
        Assert.Equal(2025, history.First(h => h.Kind == StudentDebtBalanceKind.YearEnd).Year);
    }

    /// <summary>
    /// Newest first, with the current balance ahead of everything.
    ///
    /// DUO publishes these grouped by kind and, inside a group, in no order at
    /// all - a live fetch came back 2020, 2022, 2021, 2024, 2023, 2015, 2025,
    /// 2017, 2016, 2019, 2018. Elsewhere this connector preserves a provider's
    /// order religiously, because an order usually carries meaning. This one
    /// does not, and passing it through hands every consumer the same sorting
    /// job plus a good chance of somebody plotting a debt history that jumps
    /// backwards.
    /// </summary>
    [Fact]
    public void The_history_reads_as_a_timeline_rather_than_in_duos_order()
    {
        var history = WithHistory().History;

        Assert.Equal(StudentDebtBalanceKind.Current, history[0].Kind);

        var moments = history.Skip(1).Select(h => h.Year ?? h.On!.Value.Year).ToList();

        Assert.Equal(moments.OrderByDescending(y => y), moments);

        // The fixture's own jumble, ordered: 2025, 2024, 2022 (repayment
        // start), 2020 (both grace-period entries), 2015.
        Assert.Equal([2025, 2024, 2022, 2020, 2020, 2015], moments);
    }

    /// <summary>
    /// And entries that share a moment keep DUO's order, which is what holds
    /// the grace-period entries together in the sequence it listed them.
    /// </summary>
    [Fact]
    public void Balances_at_the_same_moment_keep_the_order_duo_listed_them_in()
    {
        var grace = WithHistory().History
            .Where(h => h.Kind == StudentDebtBalanceKind.GracePeriodStart)
            .Select(h => h.Label)
            .ToList();

        Assert.Equal(["Lening hbo of universiteit", "Prestatiebeurs mbo"], grace);
    }

    /// <summary>
    /// DUO names what each grace-period balance was FOR - a travel product, a
    /// tuition-fee loan - and those words are the account holder's own history.
    /// </summary>
    [Fact]
    public void A_balance_duo_labels_keeps_its_label()
    {
        var labelled = WithHistory().History
            .Where(h => h.Kind == StudentDebtBalanceKind.GracePeriodStart)
            .ToList();

        Assert.Equal(2, labelled.Count);
        Assert.Contains(labelled, h => h.Label == "Lening hbo of universiteit");
        Assert.All(labelled, h => Assert.Equal(new DateOnly(2020, 1, 1), h.On));
    }

    [Fact]
    public void A_moment_this_connector_does_not_know_still_reaches_the_user()
    {
        const string Json = """
        {"saldoStudieschulds":[{"@type":"SaldoIetsNieuws","saldoInclusiefRente":100.00}]}
        """;

        var stated = Assert.Single(WithHistory(history: Json).History);

        Assert.Equal(StudentDebtBalanceKind.Unknown, stated.Kind);
        Assert.Equal("SaldoIetsNieuws", stated.KindLabel);
        Assert.Equal(10_000, stated.Amount.Value);
    }

    /// <summary>
    /// The months-remaining figure lives in a JSON document nested inside a
    /// JSON string: <c>"waarde":"{\"value\":365}"</c>.
    /// </summary>
    [Fact]
    public void The_months_left_to_pay_are_read_out_of_the_nested_document()
    {
        Assert.Equal(365, WithHistory().RepaymentMonthsRemaining);
    }

    [Fact]
    public void A_figure_duo_says_it_cannot_determine_is_not_invented()
    {
        const string Json = """
        {"grondslaggegevenPeriodeWaardes":[
          {"definitieNaam":"RESTEREND_AANTAL_MAANDEN_AFLOSFASE","isNietTeBepalen":true,"waarde":"{\"value\":0}"}]}
        """;

        // "I cannot work this out" and "the answer is zero" are different
        // sentences, and DUO says which.
        Assert.Null(WithHistory(grondslag: Json).RepaymentMonthsRemaining);
    }

    /// <summary>
    /// The stated current balance is NOT used to check the total, however
    /// exactly the two match on this account.
    ///
    /// Every history entry carries `schuldtype: STUDIEFINANCIERING`, so the
    /// current one is the study-finance debt alone - while the eight component
    /// amounts also cover an ov-schuld, over-payments and lifelong-learning
    /// credit. On an account with only a loan they coincide, which is precisely
    /// how a reconciliation built on that coincidence would pass every test here
    /// and then contradict itself for somebody with a travel debt.
    /// </summary>
    [Fact]
    public void The_total_stays_the_sum_of_the_components_and_still_says_so()
    {
        var debt = WithHistory();

        Assert.True(debt.TotalIsDerived);
        Assert.Equal(debt.Components.Sum(c => c.Amount.Value), debt.Total.Value);
    }

    // ---- the ledger, out of the dossier -------------------------------------

    private static StudentDebt WithLedger() =>
        DuoDebtReader.Read(
            Amounts, Positions, Holiday, Today, Options, Session,
            Fixture.Read("duo/schuldhistorie.json"),
            Fixture.Read("duo/grondslaggegevens.json"),
            Fixture.Read("duo/klantbeeld-reduced.json"));

    /// <summary>
    /// The sign is DUO's own, not this connector's reading of a reason code.
    ///
    /// That mattered enormously. The obvious design was a table mapping
    /// nineteen Dutch reason codes to a direction, built by matching five of
    /// them against a screenshot - and a live payload settled it instead: 566
    /// of 1223 amounts are negative, so the direction is carried in the data
    /// and no such table needs to exist.
    /// </summary>
    [Fact]
    public void A_repayment_reduces_the_debt_and_interest_increases_it()
    {
        var ledger = WithLedger().Ledger;

        var repayment = Assert.Single(ledger, e => e.SourceCode == "ONTVANGST");
        Assert.Equal(-5_000, repayment.Amount.Value);
        Assert.Equal(StudentDebtEntryApplies.Principal, repayment.Applies);

        var interest = Assert.Single(ledger, e => e.SourceCode == "RENTE");
        Assert.Equal(2_500, interest.Amount.Value);
        Assert.Equal(StudentDebtEntryApplies.Interest, interest.Applies);

        // The €21k that vanished between 2019 and 2020: a performance grant
        // becoming a gift, which reduces a debt without anybody paying it.
        var gift = Assert.Single(ledger, e => e.SourceCode == "OMZETTING_NAAR_GIFT");
        Assert.Equal(-2_000_000, gift.Amount.Value);
    }

    /// <summary>
    /// Each movement names the debt it was booked against, in DUO's words.
    /// </summary>
    [Fact]
    public void A_movement_is_joined_to_the_debt_it_belongs_to()
    {
        var ledger = WithLedger().Ledger;

        Assert.Equal("Lening HO", Assert.Single(ledger, e => e.SourceCode == "RENTE").Debt);
        Assert.Equal("Collegegeldkrediet", Assert.Single(ledger, e => e.SourceCode == "UITGAVE").Debt);
    }

    [Fact]
    public void The_ledger_reads_newest_first()
    {
        var booked = WithLedger().Ledger.Select(e => e.BookedOn).ToList();

        Assert.Equal(booked.OrderByDescending(d => d), booked);
    }

    /// <summary>
    /// DUO's reason codes are carried verbatim rather than translated: it
    /// publishes its own words for them in its front-end, not in its API, so
    /// any prose here would be a table copied out of minified JavaScript.
    /// </summary>
    [Fact]
    public void The_providers_own_reason_code_is_carried_untranslated()
    {
        Assert.All(WithLedger().Ledger, e => Assert.Matches("^[A-Z_]+$", e.SourceCode));
    }

    [Fact]
    public void The_monthly_instalment_is_the_one_for_this_month()
    {
        var debt = WithLedger();

        // The fixture also holds a 2022 instalment at a different amount.
        // Picking "the most recent row" would answer with a future schedule;
        // picking by month answers what is owed now.
        Assert.Equal(5_000, debt.MonthlyAmount!.Value.Value);
        Assert.Equal(new DateOnly(2026, 8, 27), debt.NextPaymentDue);
    }

    /// <summary>
    /// Every movement the provider has ever booked should sum to what is owed
    /// now, and that is a free integrity check on the whole ledger.
    ///
    /// Not a hopeful invariant - it was measured. On a live account 1223
    /// movements spanning fifteen years summed to the current balance to the
    /// cent, and separately for each of the eight debts underneath. A
    /// truncated page of history, a dropped row or one flipped sign all break
    /// it, and none of those is visible any other way.
    /// </summary>
    [Fact]
    public void A_ledger_that_sums_to_the_balance_is_reported_as_reconciled()
    {
        var debt = WithLedger();

        Assert.Equal(debt.Total.Value, debt.Ledger.Sum(e => e.Amount.Value));
        Assert.True(debt.LedgerReconciled);
    }

    [Fact]
    public void A_ledger_missing_a_movement_is_reported_as_not_reconciled()
    {
        // One row removed, which is what a truncated history looks like. The
        // record is still emitted - the figures are still DUO's - and the flag
        // is how a consumer learns this connector could not prove them
        // consistent.
        var short_ = Fixture.Read("duo/klantbeeld-reduced.json")
            .Replace("""{"bedrag":25.00,"boekdatum":"2026-08-01","boekreden":"RENTE","id":9000000103,"mutatieType":"RENTE","vorderingid":9000000200},""", string.Empty, StringComparison.Ordinal);

        var debt = DuoDebtReader.Read(
            Amounts, Positions, Holiday, Today, Options, Session, History, null, short_);

        Assert.False(debt.LedgerReconciled);
        Assert.NotEmpty(debt.Ledger);
    }

    /// <summary>
    /// A check that was never made must not read as one that passed.
    /// </summary>
    [Fact]
    public void Without_a_ledger_no_reconciliation_is_claimed()
    {
        Assert.Null(WithHistory().LedgerReconciled);
    }

    [Fact]
    public void Without_the_dossier_there_is_no_ledger_and_no_instalment()
    {
        var debt = WithHistory();

        Assert.Empty(debt.Ledger);
        Assert.Null(debt.MonthlyAmount);
        Assert.Null(debt.NextPaymentDue);
    }

    [Fact]
    public void The_content_hash_moves_when_duo_recalculates_to_a_new_date()
    {
        // Same figures, new date. A consumer showing "as of 1 July" when the
        // provider now says 1 August is stale in exactly the way this field
        // exists to reveal, so the record has to read as changed.
        var july = WithHistory(history: History.Replace("2026-08-01", "2026-07-01", StringComparison.Ordinal));

        Assert.NotEqual(WithHistory().ContentHash, july.ContentHash);
    }
}
