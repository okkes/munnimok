using System.Text.Json;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace ShopConnector.Adapters.Support;

/// no overload inspects the value: providers differ (one is inconsistent between its own endpoints) and a heuristic
/// corrupts money silently. The declared unit governs and Reconciliation checks the result.
internal static class MoneyReader
{
    public static Money Read(JsonElement element, MoneyUnit unit, string currency, string field) => element.ValueKind switch
    {
        JsonValueKind.Number => new Money(MoneyParser.ToMinor(element.GetDecimal(), unit), currency),
        JsonValueKind.String => new Money(MoneyParser.ToMinor(element.GetString(), unit, field), currency),
        _ => throw ConnectorException.ProviderChanged($"{field}: expected a money value, got {element.ValueKind}"),
    };

    /// amounts arrive as 12.34, {"amount": 12.34} or nested twice, sometimes across endpoints of one API
    public static Money? Optional(JsonElement parent, MoneyUnit unit, string currency, string field, params string[] names)
    {
        if (!JsonAccess.TryProp(parent, out var value, names)) return null;
        return Unwrap(value, unit, currency, field);
    }

    public static Money Require(JsonElement parent, MoneyUnit unit, string currency, string field, params string[] names) =>
        Optional(parent, unit, currency, field, names)
        ?? throw ConnectorException.ProviderChanged($"{field}: no amount under any of [{string.Join(", ", names)}]");

    private static Money? Unwrap(JsonElement value, MoneyUnit unit, string currency, string field)
    {
        for (var depth = 0; depth < 3 && value.ValueKind == JsonValueKind.Object; depth++)
        {
            if (!JsonAccess.TryProp(value, out var inner, "amount", "value", "gross", "total")) return null;
            value = inner;
        }

        return value.ValueKind is JsonValueKind.Number or JsonValueKind.String
            ? Read(value, unit, currency, field)
            : null;
    }

    /// never inferred from a symbol: "$" is at least four currencies
    public static string Currency(JsonElement parent, string fallback)
    {
        if (!JsonAccess.TryProp(parent, out var value, "currency", "currencyCode", "isoCode")) return fallback;

        var code = value.ValueKind == JsonValueKind.Object
            ? JsonAccess.StrOf(value, "code", "isoCode", "currencyCode")
            : JsonAccess.Str(value);

        return code is { Length: 3 } ? code.ToUpperInvariant() : fallback;
    }
}
