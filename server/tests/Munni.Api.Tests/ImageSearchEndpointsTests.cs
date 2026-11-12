using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Munni.Api.Data;
using Munni.Api.Images;

namespace Munni.Api.Tests;

/// <summary>Brave's search and its image store, as far as the API talks to them.</summary>
internal sealed class FakeBraveHandler : HttpMessageHandler
{
    public int Searches;
    public string? LastToken;
    public string? LastQuery;
    /// <summary>What the next search answers: left this month, seconds until the month is back, and the status.</summary>
    public (int Left, int ResetSeconds, HttpStatusCode Status) Next = (1999, 1_000_000, HttpStatusCode.OK);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var uri = request.RequestUri!;
        if (uri.Host == "imgs.search.brave.com")
        {
            if (uri.AbsolutePath.Contains("missing")) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            var content = new ByteArrayContent(uri.AbsolutePath.Contains("huge") ? new byte[5 * 1024 * 1024] : [0x89, 0x50, 0x4E, 0x47]);
            content.Headers.ContentType = new(uri.AbsolutePath.Contains("page") ? "text/html" : "image/png");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }

        Searches++;
        LastToken = request.Headers.TryGetValues("X-Subscription-Token", out var token) ? token.Single() : null;
        LastQuery = uri.Query;
        var body = Next.Status == HttpStatusCode.OK
            ? """
              {"type":"images","results":[
                {"title":"Netflix logo","source":"netflix.com","thumbnail":{"src":"https://imgs.search.brave.com/abc/netflix.png","width":500,"height":300}},
                {"title":"No picture","source":"example.com","thumbnail":null},
                {"title":"Elsewhere","source":"evil.example","thumbnail":{"src":"https://evil.example/x.png"}}
              ]}
              """
            : """{"type":"ErrorResponse","error":{"id":"x","status":429,"code":"RATE_LIMITED"}}""";
        var response = new HttpResponseMessage(Next.Status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        // one figure per window, the shortest first: the per-second window, then the month
        response.Headers.Add("X-RateLimit-Remaining", $"0, {Next.Left}");
        response.Headers.Add("X-RateLimit-Reset", $"1, {Next.ResetSeconds}");
        return Task.FromResult(response);
    }
}

/// <summary>A clock the test moves by hand.</summary>
internal sealed class HandClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;
}

public class ImageSearchApiFactory : WebApplicationFactory<Program>
{
    private readonly string _databaseName = $"image-search-tests-{Guid.NewGuid():N}";
    internal FakeBraveHandler Brave { get; } = new();
    internal HandClock Clock { get; } = new(new DateTimeOffset(2026, 11, 12, 10, 0, 0, TimeSpan.Zero));
    public string? Key { get; init; } = "brave-test-key";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("Auth:TestMode", "true");
        builder.UseSetting("Db:AutoMigrate", "false");
        builder.UseSetting("ImageSearch:BraveKey", Key);
        builder.ConfigureServices(services =>
        {
            foreach (var d in services
                         .Where(d =>
                             d.ServiceType == typeof(DbContextOptions<AppDbContext>) ||
                             d.ServiceType == typeof(DbContextOptions) ||
                             d.ServiceType == typeof(AppDbContext) ||
                             d.ServiceType == typeof(TimeProvider) ||
                             d.ServiceType.Name.Contains("IDbContextOptionsConfiguration"))
                         .ToList())
            {
                services.Remove(d);
            }
            services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase(_databaseName));
            services.AddSingleton<TimeProvider>(Clock);
            services.AddHttpClient(ImageSearchEndpoints.SearchClientName).ConfigurePrimaryHttpMessageHandler(() => Brave);
            services.AddHttpClient(ImageSearchEndpoints.StoreClientName).ConfigurePrimaryHttpMessageHandler(() => Brave);
        });
    }
}

/// <summary>
/// #521: picture search on the web. One factory per test: the pause and the
/// per-person counts live in the API's memory.
/// </summary>
public class ImageSearchEndpointsTests
{
    private static HttpClient ClientFor(ImageSearchApiFactory factory, string sub, string? scope = null)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-User-Sub", sub);
        client.DefaultRequestHeaders.Add("X-Munni-Device", "test-device");
        if (scope is not null) client.DefaultRequestHeaders.Add("X-User-Scope", scope);
        return client;
    }

    private static async Task<JsonElement> SearchAsync(HttpClient client, string q) =>
        await client.GetFromJsonAsync<JsonElement>($"/images/search?q={Uri.EscapeDataString(q)}");

    [Fact]
    public async Task A_search_asks_Brave_with_the_key_and_hands_back_only_pictures_from_its_own_store()
    {
        await using var factory = new ImageSearchApiFactory();
        var client = ClientFor(factory, "searcher");

        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/images/search?q=netflix")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/images/search?q=a")).StatusCode);

        var reply = await SearchAsync(client, "Netflix   logo");
        Assert.Equal("ok", reply.GetProperty("state").GetString());
        var hit = Assert.Single(reply.GetProperty("results").EnumerateArray());
        Assert.Equal("https://imgs.search.brave.com/abc/netflix.png", hit.GetProperty("thumbnail").GetString());
        Assert.Equal("Netflix logo", hit.GetProperty("title").GetString());
        Assert.Equal("netflix.com", hit.GetProperty("source").GetString());
        Assert.Equal("brave-test-key", factory.Brave.LastToken);
        Assert.Contains("q=netflix%20logo", factory.Brave.LastQuery);
        Assert.Contains("safesearch=strict", factory.Brave.LastQuery);

        // the same words within a day cost nothing, however they are typed
        await SearchAsync(client, "netflix logo");
        await SearchAsync(ClientFor(factory, "somebody-else"), "NETFLIX LOGO");
        Assert.Equal(1, factory.Brave.Searches);

        // the capability tells the app the door exists
        var health = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
        Assert.True(health.GetProperty("capabilities").GetProperty("imageSearch").GetBoolean());
    }

    [Fact]
    public async Task The_month_used_up_is_a_pause_with_its_end_and_nobody_is_asked_again_until_then()
    {
        await using var factory = new ImageSearchApiFactory();
        var client = ClientFor(factory, "searcher");

        // the last search of the month still answers — and the next one is not even sent
        factory.Brave.Next = (0, 3600, HttpStatusCode.OK);
        Assert.Equal("ok", (await SearchAsync(client, "first")).GetProperty("state").GetString());
        var paused = await SearchAsync(client, "second");
        Assert.Equal("paused", paused.GetProperty("state").GetString());
        Assert.Equal(factory.Clock.GetUtcNow().AddHours(1), paused.GetProperty("until").GetDateTimeOffset());
        Assert.Equal(1, factory.Brave.Searches);
        // what was answered before the pause still is
        Assert.Equal("ok", (await SearchAsync(client, "first")).GetProperty("state").GetString());

        // the month is back
        factory.Clock.Advance(TimeSpan.FromHours(1) + TimeSpan.FromSeconds(1));
        factory.Brave.Next = (1999, 2_000_000, HttpStatusCode.OK);
        Assert.Equal("ok", (await SearchAsync(client, "second")).GetProperty("state").GetString());
        Assert.Equal(2, factory.Brave.Searches);
    }

    [Fact]
    public async Task A_refusal_with_the_month_used_up_pauses_and_any_other_refusal_is_just_not_available()
    {
        await using var factory = new ImageSearchApiFactory();
        var client = ClientFor(factory, "searcher");
        var admin = ClientFor(factory, "the-admin", "admin");
        await admin.PutAsJsonAsync("/admin/image-search", new { dailyPerUser = 2 });

        // a burst: refused while the month still has searches — no date to give, and it does not count against the person
        factory.Brave.Next = (500, 1_000_000, HttpStatusCode.TooManyRequests);
        var burst = await SearchAsync(client, "one");
        Assert.Equal("unavailable", burst.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, burst.GetProperty("until").ValueKind);
        // a withdrawn key
        factory.Brave.Next = (500, 1_000_000, HttpStatusCode.Unauthorized);
        Assert.Equal("unavailable", (await SearchAsync(client, "two")).GetProperty("state").GetString());

        // refused with nothing left: the pause, with the service's own reset
        factory.Brave.Next = (0, 7200, HttpStatusCode.TooManyRequests);
        var refused = await SearchAsync(client, "three");
        Assert.Equal("paused", refused.GetProperty("state").GetString());
        Assert.Equal(factory.Clock.GetUtcNow().AddHours(2), refused.GetProperty("until").GetDateTimeOffset());

        // none of the three reached an answer: the person's two searches for today are still there
        factory.Clock.Advance(TimeSpan.FromHours(3));
        factory.Brave.Next = (1999, 1_000_000, HttpStatusCode.OK);
        Assert.Equal("ok", (await SearchAsync(client, "four")).GetProperty("state").GetString());
        Assert.Equal("ok", (await SearchAsync(client, "five")).GetProperty("state").GetString());
        Assert.Equal("limited", (await SearchAsync(client, "six")).GetProperty("state").GetString());

        var status = await admin.GetFromJsonAsync<JsonElement>("/admin/image-search");
        Assert.Equal(1999, status.GetProperty("remainingThisMonth").GetInt32());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("pausedUntil").ValueKind);
    }

    [Fact]
    public async Task The_operator_sets_how_many_searches_a_person_gets_a_day_and_without_a_limit_there_is_none()
    {
        await using var factory = new ImageSearchApiFactory();
        var user = ClientFor(factory, "searcher");
        var other = ClientFor(factory, "somebody-else");
        var admin = ClientFor(factory, "the-admin", "admin");

        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/admin/image-search")).StatusCode);
        var before = await admin.GetFromJsonAsync<JsonElement>("/admin/image-search");
        Assert.True(before.GetProperty("enabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("dailyPerUser").ValueKind);

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/admin/image-search", new { dailyPerUser = 0 })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/admin/image-search", new { dailyPerUser = 2 })).StatusCode);
        Assert.Equal(2, (await admin.GetFromJsonAsync<JsonElement>("/admin/image-search")).GetProperty("dailyPerUser").GetInt32());

        Assert.Equal("ok", (await SearchAsync(user, "one")).GetProperty("state").GetString());
        Assert.Equal("ok", (await SearchAsync(user, "two")).GetProperty("state").GetString());
        var limited = await SearchAsync(user, "three");
        Assert.Equal("limited", limited.GetProperty("state").GetString());
        Assert.Equal(new DateTimeOffset(2026, 11, 13, 0, 0, 0, TimeSpan.Zero), limited.GetProperty("until").GetDateTimeOffset());
        // words already answered cost nothing and are not refused; the limit is each person's own
        Assert.Equal("ok", (await SearchAsync(user, "one")).GetProperty("state").GetString());
        Assert.Equal("ok", (await SearchAsync(other, "three")).GetProperty("state").GetString());
        Assert.Equal(3, factory.Brave.Searches);

        // tomorrow the count starts over; the limit taken off is no limit
        factory.Clock.Advance(TimeSpan.FromDays(1));
        Assert.Equal("ok", (await SearchAsync(user, "four")).GetProperty("state").GetString());
        Assert.Equal(HttpStatusCode.OK, (await admin.PutAsJsonAsync("/admin/image-search", new { dailyPerUser = (int?)null })).StatusCode);
        foreach (var word in new[] { "five", "six", "seven" })
            Assert.Equal("ok", (await SearchAsync(user, word)).GetProperty("state").GetString());
    }

    [Fact]
    public async Task A_picked_picture_is_fetched_from_Braves_store_only_and_only_when_it_is_a_picture_of_a_fair_size()
    {
        await using var factory = new ImageSearchApiFactory();
        var client = ClientFor(factory, "searcher");
        static string Picked(string url) => $"/images/picked?u={Uri.EscapeDataString(url)}";

        var picture = await client.GetAsync(Picked("https://imgs.search.brave.com/abc/netflix.png"));
        Assert.Equal(HttpStatusCode.OK, picture.StatusCode);
        Assert.Equal("image/png", picture.Content.Headers.ContentType?.MediaType);
        Assert.Equal(4, (await picture.Content.ReadAsByteArrayAsync()).Length);

        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync(Picked("https://imgs.search.brave.com/abc/netflix.png"))).StatusCode);
        // anywhere else is refused before a request is made
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Picked("https://evil.example/x.png"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Picked("http://imgs.search.brave.com/abc/x.png"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Picked("https://imgs.search.brave.com.evil.example/x.png"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync(Picked("not a url"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Picked("https://imgs.search.brave.com/missing.png"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Picked("https://imgs.search.brave.com/page.html"))).StatusCode);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await client.GetAsync(Picked("https://imgs.search.brave.com/huge.png"))).StatusCode);
    }

    [Fact]
    public async Task Without_a_key_there_is_no_search_and_the_portal_can_say_so()
    {
        await using var factory = new ImageSearchApiFactory { Key = "" };
        var client = ClientFor(factory, "searcher");
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/images/search?q=netflix")).StatusCode);
        var health = await factory.CreateClient().GetFromJsonAsync<JsonElement>("/health");
        Assert.False(health.GetProperty("capabilities").GetProperty("imageSearch").GetBoolean());
        var status = await ClientFor(factory, "the-admin", "admin").GetFromJsonAsync<JsonElement>("/admin/image-search");
        Assert.False(status.GetProperty("enabled").GetBoolean());
    }
}
