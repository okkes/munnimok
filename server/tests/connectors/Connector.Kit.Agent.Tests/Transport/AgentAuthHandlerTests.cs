using System.Net;
using System.Net.Http.Headers;
using Connector.Kit.Agent.Transport;

namespace Connector.Kit.Agent.Tests.Transport;

/// <summary>
/// The handler that signs an agent's calls to the control plane: the
/// enrollment token once the agent has one, nothing before, and never over
/// an authorization a caller chose itself (the enrollment call carries its
/// one-time code that way).
/// </summary>
public sealed class AgentAuthHandlerTests
{
    private sealed class Capture : HttpMessageHandler
    {
        public AuthenticationHeaderValue? LastAuthorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastAuthorization = request.Headers.Authorization;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private static AgentEnrollment Enrollment(string token) => new()
    {
        AgentId = "agt_1",
        Token = token,
        ControlPlane = "https://connector.test",
        EnrolledAt = new DateTimeOffset(2026, 9, 29, 12, 0, 0, TimeSpan.Zero),
    };

    [Fact]
    public async Task An_enrolled_agent_sends_its_token_and_an_unenrolled_one_sends_nothing()
    {
        var identity = new AgentIdentity();
        var capture = new Capture();
        using var http = new HttpClient(new AgentAuthHandler(identity) { InnerHandler = capture });

        using var before = await http.GetAsync("https://connector.test/agent/v1/heartbeat");
        Assert.Null(capture.LastAuthorization);
        Assert.False(identity.IsEnrolled);
        Assert.Throws<InvalidOperationException>(() => identity.AgentId);

        identity.Set(Enrollment("tok_1"));
        using var during = await http.GetAsync("https://connector.test/agent/v1/heartbeat");
        Assert.Equal("Bearer", capture.LastAuthorization!.Scheme);
        Assert.Equal("tok_1", capture.LastAuthorization.Parameter);
        Assert.Equal("agt_1", identity.AgentId);

        identity.Clear();
        using var after = await http.GetAsync("https://connector.test/agent/v1/heartbeat");
        Assert.Null(capture.LastAuthorization);
    }

    [Fact]
    public async Task A_call_that_already_carries_an_authorization_keeps_its_own()
    {
        var identity = new AgentIdentity();
        identity.Set(Enrollment("tok_1"));
        var capture = new Capture();
        using var http = new HttpClient(new AgentAuthHandler(identity) { InnerHandler = capture });
        using var enroll = new HttpRequestMessage(HttpMethod.Post, "https://connector.test/agent/v1/enroll");
        enroll.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "AGNT-ONE-TIME");

        using var response = await http.SendAsync(enroll);

        Assert.Equal("AGNT-ONE-TIME", capture.LastAuthorization!.Parameter);
    }
}
