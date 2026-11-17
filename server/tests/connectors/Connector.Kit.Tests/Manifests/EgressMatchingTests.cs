using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

// `any` is no wildcard on the claim side and a missing claim is no "will do": either reading makes every requirement
// pass for every agent and changes no routing decision
public sealed class EgressMatchingTests
{
    private static readonly EgressRequirement DutchResidential =
        new() { Country = "NL", Kind = EgressRequirement.Residential };

    private static readonly EgressRequirement DutchAny =
        new() { Country = "NL", Kind = EgressRequirement.Any };

    [Fact]
    public void A_residential_claim_satisfies_a_provider_that_asks_for_residential()
    {
        Assert.True(DutchResidential.IsSatisfiedBy(DutchResidential));
    }

    // `any` is weaker than `residential`: it is what a datacenter agent (the NAS agents) claims, so a wildcard would admit it
    [Fact]
    public void An_any_claim_does_not_satisfy_a_provider_that_asks_for_residential()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(DutchAny));
    }

    // on the requirement side `any` does mean anything: the asymmetry the rule rests on
    [Theory]
    [InlineData(EgressRequirement.Residential)]
    [InlineData(EgressRequirement.Any)]
    public void A_provider_that_asks_for_any_takes_whatever_the_agent_claims(string claimed)
    {
        Assert.True(DutchAny.IsSatisfiedBy(new EgressRequirement { Country = "NL", Kind = claimed }));
    }

    // no claim is the default; reading it as "any address will do" would make the check opt-in for careful deployments
    [Fact]
    public void An_agent_that_claims_no_address_satisfies_nothing()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(null));
        Assert.False(DutchAny.IsSatisfiedBy(null));
    }

    [Fact]
    public void The_country_has_to_match()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(
            new EgressRequirement { Country = "BE", Kind = EgressRequirement.Residential }));
    }

    // case-insensitive: AGENT_EGRESS_COUNTRY=nl is typed into compose files, and ordinal would silently serve nothing
    [Fact]
    public void Case_does_not_decide_where_an_agent_is()
    {
        Assert.True(DutchResidential.IsSatisfiedBy(
            new EgressRequirement { Country = "nl", Kind = "Residential" }));
    }

    // ManifestValidator does not check the kind string; an unknown kind demands an exact match so a typo is not widened to `any`
    [Fact]
    public void A_kind_nobody_recognises_is_still_a_requirement()
    {
        var exotic = new EgressRequirement { Country = "NL", Kind = "mobile" };

        Assert.False(exotic.IsSatisfiedBy(DutchResidential));
        Assert.True(exotic.IsSatisfiedBy(new EgressRequirement { Country = "NL", Kind = "mobile" }));
    }

    // CanServe is the one predicate EfLeasedJobQueue.TryLeaseAsync filters with; provider and runtime axes are satisfied
    // so only the address can move the answer
    [Fact]
    public void An_agent_on_the_wrong_line_cannot_serve_a_provider_that_asks_for_one()
    {
        var manifest = Make.Manifest() with
        {
            Id = "jumbo",
            Runtime = ProviderRuntime.BrowserInteractive,
            Agent = new AgentRequirement
            {
                Required = true,
                Class = AgentClass.Pooled,
                Egress = DutchResidential,
            },
        };

        var datacenter = new AgentCapabilities
        {
            Providers = ["jumbo"],
            Runtimes = [ProviderRuntime.BrowserInteractive],
            Egress = DutchAny,
        };

        var unstated = new AgentCapabilities
        {
            Providers = ["jumbo"],
            Runtimes = [ProviderRuntime.BrowserInteractive],
        };

        var home = datacenter with { Egress = DutchResidential };

        Assert.False(datacenter.CanServe(manifest));
        Assert.False(unstated.CanServe(manifest));
        Assert.True(home.CanServe(manifest));
    }

    // most providers ask for no address, so turning this on is not a fleet-wide narrowing
    [Fact]
    public void A_provider_that_asks_for_no_address_is_served_by_an_agent_that_claims_none()
    {
        var manifest = Make.Manifest();

        Assert.Null(manifest.Agent.Egress);
        Assert.True(new AgentCapabilities().CanServe(manifest));
    }
}
