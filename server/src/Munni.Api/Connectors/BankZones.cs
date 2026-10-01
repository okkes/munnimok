namespace Munni.Api.Connectors;

/// <summary>
/// The zone a bank books in, from the IBAN's country: an unattended fetch
/// that a party wants at a local hour (<c>limits.preferred_fetch_hour_local</c>)
/// is timed in it. Banks book overnight, so 03:00 local gets whole days.
/// Unknown countries and platforms without the zone read as UTC.
/// </summary>
public static class BankZones
{
    private static readonly Dictionary<string, string> ZoneByCountry = new(StringComparer.Ordinal)
    {
        ["AT"] = "Europe/Vienna",
        ["BE"] = "Europe/Brussels",
        ["BG"] = "Europe/Sofia",
        ["CH"] = "Europe/Zurich",
        ["CY"] = "Asia/Nicosia",
        ["CZ"] = "Europe/Prague",
        ["DE"] = "Europe/Berlin",
        ["DK"] = "Europe/Copenhagen",
        ["EE"] = "Europe/Tallinn",
        ["ES"] = "Europe/Madrid",
        ["FI"] = "Europe/Helsinki",
        ["FR"] = "Europe/Paris",
        ["GB"] = "Europe/London",
        ["GR"] = "Europe/Athens",
        ["HR"] = "Europe/Zagreb",
        ["HU"] = "Europe/Budapest",
        ["IE"] = "Europe/Dublin",
        ["IS"] = "Atlantic/Reykjavik",
        ["IT"] = "Europe/Rome",
        ["LI"] = "Europe/Vaduz",
        ["LT"] = "Europe/Vilnius",
        ["LU"] = "Europe/Luxembourg",
        ["LV"] = "Europe/Riga",
        ["MT"] = "Europe/Malta",
        ["NL"] = "Europe/Amsterdam",
        ["NO"] = "Europe/Oslo",
        ["PL"] = "Europe/Warsaw",
        ["PT"] = "Europe/Lisbon",
        ["RO"] = "Europe/Bucharest",
        ["SE"] = "Europe/Stockholm",
        ["SI"] = "Europe/Ljubljana",
        ["SK"] = "Europe/Bratislava",
    };

    /// <summary>The zone for an IBAN (its first two letters) or a country code; UTC when unknown.</summary>
    public static TimeZoneInfo ZoneFor(string? ibanOrCountry)
    {
        var country = ibanOrCountry is { Length: >= 2 } text ? text[..2].ToUpperInvariant() : string.Empty;
        if (!ZoneByCountry.TryGetValue(country, out var zoneId)) return TimeZoneInfo.Utc;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(zoneId);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return TimeZoneInfo.Utc;
        }
    }

    /// <summary>True when it is <paramref name="hour"/> o'clock in the zone of <paramref name="ibanOrCountry"/>.</summary>
    public static bool IsLocalHour(string? ibanOrCountry, int hour, DateTimeOffset nowUtc) =>
        TimeZoneInfo.ConvertTime(nowUtc, ZoneFor(ibanOrCountry)).Hour == hour;
}
