using BankConnector.Adapters;
using Connector.Kit.Adapters;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

namespace Connector.Kit.Agent.Tests.Deployment;

/// deploy/byo/docker-compose.yml set no egress; once CanServe compared the claim with the manifest, DUO, BKR and
/// much of the shopping catalogue stopped being offered to the one residential machine. Own-machine providers are
/// INCLUDED here, excluded in LocalStackEgressTests: this is the machine they mean
public sealed class ByoAgentEgressTests
{
    [Fact]
    public void The_household_agent_claims_an_address_every_provider_it_carries_accepts()
    {
        var compose = ByoCompose.Read();
        Assert.NotEmpty(compose.Services);

        IReadOnlyList<ProviderManifest> manifests =
        [
            .. BankAdapters.All().Select(adapter => adapter.Describe()),
            .. ShopAdapters.All().Select(adapter => adapter.Describe()),
            .. RegistryAdapters.All().Select(adapter => adapter.Describe()),
        ];

        foreach (var service in compose.Services)
        {
            Assert.NotEmpty(service.MergedEnvironment);

            var configuration = new ConfigurationBuilder()
                .AddJsonFile(
                    Path.Combine(ByoCompose.AgentProject, "appsettings.json"),
                    optional: false)
                .AddInMemoryCollection(service.MergedEnvironment.Select(kv => KeyValuePair.Create(
                    kv.Key.Replace("__", ":", StringComparison.Ordinal), (string?)kv.Value)))
                .Build();

            var services = new ServiceCollection();
            services.AddConnectorAgent(configuration, agent =>
            {
                foreach (var manifest in manifests) agent.AddAdapter(new ManifestOnlyAdapter(manifest));
            });

            var capabilities = services.BuildServiceProvider()
                .GetRequiredService<ConnectorAgentOptions>()
                .BuildCapabilities(manifests);

            // so a run where the compose override never arrived, and the appsettings' pooled class stood, cannot pass
            Assert.Equal(AgentClass.Byo, capabilities.Class);

            foreach (var manifest in manifests)
            {
                Assert.True(
                    capabilities.CanServe(manifest),
                    $"the agent in deploy/connectors/household-agent.yml claims "
                    + $"{capabilities.Egress?.Country ?? "?"}/{capabilities.Egress?.Kind ?? "nothing"} and "
                    + $"cannot serve '{manifest.Id}', which asks for "
                    + $"{manifest.Agent.Egress?.Country}/{manifest.Agent.Egress?.Kind}. This is somebody's "
                    + "own machine on their own line: the claim is not a preference, it is the fact that "
                    + "decides whether their agent is offered the providers they brought it for");
            }
        }
    }

    private sealed class ManifestOnlyAdapter(ProviderManifest manifest) : IProviderAdapter
    {
        public ProviderManifest Describe() => manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException("this suite reads configuration and runs nothing");

        public Task<FetchResult> FetchAsync(IJobContext ctx, Kit.Jobs.ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException("this suite reads configuration and runs nothing");
    }
}
