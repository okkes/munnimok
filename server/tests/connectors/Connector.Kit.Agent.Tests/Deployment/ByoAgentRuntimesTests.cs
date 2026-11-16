using Connector.Kit.Adapters;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Connector.Kit.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Connector.Kit.Agent.Tests.Deployment;

/// proves the shipped files produce the rule AdvertisedRuntimesTests proves: appsettings listed the pooled tiers for every
/// image and the BYO compose left the list alone, so an agent enrolled that could never get a persistent login
/// the environment comes from whichever services the file ships; ByoAgentServicesTests holds the file's shape
public sealed class ByoAgentRuntimesTests
{
    /// the per-connector images keep working (still built and published, connector as the top-level shorthand):
    /// a drifted appsettings would silently strand those households
    [Theory]
    [InlineData("server/src/connectors/Connector.Agent")]
    public void The_shipped_settings_under_the_BYO_compose_file_advertise_browser_persistent(string agentDirectory)
    {
        var compose = ByoCompose.Read();
        Assert.NotEmpty(compose.Services);

        foreach (var service in compose.Services)
        {
            Assert.NotEmpty(service.MergedEnvironment);

            // the environment provider translates ConnectorAgent__Class to ConnectorAgent:Class;
            // an in-memory one is handed translated keys
            var configuration = new ConfigurationBuilder()
                .AddJsonFile(Path.Combine(ByoCompose.RepoRoot(), agentDirectory, "appsettings.json"), optional: false)
                .AddInMemoryCollection(service.MergedEnvironment.Select(kv => KeyValuePair.Create(
                    kv.Key.Replace("__", ":", StringComparison.Ordinal), (string?)kv.Value)))
                .Build();

            var services = new ServiceCollection();
            services.AddConnectorAgent(configuration, agent => agent.AddAdapter(new PersistentAdapter()));
            var options = services.BuildServiceProvider().GetRequiredService<ConnectorAgentOptions>();

            var capabilities = options.BuildCapabilities([PersistentAdapter.Manifest]);

            // the compose file makes it BYO, the appsettings say pooled: asserted so a missing override cannot pass
            Assert.Equal(AgentClass.Byo, capabilities.Class);

            Assert.Equal([PersistentAdapter.Manifest.Id], capabilities.Providers);
            Assert.Equal([ProviderRuntime.BrowserPersistent], capabilities.Runtimes);
        }
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
