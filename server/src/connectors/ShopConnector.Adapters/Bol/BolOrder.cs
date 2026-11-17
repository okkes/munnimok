using System.Globalization;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;
using ShopConnector.Adapters.Support;

namespace ShopConnector.Adapters.Bol;

internal sealed record BolOrder
{
    public required string Id { get; init; }

    /// <summary>Carries a real offset. See <see cref="BolDate"/> for why that is not optional.</summary>
    public required DateTimeOffset PlacedAt { get; init; }

    public required Money Total { get; init; }

    /// <summary>Lands in the receipt's store_name; null when the order page names none (bol ships many itself).</summary>
    public string? SellerName { get; init; }

    public ReceiptPayment Payment { get; init; } = ReceiptFactory.Payment();

    public IReadOnlyList<ReceiptItem> Items { get; init; } = [];

    /// <summary>Verbatim payload, null unless requested: a purchase not held cannot leak</summary>
    public string? Raw { get; init; }
}

/// Pure seam, URL in, orders out (no transport, cookies, clock). Whether the orders page is HTML or a JSON shell is
/// unknowable without an account, so both are built, an option chooses, and failures name the shape.
internal interface IBolOrdersShape
{
    /// <summary><c>html</c> or <c>json</c>. Appears in every failure and in <c>FetchResult.Via</c>.</summary>
    string Name { get; }

    string ConfigHint { get; }

    string Url(BolOptions options, int page);

    string Accept { get; }

    /// <summary>The request body, null for none: GraphQL is a POST, the page shapes are GETs; the seam carries that so the
    /// adapter does not branch.</summary>
    string? Body(BolOptions options, int page) => null;

    /// <summary>Headers beyond the common ones: bol's edge wants the GraphQL operation named in a header.</summary>
    IReadOnlyList<KeyValuePair<string, string>> Headers(BolOptions options) => [];

    /// <summary>True where the order states no total and the receipt's is our sum of its lines: page markup shows a total,
    /// GraphQL does not.</summary>
    bool TotalIsDerived => false;

    /// <summary>Empty only where the body says so; an unrecognisable body is ProviderChanged, never a quiet zero.</summary>
    /// <param name="keepRaw">carry each order's verbatim payload on Raw; off by default</param>
    /// <param name="warn">field errors bol reports beside orders it did deliver (prod, 2026-10-07); null drops them</param>
    IReadOnlyList<BolOrder> Parse(string body, BolOptions options, TimeZoneInfo zone, bool keepRaw = false, Action<string>? warn = null);
}

internal static class BolShapes
{
    public static IBolOrdersShape For(BolOrdersShape shape) => shape switch
    {
        BolOrdersShape.GraphQl => new BolGraphQlShape(),
        BolOrdersShape.Html => new BolHtmlShape(),
        BolOrdersShape.Json => new BolJsonShape(),
        _ => throw ConnectorException.InvalidRequest($"bol: no orders shape '{shape}'"),
    };
}

/// Dutch dates with a real offset. ReceiptTime parses with the invariant culture and cannot read "14 juni 2026"; an
/// unparsed month puts a near-midnight order on the wrong day. The month table is written out, not taken from a
/// culture: an agent image with trimmed globalization must still date every receipt.
internal static partial class BolDate
{
    private const string ProviderId = BolAdapter.ProviderId;

    private static readonly Dictionary<string, int> Months = new(StringComparer.OrdinalIgnoreCase)
    {
        ["januari"] = 1, ["jan"] = 1,
        ["februari"] = 2, ["feb"] = 2,
        ["maart"] = 3, ["mrt"] = 3, ["mar"] = 3,
        ["april"] = 4, ["apr"] = 4,
        ["mei"] = 5,
        ["juni"] = 6, ["jun"] = 6,
        ["juli"] = 7, ["jul"] = 7,
        ["augustus"] = 8, ["aug"] = 8,
        ["september"] = 9, ["sep"] = 9, ["sept"] = 9,
        ["oktober"] = 10, ["okt"] = 10, ["oct"] = 10,
        ["november"] = 11, ["nov"] = 11,
        ["december"] = 12, ["dec"] = 12,
    };

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}")]
    private static partial Regex Iso { get; }

    [GeneratedRegex(@"(?<day>\d{1,2})\s+(?<month>[A-Za-z]+)\.?\s+(?<year>\d{4})")]
    private static partial Regex Spelled { get; }

    [GeneratedRegex(@"(?<day>\d{1,2})[-/](?<month>\d{1,2})[-/](?<year>\d{4})")]
    private static partial Regex Numeric { get; }

    [GeneratedRegex(@"(?<hour>\d{1,2})[:.](?<minute>\d{2})(?::(?<second>\d{2}))?")]
    private static partial Regex Clock { get; }

    public static DateTimeOffset Parse(string? raw, TimeZoneInfo zone, string field)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: {field} is missing");
        }

        var text = raw.Trim();

        if (Iso.IsMatch(text)) return ReceiptTime.Parse(text, zone, ProviderId, field);

        if (Spelled.Match(text) is { Success: true } spelled)
        {
            var name = spelled.Groups["month"].Value;
            if (!Months.TryGetValue(name, out var month))
            {
                throw ConnectorException.ProviderChanged(
                    $"{ProviderId}: {field} names a month this adapter does not know ('{name}')");
            }

            return Compose(
                Number(spelled.Groups["year"]), month, Number(spelled.Groups["day"]), text, zone, field);
        }

        if (Numeric.Match(text) is { Success: true } numeric)
        {
            return Compose(
                Number(numeric.Groups["year"]),
                Number(numeric.Groups["month"]),
                Number(numeric.Groups["day"]),
                text, zone, field);
        }

        throw ConnectorException.ProviderChanged($"{ProviderId}: cannot parse {field} from '{raw}'");
    }

    /// A date with no time becomes local midnight: the hour is not given, and inventing one would be worse.
    private static DateTimeOffset Compose(
        int year, int month, int day, string text, TimeZoneInfo zone, string field)
    {
        if (year < 1000 || month is < 1 or > 12 || day is < 1 or > 31)
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: {field} '{text}' is not a real date");
        }

        var (hour, minute, second) = TimeOfDay(text);

        var stamp = string.Create(CultureInfo.InvariantCulture,
            $"{year:D4}-{month:D2}-{day:D2}T{hour:D2}:{minute:D2}:{second:D2}");

        return ReceiptTime.Parse(stamp, zone, ProviderId, field);
    }

    private static (int Hour, int Minute, int Second) TimeOfDay(string text)
    {
        var match = Clock.Match(text);
        if (!match.Success) return (0, 0, 0);

        var hour = Number(match.Groups["hour"]);
        var minute = Number(match.Groups["minute"]);
        var second = match.Groups["second"].Success ? Number(match.Groups["second"]) : 0;

        return hour is >= 0 and < 24 && minute is >= 0 and < 60 && second is >= 0 and < 60
            ? (hour, minute, second)
            : (0, 0, 0);
    }

    private static int Number(Group group) =>
        int.TryParse(group.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : -1;
}
