using System.Globalization;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Connector.Kit.Hosting.Data;

/// stored as fixed-width zero-offset UTC ISO-8601 text: Sqlite cannot ORDER BY a DateTimeOffset,
/// and this makes lexicographic order chronological on both providers
/// invariant: nothing writes a non-UTC value (the conversion normalises anything that did)
public sealed class UtcInstantConverter() : ValueConverter<DateTimeOffset, string>(
    value => value.ToUniversalTime().ToString(Format, CultureInfo.InvariantCulture),
    stored => DateTimeOffset.ParseExact(stored, Format, CultureInfo.InvariantCulture, Styles))
{
    /// <summary>Fixed width, always zero-offset - both properties are load-bearing for ordering.</summary>
    internal const string Format = "yyyy-MM-ddTHH:mm:ss.fffffffZ";

    internal const DateTimeStyles Styles = DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal;

    public const int StoredLength = 28;
}
