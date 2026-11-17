using Xunit;

namespace Connector.Kit.Tests.Normalization;

// four of ten adapters called TryGetProperty on an element of unestablished kind; a rule prevents the fifth:
// outside the two readers no adapter calls the throwing accessors.
// Sources are scanned, not reflected: the forbidden thing is a call
public sealed class JsonReadRuleTests
{
    // each throws InvalidOperationException on a wrong-kind element instead of returning false (asserted in JsonReadTests)
    private static readonly string[] Banned =
    [
        ".TryGetProperty(",
        ".TryGetInt32(",
        ".TryGetInt64(",
        ".TryGetDecimal(",
    ];

    // JsonRead is the guarded reader; JsonAccess is the shop's alias-tolerant one (retailers rename fields)
    // and sets the kind on the line above; a third implementation means this list needs arguing
    private static readonly string[] Readers =
    [
        Path.Combine("Connector.Kit", "Normalization", "JsonRead.cs"),
        Path.Combine("ShopConnector.Adapters", "Support", "JsonAccess.cs"),
    ];

    [Fact]
    public void No_adapter_calls_a_json_accessor_that_throws_on_the_wrong_kind()
    {
        var offences = new List<string>();
        var scanned = 0;

        foreach (var file in Sources())
        {
            scanned++;

            if (Readers.Any(reader => file.EndsWith(reader, StringComparison.Ordinal))) continue;

            var lines = File.ReadAllLines(file);

            for (var i = 0; i < lines.Length; i++)
            {
                foreach (var call in Banned.Where(call => lines[i].Contains(call, StringComparison.Ordinal)))
                {
                    offences.Add(
                        $"{Path.GetRelativePath(RepoRoot(), file)}:{i + 1} calls {call.Trim('.', '(')}");
                }
            }
        }

        // a scan that looked nowhere would pass silently
        Assert.True(scanned > 100, $"only {scanned} source files were scanned; the sweep is not reaching them");

        Assert.True(
            offences.Count == 0,
            "These read a provider payload with an accessor that THROWS on the wrong kind rather than "
            + "answering false - so a JSON null where an object was expected leaves as an "
            + "InvalidOperationException, which is not a JsonException, escapes every catch on the way out "
            + "and arrives at the caller as `internal`: retriable, blamed on this connector, and fatal to "
            + "the whole fetch. Use Connector.Kit.Normalization.JsonRead instead - Child, Has, Text, Int32, "
            + "Int64, Decimal, Flag, Items, Objects - every one of which answers 'not there'.\n  "
            + string.Join("\n  ", offences));
    }

    [Fact]
    public void The_reader_this_rule_points_at_exists()
    {
        Assert.All(
            Readers,
            reader => Assert.Contains(
                Sources(),
                file => file.EndsWith(reader, StringComparison.Ordinal)));
    }

    // obj/ and bin/ hold generated copies, so a call deleted from the tree would keep being found there
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
