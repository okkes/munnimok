using Munni.Api;

namespace Munni.Api.Tests;

/// <summary>
/// One log line per request value: a line break in a path or a query value
/// never starts a second entry, and a payload never floods the log.
/// </summary>
public class LogSafeTests
{
    [Fact]
    public void LineBreaksAndControlCharactersBecomeASpace()
    {
        // U+2028 spelt as a code point: a literal one inside a string is a line break to the C# compiler too
        var line = LogSafe.Line("/admin/invitations\r\n[WRN] forged entry" + (char)0x2028 + "tab\there\u001b");

        Assert.Equal("/admin/invitations  [WRN] forged entry tab here ", line);
        Assert.DoesNotContain('\n', line);
        Assert.DoesNotContain('\r', line);
    }

    [Fact]
    public void PlainTextPassesAndLongValuesAreCutWithAMark()
    {
        Assert.Equal("GET /connectors/sessions?state=active", LogSafe.Line("GET /connectors/sessions?state=active"));

        var cut = LogSafe.Line(new string('p', 1_000));
        Assert.Equal(LogSafe.MaxLength + 1, cut.Length);
        Assert.EndsWith(LogSafe.Ellipsis.ToString(), cut, StringComparison.Ordinal);
        Assert.Equal("ab" + LogSafe.Ellipsis, LogSafe.Line("abc", max: 2));
    }

    [Fact]
    public void NothingInNothingOut()
    {
        Assert.Equal(string.Empty, LogSafe.Line(null));
        Assert.Equal(string.Empty, LogSafe.Line(string.Empty));
        Assert.Throws<ArgumentOutOfRangeException>(() => LogSafe.Line("x", max: 0));
    }
}
