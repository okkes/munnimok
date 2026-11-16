using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using RegistryConnector.Adapters.Duo;
using Xunit;

namespace RegistryConnector.Adapters.Tests;

// fixtures keep DUO's notation: zero is 0E-8 (Java BigDecimal on the wire),
// and seven of eight components are zero for most accounts
public sealed class DuoParsingTests
{
    private static readonly DuoOptions Options = new();

    // fixed day in the second rate window: a clock-reading test would fail once that window ends (2030)
    private static readonly DateOnly Today = new(2026, 8, 10);

    private const string Session = "ses_duo_fixture";

    private static string Amounts => Fixture.Read("duo/mijn-schulden.json");

    private static string Positions => Fixture.Read("duo/schulden.json");

    private static string Holiday => Fixture.Read("duo/resterend-aantal-maanden-aflosvrij.json");

    private static StudentDebt Read(
        string? amounts = null, string? positions = null, string? holiday = null, DateOnly? today = null) =>
        DuoDebtReader.Read(
            new DuoPayloads(amounts ?? Amounts, positions ?? Positions, holiday ?? Holiday),
            today ?? Today,
            Options,
            Session);

    [Fact]
    public void The_amounts_are_euros_and_the_components_are_named()
    {
        var debt = Read();

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

    // 0E-8 is a legal JSON number but MoneyParser deliberately refuses exponents, so raw text must not reach it
    [Fact]
    public void A_zero_in_scientific_notation_is_read_as_zero()
    {
        const string Json = """
        {"schuldbedragLening":100.00000000,"schuldbedragOVSchuld":0E-8,"schuldbedragPrestatiebeurs":0E-8}
        """;

        var debt = Read(amounts: Json);

        Assert.Equal(10_000, debt.Total.Value);
        Assert.Equal(StudentDebtKind.Loan, Assert.Single(debt.Components).Kind);

        Assert.Throws<ConnectorException>(() => MoneyParser.ToMinor("0E-8", MoneyUnit.MajorDecimal));
    }

    [Fact]
    public void The_zero_components_are_dropped_from_the_breakdown_but_not_from_the_total()
    {
        var debt = Read();

        // DUO publishes all eight fields for everybody; the six zeros would bury the two that say something
        Assert.Equal(2, debt.Components.Count);
        Assert.DoesNotContain(debt.Components, c => c.Amount.Value == 0);

        Assert.Equal(debt.Components.Sum(c => c.Amount.Value), debt.Total.Value);
    }

    // DUO states components and no total (its portal sums in the browser), so ours is derived and the record says so
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

        // a component dropped from the total is a figure that cannot be reconciled against a DUO letter
        Assert.Equal("schuldbedragIetsNieuws", unknown.SourceField);
        Assert.Equal(2_500, unknown.Amount.Value);
        Assert.Equal(7_500, debt.Total.Value);
    }

    // a non-number amount was once skipped silently: the other fields still summed, leaving a debt short a component.
    // a serialiser change suffices: "25.00" instead of 25.00000000 is still valid JSON
    [Fact]
    public void A_debt_amount_that_is_no_longer_a_number_fails_rather_than_going_missing()
    {
        var refused = Assert.Throws<ConnectorException>(() => Read(amounts:
            """{"schuldbedragLening":50.00000000,"schuldbedragOVSchuld":"25.00"}"""));

        Assert.Equal(ErrorCode.ProviderChanged, refused.Code);
        Assert.Contains("schuldbedragOVSchuld", refused.Message, StringComparison.Ordinal);
    }

    // every amount is schuldbedrag*: a non-number one is a missing debt and fails; any other field is metadata, noted once
    [Fact]
    public void A_field_that_is_not_an_amount_at_all_is_named_rather_than_passed_over()
    {
        var notes = new List<string>();

        var debt = DuoDebtReader.Read(
            new DuoPayloads(
                """{"schuldbedragLening":50.00000000,"peildatum":"2026-08-10"}""",
                Positions,
                Holiday),
            Today,
            Options,
            Session,
            note: notes.Add);

        Assert.Equal(5_000, debt.Total.Value);
        Assert.Contains(notes, n => n.Contains("peildatum", StringComparison.Ordinal));
    }

    // the note exists to be noticed once, when DUO's payload grows a field.
    // the live capture is eight numbers, so it stays silent
    [Fact]
    public void The_real_payload_produces_no_note_at_all()
    {
        var notes = new List<string>();

        DuoDebtReader.Read(new DuoPayloads(Amounts, Positions, Holiday), Today, Options, Session, note: notes.Add);

        Assert.Empty(notes);
    }

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

    // DUO's own rule (its mijn-schulden-opbouw-mapper): the period whose window contains the day
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

        // both windows are still carried, so a consumer can say what the rate was and will become
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

    // DUO's amounts carry no key back to a position, so picking one of two disagreeing positions would be a confident guess
    [Fact]
    public void Two_positions_that_disagree_produce_no_single_phase_or_rate()
    {
        var debt = Read(positions: Fixture.Read("duo/schulden-two-positions.json"));

        Assert.Equal(StudentDebtPhase.Mixed, debt.Phase);
        Assert.Equal("TERUGBETAALPERIODE, OPBOUW_LLLK", debt.PhaseLabel);

        Assert.Null(debt.InterestRate);
        Assert.Null(debt.InterestRegime);

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

    // enrichment may be missing: every fetch costs a DigiD sign-in, so never lose the balance over an interest rate
    [Fact]
    public void Missing_extras_cost_the_extras_and_never_the_balance()
    {
        // straight to the reader: the helper reads null as "use the fixture", the very absence under test
        var debt = DuoDebtReader.Read(new DuoPayloads(Amounts, null, null), Today, Options, Session);

        Assert.Equal(1_243_477, debt.Total.Value);
        Assert.Equal(2, debt.Components.Count);

        Assert.Equal(StudentDebtPhase.Unknown, debt.Phase);
        Assert.Null(debt.PhaseLabel);
        Assert.Null(debt.InterestRate);
        Assert.Empty(debt.InterestPeriods);
        Assert.Null(debt.PaymentHolidayMonthsRemaining);
    }

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

    // singleton position: a constant external id makes every sync update one row.
    // with (session_id, external_id) uniqueness a retry is free
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
        // same total, different debts: a hash keyed on the total alone would call a shifted split no change
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

    private static string History => Fixture.Read("duo/schuldhistorie.json");

    private static StudentDebt WithHistory(string? history = null, string? grondslag = null) =>
        DuoDebtReader.Read(
            new DuoPayloads(
                Amounts, Positions, Holiday,
                history ?? History,
                grondslag ?? Fixture.Read("duo/grondslaggegevens.json")),
            Today, Options, Session);

    // the as-of date lives in DUO's "Mijn schuldhistorie" endpoint (5.6 KB, no BSN, parents or income).
    // earlier captures missed it because nobody had opened that page
    [Fact]
    public void The_as_of_date_is_the_one_duo_calculated_interest_to()
    {
        Assert.Equal(new DateOnly(2026, 8, 1), WithHistory().AsOf);
    }

    // taken from the CURRENT balance: a year-end balance is dated by its year and a phase by its start
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

    // TryGetInt32 throws InvalidOperationException on a non-number, past every JsonException catch: one null cost the debt.
    // DUO's own fixtures carry nulls on number fields (gevraagdTermijnbedrag, berekendTermijnbedrag)
    [Fact]
    public void A_number_duo_sends_as_null_costs_that_field_and_nothing_else()
    {
        const string Json = """
        {"saldoStudieschulds":[
          {"@type":"SaldoEindeKalenderjaar","jaar":null,"saldoInclusiefRente":25000.00},
          {"@type":"SaldoActueel","renteBerekendTot":"2026-08-01","saldoInclusiefRente":12434.77}]}
        """;

        var debt = WithHistory(history: Json);

        Assert.Equal(new DateOnly(2026, 8, 1), debt.AsOf);

        var yearEnd = Assert.Single(debt.History, b => b.Kind == StudentDebtBalanceKind.YearEnd);

        Assert.Null(yearEnd.Year);
        Assert.Equal(2_500_000, yearEnd.Amount.Value);
    }

    // a null entry in the array threw in whichever accessor ran first.
    // Connector.Kit.Tests.Normalization.JsonReadRuleTests now forbids it
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
        // null means nothing here is dated: do not show it as current
        var debt = DuoDebtReader.Read(new DuoPayloads(Amounts, Positions, Holiday), Today, Options, Session);

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

        var start = Assert.Single(history, h => h.Kind == StudentDebtBalanceKind.RepaymentStart);
        Assert.Equal(2_500_000, start.Amount.Value);
        Assert.Equal(new DateOnly(2022, 1, 1), start.On);

        Assert.Equal(3, history.Count(h => h.Kind == StudentDebtBalanceKind.YearEnd));
        Assert.Equal(2025, history.First(h => h.Kind == StudentDebtBalanceKind.YearEnd).Year);
    }

    // DUO lists balances grouped by kind and in no order inside a group (live: 2020, 2022, 2021, 2024, ...).
    // sorted newest first so no consumer plots a history that jumps backwards
    [Fact]
    public void The_history_reads_as_a_timeline_rather_than_in_duos_order()
    {
        var history = WithHistory().History;

        Assert.Equal(StudentDebtBalanceKind.Current, history[0].Kind);

        var moments = history.Skip(1).Select(h => h.Year ?? h.On!.Value.Year).ToList();

        Assert.Equal(moments.OrderByDescending(y => y), moments);

        Assert.Equal([2025, 2024, 2022, 2020, 2020, 2015], moments);
    }

    [Fact]
    public void Balances_at_the_same_moment_keep_the_order_duo_listed_them_in()
    {
        var grace = WithHistory().History
            .Where(h => h.Kind == StudentDebtBalanceKind.GracePeriodStart)
            .Select(h => h.Label)
            .ToList();

        Assert.Equal(["Lening hbo of universiteit", "Prestatiebeurs mbo"], grace);
    }

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

    // the stated current balance is NOT used to check the total: it is study finance only, the components also cover
    // ov-schuld, over-payments and lifelong-learning credit; they coincide only on a loan-only account
    [Fact]
    public void The_total_stays_the_sum_of_the_components_and_still_says_so()
    {
        var debt = WithHistory();

        Assert.True(debt.TotalIsDerived);
        Assert.Equal(debt.Components.Sum(c => c.Amount.Value), debt.Total.Value);
    }

    private static StudentDebt WithLedger() =>
        DuoDebtReader.Read(
            new DuoPayloads(
                Amounts, Positions, Holiday,
                Fixture.Read("duo/schuldhistorie.json"),
                Fixture.Read("duo/grondslaggegevens.json"),
                Fixture.Read("duo/klantbeeld-reduced.json")),
            Today, Options, Session);

    private const string NothingOwed =
        """{"schuldbedragLening":0E-8,"schuldbedragLevenlanglerenkrediet":0E-8,"schuldbedragOVSchuld":0E-8,"schuldbedragPrestatiebeurs":0E-8,"schuldbedragTeveelBijverdiensten":0E-8,"schuldbedragTeveelOntvangenLevenlanglerenkrediet":0E-8,"schuldbedragTeveelOntvangenStudiefinanciering":0E-8,"schuldbedragTeveelOntvangenTegemoetkomingScholier":0E-8}""";

    // #566: amounts adding up to nothing while DUO states a debt read as 0.00 in repayment.
    // the ledger sum comes first, then the stated current balance, never a zero nobody owes
    [Fact]
    public void Amounts_that_add_up_to_nothing_give_way_to_the_ledger_and_then_to_the_stated_current_balance()
    {
        var notes = new List<string>();
        var fromLedger = DuoDebtReader.Read(
            new DuoPayloads(
                NothingOwed, Positions, Holiday,
                Fixture.Read("duo/schuldhistorie.json"),
                Fixture.Read("duo/grondslaggegevens.json"),
                Fixture.Read("duo/klantbeeld-reduced.json")),
            Today, Options, Session, note: notes.Add);
        Assert.Equal(fromLedger.Ledger.Sum(e => e.Amount.Value), fromLedger.Total.Value);
        Assert.NotEqual(0, fromLedger.Total.Value);
        Assert.True(fromLedger.TotalIsDerived);
        Assert.Contains(notes, n => n.Contains("booked movements", StringComparison.Ordinal));

        var fromHistory = DuoDebtReader.Read(
            new DuoPayloads(NothingOwed, Positions, Holiday, Fixture.Read("duo/schuldhistorie.json")),
            Today, Options, Session);
        Assert.Equal(1_243_477, fromHistory.Total.Value);   // SaldoActueel's saldoInclusiefRente, 12434.77
        Assert.False(fromHistory.TotalIsDerived);

        // with nothing stated anywhere, nothing is owed
        Assert.Equal(0, DuoDebtReader.Read(new DuoPayloads(NothingOwed, Positions, Holiday), Today, Options, Session).Total.Value);
    }

    // the sign is DUO's own: 566 of 1223 live amounts are negative, so no reason-code-to-direction table is needed
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

        // a performance grant turned gift reduces the debt without anybody paying it
        var gift = Assert.Single(ledger, e => e.SourceCode == "OMZETTING_NAAR_GIFT");
        Assert.Equal(-2_000_000, gift.Amount.Value);
    }

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

    // reason codes are carried verbatim: DUO's words for them live only in its minified front-end, not its API
    [Fact]
    public void The_providers_own_reason_code_is_carried_untranslated()
    {
        Assert.All(WithLedger().Ledger, e => Assert.Matches("^[A-Z_]+$", e.SourceCode));
    }

    [Fact]
    public void The_monthly_instalment_is_the_one_for_this_month()
    {
        var debt = WithLedger();

        // the fixture also holds a 2022 instalment at another amount: pick by month, not "most recent row" (a future schedule)
        Assert.Equal(5_000, debt.MonthlyAmount!.Value.Value);
        Assert.Equal(new DateOnly(2026, 8, 27), debt.NextPaymentDue);
    }

    // every booked movement sums to the current balance, measured live (1223 movements over fifteen years, per debt too):
    // a truncated page, dropped row or flipped sign breaks it
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
        // one row removed = a truncated history; the record is still emitted, the flag says the figures were not proven
        var short_ = Fixture.Read("duo/klantbeeld-reduced.json")
            .Replace("""{"bedrag":25.00,"boekdatum":"2026-08-01","boekreden":"RENTE","id":9000000103,"mutatieType":"RENTE","vorderingid":9000000200},""", string.Empty, StringComparison.Ordinal);

        var debt = DuoDebtReader.Read(
            new DuoPayloads(Amounts, Positions, Holiday, History, null, short_), Today, Options, Session);

        Assert.False(debt.LedgerReconciled);
        Assert.NotEmpty(debt.Ledger);
    }

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
        // same figures, new date: a consumer showing "as of 1 July" is stale in the way this field reveals,
        // so the record must read as changed
        var july = WithHistory(history: History.Replace("2026-08-01", "2026-07-01", StringComparison.Ordinal));

        Assert.NotEqual(WithHistory().ContentHash, july.ContentHash);
    }
}
