using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;

namespace ShopConnector.Adapters.Support;

/// a bare date, or a wall clock read in the agent's zone, puts a near-midnight purchase on the wrong day: an explicit
/// offset is honoured, anything else is read in the provider's country zone
internal static partial class ReceiptTime
{
    [GeneratedRegex(@"(?:[Zz]|[+-]\d{2}:?\d{2})$")]
    private static partial Regex OffsetSuffix { get; }

    public static DateTimeOffset Parse(string? raw, TimeZoneInfo zone, string providerId, string field)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged($"{providerId}: {field} is missing");
        }

        var text = raw.Trim();

        if (OffsetSuffix.IsMatch(text) &&
            DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var stated))
        {
            return stated;
        }

        if (DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var wallClock))
        {
            // Kind Unspecified so GetUtcOffset reads it as local to that zone; an ambiguous autumn hour resolves to standard time
            // (an hour off twice a year beats a whole day off every day)
            var unspecified = DateTime.SpecifyKind(wallClock, DateTimeKind.Unspecified);
            return new DateTimeOffset(unspecified, zone.GetUtcOffset(unspecified));
        }

        throw ConnectorException.ProviderChanged($"{providerId}: cannot parse {field} timestamp '{raw}'");
    }
}

/// written out, not derived: every Lidl country sits on CET today, and a table makes a non-CET addition a visible edit
internal static class RetailZones
{
    private const string Netherlands = "Europe/Amsterdam";

    private const string WestEurope = "W. Europe Standard Time";

    private const string Romance = "Romance Standard Time";

    private static readonly Dictionary<string, string> ByCountry = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NL"] = Netherlands,
        ["BE"] = "Europe/Brussels",
        ["DE"] = "Europe/Berlin",
        ["AT"] = "Europe/Vienna",
        ["FR"] = "Europe/Paris",
        ["IT"] = "Europe/Rome",
        ["ES"] = "Europe/Madrid",
    };

    /// fallback for hosts without IANA ids (trimmed globalization): failing to date a receipt
    /// over a packaging choice is unacceptable
    private static readonly Dictionary<string, string> WindowsFallback = new(StringComparer.Ordinal)
    {
        [Netherlands] = WestEurope,
        ["Europe/Brussels"] = Romance,
        ["Europe/Berlin"] = WestEurope,
        ["Europe/Vienna"] = WestEurope,
        ["Europe/Paris"] = Romance,
        ["Europe/Rome"] = WestEurope,
        ["Europe/Madrid"] = Romance,
    };

    private static readonly ConcurrentDictionary<string, TimeZoneInfo> Cache = new(StringComparer.Ordinal);

    public static TimeZoneInfo Dutch => For("NL");

    public static TimeZoneInfo For(string? country)
    {
        var id = country is not null && ByCountry.TryGetValue(country, out var mapped) ? mapped : Netherlands;
        return Cache.GetOrAdd(id, Resolve);
    }

    private static TimeZoneInfo Resolve(string id)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            if (WindowsFallback.TryGetValue(id, out var windowsId))
            {
                try
                {
                    return TimeZoneInfo.FindSystemTimeZoneById(windowsId);
                }
                catch (Exception inner) when (inner is TimeZoneNotFoundException or InvalidTimeZoneException)
                {
                    throw new ConnectorException(ErrorCode.Internal, $"time zone '{id}' unavailable on this host", inner);
                }
            }

            throw new ConnectorException(ErrorCode.Internal, $"time zone '{id}' unavailable on this host", ex);
        }
    }
}
