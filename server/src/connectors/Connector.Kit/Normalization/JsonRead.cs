using System.Text.Json;

namespace Connector.Kit.Normalization;

// TryGet* THROW InvalidOperationException on a wrong element kind (a null where an object was expected), past every
// JsonException catch, surfacing as retriable internal (GraphQL "items": [null]); so every read here never throws.
// Exact names on purpose: a renamed bank field is a changed contract, not to be found under another spelling
public static class JsonRead
{
    // an undefined element answers every read below with null, so a chain can be walked without a guard at each step
    public static JsonElement Child(this JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value)
            ? value
            : default;

    // an explicit null answers false, as an absent field does
    public static bool Has(this JsonElement parent, string name, out JsonElement value)
    {
        value = parent.Child(name);
        return value.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null);
    }

    // BLANK IS NOT A VALUE: ING's credit card states id as "" on every row; providers pad strings, changing a content hash
    public static string? Text(this JsonElement parent, string name) => Text(parent.Child(name));

    public static string? Text(this JsonElement value) =>
        value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!.Trim()
            : null;

    public static int? Int32(this JsonElement parent, string name) => parent.Child(name).Int32();

    public static int? Int32(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var stated) ? stated : null;

    public static long? Int64(this JsonElement parent, string name) => parent.Child(name).Int64();

    public static long? Int64(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var stated) ? stated : null;

    // never double: money is not a float anywhere on this platform
    public static decimal? Decimal(this JsonElement parent, string name) => parent.Child(name).Decimal();

    public static decimal? Decimal(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var stated) ? stated : null;

    // only the JSON literal true: a flag decides whether a row is published (ING skips reservation: true), so look-alikes
    // would change a statement
    public static bool Flag(this JsonElement parent, string name) =>
        parent.Child(name).ValueKind == JsonValueKind.True;

    // empty rather than a throw: an absent collection is ordinary, not drift; a caller for whom absence IS drift asks with Has
    public static IEnumerable<JsonElement> Items(this JsonElement parent, string name)
    {
        var array = parent.Child(name);

        return array.ValueKind == JsonValueKind.Array ? array.EnumerateArray() : [];
    }

    // GraphQL "items": [null] threw in every loop reading a field off each entry; filtering costs that row, not its page
    public static IEnumerable<JsonElement> Objects(this IEnumerable<JsonElement> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);

        return entries.Where(entry => entry.ValueKind == JsonValueKind.Object);
    }
}
