using Connector.Api;
using Sentry;

namespace Connector.Api.Tests;

public class ConnectorTracingTests
{
    private static TransactionContext Request(string name, bool? parentSampled = null) =>
        new(name, "http.server", isParentSampled: parentSampled);

    [Theory]
    [InlineData("GET /v1/health")]
    [InlineData("POST /agent/v1/heartbeat")]
    [InlineData("GET /v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/stream")]
    [InlineData("POST /agent/v1/jobs/lease")]
    [InlineData("GET /v1/jobs/{jobId}/events")]
    [InlineData("GET /agent/v1/jobs/{jobId}/answer")]
    [InlineData("GET /agent/v1/jobs/{jobId}/live/input")]
    public void Probes_heartbeats_and_the_routes_that_wait_by_design_are_never_traced(string name)
    {
        Assert.True(ConnectorTracing.IsNeverTraced(name));
        Assert.Equal(0, ConnectorTracing.Sample(Request(name, parentSampled: true), 1));
    }

    [Theory]
    [InlineData("POST /v1/{provider}/login/{sessionId}/answer")]
    [InlineData("POST /v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/input")]
    public void What_the_person_sends_to_the_same_paths_is_an_ordinary_request(string name) =>
        Assert.False(ConnectorTracing.IsNeverTraced(name));

    [Fact]
    public void An_ordinary_request_takes_the_rate_and_a_continued_trace_keeps_its_decision()
    {
        Assert.False(ConnectorTracing.IsNeverTraced("GET /v1/{provider}/{resource}"));
        Assert.Equal(0.2, ConnectorTracing.Sample(Request("GET /v1/{provider}/{resource}"), 0.2));
        Assert.Equal(1, ConnectorTracing.Sample(Request("GET /v1/{provider}/{resource}", parentSampled: true), 0.2));
        Assert.Equal(0, ConnectorTracing.Sample(Request("GET /v1/{provider}/{resource}", parentSampled: false), 0.2));
        // errors only: nothing, whatever the parent said
        Assert.Equal(0, ConnectorTracing.Sample(Request("GET /v1/{provider}/{resource}", parentSampled: true), 0));
    }

    [Theory]
    [InlineData("0.5", 0.5)]
    [InlineData("0", 0)]
    [InlineData("1", 1)]
    [InlineData("2", 0.2)]
    [InlineData("-1", 0.2)]
    [InlineData("a fifth", 0.2)]
    [InlineData(null, 0.2)]
    public void The_configured_rate_is_a_number_in_0_to_1_or_the_default_fifth(string? configured, double expected) =>
        Assert.Equal(expected, ConnectorTracing.SampleRate(configured));
}
