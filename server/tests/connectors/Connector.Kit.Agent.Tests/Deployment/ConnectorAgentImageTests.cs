using System.Text.RegularExpressions;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent.Tests.Deployment;

// the per-connector images default to pooled; pooled in a house wipes the profile, signs out after failures and
// advertises config tiers, so the sign-in is gone without a word. No Docker here: reads the shipped files
public sealed partial class ConnectorAgentImageTests
{
    private static string ProjectDirectory => ByoCompose.AgentProject;

    [Fact]
    public void The_shipped_settings_are_a_BYO_agent_at_one_job_at_a_time()
    {
        var options = Bind();

        Assert.Equal(AgentClass.Byo, options.Class);
        Assert.Equal(1, options.MaxConcurrency);

        // no Runtimes list: tiers come from the adapters; a list cannot add one and is refused if it drops one
        Assert.Empty(options.Runtimes);

        var capabilities = options.BuildCapabilities([PersistentAdapter.Manifest]);

        Assert.Equal([ProviderRuntime.BrowserPersistent], capabilities.Runtimes);
        Assert.Equal(AgentClass.Byo, capabilities.Class);
    }

    // connectors are per-deployment: a baked-in control plane enrolls somewhere nobody chose, and an agent with
    // nowhere to call refuses to boot instead of idling healthy-looking; hence the absence is asserted
    [Fact]
    public void The_shipped_settings_name_no_connector_and_no_code()
    {
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(Path.Combine(ProjectDirectory, "appsettings.json"), optional: false)
            .Build();

        var section = configuration.GetSection(ConnectorAgentOptions.SectionName);

        Assert.Null(section["ControlPlaneBaseUrl"]);
        Assert.Null(section["EnrollmentCode"]);
        Assert.Empty(section.GetSection("Connections").GetChildren());
    }

    // one container for the household is true only if all three adapter sets are in it; a missing one looks healthy
    // read from the csproj: a kit test project referencing three products would invert the dependency direction
    [Fact]
    public void The_home_agent_references_every_products_adapters()
    {
        var project = File.ReadAllText(Path.Combine(ProjectDirectory, "Connector.Agent.csproj"));

        Assert.Contains("BankConnector.Adapters.csproj", project, StringComparison.Ordinal);
        Assert.Contains("ShopConnector.Adapters.csproj", project, StringComparison.Ordinal);
        Assert.Contains("RegistryConnector.Adapters.csproj", project, StringComparison.Ordinal);

        // referencing is not registering: a linked adapter library that is never added advertises nothing
        var program = File.ReadAllText(Path.Combine(ProjectDirectory, "Program.cs"));

        Assert.Contains("BankAdapters.All(", program, StringComparison.Ordinal);
        Assert.Contains("ShopAdapters.All(", program, StringComparison.Ordinal);
        Assert.Contains("RegistryAdapters.All(", program, StringComparison.Ordinal);
    }

    // the per-connector images once set Agent__ProfileRoot/WorkRoot, which bound to nothing: a restart lost the sign-in
    [Fact]
    public void The_dockerfile_points_the_agent_at_the_directories_it_mounts()
    {
        var dockerfile = File.ReadAllText(Path.Combine(ProjectDirectory, "Dockerfile"));

        Assert.Contains("ConnectorAgent__ProfileRootDirectory=/profiles", dockerfile, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent__WorkRootDirectory=/work", dockerfile, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent__StateFilePath=/state/agent-state.json", dockerfile, StringComparison.Ordinal);

        // Xvfb so the browser is genuinely headed; pwuser because a browser rendering a hostile page must never be root
        Assert.Contains("agent-entrypoint.sh", dockerfile, StringComparison.Ordinal);
        Assert.Contains("USER pwuser", dockerfile, StringComparison.Ordinal);
    }

    // an unpublished image is an absent provider: registry-connector-agent was missing from the paths filter and matrices
    // a missing paths entry fails nothing: per-connector agents rebuild, this one stays behind; checked against the csproj
    [Fact]
    public void The_release_workflow_publishes_the_image_and_rebuilds_it_when_its_sources_change()
    {
        var workflow = File.ReadAllText(
            Path.Combine(ByoCompose.RepoRoot(), ".github", "workflows", "release-images.yml"));

        // built from its own Dockerfile and merged into the `:latest`/`:dev` tag a host pulls; no manifest entry: arch tag only
        Assert.Contains("file: server/src/connectors/Connector.Agent/Dockerfile", workflow, StringComparison.Ordinal);
        Assert.Contains("munni-connector-agent:$CHANNEL-$BUILD-amd64", workflow, StringComparison.Ordinal);
        Assert.Contains("-t \"$REGISTRY/munni-connector-agent:$CHANNEL\"", workflow, StringComparison.Ordinal);

        // the workflow runs only for the paths it lists: every directory this image is built from must fall under one,
        // or a change there leaves the agent behind
        var filter = PathFilterEntry().Matches(workflow).Select(match => match.Groups["path"].Value).ToArray();
        foreach (var referenced in ReferencedProjectDirectories())
        {
            Assert.True(
                filter.Any(entry => referenced.StartsWith(
                    entry.Replace("**", string.Empty, StringComparison.Ordinal),
                    StringComparison.Ordinal)),
                $"the agent is built from {referenced} and no paths filter covers it, so a change there "
                + "rebuilds nothing and leaves this image behind");
        }
    }

    private static IEnumerable<string> ReferencedProjectDirectories()
    {
        var project = File.ReadAllText(Path.Combine(ProjectDirectory, "Connector.Agent.csproj"));

        foreach (Match reference in ProjectReference().Matches(project))
        {
            var absolute = Path.GetFullPath(
                Path.Combine(ProjectDirectory, reference.Groups["include"].Value.Replace('\\', Path.DirectorySeparatorChar)));

            var directory = Path.GetDirectoryName(absolute)!;

            yield return Path.GetRelativePath(ByoCompose.RepoRoot(), directory).Replace('\\', '/');
        }
    }

    [GeneratedRegex(@"<ProjectReference\s+Include=""(?<include>[^""]+)""")]
    private static partial Regex ProjectReference();

    [GeneratedRegex(@"^\s+- '(?<path>[^']+)'\s*$", RegexOptions.Multiline)]
    private static partial Regex PathFilterEntry();

    private static ConnectorAgentOptions Bind()
    {
        var configuration = new ConfigurationBuilder()
            .AddJsonFile(Path.Combine(ProjectDirectory, "appsettings.json"), optional: false)
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["ConnectorAgent:ControlPlaneBaseUrl"] = "https://registry.internal:8392/",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddConnectorAgent(configuration, agent => agent.AddAdapter(new PersistentAdapter()));

        return services.BuildServiceProvider().GetRequiredService<ConnectorAgentOptions>();
    }

    private sealed class PersistentAdapter : IProviderAdapter
    {
        public static ProviderManifest Manifest { get; } = new()
        {
            Id = "mock-bank-persistent",
            Name = "Mock bank (always-on)",
            Kind = ProviderKind.Bank,
            Country = "NL",
            ManifestVersion = 1,
            Runtime = ProviderRuntime.BrowserPersistent,
            Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo },
            SecretCustody = SecretCustody.Agent,
            UnattendedFetch = true,
            Logout = LogoutSupport.None,
            Auth = new AuthSpec
            {
                Flow = AuthFlow.DevicePersistent,
                Steps = [],
                Session = new SessionSpec { TtlSeconds = 3600, Refreshable = false },
            },
            Resources = [new ResourceSpec { Id = "accounts", Returns = ResourceShape.Account }],
        };

        public ProviderManifest Describe() => Manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
