using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Bol;

// shared so both shapes produce the same receipts (a test compares them) with no drift in "card" or line totals
internal static class BolNormalize
{
    // a line total from the unit price: the provider's quantity multiplies, and none means a single unit
    public static Money Extended(Money unit, decimal? quantity)
    {
        var count = quantity is > 0 ? decimal.Round(quantity.Value, 3, MidpointRounding.AwayFromZero) : 1m;
        return unit with { Value = (long)decimal.Round(unit.Value * count, 0, MidpointRounding.AwayFromZero) };
    }

    // never invented: unrecognised text is other, no text stays null (a weaker bank match, not a guess); "achteraf betalen"
    // is pay-later, settling days after the order, and would otherwise look like a missing payment
    public static string? Method(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        if (raw.Contains("ideal", StringComparison.OrdinalIgnoreCase)) return "ideal";

        if (raw.Contains("achteraf", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("factuur", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("invoice", StringComparison.OrdinalIgnoreCase))
        {
            return "invoice";
        }

        if (raw.Contains("cadeaubon", StringComparison.OrdinalIgnoreCase) ||
            raw.Contains("gift", StringComparison.OrdinalIgnoreCase))
        {
            return "giftcard";
        }

        return raw.Contains("creditcard", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("credit card", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("visa", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("mastercard", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("maestro", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains("pin", StringComparison.OrdinalIgnoreCase)
            ? "card"
            : "other";
    }
}
