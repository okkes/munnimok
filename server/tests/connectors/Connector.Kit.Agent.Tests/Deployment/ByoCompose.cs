using System.Text.RegularExpressions;

namespace Connector.Kit.Agent.Tests.Deployment;

/// <summary>
/// <c>deploy/byo/docker-compose.yml</c>, read the way the tests in this folder
/// need it: every service that is actually live in the file, what each of them
/// ends up with once any merge keys have been applied, and every CONNECTOR
/// BLOCK in the file whether it is live or commented out.
///
/// <para>
/// <b>Why a reader and not a YAML library.</b> This started as a private
/// twenty-line parser inside <see cref="ByoAgentRuntimesTests"/> that needed
/// four keys out of one service. It is still a line reader: the file is
/// two-space indented mappings, a test dependency on a YAML package would be a
/// new package for a handful of keys, and a reader that cannot parse something
/// a human wrote in this file is a reader that fails loudly in a test rather
/// than a deployment that does something surprising.
/// </para>
///
/// <para>
/// <b>The file used to be one service per connector and is now one service
/// with a block per connector</b>, which moves where the interesting mistakes
/// live. It kept <c>x-agent</c> and <c>x-agent-env</c> so that three service
/// blocks could share one set of settings; with one service those anchors were
/// indirection between a reader and the container's actual environment, so
/// they are gone. The merge handling below stays, because a second service is
/// still a thing somebody adds - a second account at the same provider needs
/// its own browser - and a file that grows one must not quietly stop being
/// checked.
/// </para>
///
/// <para>
/// <b>Commented lines are skipped for services and READ for connector
/// blocks</b>, and the difference is what each of them is. A commented service
/// is not running: a comment is text, and it is what keeps
/// <c>BANK_CONTROL_PLANE</c> from reaching compose. A commented connector
/// block is an instruction - the file tells the reader to uncomment the
/// connectors they use - so it is as load-bearing as a live one, and an
/// incomplete block sitting there as text is a mistake waiting for whoever
/// follows those instructions. See <see cref="ConnectorBlocks"/>.
/// </para>
/// </summary>
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

    /// <summary>
    /// The top-level <c>name:</c> - <c>connector-byo</c>. Docker prefixes
    /// every named volume with it, so this plus a declared volume is the name
    /// that shows up in <c>docker volume ls</c> and the name the migration
    /// instructions in the header have to mount.
    /// </summary>
    public string ProjectName { get; }

    /// <summary>The scalars on <c>x-agent</c> itself - <c>stop_grace_period</c> and friends.</summary>
    public IReadOnlyDictionary<string, string> Shared { get; }

    /// <summary>The environment on <c>x-agent</c>, which every service merges.</summary>
    public IReadOnlyDictionary<string, string> SharedEnvironment { get; }

    /// <summary>The services that are not commented out, in file order.</summary>
    public IReadOnlyList<ByoService> Services { get; }

    /// <summary>The names under the top-level <c>volumes:</c> key that are not commented out.</summary>
    public IReadOnlyList<string> DeclaredVolumes { get; }

    /// <summary>
    /// Every <c>ConnectorAgent__Connections__&lt;n&gt;__*</c> block under
    /// <c>services:</c>, in file order, live and commented alike.
    /// </summary>
    /// <remarks>
    /// This is where a household says which connectors its one agent attaches
    /// to, and it is the part of the file people edit. One block ships live
    /// and the rest are text the reader is told to uncomment, so a block that
    /// is missing a setting, or that shares a number with another, is a defect
    /// that only shows up on somebody else's NAS the day they follow the
    /// instructions.
    /// </remarks>
    public IReadOnlyList<ByoConnectorBlock> ConnectorBlocks { get; }

    /// <summary>
    /// What the app fills in when it renders the file for a person: the one
    /// control plane of their environment and the code minted for them.
    /// </summary>
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

        // The header explains the connector blocks before it shows one, in
        // prose that names the keys. Blocks are collected from `services:`
        // downwards so that a sentence about ConnectorAgent__Connections is
        // never mistaken for a connector somebody could uncomment.
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

            // A merge key and a list item carry no key of their own, so they
            // belong to whatever mapping is open above them and must not
            // change the path - `<<: *agent` under a service is a fact about
            // that service, not a level inside it.
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

            // A service is any key directly under `services:`. Discovered
            // rather than listed, so a fourth connector added to the file is
            // held to these rules the day it lands and not the day somebody
            // remembers the test.
            if (path is ["services", var serviceName]) services.Add(new ByoService(serviceName));
            if (path is ["volumes", var volumeName]) declaredVolumes.Add(volumeName);

            if (!mapping.Groups["value"].Success) continue;
            var value = Interpolate(Unquote(mapping.Groups["value"].Value), env);

            switch (path)
            {
                case ["name"]:
                    projectName = value;
                    break;

                // The anchor on `environment: &agent-env` is a scalar to this
                // reader and a merge target to compose. It is neither a
                // setting nor a thing a service inherits, so it is dropped
                // rather than carried into every service's effective keys.
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

        // Later wins, as it does under `<<`: the shared block first, the
        // service's own keys over it.
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

    /// <summary>The household compose the app renders for a person's own machine.</summary>
    public static string FilePath => System.IO.Path.Combine(RepoRoot(), "deploy", "connectors", "household-agent.yml");

    /// <summary>The one agent project — pooled fleet and household alike.</summary>
    public static string AgentProject => System.IO.Path.Combine(RepoRoot(), "server", "src", "connectors", "Connector.Agent");

    /// <summary>
    /// The monorepo's root: the parent of the directory holding <c>Munni.slnx</c>
    /// (<c>server/</c>), so <c>deploy/</c>, <c>.github/</c> and
    /// <c>server/src/connectors/</c> resolve from one place.
    /// </summary>
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

    /// <summary>
    /// <c>${VAR:-default}</c>, <c>${VAR:?message}</c> and <c>${VAR}</c>, as
    /// compose resolves them against <c>.env</c>. A required variable the
    /// test's <c>.env</c> does not carry fails the way compose would.
    /// </summary>
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

    /// <summary>
    /// A mapping key and, optionally, its scalar. List items, merge keys and
    /// anchors on their own are not mapping keys and do not match.
    /// </summary>
    [GeneratedRegex(@"^(?<indent>\s*)(?<key>[A-Za-z_][\w-]*):(?:\s+(?<value>\S.*))?$")]
    private static partial Regex MappingLine();

    /// <summary><c>&lt;&lt;: *anchor</c>, which is how every service takes the shared block.</summary>
    [GeneratedRegex(@"^(?<indent>\s*)<<:\s*\*(?<anchor>[A-Za-z_][\w-]*)\s*$")]
    private static partial Regex MergeLine();

    [GeneratedRegex(@"^(?<indent>\s*)-\s+(?<value>\S.*)$")]
    private static partial Regex ListItem();

    /// <summary>
    /// One line of a connector block, commented or not:
    /// <c># ConnectorAgent__Connections__1__Name: bank</c>.
    /// </summary>
    /// <remarks>
    /// The double-underscore spelling is the environment's, which is the one
    /// that matters here: this is what compose hands the container, and the
    /// configuration provider is what turns it back into
    /// <c>ConnectorAgent:Connections:1:Name</c>.
    /// </remarks>
    [GeneratedRegex(
        @"^\s*(?<hash>#\s*)?ConnectorAgent__Connections__(?<index>[0-9]+)__(?<property>[A-Za-z]+):\s+(?<value>\S.*)$")]
    private static partial Regex ConnectorSetting();

    [GeneratedRegex(@"\$\{(?<name>[A-Z_][A-Z0-9_]*)(?::-(?<default>[^}]*)|:\?(?<required>[^}]*))?\}")]
    private static partial Regex Variable();
}

/// <summary>One service in the BYO compose file, and what it merges.</summary>
internal sealed class ByoService(string name)
{
    public string Name { get; } = name;

    /// <summary>Anchors merged at the service level - <c>agent</c>, normally.</summary>
    public List<string> Merges { get; } = [];

    /// <summary>Anchors merged inside the service's <c>environment</c>.</summary>
    public List<string> EnvironmentMerges { get; } = [];

    /// <summary>The service's own scalars, before the merge is applied.</summary>
    public Dictionary<string, string> Own { get; } = new(StringComparer.Ordinal);

    /// <summary>The service's own environment, before the merge is applied.</summary>
    public Dictionary<string, string> Environment { get; } = new(StringComparer.Ordinal);

    /// <summary>What compose ends up with: the shared block, then the service's own over it.</summary>
    public Dictionary<string, string> Effective { get; } = new(StringComparer.Ordinal);

    /// <summary>What the container is actually started with.</summary>
    public Dictionary<string, string> MergedEnvironment { get; } = new(StringComparer.Ordinal);

    /// <summary>The <c>volumes:</c> entries, as written - <c>agent_state:/state</c>.</summary>
    public List<string> Volumes { get; } = [];

    public override string ToString() => Name;
}

/// <summary>
/// One connector the household's single agent attaches to, as the compose file
/// writes it: the number in the keys and the settings under it.
/// </summary>
/// <remarks>
/// A block is either live or a paragraph of text the file tells the reader to
/// uncomment, and both are held to the same rules - the commented ones more
/// urgently, if anything, because nothing else will look at them between now
/// and the moment somebody pastes their bank's address into <c>.env</c> and
/// deletes three <c>#</c>.
/// </remarks>
internal sealed class ByoConnectorBlock(string index)
{
    /// <summary>
    /// The settings a connector cannot do without. A block missing any of
    /// them is a connection the agent refuses to start on, or - worse for
    /// <c>Name</c>, which defaults to the index - one that quietly keeps its
    /// browsers in a directory called <c>1</c>.
    /// </summary>
    public static IReadOnlyList<string> Required { get; } = ["Name", "ControlPlaneBaseUrl", "EnrollmentCode"];

    /// <summary>The <c>&lt;n&gt;</c> in the keys, as written.</summary>
    public string Index { get; } = index;

    /// <summary>Every setting in the block, live or commented, with its value interpolated.</summary>
    public Dictionary<string, string> Settings { get; } = new(StringComparer.Ordinal);

    /// <summary>The settings compose will actually hand the container.</summary>
    public List<string> Live { get; } = [];

    /// <summary>The settings sitting in the block as text.</summary>
    public List<string> Commented { get; } = [];

    /// <summary>
    /// Whether this connector is one the shipped file starts, judged by its
    /// name rather than by the block as a whole - the certificate authority is
    /// commented out in a live block on purpose, being the one setting most
    /// deployments do not need.
    /// </summary>
    public bool IsLive => Live.Contains("Name");

    /// <summary>What this connector is called, or the index when it says nothing.</summary>
    public string Name => Settings.TryGetValue("Name", out var name) ? name : Index;

    public void Record(string property, string value, bool commented)
    {
        Settings[property] = value;
        (commented ? Commented : Live).Add(property);
    }

    public override string ToString() => $"{Index} ({Name})";
}
