using Connector.Kit.Logging;
using Xunit;

namespace Connector.Kit.Tests.Logging;

/// <summary>
/// One log line per value, whatever the value carried: the forged entry a
/// line break would start, the cursor games a control character plays, and
/// the flood a long payload would be.
/// </summary>
public sealed class LogSafeTests
{
    // U+2028 / U+2029, spelt as code points: a literal one inside a string is a line break to the C# compiler too
    private static readonly string LineSeparator = ((char)0x2028).ToString();
    private static readonly string ParagraphSeparator = ((char)0x2029).ToString();

    [Fact]
    public void Line_breaks_of_every_kind_become_a_space()
    {
        var forged = "job_1\r\n[ERR] the platform is on fire" + LineSeparator + "and so is this" + ParagraphSeparator + "and\u0085this";

        var line = LogSafe.Line(forged);

        Assert.Equal("job_1  [ERR] the platform is on fire and so is this and this", line);
        Assert.DoesNotContain('\n', line);
        Assert.DoesNotContain('\r', line);
    }

    [Fact]
    public void Other_control_characters_go_the_same_way_and_plain_text_passes_untouched()
    {
        Assert.Equal("a b c", LogSafe.Line("a\tb\u001bc"));
        Assert.Equal("bol: graphql refused OrdersOverviewClient (hash=sha256:d195)", LogSafe.Line("bol: graphql refused OrdersOverviewClient (hash=sha256:d195)"));
        Assert.Equal("ünïcödé stays — so does 日本語", LogSafe.Line("ünïcödé stays — so does 日本語"));
    }

    [Fact]
    public void A_long_value_is_cut_at_the_cap_and_says_so()
    {
        var payload = new string('x', 5_000);

        var line = LogSafe.Line(payload);

        Assert.Equal(LogSafe.MaxLength + 1, line.Length);
        Assert.EndsWith(LogSafe.Ellipsis.ToString(), line, StringComparison.Ordinal);

        var tight = LogSafe.Line("abcdef", max: 3);
        Assert.Equal("abc" + LogSafe.Ellipsis, tight);
        Assert.Equal("abc", LogSafe.Line("abc", max: 3));
    }

    [Fact]
    public void Nothing_in_nothing_out_so_a_callers_own_fallback_keeps_working()
    {
        Assert.Equal(string.Empty, LogSafe.Line(null));
        Assert.Equal(string.Empty, LogSafe.Line(string.Empty));
        Assert.Equal("-", LogSafe.Line((string?)null ?? "-"));
        Assert.Throws<ArgumentOutOfRangeException>(() => LogSafe.Line("x", max: 0));
    }
}
