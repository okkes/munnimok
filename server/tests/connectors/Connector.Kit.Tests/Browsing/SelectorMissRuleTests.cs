using Xunit;

namespace Connector.Kit.Tests.Browsing;

/// <summary>
/// The rule that stops <c>catch (PlaywrightException)</c> coming back.
///
/// Playwright for .NET raises <see cref="System.TimeoutException"/> - a BCL
/// type, unrelated to <c>PlaywrightException</c> - when a wait expires. So a
/// helper written to return false on a miss does no such thing: the timeout
/// escapes the catch, escapes the adapter, and reaches the caller as
/// <c>internal</c>. A page that simply did not have the button takes the whole
/// job down.
///
/// <para>
/// <see cref="Connector.Kit.Browsing.PageOps.IsSelectorMiss"/> has said this in
/// a comment since the first live Albert Heijn attempt. A comment did not stop
/// it: an audit found the bare catch in twenty-one places across four adapters
/// and the redactor, and one of them - ASN's select-all - failed live on a real
/// bank account, having passed a green suite on the way out.
/// </para>
///
/// <para>
/// So the comment becomes a rule. By reading sources rather than by reflection,
/// because what is forbidden is the shape of a catch clause and no assembly
/// records that.
/// </para>
/// </summary>
public sealed class SelectorMissRuleTests
{
    /// <summary>
    /// The catch that does not catch what it looks like it catches.
    /// </summary>
    /// <remarks>
    /// Both spellings, with and without naming the exception. Anything that
    /// also mentions <c>TimeoutException</c> on the same line has already made
    /// the choice deliberately and is left alone.
    /// </remarks>
    private static readonly string[] Banned =
    [
        "catch (PlaywrightException)",
        "catch (PlaywrightException ex)",
    ];

    [Fact]
    public void No_browser_code_catches_a_playwright_failure_without_its_timeout()
    {
        var offences = new List<string>();
        var scanned = 0;

        foreach (var file in Sources())
        {
            scanned++;

            var lines = File.ReadAllLines(file);

            for (var i = 0; i < lines.Length; i++)
            {
                if (lines[i].Contains("TimeoutException", StringComparison.Ordinal)) continue;

                // Prose about the rule is not a breach of it. PageOps' own
                // remarks quote the banned clause in order to forbid it, and
                // the first run of this test duly reported the warning as the
                // offence. A line that STARTS in a comment is documentation; a
                // trailing comment on a real statement is still scanned.
                if (IsComment(lines[i])) continue;

                foreach (var clause in Banned.Where(c => lines[i].Contains(c, StringComparison.Ordinal)))
                {
                    offences.Add($"{Path.GetRelativePath(RepoRoot(), file)}:{i + 1} uses {clause}");
                }
            }
        }

        // A sweep that finds nothing because it looked nowhere is how a rule
        // like this dies without anybody noticing.
        Assert.True(scanned > 100, $"only {scanned} source files were scanned; the sweep is not reaching them");

        Assert.True(
            offences.Count == 0,
            "These catch PlaywrightException alone. Playwright for .NET raises System.TimeoutException - not "
            + "a PlaywrightException - when a wait expires, so the miss these are written to absorb escapes "
            + "instead and arrives at the caller as `internal`: retriable, blamed on this connector, and "
            + "fatal to the whole job. A page that simply did not have the element takes the run down with "
            + "it. Catch `Exception ex when (PageOps.IsSelectorMiss(ex))` instead.\n  "
            + string.Join("\n  ", offences));
    }

    private static bool IsComment(string line)
    {
        var trimmed = line.TrimStart();

        return trimmed.StartsWith("//", StringComparison.Ordinal)
               || trimmed.StartsWith("*", StringComparison.Ordinal);
    }

    /// <summary>
    /// And the exemption for prose does not exempt code with a comment on it.
    /// </summary>
    /// <remarks>
    /// The narrow escape this rule nearly shipped with. Skipping any line that
    /// MENTIONS a comment would have let a real catch clause hide behind a
    /// trailing <c>// best effort</c> - which is exactly the sort of line one
    /// of these sits on.
    /// </remarks>
    [Fact]
    public void The_exemption_covers_prose_and_not_a_statement_with_a_note_on_it()
    {
        Assert.True(IsComment("    /// on a miss, a bare catch (PlaywrightException) lets the timeout"));
        Assert.True(IsComment("            // catch (PlaywrightException) was the old shape"));

        Assert.False(IsComment("        catch (PlaywrightException) // best effort"));
        Assert.False(IsComment("        catch (PlaywrightException)"));
    }

    /// <summary>
    /// And the predicate the rule points at has to actually cover the timeout.
    /// </summary>
    /// <remarks>
    /// Asserted against the real type rather than trusted, because the whole
    /// rule above rests on this one being right - and it is the sort of claim
    /// that reads as obviously true and is obviously true in the wrong
    /// direction. <see cref="System.TimeoutException"/> is not assignable to
    /// <c>PlaywrightException</c>, which is exactly why the bare catch fails.
    /// </remarks>
    [Fact]
    public void The_predicate_this_rule_points_at_covers_a_timeout()
    {
        Assert.True(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new System.TimeoutException("Timeout 10000ms exceeded.")));
        Assert.True(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new Microsoft.Playwright.PlaywrightException("gone")));

        // The trap itself, stated as an assertion: catching one never catches
        // the other.
        Assert.False(typeof(Microsoft.Playwright.PlaywrightException).IsAssignableFrom(typeof(System.TimeoutException)));

        // And it is not a catch-all - a real fault still travels.
        Assert.False(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new InvalidOperationException("a real fault")));
    }

    /// <summary>
    /// Every connector's own source, minus the build output - which carries
    /// generated copies, so a clause deleted from the tree would go on being
    /// found in <c>obj/</c> for ever.
    /// </summary>
    private static IEnumerable<string> Sources()
    {
        // every connector project — the kit, the hosting library, the agent runtime and the adapter packs
        var source = Path.Combine(RepoRoot(), "server", "src", "connectors");
        foreach (var file in Directory.EnumerateFiles(source, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;
            if (file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;

            yield return file;
        }
    }

    /// <summary>The monorepo's root: the parent of the directory holding <c>Munni.slnx</c>.</summary>
    private static string RepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Munni.slnx"))) return directory.Parent!.FullName;
            directory = directory.Parent;
        }

        throw new InvalidOperationException($"no Munni.slnx above {AppContext.BaseDirectory}");
    }
}
