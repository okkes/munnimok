using System.Collections;
using System.Globalization;
using System.Text;
using Connector.Kit.Errors;
using Connector.Kit.Normalization;

namespace BankConnector.Adapters.Parsing;

/// <summary>
/// One logical column and every header text known to mean it.
/// </summary>
public sealed record CsvColumnSpec
{
    /// <summary>How the reader refers to the column. Never shown to a user.</summary>
    public required string Key { get; init; }

    /// <summary>
    /// Header texts, in any language. Written as humans write them; the
    /// reader normalises both sides before comparing, so
    /// <c>"Af/Bij"</c>, <c>"AF BIJ"</c> and <c>"af-bij"</c> are one alias.
    /// </summary>
    public required IReadOnlyList<string> Aliases { get; init; }

    /// <summary>
    /// When true, the file is unusable without this column and an
    /// unresolved header is <see cref="ErrorCode.ProviderChanged"/>.
    /// </summary>
    public bool Required { get; init; } = true;
}

/// <summary>Day-first is Dutch; month-first is a US export. Never guessed.</summary>
public enum CsvDateOrder
{
    DayFirst,
    MonthFirst,
}

public sealed record CsvSchema
{
    /// <summary>Appears in every failure detail, so an operator knows which parser to fix.</summary>
    public required string Name { get; init; }

    public required IReadOnlyList<CsvColumnSpec> Columns { get; init; }

    /// <summary>
    /// <c>03-04-2026</c> is a real date under both readings and they mean
    /// different months. There is no signal in the file that resolves it, so
    /// the schema declares the order and the reader never infers it.
    /// </summary>
    public CsvDateOrder DateOrder { get; init; } = CsvDateOrder.DayFirst;
}

/// <summary>
/// A CSV reader for bank exports, which vary in almost everything.
///
/// Dutch bank exports differ in column headers (Dutch or English depending
/// on the user's interface language), in delimiter, in decimal separator
/// and in date format - sometimes between two exports from the same bank.
/// So columns are resolved by matching known ALIASES, never by position:
/// position-based mapping keeps working after a bank inserts a column and
/// starts writing the wrong data into the right field, which is the
/// silent-corruption failure this whole codebase is arranged to avoid.
///
/// When a required column cannot be resolved the reader fails with
/// <see cref="ErrorCode.ProviderChanged"/> and NAMES the column, so the fix
/// is one alias in a list rather than an afternoon with a hex editor.
/// </summary>
public static class LocaleTolerantCsv
{
    /// <summary>
    /// Tried in order of how much they distinguish. Semicolon first because
    /// a Dutch export uses it precisely so that its comma decimal separator
    /// does not collide.
    /// </summary>
    private static readonly char[] CandidateDelimiters = [';', ',', '\t', '|'];

    public static CsvTable Read(string text, CsvSchema schema)
    {
        ArgumentNullException.ThrowIfNull(schema);
        if (string.IsNullOrWhiteSpace(text))
        {
            throw ConnectorException.ProviderChanged($"{schema.Name}: csv export is empty");
        }

        var lines = SplitLines(text);
        if (lines.Count == 0)
        {
            throw ConnectorException.ProviderChanged($"{schema.Name}: csv export has no header row");
        }

        var (delimiter, headers, resolved) = ResolveHeaders(lines[0], schema);

        var rows = new List<CsvRow>(lines.Count - 1);
        for (var i = 1; i < lines.Count; i++)
        {
            var fields = SplitFields(lines[i], delimiter);

            // A short row is a bank omitting trailing empties; a long one is
            // a quoting bug or a column we have never seen, and guessing
            // which field moved is exactly the mistake alias matching exists
            // to prevent.
            if (fields.Count > headers.Count && fields.Skip(headers.Count).Any(f => !string.IsNullOrWhiteSpace(f)))
            {
                throw ConnectorException.ProviderChanged(
                    $"{schema.Name}: row {i + 1} has {fields.Count} fields but the header has {headers.Count}");
            }

            rows.Add(new CsvRow(schema, resolved, fields, i + 1));
        }

        return new CsvTable(schema, headers, resolved, rows);
    }

    public static CsvTable ReadFile(string path, CsvSchema schema) =>
        Read(File.ReadAllText(path), schema);

    /// <summary>
    /// Picks the delimiter that resolves the most known columns, then
    /// resolves the rest against it. Scoring by "how many headers do I
    /// recognise" rather than "how many fields do I get" is what makes a
    /// quoted description containing a comma harmless in a
    /// semicolon-delimited file.
    /// </summary>
    private static (char Delimiter, IReadOnlyList<string> Headers, Dictionary<string, int> Resolved) ResolveHeaders(
        string headerLine, CsvSchema schema)
    {
        var bestDelimiter = CandidateDelimiters[0];
        var bestHeaders = SplitFields(headerLine, bestDelimiter);
        var bestResolved = Match(bestHeaders, schema);

        foreach (var delimiter in CandidateDelimiters.Skip(1))
        {
            var headers = SplitFields(headerLine, delimiter);
            var resolved = Match(headers, schema);

            if (resolved.Count > bestResolved.Count ||
                (resolved.Count == bestResolved.Count && headers.Count > bestHeaders.Count))
            {
                (bestDelimiter, bestHeaders, bestResolved) = (delimiter, headers, resolved);
            }
        }

        foreach (var column in schema.Columns)
        {
            if (column.Required && !bestResolved.ContainsKey(column.Key))
            {
                throw ConnectorException.ProviderChanged(
                    $"{schema.Name}: cannot resolve required column '{column.Key}' - " +
                    $"none of [{string.Join(", ", column.Aliases)}] matched any of " +
                    $"[{string.Join(", ", bestHeaders)}]");
            }
        }

        return (bestDelimiter, bestHeaders, bestResolved);
    }

    /// <summary>
    /// Two passes. Exact normalised equality first, for every column, so a
    /// short alias can never steal a header a longer one owns - <c>rekening</c>
    /// must not claim <c>tegenrekening</c>. Only then containment, and only
    /// where it is unambiguous, which is what lets <c>bedrag</c> resolve
    /// <c>"Bedrag (EUR)"</c> without a new alias.
    /// </summary>
    private static Dictionary<string, int> Match(List<string> headers, CsvSchema schema)
    {
        var normalized = headers.Select(Normalize).ToList();
        var resolved = new Dictionary<string, int>(StringComparer.Ordinal);
        var claimed = new bool[headers.Count];

        foreach (var column in schema.Columns)
        {
            Claim(resolved, claimed, column.Key, ExactMatch(normalized, claimed, column));
        }

        foreach (var column in schema.Columns)
        {
            if (resolved.ContainsKey(column.Key)) continue;

            Claim(resolved, claimed, column.Key, ContainedMatch(normalized, claimed, column));
        }

        return resolved;
    }

    /// <summary>Records a header as a column's, unless the search came back empty-handed.</summary>
    private static void Claim(Dictionary<string, int> resolved, bool[] claimed, string key, int index)
    {
        if (index < 0) return;

        resolved[key] = index;
        claimed[index] = true;
    }

    /// <summary>
    /// The first unclaimed header equal to one of the column's aliases, tried
    /// in the column's order, or -1.
    /// </summary>
    private static int ExactMatch(List<string> normalized, bool[] claimed, CsvColumnSpec column)
    {
        foreach (var alias in column.Aliases)
        {
            var target = Normalize(alias);
            var index = normalized.FindIndex(h => h.Length > 0 && string.Equals(h, target, StringComparison.Ordinal));
            if (index >= 0 && !claimed[index]) return index;
        }

        return -1;
    }

    /// <summary>
    /// The one unclaimed header containing one of the column's aliases, or -1
    /// where no alias is contained by exactly one header.
    /// </summary>
    private static int ContainedMatch(List<string> normalized, bool[] claimed, CsvColumnSpec column)
    {
        foreach (var alias in column.Aliases)
        {
            var target = Normalize(alias);

            // A three-character fragment matches half a header row by
            // accident; below that, containment is not evidence.
            if (target.Length < 4) continue;

            var candidates = new List<int>();
            for (var i = 0; i < normalized.Count; i++)
            {
                if (!claimed[i] && normalized[i].Contains(target, StringComparison.Ordinal)) candidates.Add(i);
            }

            if (candidates.Count == 1) return candidates[0];
        }

        return -1;
    }

    /// <summary>
    /// Case, accents, spacing and punctuation all vary between exports and
    /// none of them carry meaning, so they are all removed before comparing.
    /// </summary>
    internal static string Normalize(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return string.Empty;

        var decomposed = header.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(decomposed.Length);
        foreach (var ch in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (char.IsLetterOrDigit(ch)) sb.Append(ch);
        }

        return sb.ToString();
    }

    /// <summary>
    /// Splits records, not lines: a quoted description may legitimately
    /// contain a newline, and treating that as a row boundary shifts every
    /// subsequent field by one column. Quoting is preserved here and
    /// resolved by <see cref="SplitFields"/>.
    /// </summary>
    private static List<string> SplitLines(string text)
    {
        var lines = new List<string>();
        var record = new StringBuilder();
        var inQuotes = false;
        var i = 0;

        while (i < text.Length)
        {
            var ch = text[i];

            if (ch == '"')
            {
                if (inQuotes && NextIs(text, i, '"'))
                {
                    record.Append('"').Append('"');
                    i += 2;
                    continue;
                }

                inQuotes = !inQuotes;
                record.Append(ch);
                i++;
                continue;
            }

            if (!inQuotes && (ch == '\n' || ch == '\r'))
            {
                AddLine(lines, record);
                i += LineBreakLength(text, i);
                continue;
            }

            record.Append(ch);
            i++;
        }

        AddLine(lines, record);
        return lines;
    }

    /// <summary>Whether the character after <paramref name="at"/> is this one.</summary>
    private static bool NextIs(string text, int at, char ch) => at + 1 < text.Length && text[at + 1] == ch;

    /// <summary>How many characters the line break at <paramref name="at"/> takes: two for CRLF, one otherwise.</summary>
    private static int LineBreakLength(string text, int at) => text[at] == '\r' && NextIs(text, at, '\n') ? 2 : 1;

    private static void AddLine(List<string> lines, StringBuilder record)
    {
        // U+FEFF as an escape rather than a literal, so the source carries
        // no invisible characters.
        var line = record.ToString().TrimStart('﻿');
        record.Clear();
        if (!string.IsNullOrWhiteSpace(line)) lines.Add(line);
    }

    /// <summary>
    /// RFC 4180 with the tolerances real exports need: text after a closing
    /// quote is appended rather than rejected, and a doubled quote inside a
    /// quoted field is one quote.
    /// </summary>
    internal static List<string> SplitFields(string line, char delimiter)
    {
        var fields = new List<string>();
        var current = new StringBuilder();
        var i = 0;

        while (i < line.Length)
        {
            var ch = line[i];

            if (ch == '"' && current.Length == 0)
            {
                i = Quoted(line, i + 1, current);
                continue;
            }

            if (ch == delimiter)
            {
                fields.Add(current.ToString().Trim());
                current.Clear();
            }
            else
            {
                current.Append(ch);
            }

            i++;
        }

        fields.Add(current.ToString().Trim());
        return fields;
    }

    /// <summary>
    /// Appends a quoted run, starting just after its opening quote, with a
    /// doubled quote read as one - and answers where the line goes on: just
    /// past the closing quote, or the end of the line when it never closed.
    /// </summary>
    private static int Quoted(string line, int from, StringBuilder current)
    {
        var i = from;

        while (i < line.Length)
        {
            var ch = line[i];

            if (ch != '"')
            {
                current.Append(ch);
                i++;
                continue;
            }

            if (!NextIs(line, i, '"')) return i + 1;

            current.Append('"');
            i += 2;
        }

        return i;
    }
}

public sealed class CsvTable : IReadOnlyList<CsvRow>
{
    private readonly IReadOnlyList<CsvRow> _rows;
    private readonly Dictionary<string, int> _resolved;

    internal CsvTable(CsvSchema schema, IReadOnlyList<string> headers, Dictionary<string, int> resolved, IReadOnlyList<CsvRow> rows)
    {
        Schema = schema;
        Headers = headers;
        _resolved = resolved;
        _rows = rows;
    }

    public CsvSchema Schema { get; }

    public IReadOnlyList<string> Headers { get; }

    /// <summary>Whether an optional column was present in this particular export.</summary>
    public bool HasColumn(string key) => _resolved.ContainsKey(key);

    public int Count => _rows.Count;

    public CsvRow this[int index] => _rows[index];

    public IEnumerator<CsvRow> GetEnumerator() => _rows.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>
/// One row, addressed by logical column key. Every accessor that cannot
/// produce a value raises <see cref="ErrorCode.ProviderChanged"/> naming the
/// column, the row and the offending text.
/// </summary>
public sealed class CsvRow
{
    private static readonly string[] DayFirstFormats =
        ["yyyy-MM-dd", "yyyyMMdd", "dd-MM-yyyy", "d-M-yyyy", "dd/MM/yyyy", "d/M/yyyy", "dd.MM.yyyy", "d.M.yyyy"];

    private static readonly string[] MonthFirstFormats =
        ["yyyy-MM-dd", "yyyyMMdd", "MM-dd-yyyy", "M-d-yyyy", "MM/dd/yyyy", "M/d/yyyy", "MM.dd.yyyy", "M.d.yyyy"];

    private readonly CsvSchema _schema;
    private readonly Dictionary<string, int> _resolved;
    private readonly List<string> _fields;

    internal CsvRow(CsvSchema schema, Dictionary<string, int> resolved, List<string> fields, int lineNumber)
    {
        _schema = schema;
        _resolved = resolved;
        _fields = fields;
        LineNumber = lineNumber;
    }

    /// <summary>1-based, as a text editor counts. Named in every failure.</summary>
    public int LineNumber { get; }

    /// <summary>Null when the column was absent from this export or the cell was blank.</summary>
    public string? Text(string key)
    {
        if (!_resolved.TryGetValue(key, out var index) || index >= _fields.Count) return null;

        var value = _fields[index];
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    public string Require(string key) =>
        Text(key) ?? throw ConnectorException.ProviderChanged(
            $"{_schema.Name}: row {LineNumber} has no value for required column '{key}'");

    /// <summary>
    /// Amounts go through the kit's parser, which accepts both decimal
    /// separators but refuses anything genuinely ambiguous. The unit is
    /// declared, never inferred from the value's shape.
    /// </summary>
    public long MinorUnits(string key, MoneyUnit unit = MoneyUnit.MajorString) =>
        MoneyParser.ToMinor(Require(key), unit, $"{_schema.Name}: row {LineNumber} column '{key}'");

    public long? MinorUnitsOrNull(string key, MoneyUnit unit = MoneyUnit.MajorString) =>
        Text(key) is null ? null : MinorUnits(key, unit);

    /// <summary>
    /// Some exports sign the amount; others keep the magnitude positive and
    /// put the direction in a separate <c>Af/Bij</c> column. This reads the
    /// second shape - and refuses an unrecognised indicator rather than
    /// defaulting to credit, because a silently inverted sign is the single
    /// most damaging thing a bank parser can do.
    /// </summary>
    public long SignedMinorUnits(string amountKey, string indicatorKey, MoneyUnit unit = MoneyUnit.MajorString)
    {
        var magnitude = Math.Abs(MinorUnits(amountKey, unit));
        var indicator = Text(indicatorKey);

        if (indicator is null)
        {
            throw ConnectorException.ProviderChanged(
                $"{_schema.Name}: row {LineNumber} has no debit/credit indicator in column '{indicatorKey}'");
        }

        return LocaleTolerantCsv.Normalize(indicator) switch
        {
            "af" or "d" or "debet" or "debit" or "dbit" or "uit" => -magnitude,
            "bij" or "c" or "credit" or "crdt" or "in" => magnitude,
            _ => throw ConnectorException.ProviderChanged(
                $"{_schema.Name}: row {LineNumber} column '{indicatorKey}' has unknown debit/credit indicator '{indicator}'"),
        };
    }

    public DateOnly Date(string key) =>
        DateOrNull(key) ?? throw ConnectorException.ProviderChanged(
            $"{_schema.Name}: row {LineNumber} has no value for required date column '{key}'");

    public DateOnly? DateOrNull(string key)
    {
        var raw = Text(key);
        if (raw is null) return null;

        var formats = _schema.DateOrder == CsvDateOrder.DayFirst ? DayFirstFormats : MonthFirstFormats;
        foreach (var format in formats)
        {
            if (DateOnly.TryParseExact(raw, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
            {
                return parsed;
            }
        }

        throw ConnectorException.ProviderChanged(
            $"{_schema.Name}: row {LineNumber} column '{key}' is not a {_schema.DateOrder} date: '{raw}'");
    }
}
