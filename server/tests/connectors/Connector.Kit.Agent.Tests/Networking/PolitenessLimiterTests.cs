using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using Connector.Kit.Agent.Networking;

namespace Connector.Kit.Agent.Tests.Networking;

/// <summary>
/// The handler that keeps one provider's traffic polite: a minimum gap
/// between calls, and a pause the provider itself asked for when it answers
/// 429 or 503 — its <c>Retry-After</c> when it gave one, a fixed penalty when
/// it did not.
/// </summary>
public sealed class PolitenessLimiterTests
{
    private sealed class Scripted(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls += 1;
            return Task.FromResult(answer(request));
        }
    }

    private sealed class FrozenClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private static HttpClient Client(PolitenessGate gate, TimeSpan gap, Scripted inner, TimeProvider? time = null) =>
        new(new PolitenessLimiter(gate, "jumbo", gap, time) { InnerHandler = inner });

    [Fact]
    public async Task Two_calls_to_one_provider_keep_the_minimum_gap()
    {
        var gate = new PolitenessGate();
        var inner = new Scripted(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var http = Client(gate, TimeSpan.FromMilliseconds(120), inner);

        var watch = Stopwatch.StartNew();
        using var first = await http.GetAsync("https://provider.test/a");
        using var second = await http.GetAsync("https://provider.test/b");
        watch.Stop();

        Assert.Equal(2, inner.Calls);
        Assert.True(watch.ElapsedMilliseconds >= 100, $"the second call went out after {watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task A_429_with_a_retry_after_delay_holds_the_next_call_that_long()
    {
        var gate = new PolitenessGate();
        var calls = 0;
        var inner = new Scripted(_ =>
        {
            calls += 1;
            if (calls > 1) return new HttpResponseMessage(HttpStatusCode.OK);
            var throttled = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            throttled.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromMilliseconds(400));
            return throttled;
        });
        using var http = Client(gate, TimeSpan.Zero, inner);

        using var first = await http.GetAsync("https://provider.test/a");
        Assert.Equal(HttpStatusCode.TooManyRequests, first.StatusCode);

        var watch = Stopwatch.StartNew();
        using var second = await http.GetAsync("https://provider.test/b");
        watch.Stop();

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.True(watch.ElapsedMilliseconds >= 350, $"the next call went out after only {watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task A_503_with_a_retry_after_date_is_measured_against_the_agents_clock()
    {
        var now = new DateTimeOffset(2026, 9, 29, 12, 0, 0, TimeSpan.Zero);
        var gate = new PolitenessGate(new FrozenClock(now));
        var calls = 0;
        var inner = new Scripted(_ =>
        {
            calls += 1;
            if (calls > 1) return new HttpResponseMessage(HttpStatusCode.OK);
            var down = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
            down.Headers.RetryAfter = new RetryConditionHeaderValue(now.AddMilliseconds(300));
            return down;
        });
        using var http = Client(gate, TimeSpan.Zero, inner, new FrozenClock(now));

        using var first = await http.GetAsync("https://provider.test/a");
        var watch = Stopwatch.StartNew();
        using var second = await http.GetAsync("https://provider.test/b");
        watch.Stop();

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.True(watch.ElapsedMilliseconds >= 250, $"the next call went out after only {watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task An_ordinary_answer_leaves_the_pace_alone()
    {
        var gate = new PolitenessGate();
        var inner = new Scripted(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        using var http = Client(gate, TimeSpan.Zero, inner);

        var watch = Stopwatch.StartNew();
        using var first = await http.GetAsync("https://provider.test/a");
        using var second = await http.GetAsync("https://provider.test/b");
        watch.Stop();

        Assert.True(watch.ElapsedMilliseconds < 200, $"an unthrottled pair took {watch.ElapsedMilliseconds} ms");
    }
}
