using System.Globalization;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests;

// guessing cents vs euros corrupts silently: the unit is always declared, only the separator is inferred, where unambiguous
public sealed class MoneyParserTests
{
    private static decimal Dec(string raw) => decimal.Parse(raw, CultureInfo.InvariantCulture);

    [Theory]
    [InlineData("1234", 1234L)]
    [InlineData("0", 0L)]
    [InlineData("-4231", -4231L)]
    public void Minor_units_pass_through_untouched(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.Minor));
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.Minor));
    }

    [Theory]
    [InlineData("12.34", 1234L)]
    [InlineData("12,34", 1234L)]
    [InlineData("0.05", 5L)]
    [InlineData("0,05", 5L)]
    [InlineData("-12,34", -1234L)]
    [InlineData("-12.34", -1234L)]
    [InlineData("+12.34", 1234L)]
    [InlineData("100", 10_000L)]
    public void Major_units_accept_either_decimal_separator(string raw, long expected)
    {
        // Dutch providers use both, sometimes within one account.
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorDecimal));
    }

    [Theory]
    [InlineData("1.234,56", 123_456L)]
    [InlineData("1,234.56", 123_456L)]
    [InlineData("1.234.567,89", 123_456_789L)]
    [InlineData("1,234,567.89", 123_456_789L)]
    [InlineData("-1.234,56", -123_456L)]
    [InlineData("1 234,56", 123_456L)]
    [InlineData("1\u00A0234,56", 123_456L)]
    public void A_mixed_pair_resolves_by_whichever_separator_comes_last(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
    }

    [Theory]
    [InlineData("€12,34")]
    [InlineData("€ 12,34")]
    [InlineData("12,34 €")]
    [InlineData("  12,34  ")]
    [InlineData("\u00A012,34\u00A0")]
    public void Currency_symbols_and_whitespace_are_stripped(string raw)
    {
        Assert.Equal(1234L, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
    }

    // "€ 463,-" is whole euros; the comma became a dot and NumberStyles.Number's AllowTrailingSign read "463.-" as a minus,
    // returning -46300 with no error, which would reach a user as a shop that refunds everything it sells
    [Theory]
    [InlineData("463,-", 46_300L)]
    [InlineData("€ 463,-", 46_300L)]
    [InlineData("€463,-", 46_300L)]
    [InlineData("1.234,-", 123_400L)]
    [InlineData("463.-", 46_300L)]
    [InlineData("0,-", 0L)]
    public void A_dutch_whole_euro_amount_is_positive(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
    }

    // a trailing sign is no longer accepted, so "463-" fails loudly instead of becoming minus 463
    [Theory]
    [InlineData("463-")]
    [InlineData("12,34-")]
    [InlineData("1.234,56-")]
    public void A_trailing_sign_is_not_a_number_this_parser_knows(string raw)
    {
        Assert.Equal(
            ErrorCode.ProviderChanged,
            Assert.Throws<ConnectorException>(() => MoneyParser.ToMinor(raw, MoneyUnit.MajorString)).Code);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("abc")]
    [InlineData("12.34.56")]                     // two dots, no comma to disambiguate
    [InlineData("1,234,567")]                    // group separators with no decimal at all
    [InlineData("$12.34")]
    [InlineData("12,34 EUR")]
    [InlineData("--12,34")]
    [InlineData("1.2e3")]
    public void Refuses_an_unparseable_value_as_provider_changed(string? raw)
    {
        var ex = Assert.Throws<ConnectorException>(() => MoneyParser.ToMinor(raw, MoneyUnit.MajorString));

        // ProviderChanged, not Internal: the provider's shape moved; that is the signal that pages an operator
        Assert.Equal(ErrorCode.ProviderChanged, ex.Code);
        Assert.False(ex.Retriable);
    }

    // the refusal names field and shape, never the value: a ConnectorException's detail goes into notes that are logged,
    // written to the job row and returned to the caller, and the value is a bank amount
    [Fact]
    public void The_refusal_names_the_field_and_the_shape_but_never_the_value()
    {
        var ex = Assert.Throws<ConnectorException>(
            () => MoneyParser.ToMinor("1.730,01 EUR", MoneyUnit.MajorString, field: "receipt.total"));

        Assert.Contains("receipt.total", ex.Message, StringComparison.Ordinal);
        Assert.Contains("12 character", ex.Message, StringComparison.Ordinal);
        Assert.Contains("MajorString", ex.Message, StringComparison.Ordinal);

        Assert.DoesNotContain("1.730,01", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("1730", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_lone_separator_is_always_read_as_the_decimal_point()
    {
        // the one ambiguous case: a single separator with three digits reads as a decimal point, so "1.234" is 1.23, also for a
        // Dutch export meaning 1200; a provider meaning the other is caught by the stated total not reconciling
        Assert.Equal(123L, MoneyParser.ToMinor("1,234", MoneyUnit.MajorString));
        Assert.Equal(123L, MoneyParser.ToMinor("1.234", MoneyUnit.MajorString));

        Assert.Equal(123_400L, MoneyParser.ToMinor("1.234,00", MoneyUnit.MajorString));
        Assert.Equal(123_400L, MoneyParser.ToMinor("1,234.00", MoneyUnit.MajorString));
    }

    [Theory]
    [InlineData("12.345", 1235L)]
    [InlineData("-12.345", -1235L)]
    [InlineData("12.344", 1234L)]
    [InlineData("0.005", 1L)]
    public void Rounds_half_away_from_zero(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorDecimal));
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.MajorDecimal));
    }

    [Theory]
    [InlineData("12.34", 1234L)]
    [InlineData("-12.34", -1234L)]
    [InlineData("0.1", 10L)]
    [InlineData("1234.0", 123_400L)]
    public void A_decimal_in_major_units_scales_by_a_hundred(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.MajorDecimal));
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.MajorString));
    }

    [Theory]
    [InlineData("1234.0", 1234L)]
    [InlineData("1234.9", 1234L)]
    [InlineData("-1234.9", -1234L)]
    public void A_decimal_in_minor_units_truncates(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.Minor));
    }

    [Fact]
    public void There_is_no_guess_it_unit()
    {
        // the absence is the feature: a fourth member would weaken "declare the unit per field" to a suggestion
        Assert.Equal(
            new[] { MoneyUnit.Minor, MoneyUnit.MajorDecimal, MoneyUnit.MajorString },
            Enum.GetValues<MoneyUnit>());
    }

    [Fact]
    public void An_undeclared_unit_throws_rather_than_defaulting()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => MoneyParser.ToMinor(1m, (MoneyUnit)42));
    }

    [Fact]
    public void The_same_digits_under_two_units_are_two_different_amounts()
    {
        Assert.NotEqual(
            MoneyParser.ToMinor("1234", MoneyUnit.Minor),
            MoneyParser.ToMinor("1234", MoneyUnit.MajorString));
    }

    [Fact]
    public void Money_arithmetic_refuses_to_mix_currencies()
    {
        var eur = Money.Eur(1000);
        var usd = new Money(1000, "USD");

        Assert.Throws<InvalidOperationException>(() => eur + usd);
        Assert.Throws<InvalidOperationException>(() => eur - usd);
        Assert.Equal(Money.Eur(2000), eur + Money.Eur(1000));
        Assert.Equal(Money.Eur(-1000), Money.Zero() - eur);
        Assert.Equal(Money.Eur(1000), Money.Eur(-1000).Abs());
        Assert.Equal(Money.Eur(-1000), eur.Negated());
    }
}
