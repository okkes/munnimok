using Xunit;

namespace Connector.Kit.Tests.Normalization;

/// <summary>
/// The rule that stops this coming back.
///
/// An adversarial audit of ten adapters found the same mistake in four of them:
/// <c>TryGetProperty</c> called on an element whose kind nobody had
/// established. It was written by different hands at different times and read
/// as correct every time, because the method's name says it cannot fail.
///
/// Fixing four instances fixes four instances. What makes the fifth impossible
/// is a rule, and this is it: outside the two readers that implement it, an
/// adapter does not call the runtime's throwing accessors at all.
///
/// By reading the sources rather than by reflection, because the thing being
/// forbidden is a call - not a type, not a signature, and not anything an
/// assembly records.
/// </summary>
public sealed class JsonReadRuleTests
{
    /// <summary>
    /// The four calls whose <c>Try</c> is a lie.
    /// </summary>
    /// <remarks>
    /// Each throws <see cref="InvalidOperationException"/> on an element of the
    /// wrong kind rather than returning false - see
    /// <see cref="JsonReadTests.The_runtimes_own_try_methods_throw_rather_than_answering_false"/>,
    /// which asserts that rather than assuming it.
    /// </remarks>
    private static readonly string[] Banned =
    [
        ".TryGetProperty(",
        ".TryGetInt32(",
        ".TryGetInt64(",
        ".TryGetDecimal(",
    ];

    /// <summary>
    /// The two files allowed to make those calls, and why.
    /// </summary>
    /// <remarks>
    /// <c>JsonRead</c> is the guarded reader itself. <c>JsonAccess</c> is the
    /// shop connector's alias-tolerant one, which exists because retailers
    /// rename fields between releases and meant nothing by it - a different
    /// contract from the kit's exact-name reads, and correct in its own right:
    /// its one property access establishes the element's kind on the line
    /// above.
    /// <para>
    /// Two implementations of a guard, and no more. The moment there is a
    /// third, this list is the thing that has to be argued with.
    /// </para>
    /// </remarks>
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

        // The scan finding nothing because it looked nowhere is the failure
        // mode a rule like this dies of quietly.
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

    /// <summary>
    /// And the rule is worth nothing if the reader it points at is not there.
    /// </summary>
    [Fact]
    public void The_reader_this_rule_points_at_exists()
    {
        Assert.All(
            Readers,
            reader => Assert.Contains(
                Sources(),
                file => file.EndsWith(reader, StringComparison.Ordinal)));
    }

    /// <summary>
    /// Every connector's own source, minus the build output - which carries
    /// generated copies, so a call deleted from the tree would go on being
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
