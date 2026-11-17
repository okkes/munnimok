using System.Text;
using System.Text.Json;

namespace BankConnector.Adapters.Ing;

// the shape of a payload with none of its values (strings as their length), for payloads nobody may read
// a fetch emits a note of it when IngAccounts.ReadAgreements stops making sense of what arrives
internal static partial class IngSchema
{
    // quoted rather than measured: a product taxonomy (kind, status, identifier type), none about a person
    // value (IBAN, balance), holderName and displayAlias stay lengths on purpose
    private static readonly HashSet<string> Taxonomy =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "type", "subType", "group", "status", "role",
            "identifierType", "productType", "productFamily", "iconId",
        };

    public static string Describe(JsonElement element, int maxChars = 2_400)
    {
        var text = new StringBuilder();
        Write(element, text, depth: 0, maxChars, key: null);

        return text.Length > maxChars ? string.Concat(text.ToString(0, maxChars), "…") : text.ToString();
    }

    // two locks: the key is a taxonomy name AND the value looks like a code, so a name under "type" gets a length
    private static bool Quotable(string? key, string? value) =>
        key is not null && value is not null && Taxonomy.Contains(key) && IsCode(value);

    // the second lock alone, so other diagnostics quoting a provider value use the same rule
    public static bool IsCode(string? value) => value is not null && Token().IsMatch(value);

    [System.Text.RegularExpressions.GeneratedRegex(
        "^[A-Za-z0-9_.-]{1,24}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
    private static partial System.Text.RegularExpressions.Regex Token();

    private static void Write(JsonElement element, StringBuilder text, int depth, int maxChars, string? key)
    {
        if (text.Length >= maxChars) return;

        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                WriteObject(element, text, depth, maxChars);
                break;

            case JsonValueKind.Array:
                WriteArray(element, text, depth, maxChars, key);
                break;

            // the one place a value can escape, through two locks (Quotable); everything else gets its length
            case JsonValueKind.String:
                if (Quotable(key, element.GetString()))
                {
                    text.Append('"').Append(element.GetString()).Append('"');
                }
                else
                {
                    text.Append("string(").Append(element.GetString()?.Length ?? 0).Append(')');
                }

                break;

            case JsonValueKind.Number:
                text.Append("number");
                break;

            case JsonValueKind.True or JsonValueKind.False:
                text.Append("bool");
                break;

            default:
                text.Append("null");
                break;
        }
    }

    private static void WriteObject(JsonElement element, StringBuilder text, int depth, int maxChars)
    {
        // deep enough to reach an account's own fields, shallow enough that action links do not fill the line
        if (depth >= 5)
        {
            text.Append("{…}");
            return;
        }

        text.Append('{');

        var first = true;

        foreach (var property in element.EnumerateObject())
        {
            if (text.Length >= maxChars) break;
            if (!first) text.Append(',');

            first = false;
            text.Append(property.Name).Append(':');
            Write(property.Value, text, depth + 1, maxChars, property.Name);
        }

        text.Append('}');
    }

    // merged rather than sampled: the first entry may lack fields the others have, hiding what is optional
    private static void WriteArray(
        JsonElement element, StringBuilder text, int depth, int maxChars, string? key)
    {
        var count = element.GetArrayLength();

        text.Append('[').Append(count);

        if (count == 0 || depth >= 5)
        {
            text.Append(']');
            return;
        }

        text.Append(" x ");

        var merged = Merge(element, key);

        if (!merged.AnyObject)
        {
            if (merged.Plain.Count > 0) text.Append(Quote(merged.Plain));
            else Write(merged.Scalar, text, depth + 1, maxChars, key);

            text.Append(']');
            return;
        }

        text.Append('{');
        WriteMerged(merged, text, depth, maxChars);
        text.Append("}]");
    }

    private sealed class MergedShape
    {
        public Dictionary<string, JsonElement> Fields { get; } = new(StringComparer.Ordinal);

        public Dictionary<string, List<string>> Codes { get; } = new(StringComparer.Ordinal);

        public List<string> Plain { get; } = [];

        public JsonElement Scalar { get; set; }

        public bool AnyObject { get; set; }
    }

    private static MergedShape Merge(JsonElement element, string? key)
    {
        var merged = new MergedShape();

        foreach (var entry in element.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                merged.Scalar = entry;

                // a bare list of codes states all of them: which values a taxonomy field takes is what a reader needs
                if (entry.ValueKind == JsonValueKind.String && Quotable(key, entry.GetString()))
                {
                    Add(merged.Plain, entry.GetString()!);
                }

                continue;
            }

            merged.AnyObject = true;
            MergeObject(entry, merged);
        }

        return merged;
    }

    private static void MergeObject(JsonElement entry, MergedShape merged)
    {
        foreach (var property in entry.EnumerateObject())
        {
            // every value a taxonomy field takes across every entry: the first alone would hide the types that answer the question
            if (property.Value.ValueKind == JsonValueKind.String
                && Quotable(property.Name, property.Value.GetString()))
            {
                if (!merged.Codes.TryGetValue(property.Name, out var seen)) merged.Codes[property.Name] = seen = [];

                Add(seen, property.Value.GetString()!);
                continue;
            }

            // First non-null wins, so a field that is null on one entry and
            // an object on another is described by the useful one.
            if (!merged.Fields.TryGetValue(property.Name, out var held) || held.ValueKind == JsonValueKind.Null)
            {
                merged.Fields[property.Name] = property.Value;
            }
        }
    }

    private static void WriteMerged(MergedShape merged, StringBuilder text, int depth, int maxChars)
    {
        var first = true;

        foreach (var (name, values) in merged.Codes)
        {
            if (text.Length >= maxChars) break;
            if (!first) text.Append(',');

            first = false;
            text.Append(name).Append(':').Append(Quote(values));
        }

        foreach (var (name, value) in merged.Fields)
        {
            if (text.Length >= maxChars) break;
            if (!first) text.Append(',');

            first = false;
            text.Append(name).Append(':');
            Write(value, text, depth + 1, maxChars, name);
        }
    }

    private static void Add(List<string> codes, string code)
    {
        if (!codes.Contains(code, StringComparer.Ordinal)) codes.Add(code);
    }

    private static string Quote(List<string> codes) => "\"" + string.Join("|", codes) + "\"";
}
