using System.Text;

namespace Munni.Api;

// a value somebody else chose, safe for one log line: a line break in it forges a second entry (CodeQL cs/log-forging)
// identical to Connector.Kit.Logging.LogSafe, copied because the API does not reference the kit
public static class LogSafe
{
    /// <summary>Longer values are cut here; a log line is a sentence, not a payload.</summary>
    public const int MaxLength = 200;

    public const char Ellipsis = '…';

    // null and empty come back empty, so a caller's own `?? "-"` keeps working
    public static string Line(string? value, int max = MaxLength)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        ArgumentOutOfRangeException.ThrowIfLessThan(max, 1);

        // the two literal replacements are what CodeQL's log-forging model recognises as the sanitiser; the loop covers the rest
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
