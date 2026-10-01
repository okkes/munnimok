using System.Globalization;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// Guessing wrong about cents-versus-euros corrupts financial data
/// silently, which is the one failure mode worse than crashing. The unit is
/// always declared; only the separator is inferred, and only where the
/// inference is unambiguous.
/// </summary>
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
    [InlineData("1.234,56", 123_456L)]           // nl-NL
    [InlineData("1,234.56", 123_456L)]           // en-US
    [InlineData("1.234.567,89", 123_456_789L)]
    [InlineData("1,234,567.89", 123_456_789L)]
    [InlineData("-1.234,56", -123_456L)]
    [InlineData("1 234,56", 123_456L)]           // space as the thousands group
    [InlineData("1 234,56", 123_456L)]      // no-break space, as an export writes it
    public void A_mixed_pair_resolves_by_whichever_separator_comes_last(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
    }

    [Theory]
    [InlineData("€12,34")]
    [InlineData("€ 12,34")]
    [InlineData("12,34 €")]
    [InlineData("  12,34  ")]
    [InlineData(" 12,34 ")]
    public void Currency_symbols_and_whitespace_are_stripped(string raw)
    {
        Assert.Equal(1234L, MoneyParser.ToMinor(raw, MoneyUnit.MajorString));
    }

    /// <summary>
    /// The Dutch whole-euro suffix, which was returning a NEGATIVE amount.
    ///
    /// "€ 463,-" is how a Dutch page writes four hundred and sixty-three euros
    /// and no cents. The comma branch rewrites the comma to a dot, giving
    /// "463.-", and <c>NumberStyles.Number</c> includes
    /// <c>AllowTrailingSign</c> - so .NET read the hyphen as a minus and this
    /// parser returned <b>-46300</b>. No exception, no warning, a perfectly
    /// well-formed negative.
    ///
    /// Nothing downstream would have caught it either: reconciliation compares
    /// a negative total against negative line items and agrees. It would have
    /// reached a user as a shop that refunds everything it sells.
    /// </summary>
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

    /// <summary>
    /// And a hyphen that is NOT that suffix is refused rather than read as
    /// arithmetic.
    ///
    /// Removing the suffix above is only safe because what remains cannot
    /// quietly mean something else. A trailing sign is no longer accepted at
    /// all, so "463-" - which is not notation any provider here uses - fails
    /// loudly instead of becoming minus 463.
    /// </summary>
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
    [InlineData("$12.34")]                       // a symbol we do not know
    [InlineData("12,34 EUR")]
    [InlineData("--12,34")]
    [InlineData("1.2e3")]
    public void Refuses_an_unparseable_value_as_provider_changed(string? raw)
    {
        var ex = Assert.Throws<ConnectorException>(() => MoneyParser.ToMinor(raw, MoneyUnit.MajorString));

        // Not Internal: the provider's shape moved and an adapter needs
        // fixing. That is the signal that pages an operator.
        Assert.Equal(ErrorCode.ProviderChanged, ex.Code);
        Assert.False(ex.Retriable);
    }

    /// <summary>
    /// The refusal names the FIELD and the SHAPE, and never the value.
    /// </summary>
    /// <remarks>
    /// This test used to assert the opposite - that the value was quoted - and
    /// the value in question is a balance or an amount out of somebody's bank.
    /// <para>
    /// What changed is where the detail goes. A <c>ConnectorException</c>'s
    /// detail is not a private diagnostic: adapters interpolate it into notes,
    /// and notes are now logged, written to the job row and returned to the
    /// caller. An ING agreement whose balance ING spells in a way this parser
    /// does not know would have put that figure through all three.
    /// </para>
    /// <para>
    /// Nothing is lost that anybody needed. A parse failure is diagnosed from
    /// the field, the shape and the declared unit - "eight characters under
    /// MajorString, not a number" says what to go and look at, and the one
    /// thing it cannot do is carry the amount out of the bank.
    /// </para>
    /// </remarks>
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
        // The one genuinely ambiguous case, and the parser picks rather than
        // refusing: with a single separator and three digits after it there
        // is nothing to distinguish a decimal point from a thousands group,
        // so BOTH of these read as one euro twenty-three - including the
        // dotted form a Dutch export writes for one thousand two hundred.
        //
        // This is why the money contract does not end at parsing. A provider
        // that means the other thing is caught by the stated total not
        // reconciling, which is the check that exists precisely because a
        // wrong reading here is silent.
        Assert.Equal(123L, MoneyParser.ToMinor("1,234", MoneyUnit.MajorString));
        Assert.Equal(123L, MoneyParser.ToMinor("1.234", MoneyUnit.MajorString));

        // Two decimal places leave no room for the ambiguity.
        Assert.Equal(123_400L, MoneyParser.ToMinor("1.234,00", MoneyUnit.MajorString));
        Assert.Equal(123_400L, MoneyParser.ToMinor("1,234.00", MoneyUnit.MajorString));
    }

    [Theory]
    [InlineData("12.345", 1235L)]                // half a cent rounds away from zero
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
    [InlineData("1234.9", 1234L)]                // a fractional minor unit does not exist
    [InlineData("-1234.9", -1234L)]
    public void A_decimal_in_minor_units_truncates(string raw, long expected)
    {
        Assert.Equal(expected, MoneyParser.ToMinor(Dec(raw), MoneyUnit.Minor));
    }

    [Fact]
    public void There_is_no_guess_it_unit()
    {
        // The absence is the feature. A fourth member would weaken the
        // adapter contract "declare the unit per field" to a suggestion.
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
        // The hazard the declared unit exists to remove: "1234" is either
        // 12.34 or 1234.00 and nothing in the string says which.
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
