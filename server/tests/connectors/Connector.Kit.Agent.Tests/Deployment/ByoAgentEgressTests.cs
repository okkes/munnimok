using BankConnector.Adapters;
using Connector.Kit.Adapters;
using Connector.Kit.Manifests;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using RegistryConnector.Adapters;
using ShopConnector.Adapters;

namespace Connector.Kit.Agent.Tests.Deployment;

/// <summary>
/// The household's own agent says where it is, and what it says is enough for
/// every provider it exists to run.
///
/// <para>
/// <b>What was missing.</b> <c>deploy/byo/docker-compose.yml</c> set no egress
/// at all - not the country, not the kind - which was harmless for exactly as
/// long as nothing compared the claim to what a manifest asks for. The day
/// <c>CanServe</c> began comparing them, an agent that claims nothing became an
/// agent with an address nobody can vouch for, and DUO, BKR and half the
/// shopping catalogue stopped being offered to the one machine in this
/// platform whose address is genuinely residential. The file that carries DUO -
/// the provider that has no fleet to fall back to - was the file most exposed
/// to it.
/// </para>
///
/// <para>
/// <b>Why every provider and not most.</b> This image carries every adapter the
/// platform has and advertises all of them to each connector it attaches to, so
/// "what it might be asked for" is the whole catalogue. Own-machine providers
/// are INCLUDED here where <see cref="LocalStackEgressTests"/> excludes them,
/// and that is the point of the two files: this is the machine those providers
/// mean.
/// </para>
/// </summary>
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

            // The image the file names, with the compose environment laid over
            // its appsettings exactly as the host lays environment variables
            // over a file, bound through the same AddConnectorAgent the
            // agent's own Program.cs calls.
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

            // Asserted so a run where the compose override never arrived - and
            // the appsettings' own pooled class stood - cannot pass.
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

    /// <summary>
    /// A shipped manifest with the adapter behind it removed - see
    /// <c>LocalStackEgressTests</c>, which reads the other compose file the
    /// same way.
    /// </summary>
    private sealed class ManifestOnlyAdapter(ProviderManifest manifest) : IProviderAdapter
    {
        public ProviderManifest Describe() => manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException("this suite reads configuration and runs nothing");

        public Task<FetchResult> FetchAsync(IJobContext ctx, Kit.Jobs.ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException("this suite reads configuration and runs nothing");
    }
}
