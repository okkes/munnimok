using System.Globalization;
using System.Text.Json;

using Connector.Kit;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Duo;

internal sealed record DuoPayloads(
    string? Debt,
    string? Positions = null,
    string? Holiday = null,
    string? History = null,
    string? Grondslag = null,
    string? Dossier = null);

// narrow endpoints only, never raadplegen/klantbeeld (the whole government dossier, BSN included); the ledger and
// monthly amount are dossier-only, read from it only when the ledger is asked for
// an absence found in a capture is only an absence from that capture: renteBerekendTot sits in schuldhistorie
internal static class DuoDebtReader
{
    private const string ProviderId = DuoAdapter.ProviderId;

    // an unknown field still reaches the user as Other with DUO's own name, never dropped from a total compared to a letter
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

    // TERUGBETAALPERIODE confirmed from a live payload, the OPBOUW values from DUO's own interest mapper source; else Unknown
    private static readonly Dictionary<string, StudentDebtPhase> Phases = new(StringComparer.Ordinal)
    {
        ["TERUGBETAALPERIODE"] = StudentDebtPhase.Repaying,
        ["OPBOUW"] = StudentDebtPhase.Accruing,
        ["OPBOUW_LLLK"] = StudentDebtPhase.Accruing,
        ["AANLOOPFASE"] = StudentDebtPhase.GracePeriod,
    };

    /// <param name="today">the day to resolve the rate for; passed in so a 1 January change is testable in July</param>
    public static StudentDebt Read(
        DuoPayloads payloads,
        DateOnly today,
        DuoOptions options,
        string sessionId,
        Action<string>? note = null)
    {
        ArgumentNullException.ThrowIfNull(payloads);
        ArgumentNullException.ThrowIfNull(options);

        var (components, summed) = Components(payloads.Debt, options, note);
        var positions = Positions(payloads.Positions);
        var history = History(payloads.History, options);
        var (ledger, monthly, due) = Dossier(payloads.Dossier, today, options);
        var (total, derived) = Total(summed, ledger, history, note);

        var externalId = DuoAdapter.DebtResource;

        var debt = new StudentDebt
        {
            Id = Ids.ForRecord(Ids.StudentDebt, sessionId, externalId),
            ExternalId = externalId,

            Total = new Money(total, options.Currency),

            // DUO states no total, its portal sums the components in the browser from the dossier: ours is derived,
            // unless the stated current balance stands in (see Total)
            TotalIsDerived = derived,

            Components = components,
            Phase = Phase(positions, out var phaseLabel),
            PhaseLabel = phaseLabel,
            InterestPeriods = [.. positions.SelectMany(p => p.InterestPeriods)],
            PaymentHolidayMonthsRemaining = Holiday(payloads.Holiday),

            // off the CURRENT balance only: a year-end entry is dated by its year, so the first renteBerekendTot would misdate it
            AsOf = history.FirstOrDefault(h => h.Kind == StudentDebtBalanceKind.Current)?.On,

            History = history,
            RepaymentMonthsRemaining = MonthsRemaining(payloads.Grondslag, options),

            Ledger = ledger,
            MonthlyAmount = monthly,
            NextPaymentDue = due,

            // checked every fetch: a live account's 1223 movements summed to the debt to the cent; truncation or a sign flip breaks it
            // null when no ledger was fetched: a check never made must not read as passed
            LedgerReconciled = ledger.Count == 0
                ? null
                : ledger.Sum(e => e.Amount.Value) == total,
        };

        var current = CurrentRate(positions, today);

        debt = debt with { InterestRate = current?.Rate, InterestRegime = current?.Regime };

        return debt with { ContentHash = ContentHash.Of(debt) };
    }

    // components summing to 0 while DUO says otherwise (#566: a repaying debt came through as €0.00): booked movements,
    // else the stated current balance (not derived)
    private static (long Total, bool Derived) Total(
        long summed, IReadOnlyList<StudentDebtEntry> ledger, IReadOnlyList<StudentDebtBalance> history, Action<string>? note)
    {
        if (summed != 0) return (summed, true);

        var booked = ledger.Sum(e => e.Amount.Value);
        if (booked != 0)
        {
            note?.Invoke($"{ProviderId}: the debt amounts add up to nothing; the total is the sum of DUO's booked movements, as its portal sums it");
            return (booked, true);
        }

        if (history.FirstOrDefault(h => h.Kind == StudentDebtBalanceKind.Current) is { Amount.Value: not 0 } current)
        {
            note?.Invoke($"{ProviderId}: the debt amounts add up to nothing; the total is the current balance DUO states");
            return (current.Amount.Value, false);
        }

        return (0, true);
    }

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
                // a schuldbedrag* field that is not a number is a missing debt behind a complete-looking total: fail; others are metadata
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

            // read as decimal, never via text: DUO writes zero as "0E-8" (Java BigDecimal), which the string path refuses;
            // seven of eight fields are zero
            if (field.Value.Decimal() is not { } amount)
            {
                throw ConnectorException.ProviderChanged(
                    $"{ProviderId}: {options.DebtPath} field '{field.Name}' is a number this connector " +
                    $"cannot read as an amount: {field.Value.GetRawText()}");
            }

            var minor = MoneyParser.ToMinor(amount, options.AmountUnit);
            total += minor;

            // zeroes are dropped from the breakdown: DUO publishes all eight for everybody
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

        // names what was skipped: silent unless DUO added a field, when somebody should check whether it belongs in the total
        if (unread.Count > 0)
        {
            note?.Invoke(
                $"{ProviderId}: {options.DebtPath} also carried {string.Join(", ", unread)}, which this "
                + "connector does not read as an amount. If any of those is a debt, it is not in the total");
        }

        return (components, total);
    }

    private readonly record struct Position(string? Status, IReadOnlyList<InterestPeriod> InterestPeriods);

    private static List<Position> Positions(string? json)
    {
        // absent, not failing: losing the interest rate must not lose the balance
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

    private static List<InterestPeriod> Periods(JsonElement entry)
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

    // disagreeing positions are Mixed, not a guess: the amounts carry no key back to their position
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

    // DUO's own rule (mijn-schulden-opbouw-mapper): the period whose window holds the day; null when positions disagree
    private static InterestPeriod? CurrentRate(IReadOnlyList<Position> positions, DateOnly today)
    {
        var live = positions
            .SelectMany(p => p.InterestPeriods)
            .Where(p => p.StartsOn <= today && today <= p.EndsOn)
            .ToList();

        if (live.Count == 0) return null;

        var first = live[0];

        return live.All(p => p.Rate == first.Rate
                             && string.Equals(p.Regime, first.Regime, StringComparison.Ordinal))
            ? first
            : null;
    }

    private static readonly Dictionary<string, StudentDebtBalanceKind> Moments = new(StringComparer.Ordinal)
    {
        ["SaldoActueel"] = StudentDebtBalanceKind.Current,
        ["SaldoEindeKalenderjaar"] = StudentDebtBalanceKind.YearEnd,
        ["SaldoStartAflosfase"] = StudentDebtBalanceKind.RepaymentStart,
        ["SaldoStartAanloopfase"] = StudentDebtBalanceKind.GracePeriodStart,
    };

    // not a cross-check on the total: entries are STUDIEFINANCIERING only, the components also cover ov-schuld and
    // over-payments; they coincide only on a loan-only account
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

                // the moment's own date: interest is calculated TO a day on the current balance, a phase begins ON a day
                On = Date(entry, "renteBerekendTot")
                     ?? Date(entry, "beginDatumAflosfase")
                     ?? Date(entry, "beginDatumAanloopfase"),

                Amount = amount,
                InterestPortion = Amount(entry, "saldoRentedeel", options),
                Rate = entry.Decimal("rentepercentage"),
                Label = entry.Text("vorderingsoortOmschrijving"),
            });
        }

        // chronological, current balance first, ties keep DUO's order: within a kind it is arbitrary (2020, 2022, 2021)
        return
        [
            .. stated
                .OrderBy(h => h.Kind == StudentDebtBalanceKind.Current ? 0 : 1)
                .ThenByDescending(h => h.Year ?? h.On?.Year ?? 0)
                .ThenByDescending(h => h.On ?? DateOnly.MinValue),
        ];
    }

    // "waarde" is a JSON document inside a JSON string: parsed, never pattern-matched
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

            // DUO says outright when it cannot work a figure out, which differs from the figure being absent
            if (entry.Flag("isNietTeBepalen")) return null;

            if (entry.Text("waarde") is not { } raw) continue;

            try
            {
                using var inner = JsonDocument.Parse(raw);

                if (inner.RootElement.Int32("value") is { } count) return count;
            }
            catch (JsonException)
            {
                // an unparseable nested document loses one field, not the fetch: this is enrichment
                return null;
            }
        }

        return null;
    }

    // only reached when the ledger was asked for; of the whole dossier only vorderingmutaties, vorderings labels
    // and one termijn are read
    private static (IReadOnlyList<StudentDebtEntry> Ledger, Money? Monthly, DateOnly? Due) Dossier(
        string? json, DateOnly today, DuoOptions options)
    {
        if (string.IsNullOrWhiteSpace(json)) return ([], null, null);

        using var document = Parse(json, options.DossierPath);

        if (document.RootElement.ValueKind != JsonValueKind.Object) return ([], null, null);

        var ledger = Ledger(document.RootElement, Debts(document.RootElement), options);
        var (monthly, due) = Instalment(document.RootElement, today, options);

        // newest first: DUO's order is database-arbitrary, interleaving 2016 and 2018 on a live payload
        return ([.. ledger.OrderByDescending(e => e.BookedOn)], monthly, due);
    }

    private static Dictionary<long, string> Debts(JsonElement dossier)
    {
        var debts = new Dictionary<long, string>();

        foreach (var claim in dossier.Items("vorderings").Objects())
        {
            if (claim.Int64("id") is not { } key) continue;
            if (claim.Child("vorderingsoort").Text("omschrijving") is not { } what) continue;

            debts[key] = what;
        }

        return debts;
    }

    private static List<StudentDebtEntry> Ledger(
        JsonElement dossier, Dictionary<long, string> debts, DuoOptions options)
    {
        var ledger = new List<StudentDebtEntry>();

        foreach (var movement in dossier.Items("vorderingmutaties").Objects())
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

        return ledger;
    }

    // by the month it is FOR, not the latest row: DUO carries instalments for future months
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
            // the fetch has already checked for an HTML sign-in page (it knows URL and status), so here it is a rebuilt endpoint
            throw ConnectorException.ProviderChanged($"{ProviderId}: {what} did not answer JSON: {ex.Message}");
        }
    }
}
