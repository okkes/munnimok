using System.Reflection;

namespace RegistryConnector.Adapters.Fixtures;

// recorded payloads, embedded so parse tests need no file paths; also copied to output so an operator can diff a capture
public static class FixtureCatalog
{
    private static readonly Assembly Owner = typeof(FixtureCatalog).Assembly;

    private const string Root = "RegistryConnector.Adapters.Fixtures.";

    public static string Read(string name)
    {
        using var stream = Open(name);
        using var reader = new StreamReader(stream);

        return reader.ReadToEnd();
    }

    private static Stream Open(string name)
    {
        var resource = Root + name.Replace('/', '.');

        return Owner.GetManifestResourceStream(resource)
               ?? throw new FileNotFoundException(
                   $"no fixture '{name}'; known fixtures are [{string.Join(", ", Known())}]", name);
    }

    private static IEnumerable<string> Known() =>
        Owner.GetManifestResourceNames()
            .Where(n => n.StartsWith(Root, StringComparison.Ordinal))
            .Select(n => n[Root.Length..]);
}
