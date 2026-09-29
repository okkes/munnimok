using System.Globalization;
using System.Text.Json;

using Connector.Kit;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Duo;

/// <summary>
/// What DUO says you owe, from a handful of small JSON calls and nothing else.
///
/// The opposite of BKR: there is no markup here at all. <c>mijn.duo.nl</c> is a
/// Knockout single-page app over a real JSON API, and the endpoints this reads
/// answer in hundreds of bytes apiece - the largest is 5.6 KB.
///
/// None of them is <c>raadplegen/klantbeeld</c>, which answers with the account
/// holder's whole government dossier. DUO's own debt page is built entirely
/// from it, so the temptation is real; the narrow endpoints state the same
/// money without a BSN in sight.
///
/// TWO OF THEM WERE FOUND LATE, and how is worth keeping. This reader shipped
/// with no as-of date and a documented argument that it could never have one,
/// because two captures had been searched and none of their endpoints carried
/// it. Both captures recorded only the pages the account holder happened to
/// open, and nobody had opened "Mijn schuldhistorie" - where
/// <c>renteBerekendTot</c> sits, in 5.6 KB with no dossier attached. An absence
/// found by walking a capture is only ever an absence from that capture.
///
/// The transaction ledger and the monthly repayment amount ARE dossier-only,
/// and are read from it only when a caller asks for the ledger - see
/// <see cref="Dossier"/>, which takes the movements and one instalment out of
/// that payload and reads nothing else in it.
/// </summary>
internal static class DuoDebtReader
{
    private const string ProviderId = DuoAdapter.ProviderId;

    /// <summary>
    /// DUO's eight sibling amounts, mapped.
    ///
    /// Ordered as DUO publishes them, so a breakdown reads the way the
    /// provider states it. A field appearing here that this table does not
    /// know still reaches the user - as <see cref="StudentDebtKind.Other"/>
    /// carrying DUO's own name for it - rather than being silently dropped
    /// from a total somebody is going to compare against a letter.
    /// </summary>
    private static readonly Dictionary<string, StudentDebtKind> Kinds = new(StringComparer.Ordinal)
    {
        ["schuldbedragLening"] = StudentDebtKind.Loan,
        ["schuldbedragLevenlanglerenkrediet"] = StudentDebtKind.LifelongLearningCredit,
        ["schuldbedragOVSchuld"] = StudentDebtKind.PublicTransport,
        ["schuldbedragPrestatiebeurs"] = StudentDebtKind.PerformanceGrant,
        ["schuldbedragTeveelBijverdiensten"] = StudentDebtKind.ExcessEarnings,
        ["schuldbedragTeveelOntvangenLevenlanglerenkrediet"] = StudentDebtKind.ExcessLifelongLearningCredit,
        ["schuldbedragTeveelOntvangenStudiefinanciering"] = StudentDebtKind.ExcessStudyFinance,
        ["schuldbedragTeveelOntvangenTegemoetkomingScholier"] = StudentDebtKind.ExcessSchoolAllowance,
    };

    /// <summary>
    /// DUO's own words for where a debt is, mapped to the phase.
    /// </summary>
    /// <remarks>
    /// <c>TERUGBETAALPERIODE</c> is confirmed from a live payload. The two
    /// <c>OPBOUW</c> values are confirmed from DUO's own source - its
    /// interest mapper selects on exactly these two strings - which is
    /// evidence of a different kind and is worth saying so. Anything else
    /// arrives as <see cref="StudentDebtPhase.Unknown"/> with DUO's word kept
    /// beside it.
    /// </remarks>
    private static readonly Dictionary<string, StudentDebtPhase> Phases = new(StringComparer.Ordinal)
    {
        ["TERUGBETAALPERIODE"] = StudentDebtPhase.Repaying,
        ["OPBOUW"] = StudentDebtPhase.Accruing,
        ["OPBOUW_LLLK"] = StudentDebtPhase.Accruing,
        ["AANLOOPFASE"] = StudentDebtPhase.GracePeriod,
    };

    /// <summary>
    /// The one record, built from the three payloads.
    /// </summary>
    /// <param name="today">
    /// Which day to resolve the interest rate for. Passed in rather than read
    /// from the clock so the answer is a function of its inputs - a rate that
    /// changes on 1 January must be testable in July.
    /// </param>
    public static StudentDebt Read(
        string? debtJson,
        string? positionsJson,
        string? holidayJson,
        DateOnly today,
        DuoOptions options,
        string sessionId,
        string? historyJson = null,
        string? grondslagJson = null,
        string? dossierJson = null,
        Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        var (components, total) = Components(debtJson, options, note);
        var positions = Positions(positionsJson);
        var history = History(historyJson, options);
        var (ledger, monthly, due) = Dossier(dossierJson, today, options);

        var externalId = DuoAdapter.DebtResource;

        var debt = new StudentDebt
        {
            Id = Ids.ForRecord(Ids.StudentDebt, sessionId, externalId),
            ExternalId = externalId,

            Total = new Money(total, options.Currency),

            // ALWAYS derived, on this provider. DUO publishes the components
            // and states no total anywhere; the "Totaal studieschuld" its
            // portal prints is summed in the browser, from the dossier. So
            // this is our sum, and a consumer must be told that rather than
            // shown a number that looks like DUO's own.
            TotalIsDerived = true,

            Components = components,
            Phase = Phase(positions, out var phaseLabel),
            PhaseLabel = phaseLabel,
            InterestPeriods = [.. positions.SelectMany(p => p.Periods)],
            PaymentHolidayMonthsRemaining = Holiday(holidayJson),

            // The date DUO calculated interest to, off the CURRENT balance and
            // nowhere else. A year-end entry carries no such date - it is dated
            // by its year - so taking "the first renteBerekendTot in the list"
            // would date today's figure with something else's moment.
            AsOf = history.FirstOrDefault(h => h.Kind == StudentDebtBalanceKind.Current)?.On,

            History = history,
            RepaymentMonthsRemaining = MonthsRemaining(grondslagJson, options),

            Ledger = ledger,
            MonthlyAmount = monthly,
            NextPaymentDue = due,

            // Every movement DUO has ever booked should sum to what is owed
            // now, and on a live account it did: 1223 movements over fifteen
            // years, to the cent, and separately for each of the eight debts
            // underneath. So it is checked on every fetch rather than trusted
            // once - a truncated history, a dropped row or a flipped sign all
            // break it, and none of them is visible any other way.
            //
            // Null when no ledger was fetched. A check that was never made
            // must not read as one that passed.
            LedgerReconciled = ledger.Count == 0
                ? null
                : ledger.Sum(e => e.Amount.Value) == total,
        };

        var current = CurrentRate(positions, today);

        debt = debt with { InterestRate = current?.Rate, InterestRegime = current?.Regime };

        return debt with { ContentHash = ContentHash.Of(debt) };
    }

    /// <summary>
    /// The eight amounts, minus the zeroes, plus their sum.
    /// </summary>
    private static (IReadOnlyList<StudentDebtComponent> Components, long Total) Components(
        string? json, DuoOptions options, Action<string>? note)
    {
        using var document = Parse(json, options.DebtPath);

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: {options.DebtPath} answered {document.RootElement.ValueKind}, expected an object " +
                "of one amount per debt kind");
        }

        var components = new List<StudentDebtComponent>();
        var total = 0L;
        var seen = 0;
        var unread = new List<string>();

        foreach (var field in document.RootElement.EnumerateObject())
        {
            if (field.Value.ValueKind != JsonValueKind.Number)
            {
                // AN AMOUNT THAT STOPPED BEING A NUMBER IS A HOLE IN THE TOTAL,
                // and this used to skip it without a word.
                //
                // The remaining seven fields would still sum, the ledger check
                // downstream compares that sum against a total built from the
                // same fields, and the answer would come back looking like a
                // complete statement of what somebody owes while being short by
                // a whole debt.
                //
                // Told apart by DUO's own vocabulary: every amount here is
                // schuldbedrag*, so one that is not a number is a missing debt,
                // and anything else is metadata this connector does not read.
                if (field.Name.StartsWith(options.DebtAmountPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    throw ConnectorException.ProviderChanged(
                        $"{ProviderId}: {options.DebtPath} field '{field.Name}' is "
                        + $"{field.Value.ValueKind} rather than an amount, so that debt would be missing "
                        + "from a total that still adds up and still looks complete");
                }

                unread.Add(field.Name);
                continue;
            }

            seen++;

            // Off the reader as a decimal, never via its text. DUO writes zero
            // as "0E-8" - a Java BigDecimal - and the money parser's string
            // path deliberately refuses exponents. Seven of these eight fields
            // are zero for almost everybody, so a round trip through text
            // would fail on nearly every account rather than on an odd one.
            if (field.Value.Decimal() is not { } amount)
            {
                throw ConnectorException.ProviderChanged(
                    $"{ProviderId}: {options.DebtPath} field '{field.Name}' is a number this connector " +
                    $"cannot read as an amount: {field.Value.GetRawText()}");
            }

            var minor = MoneyParser.ToMinor(amount, options.AmountUnit);
            total += minor;

            // A zero is a real answer, and it is still not worth carrying: DUO
            // publishes all eight fields for everybody, so a breakdown that
            // kept them would be seven lines of "nothing" around the one line
            // that matters. It has already been added to the total above,
            // where adding zero changes nothing.
            if (minor == 0) continue;

            components.Add(new StudentDebtComponent
            {
                Kind = Kinds.TryGetValue(field.Name, out var kind) ? kind : StudentDebtKind.Other,
                SourceField = field.Name,
                Amount = new Money(minor, options.Currency),
            });
        }

        if (seen == 0)
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: {options.DebtPath} carried no amounts at all. Either the endpoint was " +
                "rebuilt or this is not the debt summary.");
        }

        // AND WHAT WAS PASSED OVER, named. Silent on every account seen so far -
        // the live capture is eight numbers and nothing else - so this speaks
        // only when DUO has added something, which is exactly when somebody
        // should look at whether it belongs in the total.
        if (unread.Count > 0)
        {
            note?.Invoke(
                $"{ProviderId}: {options.DebtPath} also carried {string.Join(", ", unread)}, which this "
                + "connector does not read as an amount. If any of those is a debt, it is not in the total");
        }

        return (components, total);
    }

    /// <summary>One entry of <c>pfd/json/schulden</c>, reduced to what is used.</summary>
    private readonly record struct Position(string? Status, IReadOnlyList<InterestPeriod> Periods);

    private static IReadOnlyList<Position> Positions(string? json)
    {
        // Absent rather than empty. The fetch treats a call it could not make
        // as a reason to say less, not a reason to fail: the amounts are the
        // point, and losing the interest rate should not lose the balance.
        if (string.IsNullOrWhiteSpace(json)) return [];

        using var document = Parse(json, "pfd/json/schulden");

        if (document.RootElement.ValueKind != JsonValueKind.Array) return [];

        var positions = new List<Position>();

        foreach (var entry in document.RootElement.EnumerateArray().Objects())
        {
            positions.Add(new Position(entry.Text("statusSchuld"), Periods(entry)));
        }

        return positions;
    }

    private static IReadOnlyList<InterestPeriod> Periods(JsonElement entry)
    {
        var periods = new List<InterestPeriod>();

        foreach (var period in entry.Items("rentepercentagePeriodes").Objects())
        {
            var start = Date(period, "startdatum");
            var end = Date(period, "einddatum");

            if (start is null || end is null) continue;
            if (period.Decimal("rentepercentage") is not { } percentage) continue;

            periods.Add(new InterestPeriod
            {
                Regime = period.Text("vorderingsregime") ?? string.Empty,
                StartsOn = start.Value,
                EndsOn = end.Value,
                Rate = percentage,
            });
        }

        return periods;
    }

    /// <summary>
    /// Where the debt is, across every position DUO stated.
    /// </summary>
    /// <remarks>
    /// Several positions that agree are still one answer. Several that
    /// disagree are <see cref="StudentDebtPhase.Mixed"/>, not a guess:
    /// somebody repaying a loan while drawing lifelong-learning credit really
    /// is in two phases, and the amounts DUO publishes carry no key back to
    /// the position they belong to, so there is nothing to break the tie with.
    /// </remarks>
    private static StudentDebtPhase Phase(IReadOnlyList<Position> positions, out string? label)
    {
        var stated = positions
            .Select(p => p.Status)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s!)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        if (stated.Count == 0)
        {
            label = null;
            return StudentDebtPhase.Unknown;
        }

        if (stated.Count > 1)
        {
            label = string.Join(", ", stated);
            return StudentDebtPhase.Mixed;
        }

        label = stated[0];
        return Phases.TryGetValue(stated[0], out var phase) ? phase : StudentDebtPhase.Unknown;
    }

    /// <summary>
    /// The rate in force on <paramref name="today"/>, DUO's own way: the
    /// period whose window contains the day.
    /// </summary>
    /// <remarks>
    /// Lifted from DUO's <c>mijn-schulden-opbouw-mapper</c>, which finds the
    /// period with <c>startdatum &lt;= now</c> and <c>einddatum &gt;= now</c>
    /// and reads its percentage and regime off that. Resolved here so every
    /// consumer does not implement the same rule slightly differently - and
    /// null where the positions disagree, because a single rate would then be
    /// a fiction. The periods are carried whole either way.
    /// </remarks>
    private static InterestPeriod? CurrentRate(IReadOnlyList<Position> positions, DateOnly today)
    {
        var live = positions
            .SelectMany(p => p.Periods)
            .Where(p => p.StartsOn <= today && today <= p.EndsOn)
            .ToList();

        if (live.Count == 0) return null;

        var first = live[0];

        return live.All(p => p.Rate == first.Rate
                             && string.Equals(p.Regime, first.Regime, StringComparison.Ordinal))
            ? first
            : null;
    }

    /// <summary>
    /// DUO's own words for the moments it states a balance at.
    /// </summary>
    private static readonly Dictionary<string, StudentDebtBalanceKind> Moments = new(StringComparer.Ordinal)
    {
        ["SaldoActueel"] = StudentDebtBalanceKind.Current,
        ["SaldoEindeKalenderjaar"] = StudentDebtBalanceKind.YearEnd,
        ["SaldoStartAflosfase"] = StudentDebtBalanceKind.RepaymentStart,
        ["SaldoStartAanloopfase"] = StudentDebtBalanceKind.GracePeriodStart,
    };

    /// <summary>
    /// The balances DUO has published, in the order it publishes them.
    /// </summary>
    /// <remarks>
    /// NOT a cross-check on the total, however tempting the arithmetic looks.
    /// Every entry here carries <c>schuldtype: STUDIEFINANCIERING</c>, so the
    /// current one is the study-finance debt alone - while the eight component
    /// amounts also cover an ov-schuld, over-payments and lifelong-learning
    /// credit. On an account with only a loan the two figures coincide exactly,
    /// which is precisely how a reconciliation built on that coincidence would
    /// pass every test and then contradict itself for somebody with a travel
    /// debt.
    /// </remarks>
    private static IReadOnlyList<StudentDebtBalance> History(string? json, DuoOptions options)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];

        using var document = Parse(json, options.HistoryPath);

        var stated = new List<StudentDebtBalance>();

        foreach (var entry in document.RootElement.Items("saldoStudieschulds").Objects())
        {
            if (Amount(entry, "saldoInclusiefRente", options) is not { } amount) continue;

            var moment = entry.Text("@type");

            stated.Add(new StudentDebtBalance
            {
                Kind = moment is not null && Moments.TryGetValue(moment, out var kind)
                    ? kind
                    : StudentDebtBalanceKind.Unknown,
                KindLabel = moment,
                Year = entry.Int32("jaar"),

                // The moment's own date, wherever DUO puts it: interest is
                // calculated TO a day on the current balance, and a phase
                // begins ON a day.
                On = Date(entry, "renteBerekendTot")
                     ?? Date(entry, "beginDatumAflosfase")
                     ?? Date(entry, "beginDatumAanloopfase"),

                Amount = amount,
                InterestPortion = Amount(entry, "saldoRentedeel", options),
                Rate = entry.Decimal("rentepercentage"),
                Label = entry.Text("vorderingsoortOmschrijving"),
            });
        }

        // CHRONOLOGICAL, which DUO's own order is not.
        //
        // It publishes these grouped by kind and, within a group, in no order
        // at all: 2020, 2022, 2021, 2024, 2023, 2015, 2025, 2017, 2016, 2019,
        // 2018. Elsewhere this connector preserves a provider's order
        // religiously, because an order usually means something and shuffling
        // it makes correct data read as a bug. Here it means nothing, and
        // passing it through would hand every consumer the same sorting job
        // plus a good chance of somebody plotting a debt history that jumps
        // backwards.
        //
        // Newest first, with the current balance ahead of everything - that is
        // the order somebody reads a balance history in. Ties keep DUO's order,
        // which is what holds the seven grace-period entries together in the
        // sequence it listed them.
        return
        [
            .. stated
                .OrderBy(h => h.Kind == StudentDebtBalanceKind.Current ? 0 : 1)
                .ThenByDescending(h => h.Year ?? h.On?.Year ?? 0)
                .ThenByDescending(h => h.On ?? DateOnly.MinValue),
        ];
    }

    /// <summary>
    /// The months-remaining figure, out of a payload that nests its value in a
    /// JSON STRING.
    /// </summary>
    /// <remarks>
    /// <c>"waarde":"{\"value\":365}"</c> - a document inside a document, with
    /// its own <c>datatype</c> beside it. Parsed rather than pattern-matched,
    /// because a regex over somebody's debt figures is how a stray digit
    /// becomes a number nobody can explain.
    /// </remarks>
    private static int? MonthsRemaining(string? json, DuoOptions options)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        using var document = Parse(json, options.GrondslagPath);

        if (document.RootElement.ValueKind != JsonValueKind.Object
            || !document.RootElement.Has("grondslaggegevenPeriodeWaardes", out var values)
            || values.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var entry in values.EnumerateArray().Objects())
        {
            if (!string.Equals(entry.Text("definitieNaam"), options.MonthsRemainingCode, StringComparison.Ordinal))
            {
                continue;
            }

            // DUO says outright when it cannot work a figure out, and that is
            // a different thing from the figure being absent.
            if (entry.Flag("isNietTeBepalen")) return null;

            if (entry.Text("waarde") is not { } raw) continue;

            try
            {
                using var inner = JsonDocument.Parse(raw);

                if (inner.RootElement.Int32("value") is { } count) return count;
            }
            catch (JsonException)
            {
                // A nested document that will not parse is one field lost, not
                // a fetch lost: the balance is the point of this call's
                // siblings and this is enrichment.
                return null;
            }
        }

        return null;
    }

    /// <summary>
    /// The ledger and the monthly instalment, out of the dossier - and nothing
    /// else out of it.
    /// </summary>
    /// <remarks>
    /// Only ever reached when a caller asked for the ledger. What arrives here
    /// is the whole customer dossier; what leaves is <c>vorderingmutaties</c>
    /// joined to <c>vorderings</c> for a label, and one <c>termijn</c>. Every
    /// other section - the BSN, both parents, twenty years of income, the
    /// IBANs, the addresses - is never read, never copied and never returned.
    /// </remarks>
    private static (IReadOnlyList<StudentDebtEntry> Ledger, Money? Monthly, DateOnly? Due) Dossier(
        string? json, DateOnly today, DuoOptions options)
    {
        if (string.IsNullOrWhiteSpace(json)) return ([], null, null);

        using var document = Parse(json, options.DossierPath);

        if (document.RootElement.ValueKind != JsonValueKind.Object) return ([], null, null);

        // What each movement was booked against, by id. DUO names these in its
        // own words - "Lening HO", "Collegegeldkrediet" - and those words are
        // the account holder's own history.
        var debts = new Dictionary<long, string>();

        foreach (var claim in document.RootElement.Items("vorderings").Objects())
        {
            if (claim.Int64("id") is not { } key) continue;
            if (claim.Child("vorderingsoort").Text("omschrijving") is not { } what) continue;

            debts[key] = what;
        }

        var ledger = new List<StudentDebtEntry>();

        foreach (var movement in document.RootElement.Items("vorderingmutaties").Objects())
        {
            if (Date(movement, "boekdatum") is not { } booked) continue;
            if (Amount(movement, "bedrag", options) is not { } amount) continue;

            ledger.Add(new StudentDebtEntry
            {
                BookedOn = booked,
                Amount = amount,
                SourceCode = movement.Text("boekreden") ?? string.Empty,
                Applies = movement.Text("mutatieType") switch
                {
                    "HOOFDSOM" => StudentDebtEntryApplies.Principal,
                    "RENTE" => StudentDebtEntryApplies.Interest,
                    _ => StudentDebtEntryApplies.Other,
                },
                Debt = movement.Int64("vorderingid") is { } ownerId
                       && debts.TryGetValue(ownerId, out var label)
                    ? label
                    : null,
            });
        }

        var (monthly, due) = Instalment(document.RootElement, today, options);

        // Newest first. DUO's own order here is the order its database
        // happened to return, which on a live payload interleaved 2016 and
        // 2018 in the first four rows.
        return ([.. ledger.OrderByDescending(e => e.BookedOn)], monthly, due);
    }

    /// <summary>
    /// This month's instalment and the day it falls due.
    /// </summary>
    /// <remarks>
    /// Selected by the month it is FOR, not by "the most recent one": DUO
    /// carries instalments for months that have not happened yet, so the
    /// latest row is a future one and reporting it as what is owed now would
    /// be wrong every time a schedule changes.
    /// </remarks>
    private static (Money? Amount, DateOnly? Due) Instalment(
        JsonElement dossier, DateOnly today, DuoOptions options)
    {
        var month = today.ToString("yyyy-MM", CultureInfo.InvariantCulture);

        foreach (var instalment in dossier.Items("termijns").Objects())
        {
            if (!string.Equals(instalment.Text("maand"), month, StringComparison.Ordinal)) continue;

            return (Amount(instalment, "bedrag", options), Date(instalment, "vervaldatum"));
        }

        return (null, null);
    }

    private static Money? Amount(JsonElement owner, string name, DuoOptions options) =>
        owner.Decimal(name) is { } value
            ? new Money(MoneyParser.ToMinor(value, options.AmountUnit), options.Currency)
            : null;

    private static int? Holiday(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;

        using var document = Parse(json, "pfd/json/raadplegen/resterend-aantal-maanden-aflosvrij");

        return document.RootElement.Int32("resterendAantalMaandenAflosvrij");
    }

    /// <summary>
    /// A date DUO states as <c>yyyy-MM-dd</c>, or nothing.
    /// </summary>
    /// <remarks>
    /// The last accessor this file owns; the rest are
    /// <see cref="JsonRead"/>'s. This one had the same missing guard as the
    /// four the audit found - <c>owner.TryGetProperty</c> with nothing
    /// establishing that <c>owner</c> is an object - and survived that audit
    /// because it was the only one of the six not reading a number, so nothing
    /// about it looked like the pattern being hunted.
    /// </remarks>
    private static DateOnly? Date(JsonElement owner, string name) =>
        owner.Text(name) is { } raw
        && DateOnly.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var date)
            ? date
            : null;

    private static JsonDocument Parse(string? json, string what)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: {what} answered nothing");
        }

        try
        {
            return JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            // An HTML sign-in page arrives here when a session is over, and
            // that is checked before this by the fetch - which knows the URL
            // and the status code, and can tell "you are signed out" from "the
            // endpoint was rebuilt". By this point it really is the latter.
            throw ConnectorException.ProviderChanged($"{ProviderId}: {what} did not answer JSON: {ex.Message}");
        }
    }
}
