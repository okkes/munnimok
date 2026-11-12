using System.Globalization;
using Munni.Api.Auth;
using Munni.Api.Data;

namespace Munni.Api.Shopping;

/// <summary>What the app sends: the photos as data URLs and the categories the reader may choose from.</summary>
public sealed record ReceiptReadRequest(IReadOnlyList<string>? Images, IReadOnlyList<ReadCategory>? Categories);

/// <summary>
/// ok: the receipt. limited: this person's reads for today are used up,
/// back at Until. capped: the environment's reads for the month are used
/// up, back at Until. unreadable: the reader made no receipt of the
/// photos. unavailable: the reader did not answer.
/// </summary>
public sealed record ReceiptReadReply(string State, ReceiptReadResult? Receipt, DateTimeOffset? Until);

public sealed record ReceiptReadSettings(int? DailyPerUser, int? MonthlyCap, string? Model);

/// <summary>
/// #567 (user 2026-11-09): "munni api sends the picture to vision model …
/// validates totals, normalizes keys, match categories … returns the
/// receipt data back to the client". The provider's key never leaves the
/// server, every read is counted, and nothing of the photo is kept here.
/// </summary>
public static class ReceiptReadEndpoints
{
    public const string DailyLimitKey = "receiptAi.dailyPerUser";
    public const string MonthlyCapKey = "receiptAi.monthlyCap";
    public const string ModelKey = "receiptAi.model";
    public const string MonthCountPrefix = "receiptAi.read.";
    public const int DefaultDailyPerUser = 20;
    public const int DefaultMonthlyCap = 1000;
    public const int MaxPhotos = 4;

    private const int MaxPhotoBytes = 5 * 1024 * 1024;
    private const int MaxCategories = 400;
    private static readonly string[] PhotoTypes = ["image/jpeg", "image/png", "image/webp"];

    public static void MapReceiptReading(this IEndpointRouteBuilder app, bool enabled)
    {
        // the operator's side: how far one person and the whole environment can go, and how the month stands —
        // mapped without a key too, so the portal can say the reader is off
        var admin = app.MapGroup("/admin").RequireAuthorization(AdminScope.Policy);
        admin.MapGet("/receipt-reading", async (AppDbContext db, ReceiptReadCounts counts, IServiceProvider services, CancellationToken ct) =>
            Results.Ok(new
            {
                enabled,
                provider = services.GetService<IReceiptReader>()?.Provider,
                defaultModel = services.GetService<IReceiptReader>()?.DefaultModel,
                model = await ModelAsync(db, ct),
                dailyPerUser = await LimitAsync(db, DailyLimitKey, DefaultDailyPerUser, ct),
                monthlyCap = await LimitAsync(db, MonthlyCapKey, DefaultMonthlyCap, ct),
                readThisMonth = await MonthCountAsync(db, counts.MonthKey, ct),
            }));
        admin.MapPut("/receipt-reading", SaveSettingsAsync);

        if (!enabled) return;
        app.MapPost("/receipts/read", ReadAsync).RequireAuthorization();
    }

    /// <summary>A stored limit; "0" is "no limit" and nothing stored is the default.</summary>
    private static async Task<int?> LimitAsync(AppDbContext db, string key, int fallback, CancellationToken ct)
    {
        var setting = await db.AppSettings.FindAsync([key], ct);
        if (!int.TryParse(setting?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)) return fallback;
        return value <= 0 ? null : value;
    }

    private static async Task<int> MonthCountAsync(AppDbContext db, string month, CancellationToken ct)
    {
        var setting = await db.AppSettings.FindAsync([MonthCountPrefix + month], ct);
        return int.TryParse(setting?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var count) ? count : 0;
    }

    /// <summary>The model the operator chose; null = the reader's own default.</summary>
    private static async Task<string?> ModelAsync(AppDbContext db, CancellationToken ct)
    {
        var value = (await db.AppSettings.FindAsync([ModelKey], ct))?.Value;
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    /// <summary>A model id as providers write them: letters, digits, dots, dashes — never a sentence.</summary>
    private static bool IsModelId(string value) => value.Length is >= 3 and <= 80 && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '.' or '_' or ':');

    private static async Task<IResult> SaveSettingsAsync(ReceiptReadSettings body, AppDbContext db, CancellationToken ct)
    {
        var model = body.Model?.Trim() ?? string.Empty;
        if (body.DailyPerUser is < 1 or > 10_000 || body.MonthlyCap is < 1 or > 1_000_000 || (model.Length > 0 && !IsModelId(model))) return Results.BadRequest();
        await StoreAsync(db, DailyLimitKey, body.DailyPerUser, ct);
        await StoreAsync(db, MonthlyCapKey, body.MonthlyCap, ct);
        var setting = await db.AppSettings.FindAsync([ModelKey], ct);
        if (setting is null) db.AppSettings.Add(new AppSetting { Key = ModelKey, Value = model });
        else setting.Value = model;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new ReceiptReadSettings(body.DailyPerUser, body.MonthlyCap, model.Length > 0 ? model : null));
    }

    /// <summary>null is "no limit" — stored as 0, so it is told apart from "never set" (the default).</summary>
    private static async Task StoreAsync(AppDbContext db, string key, int? limit, CancellationToken ct)
    {
        var value = (limit ?? 0).ToString(CultureInfo.InvariantCulture);
        var setting = await db.AppSettings.FindAsync([key], ct);
        if (setting is null) db.AppSettings.Add(new AppSetting { Key = key, Value = value });
        else setting.Value = value;
    }

    private static async Task<IResult> ReadAsync(
        ReceiptReadRequest request, HttpContext http, IReceiptReader reader, ReceiptReadCounts counts, AppDbContext db, ILoggerFactory logs, CancellationToken ct)
    {
        var photos = Photos(request.Images);
        var categories = (request.Categories ?? []).Where(c => !string.IsNullOrWhiteSpace(c.Id) && !string.IsNullOrWhiteSpace(c.Name)).Take(MaxCategories).ToList();
        if (photos is null) return Results.BadRequest();

        var cap = await LimitAsync(db, MonthlyCapKey, DefaultMonthlyCap, ct);
        var month = counts.MonthKey;
        if (cap is { } most && await MonthCountAsync(db, month, ct) >= most)
            return Results.Ok(new ReceiptReadReply("capped", null, counts.NextMonth));
        var user = http.GetUserId();
        if (!counts.TrySpend(user, await LimitAsync(db, DailyLimitKey, DefaultDailyPerUser, ct)))
            return Results.Ok(new ReceiptReadReply("limited", null, counts.Tomorrow));

        ReadReceipt? read;
        try
        {
            read = await reader.ReadAsync(photos, categories, await ModelAsync(db, ct), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // the provider's own error text may quote the request: only its type is logged
            logs.CreateLogger("ReceiptReading").LogWarning("receipt read failed at {Provider}: {Kind}", reader.Provider, e.GetType().Name);
            counts.Refund(user);
            return Results.Ok(new ReceiptReadReply("unavailable", null, null));
        }

        // the provider was asked and answered: that read is paid for, whatever it says
        await CountMonthAsync(db, month, ct);
        var receipt = ReceiptReadCheck.Normalize(read, categories);
        return Results.Ok(receipt is null ? new ReceiptReadReply("unreadable", null, null) : new ReceiptReadReply("ok", receipt, null));
    }

    private static async Task CountMonthAsync(AppDbContext db, string month, CancellationToken ct)
    {
        var key = MonthCountPrefix + month;
        var setting = await db.AppSettings.FindAsync([key], ct);
        var next = (int.TryParse(setting?.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var count) ? count : 0) + 1;
        if (setting is null) db.AppSettings.Add(new AppSetting { Key = key, Value = next.ToString(CultureInfo.InvariantCulture) });
        else setting.Value = next.ToString(CultureInfo.InvariantCulture);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>One to four photos as data URLs of a picture type and a fair size; null when the request holds anything else.</summary>
    private static List<ReceiptPhoto>? Photos(IReadOnlyList<string>? images)
    {
        if (images is null || images.Count is 0 or > MaxPhotos) return null;
        var photos = new List<ReceiptPhoto>();
        foreach (var image in images)
        {
            var comma = image?.IndexOf(',') ?? -1;
            if (image is null || comma < 0 || !image.StartsWith("data:", StringComparison.Ordinal)) return null;
            var type = image[5..comma].Split(';')[0];
            if (!PhotoTypes.Contains(type)) return null;
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(image[(comma + 1)..]);
            }
            catch (FormatException)
            {
                return null;
            }
            if (bytes.Length is 0 or > MaxPhotoBytes) return null;
            photos.Add(new ReceiptPhoto(bytes, type));
        }
        return photos;
    }
}
