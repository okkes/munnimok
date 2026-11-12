using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Caching.Memory;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Images;

public sealed record ImageHit(string Thumbnail, string Title, string Source, int? Width, int? Height);

/// <summary>
/// What a search came to. <c>ok</c>: the pictures. <c>paused</c>: the
/// month's searches are used up, back at <c>Until</c>. <c>limited</c>: this
/// person's searches for today are used up, back at <c>Until</c>.
/// <c>unavailable</c>: the search service refused for another reason.
/// </summary>
public sealed record ImageSearchReply(string State, IReadOnlyList<ImageHit> Results, DateTimeOffset? Until);

public sealed record ImageSearchSettings(int? DailyPerUser);

/// <summary>
/// What the API remembers about the paid search between requests (#521):
/// the pause after the month's searches ran out, what the last answer said
/// is left, and how many searches each person made today. In memory on
/// purpose — after a restart the first search simply learns the pause again.
/// </summary>
public sealed class ImageSearchState(TimeProvider time)
{
    private readonly ConcurrentDictionary<(Guid User, DateOnly Day), int> _used = new();
    private long _pausedUntilTicks;
    private int _remainingThisMonth = -1;

    public DateTimeOffset Now => time.GetUtcNow();

    /// <summary>When the month's searches are back; null while there are some.</summary>
    public DateTimeOffset? PausedUntil
    {
        get
        {
            var ticks = Interlocked.Read(ref _pausedUntilTicks);
            if (ticks == 0) return null;
            var until = new DateTimeOffset(ticks, TimeSpan.Zero);
            return until > Now ? until : null;
        }
    }

    /// <summary>What the search service last said is left this month; null before the first answer.</summary>
    public int? RemainingThisMonth
    {
        get
        {
            var left = Volatile.Read(ref _remainingThisMonth);
            return left < 0 ? null : left;
        }
    }

    public DateTimeOffset Tomorrow => new(Now.UtcDateTime.Date.AddDays(1), TimeSpan.Zero);

    /// <summary>Counts one search for a person; false when today's limit is reached (no limit: always true).</summary>
    public bool TrySpend(Guid user, int? dailyLimit)
    {
        var key = (user, DateOnly.FromDateTime(Now.UtcDateTime));
        // yesterday's counts are of no use to anybody
        foreach (var stale in _used.Keys.Where(k => k.Day < key.Item2).ToList()) _used.TryRemove(stale, out _);
        while (true)
        {
            var used = _used.GetOrAdd(key, 0);
            if (dailyLimit is { } limit && used >= limit) return false;
            if (_used.TryUpdate(key, used + 1, used)) return true;
        }
    }

    /// <summary>A search that never reached an answer does not count against the person.</summary>
    public void Refund(Guid user)
    {
        var key = (user, DateOnly.FromDateTime(Now.UtcDateTime));
        _used.AddOrUpdate(key, 0, (_, used) => Math.Max(0, used - 1));
    }

    /// <summary>
    /// Reads the search service's own count. It sends one figure per window,
    /// the shortest first — the last one is the month. Returns when the month
    /// is back, once nothing is left of it.
    /// </summary>
    public DateTimeOffset? Note(HttpResponseHeaders headers)
    {
        var left = LastOf(headers, "X-RateLimit-Remaining");
        var reset = LastOf(headers, "X-RateLimit-Reset");
        if (left is null) return null;
        Volatile.Write(ref _remainingThisMonth, left.Value);
        if (left > 0 || reset is null or <= 0) return null;
        var until = Now.AddSeconds(reset.Value);
        Interlocked.Exchange(ref _pausedUntilTicks, until.UtcTicks);
        return until;
    }

    private static int? LastOf(HttpResponseHeaders headers, string name)
    {
        if (!headers.TryGetValues(name, out var values)) return null;
        var last = string.Join(',', values).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        return int.TryParse(last, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : null;
    }
}

/// <summary>
/// Picture search on the web (#521), proxied so the Brave Search key never
/// reaches a client and every paid search is counted in one place. The
/// same words within a day are answered from memory. A picked picture is
/// fetched here too, from Brave's own image store only — never from the
/// site it was found on.
/// </summary>
public static class ImageSearchEndpoints
{
    public const string SearchClientName = "brave-search";
    public const string StoreClientName = "brave-image-store";
    public const string DailyLimitKey = "imageSearch.dailyPerUser";
    public const int MaxDailyLimit = 10_000;

    private const int MaxResults = 24;
    private const int MaxPictureBytes = 4 * 1024 * 1024;
    private static readonly string[] PictureTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];

    private sealed record BraveThumbnail(
        [property: JsonPropertyName("src")] string? Src,
        [property: JsonPropertyName("width")] int? Width,
        [property: JsonPropertyName("height")] int? Height);

    private sealed record BraveResult(
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("source")] string? Source,
        [property: JsonPropertyName("thumbnail")] BraveThumbnail? Thumbnail);

    private sealed record BraveAnswer([property: JsonPropertyName("results")] List<BraveResult>? Results);

    public static void MapImageSearch(this IEndpointRouteBuilder app, bool enabled)
    {
        // the operator's side (user 2026-11-11: "configurable … by default infinite"): the limit per person per day,
        // and how the month stands — mapped without a key too, so the portal can say the feature is off
        var admin = app.MapGroup("/admin").RequireAuthorization(AdminScope.Policy);
        admin.MapGet("/image-search", async (AppDbContext db, ImageSearchState state, CancellationToken ct) =>
            Results.Ok(new
            {
                enabled,
                dailyPerUser = await DailyLimitAsync(db, ct),
                remainingThisMonth = state.RemainingThisMonth,
                pausedUntil = state.PausedUntil,
            }));
        admin.MapPut("/image-search", SaveSettingsAsync);

        if (!enabled) return;
        app.MapGet("/images/search", SearchAsync).RequireAuthorization();
        app.MapGet("/images/picked", PickedAsync).RequireAuthorization();
    }

    private static async Task<int?> DailyLimitAsync(AppDbContext db, CancellationToken ct)
    {
        var setting = await db.AppSettings.FindAsync([DailyLimitKey], ct);
        return int.TryParse(setting?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var limit) ? limit : null;
    }

    private static async Task<IResult> SaveSettingsAsync(ImageSearchSettings body, AppDbContext db, CancellationToken ct)
    {
        if (body.DailyPerUser is < 1 or > MaxDailyLimit) return Results.BadRequest();
        var setting = await db.AppSettings.FindAsync([DailyLimitKey], ct);
        if (body.DailyPerUser is { } limit)
        {
            var value = limit.ToString(CultureInfo.InvariantCulture);
            if (setting is null) db.AppSettings.Add(new AppSetting { Key = DailyLimitKey, Value = value });
            else setting.Value = value;
        }
        else if (setting is not null)
        {
            db.AppSettings.Remove(setting);
        }
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { dailyPerUser = body.DailyPerUser });
    }

    private static readonly IReadOnlyList<ImageHit> NoHits = [];

    private static async Task<IResult> SearchAsync(
        string q, HttpContext http, IHttpClientFactory clients, IMemoryCache cache, ImageSearchState state, AppDbContext db, CancellationToken ct)
    {
        var query = string.Join(' ', q.Split(' ', StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
        if (query.Length is < 2 or > 80) return Results.BadRequest();

        var cacheKey = $"images:{query}";
        if (cache.TryGetValue(cacheKey, out IReadOnlyList<ImageHit>? known) && known is not null)
            return Results.Ok(new ImageSearchReply("ok", known, null));
        if (state.PausedUntil is { } paused) return Results.Ok(new ImageSearchReply("paused", NoHits, paused));

        var user = http.GetUserId();
        if (!state.TrySpend(user, await DailyLimitAsync(db, ct)))
            return Results.Ok(new ImageSearchReply("limited", NoHits, state.Tomorrow));

        using var client = clients.CreateClient(SearchClientName);
        HttpResponseMessage response;
        try
        {
            response = await client.GetAsync(
                $"res/v1/images/search?q={Uri.EscapeDataString(query)}&count={MaxResults}&safesearch=strict&spellcheck=false", ct);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            state.Refund(user);
            return Results.Ok(new ImageSearchReply("unavailable", NoHits, null));
        }

        using (response)
        {
            var until = state.Note(response.Headers);
            if (!response.IsSuccessStatusCode)
            {
                state.Refund(user);
                // a refusal with the month used up is the pause; any other one (a burst, a withdrawn key) has no date to give
                return Results.Ok(response.StatusCode == HttpStatusCode.TooManyRequests && until is not null
                    ? new ImageSearchReply("paused", NoHits, until)
                    : new ImageSearchReply("unavailable", NoHits, null));
            }

            var answer = await JsonSerializer.DeserializeAsync<BraveAnswer>(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var hits = (answer?.Results ?? [])
                .Where(r => IsStoreUrl(r.Thumbnail?.Src))
                .Take(MaxResults)
                .Select(r => new ImageHit(r.Thumbnail!.Src!, r.Title ?? "", r.Source ?? "", r.Thumbnail.Width, r.Thumbnail.Height))
                .ToList();
            cache.Set(cacheKey, (IReadOnlyList<ImageHit>)hits, TimeSpan.FromHours(24));
            return Results.Ok(new ImageSearchReply("ok", hits, null));
        }
    }

    /// <summary>Brave's image store and nothing else: the address comes back from a client.</summary>
    internal static bool IsStoreUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && (uri.Host == "imgs.search.brave.com" || uri.Host.EndsWith(".search.brave.com", StringComparison.Ordinal));

    private static async Task<IResult> PickedAsync(string u, IHttpClientFactory clients, CancellationToken ct)
    {
        if (!IsStoreUrl(u)) return Results.BadRequest();
        using var client = clients.CreateClient(StoreClientName);
        try
        {
            using var response = await client.GetAsync(new Uri(u), HttpCompletionOption.ResponseHeadersRead, ct);
            var type = response.Content.Headers.ContentType?.MediaType;
            if (!response.IsSuccessStatusCode || type is null || !PictureTypes.Contains(type)) return Results.NotFound();
            if (response.Content.Headers.ContentLength > MaxPictureBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

            await using var body = await response.Content.ReadAsStreamAsync(ct);
            using var picture = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = await body.ReadAsync(buffer, ct)) > 0)
            {
                if (picture.Length + read > MaxPictureBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                await picture.WriteAsync(buffer.AsMemory(0, read), ct);
            }
            return Results.File(picture.ToArray(), type);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return Results.NotFound();
        }
    }
}
