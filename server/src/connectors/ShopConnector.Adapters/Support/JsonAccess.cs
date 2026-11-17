using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Support;

/// retailers rename and re-case fields unannounced, so aliases and extra fields are tolerated; money is the one
/// exception and is never inferred (MoneyReader)
internal static partial class JsonAccess
{
    /// providers write "2", "2 x", "0,750 kg" and "1.000" for the same quantity
    [GeneratedRegex(@"-?\d+(?:[.,]\d+)?")]
    private static partial Regex NumericToken { get; }

    /// exact matches beat case-insensitive ones; name order is preference order, so put the confirmed spelling first
    public static bool TryProp(JsonElement parent, out JsonElement value, params string[] names)
    {
        value = default;
        if (parent.ValueKind != JsonValueKind.Object) return false;

        foreach (var name in names)
        {
            if (parent.TryGetProperty(name, out var exact) && exact.ValueKind != JsonValueKind.Null)
            {
                value = exact;
                return true;
            }
        }

        foreach (var name in names)
        {
            foreach (var property in parent.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.Null) continue;
                if (!string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)) continue;

                value = property.Value;
                return true;
            }
        }

        return false;
    }

    public static bool TryPath(JsonElement root, string path, out JsonElement value)
    {
        value = root;
        foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!TryProp(value, out var next, segment))
            {
                value = default;
                return false;
            }

            value = next;
        }

        return true;
    }

    public static string? Str(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number => element.GetRawText(),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => null,
    };

    public static string? StrOf(JsonElement parent, params string[] names) =>
        TryProp(parent, out var value, names) ? Str(value) : null;

    /// loose parsing is safe because a quantity is never money: a misread one fails reconciliation loudly
    public static decimal? Quantity(JsonElement parent, params string[] names)
    {
        if (!TryProp(parent, out var value, names)) return null;
        if (value.ValueKind == JsonValueKind.Number) return value.Decimal();

        var raw = Str(value);
        if (raw is null) return null;

        var match = NumericToken.Match(raw);
        if (!match.Success) return null;

        return decimal.TryParse(match.Value.Replace(',', '.'), NumberStyles.Number,
            CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    /// empty list, not a throw: an absent collection is normal (a receipt with no discounts), not a shape change
    public static IReadOnlyList<JsonElement> Array(JsonElement parent, params string[] names)
    {
        if (!TryProp(parent, out var value, names) || value.ValueKind != JsonValueKind.Array) return [];
        return [.. value.EnumerateArray()];
    }

    public static IReadOnlyList<JsonElement> AsArray(JsonElement element) =>
        element.ValueKind == JsonValueKind.Array ? [.. element.EnumerateArray()] : [];

    /// last digits of a masked instrument ("XXXX1234"); null stays null so the consumer knows its match is weaker
    public static string? Tail(string? masked, int count = 4)
    {
        if (string.IsNullOrWhiteSpace(masked)) return null;

        var digits = new string([.. masked.Where(char.IsAsciiDigit)]);
        return digits.Length >= count ? digits[^count..] : null;
    }
}
