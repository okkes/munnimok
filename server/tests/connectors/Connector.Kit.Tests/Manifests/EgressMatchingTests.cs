using Connector.Kit.AgentProtocol;
using Connector.Kit.Manifests;
using Xunit;

namespace Connector.Kit.Tests;

/// <summary>
/// The address a provider asks to be reached from, against the address an
/// agent says it leaves from.
///
/// <para>
/// <b>What was missing.</b> Both halves have existed for months and nothing
/// compared them. An agent sends <c>capabilities.egress</c> on enrollment and
/// on every heartbeat; thirteen shipped manifests ask for one - DUO and BKR for
/// a Dutch residential line, and so do AH, Jumbo, Bol, amazon.nl, Lidl Plus and
/// ASN - and <c>CanServe</c>, the only gate the lease query applies, asked for
/// providers and runtimes and stopped. So the operator's datacenter fleet was
/// offered Jumbo's logins exactly as readily as a machine on a domestic line,
/// and what came back was the tarpit rather than an explanation.
/// </para>
///
/// <para>
/// <b>The two that decide whether this is a check at all</b> are
/// <see cref="An_any_claim_does_not_satisfy_a_provider_that_asks_for_residential"/>
/// and <see cref="An_agent_that_claims_no_address_satisfies_nothing"/>. Read
/// <c>any</c> as a wildcard on the claim side, or a missing claim as "will do",
/// and every requirement is satisfied by every agent: the comparison is then
/// spelled correctly, passes its own tests, and changes no routing decision
/// anywhere.
/// </para>
/// </summary>
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

    /// <summary>
    /// THE READING THAT WOULD MAKE THIS DECORATIVE.
    /// </summary>
    /// <remarks>
    /// <c>any</c> is weaker than <c>residential</c>, not a wildcard. It is the
    /// word a datacenter agent uses for itself - the NAS agents in
    /// <c>deploy/docker-compose.yml</c> say exactly this - so treating it as
    /// "matches anything" would admit the one machine the requirement exists to
    /// keep out, and do it in the deployment where it matters.
    /// </remarks>
    [Fact]
    public void An_any_claim_does_not_satisfy_a_provider_that_asks_for_residential()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(DutchAny));
    }

    /// <summary>
    /// And the same word on the REQUIREMENT side does mean "anything", which is
    /// the asymmetry the whole rule rests on.
    /// </summary>
    [Theory]
    [InlineData(EgressRequirement.Residential)]
    [InlineData(EgressRequirement.Any)]
    public void A_provider_that_asks_for_any_takes_whatever_the_agent_claims(string claimed)
    {
        Assert.True(DutchAny.IsSatisfiedBy(new EgressRequirement { Country = "NL", Kind = claimed }));
    }

    /// <summary>
    /// THE DECISION THAT MADE EVERY SHIPPED DEPLOYMENT'S CLAIM LOAD-BEARING.
    /// </summary>
    /// <remarks>
    /// Saying nothing is the default, and reading it as "any address will do"
    /// would make the comparison opt-in for exactly the deployments careful
    /// enough to fill it in. It is also the state <c>deploy/byo</c> shipped in
    /// until this change: no egress setting at all, on the one machine whose
    /// address is genuinely residential.
    /// </remarks>
    [Fact]
    public void An_agent_that_claims_no_address_satisfies_nothing()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(null));
        Assert.False(DutchAny.IsSatisfiedBy(null));
    }

    /// <summary>
    /// A provider asking for NL is asking to be reached from the Netherlands,
    /// and a residential line in Belgium is not that.
    /// </summary>
    [Fact]
    public void The_country_has_to_match()
    {
        Assert.False(DutchResidential.IsSatisfiedBy(
            new EgressRequirement { Country = "BE", Kind = EgressRequirement.Residential }));
    }

    /// <summary>
    /// Case-insensitively, because these are typed into compose files.
    /// </summary>
    /// <remarks>
    /// <c>nl</c> is the same country as <c>NL</c> and
    /// <c>AGENT_EGRESS_COUNTRY=nl</c> is a plausible thing to write. Ordinal
    /// comparison here would turn a lower-case env var into an agent that
    /// silently serves nothing that asks for an address.
    /// </remarks>
    [Fact]
    public void Case_does_not_decide_where_an_agent_is()
    {
        Assert.True(DutchResidential.IsSatisfiedBy(
            new EgressRequirement { Country = "nl", Kind = "Residential" }));
    }

    /// <summary>
    /// A kind nothing recognises demands an exact match rather than being
    /// quietly widened.
    /// </summary>
    /// <remarks>
    /// Nothing validates the string - <c>ManifestValidator</c> has no rule for
    /// it - so a manifest can ask for a word this record has never heard of.
    /// Treating that as <c>any</c> would turn a typo in a requirement into a
    /// requirement nobody has to meet.
    /// </remarks>
    [Fact]
    public void A_kind_nobody_recognises_is_still_a_requirement()
    {
        var exotic = new EgressRequirement { Country = "NL", Kind = "mobile" };

        Assert.False(exotic.IsSatisfiedBy(DutchResidential));
        Assert.True(exotic.IsSatisfiedBy(new EgressRequirement { Country = "NL", Kind = "mobile" }));
    }

    /// <summary>
    /// And the gate the lease query actually applies asks all three questions.
    /// </summary>
    /// <remarks>
    /// The rule above is only worth anything through <c>CanServe</c>: that is
    /// the single predicate <c>EfLeasedJobQueue.TryLeaseAsync</c> filters
    /// candidates with, so a manifest's requirement that this method does not
    /// read is a requirement nothing enforces. Asserted with the provider and
    /// runtime axes deliberately satisfied, so the only thing that can move the
    /// answer is the address.
    /// </remarks>
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

    /// <summary>
    /// A provider that asks for nothing is served by anybody, which is most of
    /// them and is why turning this on is not a fleet-wide narrowing.
    /// </summary>
    [Fact]
    public void A_provider_that_asks_for_no_address_is_served_by_an_agent_that_claims_none()
    {
        var manifest = Make.Manifest();

        Assert.Null(manifest.Agent.Egress);
        Assert.True(new AgentCapabilities().CanServe(manifest));
    }
}
