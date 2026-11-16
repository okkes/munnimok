using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Social;
using Xunit;

namespace Munni.Api.Tests;

// this factory sets LOW explicit limits: the other factories run TestMode-unlimited so functional suites never throttle
public class RateLimitTests : IClassFixture<RateLimitedApiFactory>
{
    private readonly RateLimitedApiFactory _factory;

    public RateLimitTests(RateLimitedApiFactory factory) => _factory = factory;

    private HttpClient ClientFor(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        return client;
    }

    [Fact]
    public async Task SocialMutations_throttle_after_the_per_minute_budget()
    {
        var client = ClientFor($"limited_{Guid.NewGuid():N}");

        // budget is 2/min here; the first two may fail functionally (unknown target) but must pass the limiter
        for (var i = 0; i < 2; i++)
        {
            var ok = await client.PostAsJsonAsync("/friends/requests", new SendFriendRequest(Guid.NewGuid()));
            Assert.NotEqual(HttpStatusCode.TooManyRequests, ok.StatusCode);
        }

        var throttled = await client.PostAsJsonAsync("/friends/requests", new SendFriendRequest(Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
        Assert.True(throttled.Headers.Contains("Retry-After"));
    }

    [Fact]
    public async Task GlobalBucket_throttles_a_hammering_user_without_affecting_others()
    {
        var noisy = ClientFor($"noisy_{Guid.NewGuid():N}");
        var quiet = ClientFor($"quiet_{Guid.NewGuid():N}");

        var sawTooMany = false;
        for (var i = 0; i < 9 && !sawTooMany; i++)
            sawTooMany = (await noisy.GetAsync("/me")).StatusCode == HttpStatusCode.TooManyRequests;
        Assert.True(sawTooMany);

        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await quiet.GetAsync("/me")).StatusCode);
    }

    // the streamed login polls a frame per request; in the global bucket a minute of signing in
    // starved sync pulls and dropped keystrokes
    [Fact]
    public async Task Live_view_polls_ride_their_own_bucket_and_leave_the_global_one_alone()
    {
        var client = ClientFor($"live_{Guid.NewGuid():N}");

        for (var i = 0; i < 20; i++)
        {
            var frame = await client.GetAsync("/connectors/mock-store-simple/login/ses_x/challenges/chl_x/live/frame?after=0");
            Assert.NotEqual(HttpStatusCode.TooManyRequests, frame.StatusCode);
        }

        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.GetAsync("/me")).StatusCode);
    }

    // #429: one request per login, so only how often one opens is bounded: each open holds a stream to the control plane
    [Fact]
    public async Task Live_view_stream_opens_ride_their_own_small_bucket()
    {
        var client = ClientFor($"livestream_{Guid.NewGuid():N}");
        const string stream = "/connectors/mock-store-simple/login/ses_x/challenges/chl_x/live/stream";

        for (var i = 0; i < 3; i++)
        {
            Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.GetAsync(stream)).StatusCode);
        }

        var refused = await client.GetAsync(stream);
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.True(refused.Headers.Contains("Retry-After"));

        Assert.NotEqual(HttpStatusCode.TooManyRequests,
            (await client.GetAsync("/connectors/mock-store-simple/login/ses_x/challenges/chl_x/live/frame?after=0")).StatusCode);
        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.GetAsync("/me")).StatusCode);
    }

    // #576: in the global bucket a minute of the lab's live view starved every other lab call and taps were dropped as if sent
    [Fact]
    public async Task The_labs_live_view_rides_the_live_bucket_too()
    {
        var client = ClientFor($"lablive_{Guid.NewGuid():N}");

        for (var i = 0; i < 20; i++)
        {
            var frame = await client.GetAsync("/lab/bench/explore/login/ses_x/challenges/chl_x/live/frame?after=0");
            Assert.NotEqual(HttpStatusCode.TooManyRequests, frame.StatusCode);
            using var input = await client.PostAsJsonAsync("/lab/bench/explore/login/ses_x/challenges/chl_x/live/input", new { events = Array.Empty<object>() });
            Assert.NotEqual(HttpStatusCode.TooManyRequests, input.StatusCode);
        }

        Assert.NotEqual(HttpStatusCode.TooManyRequests, (await client.GetAsync("/me")).StatusCode);
    }

    [Theory]
    [InlineData("/sync/%20/pull?since=0")]
    [InlineData("/sync/sp%3Cscript%3E/pull?since=0")]
    [InlineData("/sync/sp.ace/pull?since=0")]
    public async Task Malformed_spaceIds_are_rejected_with_400(string path)
    {
        var client = ClientFor($"shape_{Guid.NewGuid():N}");
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Overlong_spaceIds_are_rejected_with_400()
    {
        var client = ClientFor($"shape_{Guid.NewGuid():N}");
        var response = await client.GetAsync($"/sync/{new string('a', 65)}/pull?since=0");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Wellformed_spaceIds_pass_the_shape_filter()
    {
        var client = ClientFor($"shape_{Guid.NewGuid():N}");
        var response = await client.GetAsync($"/sync/space_{Guid.NewGuid():N}/pull?since=0");
        Assert.NotEqual(HttpStatusCode.BadRequest, response.StatusCode);
    }
}

public class RateLimitedApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("RateLimits:GlobalTokens", "8");
        builder.UseSetting("RateLimits:GlobalRefillPer10s", "1");
        builder.UseSetting("RateLimits:SocialPerMinute", "2");
        builder.UseSetting("RateLimits:LiveStreamOpens", "3");
        builder.UseSetting("RateLimits:LiveStreamOpensPer10s", "1");
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ratelimit-tests"));
        });
    }
}
