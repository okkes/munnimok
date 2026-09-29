using System.Globalization;
using System.Text.Json.Serialization;
using Connector.Kit.Errors;

namespace Connector.Kit.Normalization;

/// <summary>
/// Money is always minor units plus an ISO-4217 code. Never a float, never
/// a decimal that has been through a locale.
/// </summary>
public readonly record struct Money
{
    [JsonConstructor]
    public Money(long value, string currency)
    {
        Value = value;
        Currency = currency;
    }

    /// <summary>Minor units. Negative means money left the account.</summary>
    public long Value { get; init; }

    /// <summary>ISO-4217, uppercase.</summary>
    public string Currency { get; init; }

    public static Money Eur(long minorUnits) => new(minorUnits, "EUR");

    public static Money Zero(string currency = "EUR") => new(0, currency);

    public Money Negated() => this with { Value = -Value };

    public Money Abs() => Value < 0 ? Negated() : this;

    public static Money operator +(Money a, Money b)
    {
        EnsureSameCurrency(a, b);
        return a with { Value = a.Value + b.Value };
    }

    public static Money operator -(Money a, Money b)
    {
        EnsureSameCurrency(a, b);
        return a with { Value = a.Value - b.Value };
    }

    private static void EnsureSameCurrency(Money a, Money b)
    {
        if (!string.Equals(a.Currency, b.Currency, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"currency mismatch: {a.Currency} vs {b.Currency}");
        }
    }

    public override string ToString() =>
        string.Create(CultureInfo.InvariantCulture, $"{Value / 100m:0.00} {Currency}");
}

/// <summary>
/// How a provider represents an amount in a given field.
///
/// There is deliberately no "guess it" option. Every one of these APIs
/// represents money differently, and some are inconsistent between their
/// own endpoints. A heuristic that guesses wrong corrupts financial data
/// silently, which is the one failure mode worse than crashing - so each
/// adapter declares the unit per field and the result is checked against a
/// stated total (see <see cref="Reconciliation"/>).
/// </summary>
public enum MoneyUnit
{
    /// <summary>Already minor units: <c>1234</c> is 12.34.</summary>
    Minor,

    /// <summary>Major units with a fractional part: <c>12.34</c>.</summary>
    MajorDecimal,

    /// <summary>Major units as a string, possibly with a comma separator: <c>"12,34"</c>.</summary>
    MajorString,
}

public static class MoneyParser
{
    /// <summary>
    /// Converts a provider value to minor units under a declared unit. The
    /// unit is never inferred from the value's shape.
    /// </summary>
    public static long ToMinor(decimal raw, MoneyUnit unit) => unit switch
    {
        MoneyUnit.Minor => checked((long)decimal.Truncate(raw)),
        MoneyUnit.MajorDecimal or MoneyUnit.MajorString => checked((long)decimal.Round(raw * 100m, 0, MidpointRounding.AwayFromZero)),
        _ => throw new ArgumentOutOfRangeException(nameof(unit), unit, null),
    };

    /// <summary>
    /// Parses a provider string under a declared unit. Accepts both '.' and
    /// ',' as the decimal separator because Dutch providers use both, often
    /// within the same account, but refuses anything genuinely ambiguous
    /// rather than picking a reading.
    /// </summary>
    public static long ToMinor(string? raw, MoneyUnit unit, string field = "amount")
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged($"{field}: empty money value");
        }

        var cleaned = raw.Trim().Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("€", string.Empty, StringComparison.Ordinal);

        // "463,-" and "463.-" both mean 463 and no cents. See the remarks:
        // leaving the hyphen to the parser read it as a trailing MINUS and
        // returned negative 463.
        //
        // The hyphen becomes "00" rather than being deleted, because that
        // separator is still carrying information. Deleting it turns
        // "1.234,-" into "1.234", where the dot has silently changed from a
        // thousands group into a decimal point and 1234 euros becomes 1.23 -
        // which is the same class of quiet corruption in a smaller coat.
        if (cleaned.EndsWith(",-", StringComparison.Ordinal)
            || cleaned.EndsWith(".-", StringComparison.Ordinal))
        {
            cleaned = string.Concat(cleaned.AsSpan(0, cleaned.Length - 1), "00");
        }

        var hasDot = cleaned.Contains('.', StringComparison.Ordinal);
        var hasComma = cleaned.Contains(',', StringComparison.Ordinal);

        if (hasDot && hasComma)
        {
            // Whichever comes last is the decimal separator; the other is a
            // thousands grouping. "1.234,56" and "1,234.56" both resolve.
            var decimalSep = cleaned.LastIndexOf(',') > cleaned.LastIndexOf('.') ? ',' : '.';
            var groupSep = decimalSep == ',' ? '.' : ',';
            cleaned = cleaned.Replace(groupSep.ToString(), string.Empty, StringComparison.Ordinal)
                .Replace(decimalSep, '.');
        }
        else if (hasComma)
        {
            cleaned = cleaned.Replace(',', '.');
        }

        // NumberStyles.Number spelled out, MINUS AllowTrailingSign.
        //
        // Number includes it, and that inclusion is what turned "463,-" into
        // negative 463 after the comma became a dot. A leading sign stays -
        // a refund really is "-5,00" - but a hyphen at the END is not notation
        // this parser recognises now that the Dutch whole-euro suffix has been
        // taken off above, and the honest answer to something unrecognised is
        // to refuse it rather than to read it as arithmetic.
        const NumberStyles Money =
            NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite
            | NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint
            | NumberStyles.AllowThousands;

        if (!decimal.TryParse(cleaned, Money, CultureInfo.InvariantCulture, out var parsed))
        {
            // THE SHAPE, NOT THE FIGURE. This used to quote `raw`, which is a
            // balance or an amount straight out of somebody's bank - and the
            // detail on a ConnectorException is not a private thing: adapters
            // interpolate it into notes, which are now logged, written to the
            // job row and returned to the caller. A parse failure is diagnosed
            // from the shape anyway ("eight characters, not a number"), and the
            // one thing the shape cannot do is carry the amount out.
            throw ConnectorException.ProviderChanged(
                $"{field}: cannot parse a money value of {raw?.Length ?? 0} character(s) under {unit}");
        }

        return ToMinor(parsed, unit);
    }
}
