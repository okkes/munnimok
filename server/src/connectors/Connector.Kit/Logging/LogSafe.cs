using System.Text;

namespace Connector.Kit.Logging;

/// <summary>
/// A value somebody else chose, made safe for one log line.
///
/// A route parameter, a query value, an agent's failure detail or a
/// party's reason key is written into the log exactly as it arrived, and a
/// line break inside it forges a second entry that looks like the
/// platform's own (CodeQL cs/log-forging, 2026-10-09: twenty sites). Every
/// such value goes through <see cref="Line"/>: line breaks and the other
/// control characters become a space, the Unicode line separators too, and
/// the length is capped so one request cannot flood an aggregator.
/// </summary>
public static class LogSafe
{
    /// <summary>Longer values are cut here; a log line is a sentence, not a payload.</summary>
    public const int MaxLength = 200;

    /// <summary>The mark a cut value ends on.</summary>
    public const char Ellipsis = '…';

    /// <summary>
    /// The value on one line, at most <paramref name="max"/> characters
    /// (plus the ellipsis when it was cut). Null and empty come back empty,
    /// so a caller's own <c>?? "-"</c> keeps working on the way in.
    /// </summary>
    public static string Line(string? value, int max = MaxLength)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        ArgumentOutOfRangeException.ThrowIfLessThan(max, 1);

        // The two literal replacements are what CodeQL's log-forging model
        // recognises as the sanitiser; the loop below is for everything the
        // model does not name (tabs, escapes, NEL, the Unicode separators).
        var flat = value.Replace("\r", " ").Replace("\n", " ");

        var line = new StringBuilder(Math.Min(flat.Length, max) + 1);
        foreach (var ch in flat)
        {
            if (line.Length >= max)
            {
                line.Append(Ellipsis);
                break;
            }

            line.Append(IsLineBreaking(ch) ? ' ' : ch);
        }

        return line.ToString();
    }

    /// <summary>U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: line breaks to a log viewer, not control characters to <see cref="char.IsControl(char)"/>.</summary>
    private const char LineSeparator = (char)0x2028;
    private const char ParagraphSeparator = (char)0x2029;

    private static bool IsLineBreaking(char ch) =>
        char.IsControl(ch) || ch is LineSeparator or ParagraphSeparator;
}
