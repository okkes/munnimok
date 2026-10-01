using Connector.Kit.Adapters;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// The digest an agent is judged by covers the parties an agent can be
/// leased, and nothing a control plane decides on its own.
///
/// The first pooled agent on a NAS (2026-10-01) ran the image its control
/// plane ran, enrolled, heartbeated, and was leased nothing: the control
/// plane held the operator's GoCardless keys, so its catalogue carried an
/// inline party the agent never runs, and it withheld raw from its catalogue
/// as production does while the agent's registry strips nothing. Both moved
/// the catalogue's digest - correctly, it is a consumer's ETag - and the
/// agent was "stale" against a number it could never produce. What the two
/// sides compare now is the agent-served set in one canonical shape.
/// </summary>
public sealed class AgentCatalogDigestTests
{
    private static ProviderManifest Browser(string id, params string[] includeValues) => Make.Manifest() with
    {
        Id = id,
        Runtime = ProviderRuntime.BrowserOnce,
        Agent = new AgentRequirement { Required = true, Class = AgentClass.Pooled },
        Resources = [Resource(includeValues)],
    };

    /// <summary>What a control plane runs in-process: the aggregators, when the operator's keys are present.</summary>
    private static ProviderManifest Inline(string id) => Make.Manifest() with { Id = id };

    private static ResourceSpec Resource(string[] includeValues) => new()
    {
        Id = "receipts",
        Returns = ResourceShape.Receipt,
        Params = includeValues.Length == 0
            ? [new ParamSpec { Key = "since", Type = ParamType.Date, Required = true }]
            :
            [
                new ParamSpec { Key = "since", Type = ParamType.Date, Required = true },
                new ParamSpec
                {
                    Key = ResourceRequest.IncludeParam,
                    Type = ParamType.Enum,
                    Values = includeValues,
                    Multi = true,
                },
            ],
    };

    [Fact]
    public void An_inline_party_the_control_plane_runs_itself_moves_the_catalogue_and_not_the_agents_digest()
    {
        var agentsOwn = new ProviderRegistry([new StubAdapter(Browser("shop"))]);
        var withAggregator = new ProviderRegistry([new StubAdapter(Browser("shop")), new StubAdapter(Inline("aggregator"))]);

        Assert.NotEqual(agentsOwn.CatalogDigest, withAggregator.CatalogDigest);
        Assert.Equal(agentsOwn.AgentCatalogDigest, withAggregator.AgentCatalogDigest);
    }

    [Fact]
    public void Withholding_raw_moves_the_catalogue_and_not_the_agents_digest()
    {
        var offered = new ProviderRegistry([new StubAdapter(Browser("shop", "items", "raw"))], offerRawPayloads: true);
        var withheld = new ProviderRegistry([new StubAdapter(Browser("shop", "items", "raw"))], offerRawPayloads: false);

        Assert.NotEqual(offered.CatalogDigest, withheld.CatalogDigest);
        Assert.Equal(offered.AgentCatalogDigest, withheld.AgentCatalogDigest);
    }

    [Fact]
    public void A_party_an_agent_serves_that_changes_moves_the_agents_digest()
    {
        var one = new ProviderRegistry([new StubAdapter(Browser("shop"))]);
        var bumped = new ProviderRegistry([new StubAdapter(Browser("shop") with { ManifestVersion = 2 })]);

        Assert.NotEqual(one.AgentCatalogDigest, bumped.AgentCatalogDigest);
        Assert.Matches("^sha256:[0-9a-f]{64}$", one.AgentCatalogDigest);
    }

    [Fact]
    public void The_agent_served_set_keeps_every_party_that_needs_an_agent_and_drops_only_the_inline_ones()
    {
        var household = Browser("bank") with { Agent = new AgentRequirement { Required = true, Class = AgentClass.Byo } };

        var served = ProviderRegistry.AgentServed([Inline("aggregator"), Browser("shop"), household]);

        Assert.Equal(new[] { "bank", "shop" }, served.Select(m => m.Id).ToArray());
    }

    private sealed class StubAdapter(ProviderManifest manifest) : IProviderAdapter
    {
        public ProviderManifest Describe() => manifest;

        public Task<LoginResult> LoginAsync(IJobContext ctx, CancellationToken ct) =>
            throw new NotSupportedException();

        public Task<FetchResult> FetchAsync(IJobContext ctx, ResourceRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }
}
