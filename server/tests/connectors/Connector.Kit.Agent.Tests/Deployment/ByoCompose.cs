using System.Text.RegularExpressions;

namespace Connector.Kit.Agent.Tests.Deployment;

// a line reader, not a YAML library: one that cannot parse what a human wrote fails loudly in a test
// commented services are skipped (not running); commented connector blocks are read: users are told to uncomment them
internal sealed partial class ByoCompose
{
    private ByoCompose(
        string projectName,
        IReadOnlyDictionary<string, string> shared,
        IReadOnlyDictionary<string, string> sharedEnvironment,
        IReadOnlyList<ByoService> services,
        IReadOnlyList<string> declaredVolumes,
        IReadOnlyList<ByoConnectorBlock> connectorBlocks)
    {
        ProjectName = projectName;
        Shared = shared;
        SharedEnvironment = sharedEnvironment;
        Services = services;
        DeclaredVolumes = declaredVolumes;
        ConnectorBlocks = connectorBlocks;
    }

    // docker prefixes named volumes with it: the name the header's migration instructions must mount
    public string ProjectName { get; }

    public IReadOnlyDictionary<string, string> Shared { get; }

    public IReadOnlyDictionary<string, string> SharedEnvironment { get; }

    public IReadOnlyList<ByoService> Services { get; }

    public IReadOnlyList<string> DeclaredVolumes { get; }

    // live and commented alike: a defect in a block the reader is told to uncomment only shows up on their NAS
    public IReadOnlyList<ByoConnectorBlock> ConnectorBlocks { get; }

    public static IReadOnlyDictionary<string, string> DotEnv { get; } =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["CONNECTOR_URL"] = "https://munni-dev-nas.test/connector",
            ["ENROLLMENT_CODE"] = "AGNT-TEST-0000",
        };

    public static ByoCompose Read(IReadOnlyDictionary<string, string>? dotEnv = null)
    {
        var env = dotEnv ?? DotEnv;

        var projectName = string.Empty;
        var shared = new Dictionary<string, string>(StringComparer.Ordinal);
        var sharedEnvironment = new Dictionary<string, string>(StringComparer.Ordinal);
        var services = new List<ByoService>();
        var declaredVolumes = new List<string>();
        var blocks = new List<ByoConnectorBlock>();
        var ancestry = new List<(int Indent, string Key)>();

        // collected from `services:` down: the header's prose names these keys and must not read as a connector
        var inServices = false;

        foreach (var raw in File.ReadLines(FilePath))
        {
            var line = raw.TrimEnd();
            if (line.StartsWith("services:", StringComparison.Ordinal)) inServices = true;

            if (inServices && ConnectorSetting().Match(line) is { Success: true } setting)
            {
                var index = setting.Groups["index"].Value;
                var block = blocks.Find(candidate => candidate.Index == index);
                if (block is null)
                {
                    block = new ByoConnectorBlock(index);
                    blocks.Add(block);
                }

                block.Record(
                    setting.Groups["property"].Value,
                    Interpolate(Unquote(setting.Groups["value"].Value), env),
                    commented: setting.Groups["hash"].Success);
            }

            if (line.Length == 0 || line.TrimStart().StartsWith('#')) continue;

            // a merge key or list item has no key of its own: it belongs to the open mapping above and must not change the path
            if (MergeLine().Match(line) is { Success: true } merge)
            {
                Record(ancestry, merge.Groups["anchor"].Value, isMerge: true);
                continue;
            }

            if (ListItem().Match(line) is { Success: true } item)
            {
                Record(ancestry, Interpolate(Unquote(item.Groups["value"].Value), env), isMerge: false);
                continue;
            }

            var mapping = MappingLine().Match(line);
            if (!mapping.Success) continue;

            var indent = mapping.Groups["indent"].Length;
            while (ancestry.Count > 0 && ancestry[^1].Indent >= indent) ancestry.RemoveAt(ancestry.Count - 1);
            ancestry.Add((indent, mapping.Groups["key"].Value));

            var path = ancestry.Select(a => a.Key).ToArray();

            // discovered, not listed, so a newly added service is held to these rules at once
            if (path is ["services", var serviceName]) services.Add(new ByoService(serviceName));
            if (path is ["volumes", var volumeName]) declaredVolumes.Add(volumeName);

            if (!mapping.Groups["value"].Success) continue;
            var value = Interpolate(Unquote(mapping.Groups["value"].Value), env);

            switch (path)
            {
                case ["name"]:
                    projectName = value;
                    break;

                // the anchor on `environment: &agent-env` is neither a setting nor inherited: dropped
                case ["x-agent", "environment"]:
                    break;
                case ["x-agent", var key]:
                    shared[key] = value;
                    break;
                case ["x-agent", "environment", var key]:
                    sharedEnvironment[key] = value;
                    break;
                case ["services", var name, var key] when services.Find(s => s.Name == name) is { } service:
                    service.Own[key] = value;
                    break;
                case ["services", var name, "environment", var key] when services.Find(s => s.Name == name) is { } service:
                    service.Environment[key] = value;
                    break;
                default:
                    break;
            }
        }

        // later wins, as under `<<`: the shared block first, the service's own keys over it
        foreach (var service in services)
        {
            if (service.Merges.Contains("agent"))
            {
                foreach (var (key, value) in shared) service.Effective.TryAdd(key, value);
            }

            foreach (var (key, value) in service.Own) service.Effective[key] = value;

            if (service.EnvironmentMerges.Contains("agent-env"))
            {
                foreach (var (key, value) in sharedEnvironment) service.MergedEnvironment[key] = value;
            }

            foreach (var (key, value) in service.Environment) service.MergedEnvironment[key] = value;
        }

        return new ByoCompose(projectName, shared, sharedEnvironment, services, declaredVolumes, blocks);

        void Record(List<(int Indent, string Key)> open, string value, bool isMerge)
        {
            var at = open.Select(a => a.Key).ToArray();
            if (at is not ["services", var name, ..]) return;
            if (services.Find(s => s.Name == name) is not { } service) return;

            switch (at)
            {
                case ["services", _] when isMerge:
                    service.Merges.Add(value);
                    break;
                case ["services", _, "environment"] when isMerge:
                    service.EnvironmentMerges.Add(value);
                    break;
                case ["services", _, "volumes"] when !isMerge:
                    service.Volumes.Add(value);
                    break;
                default:
                    break;
            }
        }
    }

    public static string FilePath => System.IO.Path.Combine(RepoRoot(), "deploy", "connectors", "household-agent.yml");

    public static string AgentProject => System.IO.Path.Combine(RepoRoot(), "server", "src", "connectors", "Connector.Agent");

    public static string RepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null)
        {
            if (File.Exists(System.IO.Path.Combine(directory.FullName, "Munni.slnx"))) return directory.Parent!.FullName;
            directory = directory.Parent;
        }

        throw new InvalidOperationException($"no Munni.slnx above {AppContext.BaseDirectory}");
    }

    // a required variable missing from the test's .env fails the way compose would
    private static string Interpolate(string value, IReadOnlyDictionary<string, string> dotEnv) =>
        Variable().Replace(value, m =>
        {
            if (dotEnv.TryGetValue(m.Groups["name"].Value, out var set)) return set;
            if (m.Groups["default"].Success) return m.Groups["default"].Value;
            if (m.Groups["required"].Success)
            {
                throw new InvalidOperationException(
                    $"the compose file requires {m.Groups["name"].Value}: {m.Groups["required"].Value}");
            }

            return string.Empty;
        });

    private static string Unquote(string value) =>
        value.Length >= 2 && value[0] == '"' && value[^1] == '"' ? value[1..^1] : value;

    [GeneratedRegex(@"^(?<indent>\s*)(?<key>[A-Za-z_][\w-]*):(?:\s+(?<value>\S.*))?$")]
    private static partial Regex MappingLine();

    [GeneratedRegex(@"^(?<indent>\s*)<<:\s*\*(?<anchor>[A-Za-z_][\w-]*)\s*$")]
    private static partial Regex MergeLine();

    [GeneratedRegex(@"^(?<indent>\s*)-\s+(?<value>\S.*)$")]
    private static partial Regex ListItem();

    [GeneratedRegex(
        @"^\s*(?<hash>#\s*)?ConnectorAgent__Connections__(?<index>[0-9]+)__(?<property>[A-Za-z]+):\s+(?<value>\S.*)$")]
    private static partial Regex ConnectorSetting();

    [GeneratedRegex(@"\$\{(?<name>[A-Z_][A-Z0-9_]*)(?::-(?<default>[^}]*)|:\?(?<required>[^}]*))?\}")]
    private static partial Regex Variable();
}

internal sealed class ByoService(string name)
{
    public string Name { get; } = name;

    public List<string> Merges { get; } = [];

    public List<string> EnvironmentMerges { get; } = [];

    public Dictionary<string, string> Own { get; } = new(StringComparer.Ordinal);

    public Dictionary<string, string> Environment { get; } = new(StringComparer.Ordinal);

    public Dictionary<string, string> Effective { get; } = new(StringComparer.Ordinal);

    public Dictionary<string, string> MergedEnvironment { get; } = new(StringComparer.Ordinal);

    public List<string> Volumes { get; } = [];

    public override string ToString() => Name;
}

// live or commented, a block is held to the same rules: nothing else checks the commented ones before a user uncomments them
internal sealed class ByoConnectorBlock(string index)
{
    // a block missing one makes the agent refuse to start, or (Name defaults to the index) keeps browsers in a directory `1`
    public static IReadOnlyList<string> Required { get; } = ["Name", "ControlPlaneBaseUrl", "EnrollmentCode"];

    public string Index { get; } = index;

    public Dictionary<string, string> Settings { get; } = new(StringComparer.Ordinal);

    public List<string> Live { get; } = [];

    public List<string> Commented { get; } = [];

    // judged by name, not by the whole block: the certificate authority is commented out in a live block on purpose
    public bool IsLive => Live.Contains("Name");

    public string Name => Settings.TryGetValue("Name", out var name) ? name : Index;

    public void Record(string property, string value, bool commented)
    {
        Settings[property] = value;
        (commented ? Commented : Live).Add(property);
    }

    public override string ToString() => $"{Index} ({Name})";
}
