using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Amazon;

// unit and currency are declared by the caller, never sniffed; amazon-orders strips commas and treats '.' as decimal,
// so "€ 12,50" becomes 1250.0 without throwing: never port that regex
internal static partial class AmazonMoney
{
    [GeneratedRegex(@"^\d{1,3}(?:\.\d{3})+$")]
    private static partial Regex DutchGrouping { get; }

    [GeneratedRegex(@"^\d{1,3}(?:,\d{3})+$")]
    private static partial Regex EnglishGrouping { get; }

    [GeneratedRegex(@"^[0-9.,]+$")]
    private static partial Regex DigitsAndSeparators { get; }

    // currency alternation is wider than the accepted tokens on purpose:
    // a dollar amount must read as "not euros", not as "no total on the card"
    [GeneratedRegex(@"(?:EUR|USD|GBP|CHF|SEK|PLN|[€$£¥₹])\s*-?\s*[0-9][0-9.,]*"
                    + @"|-?\s*[0-9][0-9.,]*\s*(?:EUR|USD|GBP|CHF|SEK|PLN|[€$£¥₹])")]
    private static partial Regex AmountInText { get; }

    public static Money Parse(string? raw, MoneyUnit unit, string currency, string field, AmazonOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged($"{AmazonAdapter.ProviderId}: {field} is empty");
        }

        var text = HtmlText.Normalize(raw);
        var negative = IsNegative(text);
        var digits = StripCurrency(text, field, options);

        return new Money(MoneyParser.ToMinor(Normalize(digits), unit, field) * (negative ? -1 : 1), currency);
    }

    public static Money? Find(string? raw, MoneyUnit unit, string currency, string field, AmazonOptions options)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var text = HtmlText.Normalize(raw);
        var match = AmountInText.Match(text);
        if (!match.Success) return null;

        var negative = IsNegativeAt(text, match);
        var digits = StripCurrency(match.Value, field, options);
        var value = MoneyParser.ToMinor(Normalize(digits), unit, field);

        return new Money(negative ? -value : value, currency);
    }

    // the label is everything before the amount, so a row survives one cell, two cells or a definition list
    public static (string Label, Money? Amount) Row(
        string? raw, MoneyUnit unit, string currency, string field, AmazonOptions options)
    {
        if (string.IsNullOrWhiteSpace(raw)) return (string.Empty, null);

        var text = HtmlText.Normalize(raw);
        var match = AmountInText.Match(text);
        if (!match.Success) return (text, null);

        // "Actiekorting: -€ 9,99" leaves "Actiekorting: -" behind, which must not end up in an item name
        var label = text[..match.Index].Trim().TrimEnd(':', '-', '−', ' ');
        var negative = IsNegativeAt(text, match);
        var value = MoneyParser.ToMinor(Normalize(StripCurrency(match.Value, field, options)), unit, field);

        return (label, new Money(negative ? -value : value, currency));
    }

    private static bool IsNegative(string text) =>
        text.Contains('-', StringComparison.Ordinal)
        || text.Contains('−', StringComparison.Ordinal)     // minus sign
        || (text.Contains('(', StringComparison.Ordinal) && text.Contains(')', StringComparison.Ordinal));

    // judged from the token and the char just before it, never the whole line: "Btw-bedrag" would read as a credit
    private static bool IsNegativeAt(string text, Match match)
    {
        if (IsNegative(match.Value)) return true;

        var i = match.Index - 1;
        while (i >= 0 && char.IsWhiteSpace(text[i])) i--;

        if (i < 0) return false;
        if (text[i] is '-' or '−') return true;

        var after = text.AsSpan(match.Index + match.Length).TrimStart();
        return text[i] == '(' && after.Length > 0 && after[0] == ')';
    }

    // refuses tokens outside CurrencyTokens so a non-euro order is never recorded as euros; a symbol never names a currency
    private static string StripCurrency(string text, string field, AmazonOptions options)
    {
        var stripped = text;
        foreach (var token in options.CurrencyTokens)
        {
            stripped = stripped.Replace(token, string.Empty, StringComparison.OrdinalIgnoreCase);
        }

        stripped = stripped
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace("(", string.Empty, StringComparison.Ordinal)
            .Replace(")", string.Empty, StringComparison.Ordinal)
            .Replace("+", string.Empty, StringComparison.Ordinal)
            .Replace("-", string.Empty, StringComparison.Ordinal)
            .Replace("−", string.Empty, StringComparison.Ordinal);

        if (!DigitsAndSeparators.IsMatch(stripped))
        {
            throw ConnectorException.ProviderChanged(
                $"{AmazonAdapter.ProviderId}: {field} '{text}' is not an amount in " +
                $"[{string.Join(", ", options.CurrencyTokens)}]; " +
                "an amount in another currency must not be recorded as one in this one");
        }

        return stripped;
    }

    // a lone separator is read as the decimal point, wrong for whole-euro grouping ("€ 1.234" would become 1.234, no throw).
    // resolved by anchored shape: exactly three digits after every separator and no second kind of separator
    private static string Normalize(string digits)
    {
        if (DutchGrouping.IsMatch(digits))
        {
            return digits.Replace(".", string.Empty, StringComparison.Ordinal);
        }

        if (EnglishGrouping.IsMatch(digits))
        {
            return digits.Replace(",", string.Empty, StringComparison.Ordinal);
        }

        return digits;
    }
}
