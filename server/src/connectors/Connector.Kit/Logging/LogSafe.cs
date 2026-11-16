using System.Text;

namespace Connector.Kit.Logging;

// CodeQL cs/log-forging: a line break in a route parameter, query value, agent detail or reason key forges a log entry;
// every such value goes through Line (breaks and control characters become a space, length capped)
public static class LogSafe
{
    /// <summary>Longer values are cut here; a log line is a sentence, not a payload.</summary>
    public const int MaxLength = 200;

    public const char Ellipsis = '…';

    // null and empty come back empty, so a caller's ?? "-" keeps working
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

    // U+2028/U+2029 are line breaks to a log viewer but not char.IsControl
    private const char LineSeparator = (char)0x2028;
    private const char ParagraphSeparator = (char)0x2029;

    private static bool IsLineBreaking(char ch) =>
        char.IsControl(ch) || ch is LineSeparator or ParagraphSeparator;
}
