using System.Text.RegularExpressions;
using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent.Tests.Deployment;

/// <summary>
/// THE IMAGE A PERSON INSTALLS — and the operator's pooled fleet runs the
/// same one: what <c>Connector.Agent</c> ships as it stands, before any
/// compose file touches it.
///
/// <para>
/// The three per-connector agent images default to <c>pooled</c>, because most
/// of their instances are the operator's fleet. Most instances of this one are
/// somebody's house, and a pooled agent there is a quiet wrong answer in three
/// directions at once: it wipes the browser profile between jobs, signs itself
/// out to tidy up after a failure, and advertises the tiers its configuration
/// lists rather than the ones its adapters need. The sign-in the account
/// holder did once is simply gone, and nothing says why.
/// </para>
///
/// <para>
/// In the style of <see cref="ByoAgentRuntimesTests"/>: the deployment is the
/// thing under test and a one-line edit to a shipped file is what breaks it.
/// What this cannot reach is whether the CONTAINER then runs - that is Docker,
/// and there is none here - so it reads the files that decide what the
/// container is.
/// </para>
/// </summary>
public sealed partial class ConnectorAgentImageTests
{
    private static string ProjectDirectory => ByoCompose.AgentProject;

    /// <summary>
    /// The settings in the image are a BYO agent that runs one job at a time
    /// and derives its tiers from its adapters.
    /// </summary>
    /// <remarks>
    /// Bound through <c>AddConnectorAgent</c>, the same call this image's
    /// <c>Program.cs</c> makes, with only a control plane added - which is
    /// per-deployment and comes from the environment. So what is asserted is
    /// what the image IS, not what a compose file over it could make it.
    /// </remarks>
    [Fact]
    public void The_shipped_settings_are_a_BYO_agent_at_one_job_at_a_time()
    {
        var options = Bind();

        Assert.Equal(AgentClass.Byo, options.Class);
        Assert.Equal(1, options.MaxConcurrency);

        // No Runtimes list, ever. A BYO agent's tiers come from its adapters:
        // a list here cannot add one, is refused if it takes one away, and so
        // can only turn a working agent into one that will not start.
        Assert.Empty(options.Runtimes);

        // And it advertises the persistent tier - the one this whole image
        // exists for - without being told to.
        var capabilities = options.BuildCapabilities([PersistentAdapter.Manifest]);

        Assert.Equal([ProviderRuntime.BrowserPersistent], capabilities.Runtimes);
        Assert.Equal(AgentClass.Byo, capabilities.Class);
    }

    /// <summary>
    /// The shipped file configures no connector, and one process's worth of
    /// directories.
    /// </summary>
    /// <remarks>
    /// The connectors are per-deployment: an address and a one-time code
    /// belong to the household, not to the image. A control plane baked in
    /// here would be an agent that enrolls somewhere nobody chose, and an
    /// agent with nowhere to call refuses to boot rather than idling as a
    /// healthy-looking instance that never picks up work - which is why this
    /// asserts the absence rather than leaving it to chance.
    /// </remarks>
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

    /// <summary>
    /// IT CARRIES EVERY PRODUCT'S ADAPTERS, which is the whole reason this
    /// image exists.
    /// </summary>
    /// <remarks>
    /// One container for the household instead of three is only true if the
    /// binaries for all three are in it. Dropping a reference here would
    /// produce an image that builds, enrolls, heartbeats and looks completely
    /// healthy while being unable to serve a third of what somebody connected
    /// - the same shape of failure as the registry agent that was pointed at
    /// the shopping image and advertised fifteen shop providers and no BKR.
    /// <para>
    /// Read from the project file rather than by referencing the adapters:
    /// this suite is the KIT's, and a kit test project that depends on three
    /// products would invert the direction everything else here depends in.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_home_agent_references_every_products_adapters()
    {
        var project = File.ReadAllText(Path.Combine(ProjectDirectory, "Connector.Agent.csproj"));

        Assert.Contains("BankConnector.Adapters.csproj", project, StringComparison.Ordinal);
        Assert.Contains("ShopConnector.Adapters.csproj", project, StringComparison.Ordinal);
        Assert.Contains("RegistryConnector.Adapters.csproj", project, StringComparison.Ordinal);

        // And registers each set, which is a separate thing from referencing
        // it: an adapter library that is linked and never added is an agent
        // that advertises nothing from it.
        var program = File.ReadAllText(Path.Combine(ProjectDirectory, "Program.cs"));

        Assert.Contains("BankAdapters.All(", program, StringComparison.Ordinal);
        Assert.Contains("ShopAdapters.All(", program, StringComparison.Ordinal);
        Assert.Contains("RegistryAdapters.All(", program, StringComparison.Ordinal);
    }

    /// <summary>
    /// The image's own Dockerfile mounts the three directories the settings
    /// name, and holds the enrollments where a volume can keep them.
    /// </summary>
    /// <remarks>
    /// The per-connector images carried <c>Agent__ProfileRoot</c> and
    /// <c>Agent__WorkRoot</c> for a while, which bound to nothing: the agent
    /// used a home-directory default while the compose file dutifully mounted
    /// volumes that nothing ever wrote to, and the first restart after a
    /// sign-in was a sign-in again. The keys are asserted here in full,
    /// because that failure is invisible until somebody has already lost a
    /// session.
    /// </remarks>
    [Fact]
    public void The_dockerfile_points_the_agent_at_the_directories_it_mounts()
    {
        var dockerfile = File.ReadAllText(Path.Combine(ProjectDirectory, "Dockerfile"));

        Assert.Contains("ConnectorAgent__ProfileRootDirectory=/profiles", dockerfile, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent__WorkRootDirectory=/work", dockerfile, StringComparison.Ordinal);
        Assert.Contains("ConnectorAgent__StateFilePath=/state/agent-state.json", dockerfile, StringComparison.Ordinal);

        // The entrypoint starts an Xvfb so the browser can be genuinely
        // headed, and runs as pwuser: a browser rendering a hostile page must
        // never be root.
        Assert.Contains("agent-entrypoint.sh", dockerfile, StringComparison.Ordinal);
        Assert.Contains("USER pwuser", dockerfile, StringComparison.Ordinal);
    }

    /// <summary>
    /// The image is published, and it is rebuilt when anything it is built
    /// from changes.
    /// </summary>
    /// <remarks>
    /// <b>An image nobody publishes is an absent provider, and this repository
    /// has already paid for that once.</b> The release workflow's paths filter
    /// omitted <c>registry-connector/src</c> and its matrices named bank and
    /// shop, so <c>registry-connector-agent</c> had never existed on the day
    /// <c>deploy/byo</c> started naming it - and that is the one connector the
    /// file ships live, so a household following the README had nothing to
    /// start at all.
    /// The compose file beside this test now names <c>Connector.Agent</c> in the
    /// same way.
    /// <para>
    /// The paths half is the quieter failure of the two. A missing filter
    /// entry does not fail anything: it means a change to one of the three
    /// adapter libraries this image links produces a push that rebuilds the
    /// three per-connector agents and leaves the household's one sitting at
    /// the previous build, which then differs from the connector it talks to
    /// in whichever way the adapter changed. So the filter is checked against
    /// the project's own references rather than against a list written here -
    /// a fourth reference added to the csproj is held to this on the day it
    /// lands.
    /// </para>
    /// </remarks>
    [Fact]
    public void The_release_workflow_publishes_the_image_and_rebuilds_it_when_its_sources_change()
    {
        var workflow = File.ReadAllText(
            Path.Combine(ByoCompose.RepoRoot(), ".github", "workflows", "release-images.yml"));

        // Built from its own Dockerfile, and merged into the channel tag a
        // host actually pulls - `:latest`, which the manifest job mints. A
        // build with no manifest entry publishes only an arch-suffixed tag
        // that nothing in deploy/ names.
        // Built from its own Dockerfile out of the `server` context, and
        // merged into the channel tag a host actually pulls — `:latest` /
        // `:dev`, which the manifest job mints from the one architecture the
        // agent has.
        Assert.Contains("file: server/src/connectors/Connector.Agent/Dockerfile", workflow, StringComparison.Ordinal);
        Assert.Contains("munni-connector-agent:$CHANNEL-$BUILD-amd64", workflow, StringComparison.Ordinal);
        Assert.Contains("-t \"$REGISTRY/munni-connector-agent:$CHANNEL\"", workflow, StringComparison.Ordinal);

        // munni's image workflow runs only for the paths it lists, so every
        // directory this image is built from must fall under one of them — a
        // change to an adapter library that rebuilt nothing would leave the
        // agent behind the control plane it talks to.
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

    /// <summary>
    /// Where each project <c>Connector.Agent.csproj</c> references lives, relative to
    /// the repository root and written with forward slashes, which is how the
    /// workflow spells a path.
    /// </summary>
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

    /// <summary>One <c>- 'server/**'</c> under the push filter.</summary>
    [GeneratedRegex(@"^\s+- '(?<path>[^']+)'\s*$", RegexOptions.Multiline)]
    private static partial Regex PathFilterEntry();

    /// <summary>
    /// The shipped settings, bound the way <c>Program.cs</c> binds them, with
    /// the one per-deployment value the environment supplies.
    /// </summary>
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

    /// <summary>
    /// The shape of provider this image exists for: a persistent tier, agent
    /// custody, unattended.
    /// </summary>
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
