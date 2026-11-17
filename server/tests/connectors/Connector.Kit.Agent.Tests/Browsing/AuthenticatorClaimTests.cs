using Connector.Kit.Agent.Browsing;
using Connector.Kit.Manifests;

namespace Connector.Kit.Agent.Tests.Browsing;

// a pooled agent has no authenticator and a passkey prompt does not fail, it WAITS (Amazon: mediation required, 15 min):
// the job burns its budget on hardware that does not exist, so the safe default is claiming none
public sealed class AuthenticatorClaimTests
{
    [Fact]
    public void A_browser_claims_no_authenticator_until_told_otherwise()
    {
        Assert.False(
            new BrowserLeaseOptions().HasAuthenticator,
            "a pooled browser must never be assumed to reach an authenticator");
    }

    // only BYO runs on somebody's own machine with a real authenticator; every other class is a datacenter machine
    [Theory]
    [InlineData(AgentClass.Byo, true)]
    [InlineData(AgentClass.Pooled, false)]
    [InlineData(AgentClass.Inline, false)]
    public void Only_a_browser_on_someones_own_machine_can_answer_a_passkey(AgentClass agent, bool expected)
    {
        Assert.Equal(expected, BrowserLeaseOptions.CanReachAuthenticator(agent));
    }
}
