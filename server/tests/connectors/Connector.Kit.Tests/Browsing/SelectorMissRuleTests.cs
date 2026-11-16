using Xunit;

namespace Connector.Kit.Tests.Browsing;

// Playwright .NET raises System.TimeoutException, not a PlaywrightException, on an expired wait: a bare
// catch (PlaywrightException) lets it escape as `internal` and takes the job down
// a comment did not stop it (21 bare catches, one failed live on a bank), so this reads sources
public sealed class SelectorMissRuleTests
{
    // both spellings; a line that also mentions TimeoutException made the choice deliberately
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

                // prose quoting the banned clause is not a breach: a line that starts in a comment is skipped,
                // a trailing comment on a statement is still scanned
                if (IsComment(lines[i])) continue;

                foreach (var clause in Banned.Where(c => lines[i].Contains(c, StringComparison.Ordinal)))
                {
                    offences.Add($"{Path.GetRelativePath(RepoRoot(), file)}:{i + 1} uses {clause}");
                }
            }
        }

        // a sweep that looked nowhere would die unnoticed
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
               || trimmed.StartsWith('*');
    }

    // skipping any line that mentions a comment would let a real catch hide behind a trailing // best effort
    [Fact]
    public void The_exemption_covers_prose_and_not_a_statement_with_a_note_on_it()
    {
        Assert.True(IsComment("    /// on a miss, a bare catch (PlaywrightException) lets the timeout"));
        Assert.True(IsComment("            // catch (PlaywrightException) was the old shape"));

        Assert.False(IsComment("        catch (PlaywrightException) // best effort"));
        Assert.False(IsComment("        catch (PlaywrightException)"));
    }

    // asserted against the real types: TimeoutException is not assignable to PlaywrightException,
    // which is why the bare catch fails
    [Fact]
    public void The_predicate_this_rule_points_at_covers_a_timeout()
    {
        Assert.True(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new System.TimeoutException("Timeout 10000ms exceeded.")));
        Assert.True(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new Microsoft.Playwright.PlaywrightException("gone")));

        Assert.False(typeof(Microsoft.Playwright.PlaywrightException).IsAssignableFrom(typeof(System.TimeoutException)));

        Assert.False(Connector.Kit.Browsing.PageOps.IsSelectorMiss(new InvalidOperationException("a real fault")));
    }

    // minus build output: obj/ holds generated copies that would keep finding a clause deleted from the tree
    private static IEnumerable<string> Sources()
    {
        var source = Path.Combine(RepoRoot(), "server", "src", "connectors");
        foreach (var file in Directory.EnumerateFiles(source, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;
            if (file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) continue;

            yield return file;
        }
    }

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
