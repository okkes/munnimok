using System.Reflection;

namespace ShopConnector.Adapters.Fixtures;

// fixtures are part of the contract: parsing is tested offline in CI, and the mock providers read them too
public static class FixtureCatalog
{
    private const string Prefix = "ShopConnector.Adapters.Fixtures.";

    private static readonly Assembly Owner = typeof(FixtureCatalog).Assembly;

    private static readonly Dictionary<string, string> Resources = Build();

    public static IReadOnlyList<string> Names { get; } = [.. Resources.Keys.Order(StringComparer.Ordinal)];

    public static string Read(string name)
    {
        using var stream = Open(name);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public static Stream Open(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        if (!Resources.TryGetValue(name.Replace('\\', '/'), out var resource))
        {
            throw new FileNotFoundException(
                $"no fixture '{name}'; known fixtures are [{string.Join(", ", Names)}]", name);
        }

        return Owner.GetManifestResourceStream(resource)
               ?? throw new FileNotFoundException($"fixture '{name}' is registered but unreadable", name);
    }

    // MSBuild flattens folders into dots, so the last two segments are file.extension: a fixture file name has exactly one dot
    private static Dictionary<string, string> Build()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var resource in Owner.GetManifestResourceNames())
        {
            if (!resource.StartsWith(Prefix, StringComparison.Ordinal)) continue;

            var segments = resource[Prefix.Length..].Split('.');
            if (segments.Length < 2) continue;

            var file = $"{segments[^2]}.{segments[^1]}";
            var folders = segments[..^2];
            map[folders.Length == 0 ? file : $"{string.Join('/', folders)}/{file}"] = resource;
        }

        return map;
    }
}
