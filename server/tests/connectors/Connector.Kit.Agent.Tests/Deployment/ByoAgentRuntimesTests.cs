using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent.Tests.Deployment;

/// <summary>
/// The configuration a user actually ships advertises the tier they installed
/// it for.
///
/// <para>
/// <b>What was missing.</b> <c>AdvertisedRuntimesTests</c> proves the rule:
/// a BYO agent's tiers come from its adapters. This proves the rule is what
/// the shipped files produce, which is a different claim and the one that
/// failed live. The code was right about a BYO agent for as long as nobody
/// looked at the appsettings, which listed the pooled fleet's three tiers
/// for every image, and at the BYO compose file, which set the class and
/// left the list alone. Neither file was wrong on its own; together they
/// enrolled an agent that could never be handed a persistent login. No test
/// read either file.
/// </para>
///
/// <para>
/// <b>What this reads.</b> Each agent's <c>appsettings.json</c> as the
/// image carries it - not the Development one, which never reaches an image
/// - with the environment <c>deploy/byo/docker-compose.yml</c> gives the
/// container laid over it, exactly as the host lays environment variables
/// over the file. Then the options are bound through
/// <c>AddConnectorAgent</c>, the same call the three <c>Program.cs</c> make,
/// and asked what they would advertise for a persistent provider. In the
/// style of <c>AgentExclusivityTests</c>: the deployment is the thing under
/// test, and a one-line edit to either file is what breaks it.
/// </para>
///
/// <para>
/// The environment comes from whichever services that file ships live -
/// there is one now, an agent that attaches to as many connectors as the
/// household lists - rather than from a service named here, because the point
/// of the check is that the file as shipped produces this, and a test naming
/// the service argues with the file about what it ships.
/// <see cref="ByoAgentServicesTests"/> is what holds the file's shape and its
/// connector blocks; this one takes the environment that comes out and asks
/// what an agent bound from it would advertise.
/// </para>
/// </summary>
public sealed class ByoAgentRuntimesTests
{
    /// <summary>
    /// Every agent image, because every one of them ships the same appsettings
    /// shape and this environment is laid over whichever one is installed.
    /// </summary>
    /// <remarks>
    /// <c>home-agent</c> is the one the compose file names, and it is here
    /// because it is the image the assertion is actually about. The three
    /// per-connector ones are here because they KEEP WORKING - the file's own
    /// migration note promises it, they are still built and still published,
    /// and a household that has not moved yet is running one of them under an
    /// environment that differs from this one only by carrying its connector
    /// as the top-level shorthand rather than as a numbered block. An image
    /// whose appsettings drifted into advertising the pooled fleet's tiers
    /// would strand exactly those people, silently, on the tier this file
    /// exists for.
    /// </remarks>
    [Theory]
    [InlineData("server/src/connectors/Connector.Agent")]
    public void The_shipped_settings_under_the_BYO_compose_file_advertise_browser_persistent(string agentDirectory)
    {
        var compose = ByoCompose.Read();
        Assert.NotEmpty(compose.Services);

        foreach (var service in compose.Services)
        {
            Assert.NotEmpty(service.MergedEnvironment);

            // ConnectorAgent__Class on a container is ConnectorAgent:Class to
            // the binder; the environment provider does this translation and
            // an in-memory one is handed the translated keys.
            var configuration = new ConfigurationBuilder()
                .AddJsonFile(Path.Combine(ByoCompose.RepoRoot(), agentDirectory, "appsettings.json"), optional: false)
                .AddInMemoryCollection(service.MergedEnvironment.Select(kv => KeyValuePair.Create(
                    kv.Key.Replace("__", ":", StringComparison.Ordinal), (string?)kv.Value)))
                .Build();

            var services = new ServiceCollection();
            services.AddConnectorAgent(configuration, agent => agent.AddAdapter(new PersistentAdapter()));
            var options = services.BuildServiceProvider().GetRequiredService<ConnectorAgentOptions>();

            var capabilities = options.BuildCapabilities([PersistentAdapter.Manifest]);

            // The compose file is what makes it BYO; the appsettings say
            // pooled. Asserted so a test that passed because the override
            // never arrived cannot pass.
            Assert.Equal(AgentClass.Byo, capabilities.Class);

            Assert.Equal([PersistentAdapter.Manifest.Id], capabilities.Providers);
            Assert.Equal([ProviderRuntime.BrowserPersistent], capabilities.Runtimes);
        }
    }

    /// <summary>
    /// The shape of provider the BYO agent exists for: a persistent tier,
    /// agent custody, unattended.
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
