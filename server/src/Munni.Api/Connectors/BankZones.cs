namespace Munni.Api.Connectors;

// the zone a bank books in, from the IBAN's country: banks book overnight, so a party's preferred local fetch hour
// (03:00) gets whole days; unknown countries and platforms without the zone read as UTC
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

    public static bool IsLocalHour(string? ibanOrCountry, int hour, DateTimeOffset nowUtc) =>
        TimeZoneInfo.ConvertTime(nowUtc, ZoneFor(ibanOrCountry)).Hour == hour;
}
