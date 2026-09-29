using Connector.Kit.Agent.Browsing;
using Connector.Kit.Manifests;

namespace Connector.Kit.Agent.Tests.Browsing;

/// <summary>
/// Whether a browser may claim it can reach an authenticator.
///
/// The default is the whole test. A pooled agent is a container with no
/// security key, no fingerprint reader, no phone and nobody sitting at it, and
/// a page that asks it for a passkey does not fail - it WAITS. Amazon's
/// sign-in asks with <c>mediation: "required"</c> and a fifteen-minute
/// timeout, which in a headed container is a browser dialog nothing can ever
/// answer: the password is accepted, the page freezes, and the job spends its
/// entire budget on hardware that does not exist. Three live logins died
/// exactly there, with the same DOM digest each time.
///
/// So the safe value has to be the one you get by not thinking about it.
/// </summary>
public sealed class AuthenticatorClaimTests
{
    [Fact]
    public void A_browser_claims_no_authenticator_until_told_otherwise()
    {
        Assert.False(
            new BrowserLeaseOptions().HasAuthenticator,
            "a pooled browser must never be assumed to reach an authenticator");
    }

    /// <summary>
    /// And only a BYO agent may say yes: that browser runs on somebody's own
    /// machine, where the authenticator is real and using it is their business.
    /// Every other class is a machine in a datacenter.
    /// </summary>
    [Theory]
    [InlineData(AgentClass.Byo, true)]
    [InlineData(AgentClass.Pooled, false)]
    [InlineData(AgentClass.Inline, false)]
    public void Only_a_browser_on_someones_own_machine_can_answer_a_passkey(AgentClass agent, bool expected)
    {
        // The runner's own rule, called rather than restated. An earlier
        // version of this test asserted `agent == AgentClass.Byo`, which is the
        // rule written twice and cannot fail however the source changes.
        Assert.Equal(expected, BrowserLeaseOptions.CanReachAuthenticator(agent));
    }
}
