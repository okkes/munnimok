using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace RegistryConnector.Adapters.Bkr;

// the hidden #pdf-export print block holds every credit's detail, keyed on label text (confirmed live 2026-08-04)
// the visible rows appear TWICE (Alles and Lopend tabs), so counting li.contract doubles
// status comes from the print block, never a CSS class
internal static partial class BkrCreditParser
{
    private const string ProviderId = BkrAdapter.ProviderId;

    [GeneratedRegex(@"<div class=""pdf-page"">(?<page>.*?)(?=<div class=""pdf-page"">|\z)", RegexOptions.Singleline)]
    private static partial Regex Page { get; }

    [GeneratedRegex(
        @"<div class=""label"">(?<label>.*?)</div>\s*<div class=""value"">(?<value>.*?)</div>",
        RegexOptions.Singleline)]
    private static partial Regex Pair { get; }

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex Tags { get; }

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace { get; }

    public static IReadOnlyList<CreditRegistration> Parse(string? html, BkrOptions options, string sessionId)
    {
        ArgumentNullException.ThrowIfNull(options);

        if (string.IsNullOrWhiteSpace(html))
        {
            throw ConnectorException.ProviderChanged($"{ProviderId}: the portal returned an empty page");
        }

        if (!html.Contains(options.PrintBlockMarker, StringComparison.Ordinal))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the page carries no '{options.PrintBlockMarker}' block, which is where every " +
                "credit's detail is stated. Either the portal was rebuilt or this is not the credit overview.");
        }

        var credits = new List<CreditRegistration>();

        foreach (Match page in Page.Matches(html))
        {
            var fields = Fields(page.Groups["page"].Value);

            // the consumer's own page has a birth date and no credit reference; ProfileOf reads it
            if (!fields.TryGetValue(options.ReferenceLabel, out var reference)) continue;
            if (string.IsNullOrWhiteSpace(reference)) continue;

            credits.Add(Credit(fields, reference, options, sessionId));
        }

        if (credits.Count == 0 && !html.Contains(options.EmptyRegisterMarker, StringComparison.OrdinalIgnoreCase))
        {
            // an empty register is a real answer, but only when the page says so, never because the parser stopped matching
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: the print block yielded no credits and the page does not say the register is empty");
        }

        return credits;
    }

    public static string? ProfileOf(string? html, BkrOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrWhiteSpace(html)) return null;

        foreach (Match page in Page.Matches(html))
        {
            var fields = Fields(page.Groups["page"].Value);
            if (fields.ContainsKey(options.ReferenceLabel)) continue;

            var surname = fields.GetValueOrDefault(options.SurnameLabel);
            var initials = fields.GetValueOrDefault(options.InitialsLabel);

            if (string.IsNullOrWhiteSpace(surname)) continue;

            return string.IsNullOrWhiteSpace(initials) ? surname : $"{initials} {surname}";
        }

        return null;
    }

    private static CreditRegistration Credit(
        IReadOnlyDictionary<string, string> fields, string reference, BkrOptions options, string sessionId)
    {
        var label = fields.GetValueOrDefault(options.KindLabel);

        var ended = Date(fields.GetValueOrDefault(options.ActualEndLabel), options);

        return new CreditRegistration
        {
            Id = Connector.Kit.Ids.ForRecord(Connector.Kit.Ids.CreditRegistration, sessionId, reference),
            ExternalId = reference,

            Creditor = fields.GetValueOrDefault(options.CreditorLabel)
                       ?? throw ConnectorException.ProviderChanged(
                           $"{ProviderId}: a credit states no '{options.CreditorLabel}'"),

            Kind = Kind(label, options),
            KindLabel = label,

            Amount = Money(fields.GetValueOrDefault(options.AmountLabel), options),

            // the register's own words, not a date comparison: a passed expected end is not an ended credit,
            // and inferring it would report live debt as settled
            Status = ended is not null ? CreditStatus.Ended : CreditStatus.Running,

            StartedOn = Date(fields.GetValueOrDefault(options.RegisteredLabel), options),
            EndsOn = ended ?? Date(fields.GetValueOrDefault(options.ExpectedEndLabel), options),

            // never interpreted, null when nothing is reported: what an arrears code means is not the connector's judgement
            ArrearsCode = Arrears(fields, options),
        };
    }

    /// KindLabel carries the register's own words, so a type this does not know still reaches the user
    private static CreditKind Kind(string? label, BkrOptions options)
    {
        if (string.IsNullOrWhiteSpace(label)) return CreditKind.Other;

        foreach (var (needle, kind) in options.CreditKinds)
        {
            if (label.Contains(needle, StringComparison.OrdinalIgnoreCase)) return kind;
        }

        return CreditKind.Other;
    }

    /// the dot is a thousands separator ("2.000" is two thousand): read as a decimal it turns the debt into two euros
    private static Money Money(string? raw, BkrOptions options)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: a credit states no '{options.AmountLabel}'");
        }

        var cleaned = raw
            .Replace("€", string.Empty, StringComparison.Ordinal)
            .Replace("\u00A0", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Trim();

        if (!decimal.TryParse(cleaned, NumberStyles.Number, Dutch, out var amount))
        {
            // field and shape only, never the value or contract number:
            // notes are logged, stored on the job row and returned to the caller
            throw ConnectorException.ProviderChanged(
                $"{ProviderId}: a credit states a '{options.AmountLabel}' of " +
                $"{raw!.Length} character(s) that is not a number");
        }

        return new Money(
            checked((long)decimal.Round(amount * 100m, 0, MidpointRounding.AwayFromZero)),
            options.Currency);
    }

    /// <summary>dd-MM-yyyy, as the portal prints it. Null when the field is blank.</summary>
    private static DateOnly? Date(string? raw, BkrOptions options)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        return DateOnly.TryParseExact(raw.Trim(), [.. options.DateFormats], Dutch, DateTimeStyles.None, out var date)
            ? date
            : null;
    }

    /// the register prints a "nothing to report" sentence when there is nothing: that is no arrears code, so null
    private static string? Arrears(IReadOnlyDictionary<string, string> fields, BkrOptions options)
    {
        foreach (var label in options.ArrearsLabels)
        {
            if (!fields.TryGetValue(label, out var value)) continue;
            if (string.IsNullOrWhiteSpace(value)) continue;

            return options.NoArrearsMarkers.Any(nothing => value.Contains(nothing, StringComparison.OrdinalIgnoreCase))
                ? null
                : value;
        }

        return null;
    }

    /// keyed by label text: the labels are stable, the Bootstrap grid classes around them are not
    private static Dictionary<string, string> Fields(string page)
    {
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var groups in Pair.Matches(page).Select(pair => pair.Groups))
        {
            var label = Text(groups["label"].Value);
            if (label.Length == 0) continue;

            // First wins. A print page states each label once; a repeat would
            // be a layout artefact rather than a second value.
            found.TryAdd(label, Text(groups["value"].Value));
        }

        return found;
    }

    private static string Text(string markup) =>
        Whitespace.Replace(WebUtility.HtmlDecode(Tags.Replace(markup, " ")), " ").Trim();

    private static readonly CultureInfo Dutch = CultureInfo.GetCultureInfo("nl-NL");
}
