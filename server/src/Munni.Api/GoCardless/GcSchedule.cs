namespace Munni.Api.GoCardless;

/// <summary>
/// When to fetch a linked account: once a day, in the 03:00 hour at the
/// bank's local time (quiet hours, fresh end-of-day books, and 1 call
/// per endpoint per day instead of 4 — far inside GoCardless's budget).
/// The bank's country comes from the IBAN prefix; unknown prefixes fall
/// back to UTC, which only shifts the hour, never the cadence.
/// </summary>
internal static class GcSchedule
{
    internal const int FetchLocalHour = 3;

    // GoCardless coverage (EEA + UK + CH); one canonical zone per country
    private static readonly Dictionary<string, string> ZoneByCountry = new()
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

    internal static TimeZoneInfo ZoneForIban(string iban)
    {
        var country = iban.Length >= 2 ? iban[..2].ToUpperInvariant() : "";
        if (ZoneByCountry.TryGetValue(country, out var zoneId))
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(zoneId);
            }
            catch (TimeZoneNotFoundException)
            {
                // stripped tz database in the runtime image — UTC fallback
            }
            catch (InvalidTimeZoneException)
            {
                // corrupt zone data — UTC fallback
            }
        }
        return TimeZoneInfo.Utc;
    }

    /// <summary>
    /// Due when never fetched (a fresh link should not wait for tonight),
    /// or when the bank's clock is in the 03:00 hour and the last fetch
    /// is at least 20h old (one fetch per night, DST-shift tolerant).
    /// </summary>
    internal static bool IsDue(string iban, DateTimeOffset? lastFetchAt, DateTimeOffset nowUtc)
    {
        if (lastFetchAt is null) return true;
        var local = TimeZoneInfo.ConvertTime(nowUtc, ZoneForIban(iban));
        if (local.Hour != FetchLocalHour) return false;
        return nowUtc - lastFetchAt.Value > TimeSpan.FromHours(20);
    }
}
