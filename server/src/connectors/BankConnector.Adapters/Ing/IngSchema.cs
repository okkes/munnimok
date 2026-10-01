using System.Text;
using System.Text.Json;

namespace BankConnector.Adapters.Ing;

/// <summary>
/// The SHAPE of a payload, with none of its contents.
///
/// Written for a payload nobody is allowed to read. ING's overview lists every
/// account somebody has - current, savings, credit cards, loans - and renders
/// them from one call, <c>/global/agreements</c>. The capture that this adapter
/// was built from deliberately did not save that response: the recorder ran
/// against an account with real money in it and withheld anything it had no
/// stated reason to keep, which was the right trade.
///
/// So this states the structure and refuses the values: keys, nesting, array
/// lengths, and for a string its LENGTH rather than its text. That is enough to
/// tell an eighteen-character IBAN from a seven-character product code and to
/// write a reader against, and it cannot carry a name, an account number or a
/// balance out of somebody's bank into a log.
///
/// It worked: one live run through this is what
/// <see cref="IngAccounts.ReadAgreements"/> was written from, and it stays here
/// for the next time - a note from this is what a fetch emits when that reader
/// stops making sense of what arrives.
/// </summary>
internal static partial class IngSchema
{
    /// <summary>
    /// The handful of keys whose VALUE is stated rather than measured.
    /// </summary>
    /// <remarks>
    /// A structure alone was not enough. The first live report said an account
    /// list holds seven agreements, each with a seven-character <c>type</c> - and
    /// which seven-character word means "savings" is the entire question a
    /// reader has to answer. Lengths cannot answer it.
    /// <para>
    /// So these, and only these, are named: they are a product taxonomy - what
    /// KIND of thing an agreement is, whether it is open, what sort of
    /// identifier it carries. None of them is about a person. Everything else
    /// stays a length, which matters most for the keys deliberately absent here:
    /// <c>value</c> is the IBAN under <c>commercialId</c> and the balance under
    /// <c>balance</c>, <c>holderName</c> is the account holder, and
    /// <c>displayAlias</c> is the name they gave their own savings pot.
    /// </para>
    /// </remarks>
    private static readonly HashSet<string> Taxonomy =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "type", "subType", "group", "status", "role",
            "identifierType", "productType", "productFamily", "iconId",
        };

    /// <summary>
    /// A one-line type signature, capped.
    /// </summary>
    /// <param name="element">The payload.</param>
    /// <param name="maxChars">
    /// Where to stop. A schema that fills an operator's terminal is one nobody
    /// reads, and the interesting part of an ING payload is the first level or
    /// two.
    /// </param>
    public static string Describe(JsonElement element, int maxChars = 2_400)
    {
        var text = new StringBuilder();
        Write(element, text, depth: 0, maxChars, key: null);

        return text.Length > maxChars ? string.Concat(text.ToString(0, maxChars), "…") : text.ToString();
    }

    /// <summary>
    /// May this string be quoted rather than measured?
    /// </summary>
    /// <remarks>
    /// Two locks, not one. The key has to be a taxonomy name AND the value has
    /// to look like a code - short, and made only of letters, digits, dots,
    /// dashes and underscores. A bank that one day puts a person's name under a
    /// key called "type" gets a length, because the second lock holds when the
    /// first assumption stops being true.
    /// </remarks>
    private static bool Quotable(string? key, string? value) =>
        key is not null && value is not null && Taxonomy.Contains(key) && IsCode(value);

    /// <summary>
    /// Does this look like a code rather than something somebody wrote?
    /// </summary>
    /// <remarks>
    /// The second of this file's two locks, on its own, so a diagnostic
    /// elsewhere that wants to quote a provider's value can be held to the same
    /// rule rather than inventing a looser one. Short, and made only of
    /// letters, digits, dots, dashes and underscores - which a name, an address
    /// or a remittance line is not.
    /// </remarks>
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

            // The one place a value could escape, and it only does through two
            // locks - see Quotable. Everything else gets its LENGTH, which
            // distinguishes an IBAN from a product code without being one.
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
        // Deep enough to reach an account's own fields, shallow enough that a
        // bank's action links do not fill the line.
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

    /// <summary>
    /// An array as its length plus ONE merged element shape.
    /// </summary>
    /// <remarks>
    /// Merged rather than sampled: an account list is exactly the case where
    /// the first entry has fields the others do not - a savings account states
    /// a target, a current account does not - and describing only the first
    /// would hide the fields a reader has to treat as optional.
    /// </remarks>
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

    /// <summary>
    /// Every entry of one array, folded into one shape.
    /// </summary>
    private sealed class MergedShape
    {
        /// <summary>Each object field by name, described by its first non-null value.</summary>
        public Dictionary<string, JsonElement> Fields { get; } = new(StringComparer.Ordinal);

        /// <summary>Every value a taxonomy field took, across every entry.</summary>
        public Dictionary<string, List<string>> Codes { get; } = new(StringComparer.Ordinal);

        /// <summary>The codes of a bare list of them.</summary>
        public List<string> Plain { get; } = [];

        /// <summary>The last scalar entry, for a bare list of anything else.</summary>
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

                // A bare list of codes states all of them: which values a
                // taxonomy field can take is exactly what a reader needs, and
                // "[3 x string(10)]" says nothing at all.
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
            // EVERY value a taxonomy field takes, ACROSS EVERY ENTRY. This
            // is the whole reason the probe was widened: an account list of
            // seven agreements has several types between them, and taking
            // the first would report one and hide the ones that answer the
            // question.
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

    /// <summary>The merged shape's fields: the taxonomy codes first, then everything else.</summary>
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

    /// <summary>Distinct, and in the order ING listed them.</summary>
    private static void Add(List<string> codes, string code)
    {
        if (!codes.Contains(code, StringComparer.Ordinal)) codes.Add(code);
    }

    private static string Quote(List<string> codes) => "\"" + string.Join("|", codes) + "\"";
}
