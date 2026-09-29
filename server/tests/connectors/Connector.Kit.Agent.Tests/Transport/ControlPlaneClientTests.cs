using System.Net;
using System.Text;
using Connector.Kit.Agent.Transport;
using Connector.Kit.AgentProtocol;
using Connector.Kit.Challenges;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Microsoft.Extensions.Logging.Abstractions;

namespace Connector.Kit.Agent.Tests.Transport;

/// <summary>
/// The client's translation of what comes back over the wire: a control
/// plane that cannot be reached, one that answers with a status the agent
/// must act on, and one whose body does not parse each become a typed
/// exception (or a plain answer) the loops above can reason about.
/// </summary>
public sealed class ControlPlaneClientTests
{
    private sealed class Scripted(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Paths { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Paths.Add(request.RequestUri!.PathAndQuery);
            return Task.FromResult(answer(request));
        }

        public HttpClient CreateClient(string name) =>
            new(this, disposeHandler: false) { BaseAddress = new Uri("https://control-plane.test/") };
    }

    private sealed class Unreachable : HttpMessageHandler, IHttpClientFactory
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            throw new HttpRequestException("connection refused");

        public HttpClient CreateClient(string name) =>
            new(this, disposeHandler: false) { BaseAddress = new Uri("https://control-plane.test/") };
    }

    private static ControlPlaneClient Client(IHttpClientFactory factory) =>
        new(factory, NullLogger<ControlPlaneClient>.Instance, "munni");

    private static HttpResponseMessage Status(HttpStatusCode status) => new(status);

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private static EnrollRequest Enroll() => new()
    {
        Code = "AGNT-1",
        Name = "box",
        Capabilities = new AgentCapabilities(),
    };

    private static LiveFrame Frame() => new()
    {
        Sequence = 7,
        Bytes = [1, 2, 3],
        Width = 393,
        Height = 851,
    };

    [Fact]
    public void Client_names_carry_the_connection_so_one_machine_can_serve_several_connectors()
    {
        Assert.Equal("connector-agent-control-plane#munni", ControlPlaneClient.ClientNameFor("munni"));
        Assert.Equal("connector-agent-control-plane#default", ControlPlaneClient.ClientNameFor(null));
        Assert.Equal("connector-agent-control-plane-keepalive#munni", ControlPlaneClient.KeepaliveClientNameFor("munni"));
    }

    [Fact]
    public async Task A_control_plane_that_cannot_be_reached_is_a_transient_failure_on_every_route()
    {
        var client = Client(new Unreachable());
        var ct = CancellationToken.None;

        var enroll = await Assert.ThrowsAsync<ControlPlaneException>(() => client.EnrollAsync(Enroll(), ct));
        var answer = await Assert.ThrowsAsync<ControlPlaneException>(() => client.PollAnswerAsync("job_1", ct, "chl_1"));
        var frame = await Assert.ThrowsAsync<ControlPlaneException>(() => client.PostLiveFrameAsync("job_1", Frame(), ct));
        var input = await Assert.ThrowsAsync<ControlPlaneException>(() => client.PollLiveInputAsync("job_1", 0, ct));
        var renew = await Assert.ThrowsAsync<ControlPlaneException>(() => client.RenewAsync("job_1", ct));

        foreach (var failure in new[] { enroll, answer, frame, input, renew })
        {
            Assert.True(failure.IsTransient, failure.Message);
            Assert.Null(failure.Status);
            Assert.IsType<HttpRequestException>(failure.InnerException);
        }
    }

    [Fact]
    public async Task A_renew_the_control_plane_refuses_is_a_lost_lease_and_a_broken_one_is_an_error()
    {
        var refused = Client(new Scripted(_ => Status(HttpStatusCode.Conflict)));
        var broken = Client(new Scripted(_ => Status(HttpStatusCode.BadGateway)));

        Assert.False(await refused.RenewAsync("job_1", CancellationToken.None));
        var failure = await Assert.ThrowsAsync<ControlPlaneException>(() => broken.RenewAsync("job_1", CancellationToken.None));

        Assert.Equal(HttpStatusCode.BadGateway, failure.Status);
        Assert.True(failure.IsTransient);
    }

    [Fact]
    public async Task A_live_frame_is_dropped_on_a_client_error_and_reported_on_a_server_error()
    {
        var handler = new Scripted(_ => Status(HttpStatusCode.NoContent));
        var accepted = Client(handler);
        var gone = Client(new Scripted(_ => Status(HttpStatusCode.Gone)));
        var broken = Client(new Scripted(_ => Status(HttpStatusCode.InternalServerError)));

        Assert.True(await accepted.PostLiveFrameAsync("job_1", Frame(), CancellationToken.None));
        Assert.False(await gone.PostLiveFrameAsync("job_1", Frame(), CancellationToken.None));
        var failure = await Assert.ThrowsAsync<ControlPlaneException>(() => broken.PostLiveFrameAsync("job_1", Frame(), CancellationToken.None));

        Assert.Equal(HttpStatusCode.InternalServerError, failure.Status);
        Assert.Equal("/agent/v1/jobs/job_1/live/frame", Assert.Single(handler.Paths));
    }

    [Fact]
    public async Task An_answer_poll_reports_an_expired_challenge_as_the_adapters_own_error()
    {
        var expired = Client(new Scripted(_ => Status(HttpStatusCode.Gone)));
        var timedOut = Client(new Scripted(_ => Status(HttpStatusCode.RequestTimeout)));
        var handler = new Scripted(_ => Status(HttpStatusCode.NoContent));
        var nothing = Client(handler);

        var first = await Assert.ThrowsAsync<ConnectorException>(() => expired.PollAnswerAsync("job_1", CancellationToken.None, "chl_1"));
        var second = await Assert.ThrowsAsync<ConnectorException>(() => timedOut.PollAnswerAsync("job_1", CancellationToken.None, "chl_1"));

        Assert.Equal(ErrorCode.ChallengeExpired, first.Code);
        Assert.Equal(ErrorCode.ChallengeExpired, second.Code);
        Assert.Null(await nothing.PollAnswerAsync("job_1", CancellationToken.None, "chl 1"));
        Assert.Equal("/agent/v1/jobs/job_1/answer?challenge_id=chl%201", Assert.Single(handler.Paths));
    }

    [Fact]
    public async Task Live_input_comes_back_as_a_batch_or_as_nothing_and_a_refusal_is_an_error()
    {
        var handler = new Scripted(_ => Json("""{"events":[]}"""));
        var some = Client(handler);
        var none = Client(new Scripted(_ => Status(HttpStatusCode.NoContent)));
        var refused = Client(new Scripted(_ => Status(HttpStatusCode.Forbidden)));

        Assert.NotNull(await some.PollLiveInputAsync("job_1", 2, CancellationToken.None));
        Assert.Equal("/agent/v1/jobs/job_1/live/input?after=2", Assert.Single(handler.Paths));
        Assert.Null(await none.PollLiveInputAsync("job_1", 2, CancellationToken.None));
        var failure = await Assert.ThrowsAsync<ControlPlaneException>(() => refused.PollLiveInputAsync("job_1", 2, CancellationToken.None));

        Assert.True(failure.IsAuthFailure);
    }

    [Fact]
    public async Task A_failure_report_returns_the_recorded_state_or_nothing_when_the_answer_is_unreadable()
    {
        var requeued = Client(new Scripted(_ => Json("""{"state":"Queued"}""")));
        var unreadable = Client(new Scripted(_ => Json("not json at all")));
        var failure = new JobFailRequest { Code = "provider_unavailable", Detail = "scripted" };

        Assert.Equal(JobState.Queued, await requeued.FailAsync("job_1", failure, CancellationToken.None));
        Assert.Null(await unreadable.FailAsync("job_1", failure, CancellationToken.None));
    }

    [Fact]
    public async Task A_body_the_agent_cannot_read_is_reported_as_malformed_rather_than_as_a_null_reference()
    {
        var garbled = Client(new Scripted(_ => Json("{ this is not an enrollment")));

        var failure = await Assert.ThrowsAsync<ControlPlaneException>(() => garbled.EnrollAsync(Enroll(), CancellationToken.None));

        Assert.Contains("malformed", failure.Message, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, failure.Status);
    }

    [Fact]
    public async Task A_rejected_enrollment_carries_the_status_so_the_host_can_tell_a_verdict_from_an_outage()
    {
        var rejected = Client(new Scripted(_ => Status(HttpStatusCode.Forbidden)));

        var failure = await Assert.ThrowsAsync<ControlPlaneException>(() => rejected.EnrollAsync(Enroll(), CancellationToken.None));

        Assert.True(failure.IsAuthFailure);
        Assert.False(failure.IsTransient);
    }
}
