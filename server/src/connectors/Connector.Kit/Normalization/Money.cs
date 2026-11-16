using System.Globalization;
using System.Text.Json.Serialization;
using Connector.Kit.Errors;

namespace Connector.Kit.Normalization;

// minor units plus an ISO-4217 code; never a float, never a decimal that went through a locale
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

// no "guess it" option: a wrong guess corrupts money silently, so each adapter declares the unit per field and the
// result is checked against a stated total (Reconciliation)
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
    public static long ToMinor(decimal raw, MoneyUnit unit) => unit switch
    {
        MoneyUnit.Minor => checked((long)decimal.Truncate(raw)),
        MoneyUnit.MajorDecimal or MoneyUnit.MajorString => checked((long)decimal.Round(raw * 100m, 0, MidpointRounding.AwayFromZero)),
        _ => throw new ArgumentOutOfRangeException(nameof(unit), unit, null),
    };

    // accepts '.' and ',' as the decimal separator (Dutch providers use both, even within one account); refuses the ambiguous
    public static long ToMinor(string? raw, MoneyUnit unit, string field = "amount")
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged($"{field}: empty money value");
        }

        var cleaned = raw.Trim().Replace("\u00A0", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("€", string.Empty, StringComparison.Ordinal);

        // "463,-" and "463.-" mean 463, no cents; the hyphen becomes "00", not deleted: deleting turns "1.234,-" into "1.234",
        // where the dot becomes a decimal point and 1234 euros reads as 1.23
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

        // NumberStyles.Number minus AllowTrailingSign: it read "463,-" as negative 463; a leading sign stays (a refund is
        // "-5,00"), but a trailing hyphen is refused rather than read as arithmetic
        const NumberStyles Money =
            NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite
            | NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint
            | NumberStyles.AllowThousands;

        if (!decimal.TryParse(cleaned, Money, CultureInfo.InvariantCulture, out var parsed))
        {
            // the shape, not the figure: adapters interpolate exception detail into notes that are logged, stored on the job row
            // and returned to the caller, so it must not carry an amount out of somebody's bank
            throw ConnectorException.ProviderChanged(
                $"{field}: cannot parse a money value of {raw?.Length ?? 0} character(s) under {unit}");
        }

        return ToMinor(parsed, unit);
    }
}
