using System.Text.Json;

namespace Connector.Kit.Normalization;

/// <summary>
/// Reading a provider's JSON without trusting its shape.
///
/// <para>
/// <b>The hazard this exists for.</b>
/// <see cref="JsonElement.TryGetProperty(string, out JsonElement)"/>,
/// <c>TryGetInt32</c>, <c>TryGetInt64</c> and <c>TryGetDecimal</c> all THROW
/// <see cref="InvalidOperationException"/> when the element they are called on
/// is the wrong kind, rather than returning false. The <c>Try</c> in their
/// names is about a property that is missing or a number that will not fit -
/// never about the element itself. A <c>null</c> where an object was expected
/// is not a missing property; it is a different kind, and it throws.
/// </para>
///
/// <para>
/// That is convincing enough to have got past review in four separate adapters
/// - MediaMarkt, DUO, bol and ING - and the payloads that reach it are
/// ordinary. GraphQL sends <c>"items": [null]</c> whenever a non-nullable child
/// errors. DUO's own recorded fixtures carry explicit nulls on number-typed
/// fields. What it costs is out of all proportion to the cause: an
/// <see cref="InvalidOperationException"/> is not a
/// <see cref="JsonException"/>, so it walks past every catch on the way out and
/// surfaces as <c>internal</c> - retriable, blamed on this connector, and fatal
/// to the whole fetch. One <c>"jaar": null</c> cost an entire student debt and
/// a fresh DigiD sign-in to try again.
/// </para>
///
/// <para>
/// So: every read here answers "not there" for anything that is not the shape
/// asked for, and nothing here can throw on a payload. Drift is then reported
/// by the caller that knows what the field MEANT - which is the only place that
/// can say whether its absence matters.
/// </para>
///
/// <para>
/// Exact names, deliberately. A retailer that renames a field between releases
/// meant nothing by it, and the shop connector's alias-tolerant reader is built
/// for that. A bank or a registry that renames one has changed its contract,
/// and quietly finding the value under a different spelling would hide exactly
/// the event a connector exists to notice.
/// </para>
/// </summary>
public static class JsonRead
{
    /// <summary>
    /// A named child, or <see cref="JsonValueKind.Undefined"/> - never a throw.
    /// </summary>
    /// <remarks>
    /// The primitive the rest of this file is built from, and the one to reach
    /// for when a caller wants to make its own decision about the kind. An
    /// undefined element answers every read below with null, so a whole chain
    /// of them can be walked without a guard at each step.
    /// </remarks>
    public static JsonElement Child(this JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value)
            ? value
            : default;

    /// <summary>
    /// Is this child there, and is it something rather than <c>null</c>?
    /// </summary>
    /// <remarks>
    /// For the caller that wants the element and a branch, rather than a value.
    /// An explicit <c>null</c> answers false: a provider stating a field as null
    /// is telling you it has no value for it, which is what an absent field
    /// says too.
    /// </remarks>
    public static bool Has(this JsonElement parent, string name, out JsonElement value)
    {
        value = parent.Child(name);
        return value.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null);
    }

    /// <summary>
    /// A string child: trimmed, and null when blank.
    /// </summary>
    /// <remarks>
    /// BLANK IS NOT A VALUE, and this is not a stylistic preference. ING's
    /// credit card states <c>id</c> as an empty string on every row - present,
    /// and worth nothing - which is the version that gets past a null check and
    /// becomes an empty external id on a real transaction. Providers also pad:
    /// an untrimmed "Incasso ING creditcard             " carries thirteen
    /// spaces into a content hash and changes it.
    /// </remarks>
    public static string? Text(this JsonElement parent, string name) => Text(parent.Child(name));

    /// <summary>This element as a string, under the same rule.</summary>
    public static string? Text(this JsonElement value) =>
        value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!.Trim()
            : null;

    /// <summary>A whole-number child, or null.</summary>
    public static int? Int32(this JsonElement parent, string name) => parent.Child(name).Int32();

    /// <summary>This element as a whole number, under the same rule.</summary>
    /// <remarks>
    /// The element-level form exists so that a value reached some other way -
    /// down a dotted path, out of an array, off an enumerator - has a safe read
    /// too. Without one, the only way to finish such a read was the raw API,
    /// which is the whole thing this file is here to replace.
    /// </remarks>
    public static int? Int32(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var stated) ? stated : null;

    /// <inheritdoc cref="Int32(JsonElement, string)"/>
    public static long? Int64(this JsonElement parent, string name) => parent.Child(name).Int64();

    /// <inheritdoc cref="Int32(JsonElement)"/>
    public static long? Int64(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var stated) ? stated : null;

    /// <summary>
    /// A numeric child as a <see cref="decimal"/>.
    /// </summary>
    /// <remarks>
    /// Never <c>double</c>. Money is not a float anywhere on this platform, and
    /// a balance that has been through a binary fraction is one nobody can
    /// reason about afterwards.
    /// </remarks>
    public static decimal? Decimal(this JsonElement parent, string name) => parent.Child(name).Decimal();

    /// <inheritdoc cref="Decimal(JsonElement, string)"/>
    public static decimal? Decimal(this JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var stated) ? stated : null;

    /// <summary>
    /// A child that is literally <c>true</c>.
    /// </summary>
    /// <remarks>
    /// Only the JSON literal, never the string "true" and never a non-zero
    /// number. A flag decides whether a row is published at all - ING skips a
    /// transaction on <c>reservation: true</c> - so a reader that accepted
    /// look-alikes would silently change what a statement contains.
    /// </remarks>
    public static bool Flag(this JsonElement parent, string name) =>
        parent.Child(name).ValueKind == JsonValueKind.True;

    /// <summary>
    /// The elements of an array child, or nothing.
    /// </summary>
    /// <remarks>
    /// Empty rather than a throw, because an absent collection is an ordinary
    /// provider answer - a receipt with no discounts, an account with no links -
    /// and not a shape change. A caller for whom the array's absence IS drift
    /// asks with <see cref="Has"/> and says so itself.
    /// </remarks>
    public static IEnumerable<JsonElement> Items(this JsonElement parent, string name)
    {
        var array = parent.Child(name);

        return array.ValueKind == JsonValueKind.Array ? array.EnumerateArray() : [];
    }

    /// <summary>
    /// Only the entries of an array that are objects.
    /// </summary>
    /// <remarks>
    /// THE ONE THAT WOULD HAVE CAUGHT IT. A GraphQL server sends
    /// <c>"items": [null]</c> whenever a non-nullable child errors, and every
    /// loop that walked such an array and read a field off each entry threw on
    /// the first one. Filtering here means a row a provider could not render
    /// costs that row rather than the page it was on.
    /// </remarks>
    public static IEnumerable<JsonElement> Objects(this IEnumerable<JsonElement> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);

        return entries.Where(entry => entry.ValueKind == JsonValueKind.Object);
    }
}
